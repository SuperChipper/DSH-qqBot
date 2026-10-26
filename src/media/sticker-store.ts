/**
 * 表情包存储 — 自动收藏、内容去重、索引与动态 prompt 清单。
 *
 * 数据流：
 *   图片（media/） → save() → 复制到 stickers/ → 追加 index.json
 *   每回合 system-prompt/assemble → promptSections() → 注入自动收藏清单
 *
 * 索引是唯一事实源；旧条目没有 sha256 时在首次保存前惰性补齐，
 * 因此手动维护的 index.json 也能参与去重。
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import type { Logger } from '../types.ts';

/** index.json 中的一条表情记录（保留旧条目的未知字段） */
export interface StickerIndexEntry {
  emotion: string;
  file: string;
  bytes: number;
  sha256?: string;
  /** 由 qqbot_save_sticker 自动收藏；只有这些条目会进入动态 prompt */
  auto?: boolean;
  createdAt?: number;
  note?: string;
  [key: string]: unknown;
}

/** system-prompt section 的最小形状（与 SessionManager 的 Projection 兼容） */
export interface StickerPromptSection {
  name: string;
  order: number;
  text: string;
}

export interface StickerStoreOptions {
  /** 表情包目录（必须可写） */
  root: string;
  /** 允许作为收藏来源的根目录（通常是 media/ 与额外目录） */
  allowedRoots: string[];
  /** 敏感路径：命中后拒绝读取/收藏 */
  sensitivePaths?: string[];
  /** 单张图片大小上限 */
  maxBytes: number;
  /** 自动收藏条目上限 */
  maxAutoEntries: number;
  /** 动态清单最多列出的条目数 */
  maxPromptEntries?: number;
  logger?: Logger;
}

export interface SaveStickerInput {
  /** 图片绝对路径（通常来自用户消息里的 - Image: 行） */
  source: string;
  /** bot 自己此刻的情绪/场景标签，不是图片内容描述 */
  emotion: string;
  /** 为什么想收藏（可选，写入索引） */
  note?: string;
  /** 首选文件名（可选，如 fish_破防.png） */
  file?: string;
}

export interface SaveStickerResult {
  saved: boolean;
  duplicate: boolean;
  file: string;
  emotion: string;
  bytes: number;
  total: number;
  message: string;
}

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const DEFAULT_MAX_PROMPT_ENTRIES = 80;
const MAX_EMOTION_LENGTH = 32;
const MAX_FILENAME_STEM = 48;

/** 路径是否位于 root 目录内（含 root 本身） */
function isWithin(path: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** 规范化情绪标签：去掉换行/路径字符，限制长度 */
function normalizeEmotion(input: string): string {
  const value = input.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (value.length === 0) throw new Error('emotion 不能为空');
  return value.slice(0, MAX_EMOTION_LENGTH);
}

/** 文件名安全化：只保留中文、字母、数字、下划线、短横线 */
function safeStem(input: string): string {
  const value = input
    .replace(/[\s\\/:*?"<>|]+/g, '_')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, MAX_FILENAME_STEM);
  return value.length > 0 ? value : 'sticker';
}

/** 从内容计算 SHA-256（十六进制） */
function hashFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export interface StickerMatchResult {
  matched: true;
  file: string;
  emotion: string;
  note?: string;
  bytes: number;
  sha256: string;
  total: number;
}

export class StickerStore {
  readonly root: string;
  readonly indexPath: string;
  private readonly allowedRoots: string[];
  private readonly sensitivePaths: string[];
  private readonly maxBytes: number;
  private readonly maxAutoEntries: number;
  private readonly maxPromptEntries: number;
  private readonly logger?: Logger;

  constructor(options: StickerStoreOptions) {
    this.root = resolve(options.root);
    this.indexPath = join(this.root, 'index.json');
    this.allowedRoots = options.allowedRoots.map((root) => resolve(root));
    this.sensitivePaths = (options.sensitivePaths ?? []).map((root) => resolve(root));
    this.maxBytes = options.maxBytes;
    this.maxAutoEntries = options.maxAutoEntries;
    this.maxPromptEntries = options.maxPromptEntries ?? DEFAULT_MAX_PROMPT_ENTRIES;
    this.logger = options.logger;
  }

  /**
   * 收藏一张图。
   *
   * 同步执行：整个校验、哈希、复制、索引写回都在一个事件循环片段内完成，
   * 并发工具调用不会交错写 index.json。重复内容直接返回 duplicate，
   * 不复制、不改索引。
   */
  save(input: SaveStickerInput): SaveStickerResult {
    const emotion = normalizeEmotion(input.emotion);
    const source = resolve(input.source);

    if (!existsSync(source)) throw new Error(`图片不存在: ${source}`);
    if (!this.allowedRoots.some((root) => isWithin(source, root))) {
      throw new Error(`图片不在允许的目录内: ${source}（允许: ${this.allowedRoots.join('、')}）`);
    }
    if (this.sensitivePaths.some((root) => isWithin(source, root))) {
      throw new Error(`图片位于敏感目录，禁止收藏: ${source}`);
    }

    const stat = statSync(source);
    if (!stat.isFile()) throw new Error(`不是普通文件: ${source}`);
    if (stat.size <= 0) throw new Error(`图片为空: ${source}`);
    if (stat.size > this.maxBytes) {
      throw new Error(`图片过大: ${stat.size} bytes（上限 ${this.maxBytes} bytes）`);
    }

    const sourceExt = extname(source).toLowerCase();
    if (!IMAGE_EXTS.has(sourceExt)) {
      throw new Error(`不支持的图片格式: ${sourceExt || '(无扩展名)'}`);
    }

    const bytes = readFileSync(source);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const entries = this.readIndex();
    this.backfillHashes(entries);

    const duplicate = entries.find((entry) => entry.sha256 === sha256);
    if (duplicate !== undefined) {
      return {
        saved: false,
        duplicate: true,
        file: duplicate.file,
        emotion: duplicate.emotion,
        bytes: duplicate.bytes,
        total: entries.length,
        message: `这张已经收藏过了：${duplicate.file}（情绪「${duplicate.emotion}」），未重复保存。`,
      };
    }

    const autoCount = entries.filter((entry) => entry.auto === true).length;
    if (autoCount >= this.maxAutoEntries) {
      throw new Error(`自动收藏已达上限（${this.maxAutoEntries} 条），请清理 index.json 或调大 stickers.maxAutoEntries`);
    }

    const file = this.pickFileName(input.file, emotion, sourceExt);
    mkdirSync(this.root, { recursive: true });
    writeFileSync(join(this.root, file), bytes);

    const entry: StickerIndexEntry = {
      emotion,
      file,
      bytes: bytes.length,
      sha256,
      auto: true,
      createdAt: Date.now(),
      ...(input.note !== undefined && input.note.trim() !== '' ? { note: input.note.trim() } : {}),
    };
    entries.push(entry);
    this.writeIndex(entries);
    this.logger?.info(`im-qqbot: 收藏表情 ${file}（情绪「${emotion}」），共 ${entries.length} 条`);

    return {
      saved: true,
      duplicate: false,
      file,
      emotion,
      bytes: bytes.length,
      total: entries.length,
      message: `已收藏「${emotion}」→ ${file}（${entries.length} 条）。可以立即用 qqbot_send_file 发出；从下一回合起它会出现在自动收藏清单里。`,
    };
  }

  /**
   * 按内容 SHA-256 在表情索引里查找完全相同的图片（只读，不上传、不复制）。
   * 命中时返回情绪/备注/文件；未命中返回 undefined。
   */
  match(source: string): StickerMatchResult | undefined {
    const resolved = resolve(source);
    if (!existsSync(resolved)) throw new Error(`图片不存在: ${resolved}`);
    if (!this.allowedRoots.some((root) => isWithin(resolved, root))) {
      throw new Error(`图片不在允许的目录内: ${resolved}（允许: ${this.allowedRoots.join('、')}）`);
    }
    if (this.sensitivePaths.some((root) => isWithin(resolved, root))) {
      throw new Error(`图片位于敏感目录，禁止匹配: ${resolved}`);
    }
    const stat = statSync(resolved);
    if (!stat.isFile()) throw new Error(`不是普通文件: ${resolved}`);
    if (stat.size <= 0) throw new Error(`图片为空: ${resolved}`);
    if (stat.size > this.maxBytes) throw new Error(`图片过大: ${stat.size} bytes（上限 ${this.maxBytes} bytes）`);
    const ext = extname(resolved).toLowerCase();
    if (!IMAGE_EXTS.has(ext)) throw new Error(`不支持的图片格式: ${ext || '(无扩展名)'}`);

    const sha256 = createHash('sha256').update(readFileSync(resolved)).digest('hex');
    const entries = this.readIndex();
    this.backfillHashes(entries);
    const found = entries.find((entry) => entry.sha256 === sha256);
    if (found === undefined) return undefined;
    return {
      matched: true,
      file: found.file,
      emotion: found.emotion,
      ...(found.note !== undefined && found.note.trim() !== '' ? { note: found.note.trim() } : {}),
      bytes: found.bytes,
      sha256,
      total: entries.length,
    };
  }

  /**
   * 生成每回合注入的 prompt section：
   * - 收藏指令（始终存在，告诉 bot 何时该调用工具）
   * - 自动收藏清单（只列 auto:true 且文件仍存在的条目）
   */
  promptSections(): StickerPromptSection[] {
    const sections: StickerPromptSection[] = [{
      name: 'qqbot:sticker-capture',
      order: 91,
      text: [
        '【表情收藏】',
        '你有一批自己的表情包。看到一张图、内心产生明确情绪，并且觉得以后会想用它表达这种情绪时，可以调用 qqbot_save_sticker 收藏：',
        'image=图片本地路径（复制用户消息里的 - Image: 行），emotion=你此刻的情绪/场景（如「破防」「被萌到」「无语」「骄傲」），note=一句为什么想存。',
        '只在真正想用的时候存：普通截图、长文截图、与情绪无关的图不要存；重复图片会按内容哈希自动跳过，不要为了凑数反复存。',
        '必须通过真正的工具调用收藏：不要把 <qqbot_save_sticker>、<image>、<emotion> 这类标签写进回复正文——那不是调用，会被当普通文字发出去。',
        '如果要同时回复和收藏：先发起 qqbot_save_sticker 工具调用（正文留空），拿到工具结果后再写回复。',
        '收藏后可以立即用 qqbot_send_file 发出；从下一回合起，它会自动出现在下面的「自动收藏」清单里。',
      ].join('\n'),
    }];

    let entries: StickerIndexEntry[];
    try {
      entries = this.readIndex();
    } catch (err) {
      this.logger?.warn(`im-qqbot: 读取表情索引失败，跳过动态清单: ${err instanceof Error ? err.message : String(err)}`);
      return sections;
    }

    const visible = entries
      .filter((entry) => entry.auto === true && typeof entry.file === 'string' && entry.file.length > 0)
      .filter((entry) => existsSync(join(this.root, entry.file)))
      .slice(-this.maxPromptEntries);

    if (visible.length === 0) return sections;

    sections.push({
      name: 'qqbot:sticker-catalog',
      order: 92,
      text: [
        '【自动收藏的表情】',
        `路径前缀：${this.root}`,
        `情绪=文件：${visible.map((entry) => `${entry.emotion}=${entry.file}`).join(' ')}`,
        '一次最多发 1 张；先文字后图片，别刷屏。',
      ].join('\n'),
    });
    return sections;
  }

  /** 读取并校验 index.json；缺失时返回空数组 */
  private readIndex(): StickerIndexEntry[] {
    if (!existsSync(this.indexPath)) return [];
    const raw = readFileSync(this.indexPath, 'utf8').trim();
    if (raw.length === 0) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('index.json 顶层必须是数组');
    return parsed as StickerIndexEntry[];
  }

  /** 原子写回索引：临时文件 + rename，避免半截 JSON */
  private writeIndex(entries: StickerIndexEntry[]): void {
    mkdirSync(this.root, { recursive: true });
    const tmp = `${this.indexPath}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, `${JSON.stringify(entries, null, 2)}\n`, 'utf8');
    try {
      renameSync(tmp, this.indexPath);
    } catch (err) {
      // Windows 上目标被占用时 rename 可能失败：退回覆盖写并清理临时文件
      try {
        writeFileSync(this.indexPath, readFileSync(tmp));
      } finally {
        try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
      }
      this.logger?.warn(`im-qqbot: 索引原子替换失败，已回退写入: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 旧条目没有 sha256 时惰性补齐（只读文件，缺失文件跳过） */
  private backfillHashes(entries: StickerIndexEntry[]): void {
    let changed = false;
    for (const entry of entries) {
      if (typeof entry.file !== 'string' || entry.file.length === 0) continue;
      if (typeof entry.sha256 === 'string' && entry.sha256.length > 0) continue;
      const path = join(this.root, entry.file);
      if (!existsSync(path)) continue;
      try {
        entry.sha256 = hashFile(path);
        if (typeof entry.bytes !== 'number') entry.bytes = statSync(path).size;
        changed = true;
      } catch {
        // 单个旧文件不可读不影响新收藏
      }
    }
    if (changed) this.writeIndex(entries);
  }

  /** 选择不覆盖已有文件的名字 */
  private pickFileName(preferred: string | undefined, emotion: string, sourceExt: string): string {
    let stem: string;
    let ext = sourceExt;

    if (preferred !== undefined && preferred.trim() !== '') {
      const requested = preferred.trim();
      if (/[\\/:*?"<>|]/.test(requested)) throw new Error(`file 不能包含路径或非法字符: ${requested}`);
      const requestedExt = extname(requested).toLowerCase();
      if (requestedExt !== '') {
        if (!IMAGE_EXTS.has(requestedExt)) throw new Error(`file 扩展名不支持: ${requestedExt}`);
        ext = requestedExt;
        stem = safeStem(requested.slice(0, -requestedExt.length));
      } else {
        stem = safeStem(requested);
      }
    } else {
      stem = `fish_${safeStem(emotion)}`;
    }

    let candidate = `${stem}${ext}`;
    let index = 2;
    while (existsSync(join(this.root, candidate))) {
      candidate = `${stem}_${index}${ext}`;
      index += 1;
      if (index > 999) throw new Error('同名文件过多，无法生成唯一文件名');
    }
    return candidate;
  }
}
