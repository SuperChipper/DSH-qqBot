/**
 * 共享笔记库 — 把一个目录下的 Markdown 笔记当作跨会话共享的长期记忆。
 *
 *   - 按标题（#/##/###）把每个 .md 切成小段，一段就是一个检索单元；
 *   - 中文按二字切词（bigram）、英文/数字按词，BM25 打分，不依赖向量服务；
 *   - BM25 之外再走一路字面精确匹配（专有名词、引号原文、别名、编号），可选再加一路向量语义相似度，
 *     多路 RRF 融合后取 top-k；
 *   - 目录有改动（文件增删、mtime/大小变化）时自动重建索引，人手改笔记也能立即生效；
 *   - save 只写到笔记根目录下，按标题建文件或追加小节；
 *   - `chats/<会话键>/` 下是只属于某个群/私聊的笔记（如某个群的跑团进度），只有那个会话检索得到，
 *     避免别的群的存档混进来。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { basename, extname, join, relative } from 'node:path';
import type { Logger } from '../types.ts';
import { EXACT_STRONG_SCORE, scoreExact, type ExactScore } from '../features/exact-match.ts';
import { fuseRankings, gateSimilarities, type SemanticGate } from '../features/rank-fusion.ts';
import type { EmbeddingCache } from './embedding.ts';

/** 单个笔记文件大小上限：更大的文件跳过，避免把日志之类的东西误当笔记 */
const MAX_FILE_BYTES = 512 * 1024;
/** 最多索引的文件数 */
const MAX_FILES = 500;
/** 递归深度上限 */
const MAX_DEPTH = 3;
/** 单段最大字符数：超出按段落再切 */
const MAX_CHUNK_CHARS = 1200;
/** 两次扫描目录的最小间隔(ms) */
const RESCAN_INTERVAL_MS = 3000;
/** 单次 save 的内容上限 */
const MAX_SAVE_CHARS = 8000;

/** 会话私有笔记的子目录：chats/<会话键>/xxx.md */
const CHAT_NOTES_DIR = 'chats';

const BM25_K1 = 1.2;
/** 长度归一化放轻（常见取 0.75）：笔记段都很短，否则「待办」这类短段会压过真正讲这件事的段 */
const BM25_B = 0.3;
/** 参与融合的粗检索名次上限：再往后的段只有被精确一路捞到才有机会进结果 */
const COARSE_POOL = 50;

export interface NoteChunk {
  /** 相对笔记根目录的路径（posix 分隔符） */
  file: string;
  /** 标题路径，如「大肥鱼小课堂 › 一、逐集笔记 › 04 …」 */
  heading: string;
  text: string;
}

export interface NoteHit extends NoteChunk {
  score: number;
  /** 命中的不同查询词个数 */
  matched: number;
  /**
   * 命中的查询词占比（0-1），用于判断是否值得自动注入。
   * 分母只算笔记库里出现过的查询词：「你还记得…吗」这类口语虚词组合不拉低覆盖率。
   */
  coverage: number;
  /** 字面精确命中（引号原文/别名/编号/专有名词）；没有精确命中时缺省 */
  exact?: ExactScore;
  /** 与查询的余弦相似度；只有过了语义门槛才有，语义检索没开或没过门槛时缺省 */
  similarity?: number;
}

export interface SaveNoteInput {
  title: string;
  content: string;
  /** 目标文件名（只取 basename）；缺省按标题建文件 */
  file?: string;
  /** 来源描述，如「群聊」「私聊」 */
  source?: string;
  /** 会话键：给了就写进 chats/<会话键>/，只有这个会话检索得到 */
  chatKey?: string;
}

export interface SaveNoteResult {
  file: string;
  created: boolean;
  chars: number;
  message: string;
}

interface IndexedChunk extends NoteChunk {
  terms: Map<string, number>;
  length: number;
}

/**
 * 切词：中日文连续片段取二字组（单字片段保留单字），英文/数字取整词（小写）。
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const normalized = text.normalize('NFKC').toLowerCase();
  for (const match of normalized.matchAll(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+|[a-z0-9_]+/gu)) {
    const run = match[0];
    if (/^[a-z0-9_]+$/.test(run)) {
      if (run.length >= 2 || /\d/.test(run)) tokens.push(run);
      continue;
    }
    if (run.length === 1) {
      tokens.push(run);
      continue;
    }
    for (let i = 0; i < run.length - 1; i++) tokens.push(run.slice(i, i + 2));
  }
  return tokens;
}

/** 参与检索/算向量的全文：标题路径 + 正文 */
function embeddingText(chunk: NoteChunk): string {
  return `${chunk.heading}\n${chunk.text}`;
}

function countTerms(tokens: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  return counts;
}

/** 把超长段按空行再切，保证每段不超过 MAX_CHUNK_CHARS */
function splitLong(text: string): string[] {
  if (text.length <= MAX_CHUNK_CHARS) return [text];
  const parts: string[] = [];
  let current = '';
  for (const paragraph of text.split(/\n\s*\n/)) {
    if (current.length > 0 && current.length + paragraph.length + 2 > MAX_CHUNK_CHARS) {
      parts.push(current);
      current = '';
    }
    current = current.length > 0 ? `${current}\n\n${paragraph}` : paragraph;
    while (current.length > MAX_CHUNK_CHARS) {
      parts.push(current.slice(0, MAX_CHUNK_CHARS));
      current = current.slice(MAX_CHUNK_CHARS);
    }
  }
  if (current.trim().length > 0) parts.push(current);
  return parts;
}

/**
 * 按标题把一篇 Markdown 切成段。# / ## / ### 开新段，更深的标题并入当前段。
 * 标题路径作为段的上下文，同时参与检索。
 */
export function chunkMarkdown(file: string, markdown: string): NoteChunk[] {
  const fallbackTitle = basename(file, extname(file));
  const stack: string[] = [];
  const chunks: NoteChunk[] = [];
  let body: string[] = [];

  const flush = (): void => {
    const text = body.join('\n').trim();
    body = [];
    if (text.length === 0) return;
    const heading = stack.length > 0 ? stack.join(' › ') : fallbackTitle;
    for (const part of splitLong(text)) chunks.push({ file, heading, text: part.trim() });
  };

  for (const line of markdown.split(/\r?\n/)) {
    const match = /^(#{1,3})\s+(.+?)\s*#*\s*$/.exec(line);
    if (match === null) {
      body.push(line);
      continue;
    }
    flush();
    const level = match[1]!.length;
    stack.length = Math.min(stack.length, level - 1);
    stack[level - 1] = match[2]!;
    // 标题跳级（# 后直接 ###）时补齐中间层，避免 join 出 undefined
    for (let i = 0; i < level - 1; i++) stack[i] ??= fallbackTitle;
  }
  flush();
  return chunks;
}

/** 文件名净化：去路径与非法字符，补 .md 扩展名 */
function sanitizeNoteFileName(name: string): string {
  const base = basename(name.replace(/\\/g, '/'))
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  const safe = base.length > 0 && base !== '.' && base !== '..' ? base : 'note';
  return extname(safe).toLowerCase() === '.md' ? safe : `${safe}.md`;
}

/** 会话键 → 目录名，如 group:ABC → group_ABC */
export function chatNotesDir(chatKey: string): string {
  return chatKey.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) || 'unknown';
}

/** QQ 会话的笔记会话键 */
export function chatKeyOf(scope: string, peerId: string): string {
  return `${scope}_${peerId}`;
}

/** 这段笔记属于哪个会话；共享笔记返回 undefined */
function chatOwnerOf(file: string): string | undefined {
  const parts = file.split('/');
  return parts.length >= 3 && parts[0] === CHAT_NOTES_DIR ? parts[1] : undefined;
}

/**
 * 当前会话能不能看到这段笔记：共享笔记都能看；会话私有笔记只有本会话能看。
 * chatKey 为 undefined 表示本机会话（主人自己），全部可见。
 */
function visibleTo(file: string, chatKey: string | undefined): boolean {
  if (chatKey === undefined) return true;
  const owner = chatOwnerOf(file);
  return owner === undefined || owner === chatNotesDir(chatKey);
}

function today(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export class NotesStore {
  public readonly root: string;
  private readonly logger: Logger | undefined;
  private chunks: IndexedChunk[] = [];
  private docFreq = new Map<string, number>();
  private avgLength = 0;
  private signature = '';
  private lastScan = 0;
  private semantic: { cache: EmbeddingCache; gate: SemanticGate } | undefined;

  public constructor(root: string, logger?: Logger) {
    this.root = root;
    this.logger = logger;
  }

  /** 当前索引的段数（测试/日志用） */
  public get size(): number {
    this.refresh();
    return this.chunks.length;
  }

  /** 挂上语义检索（向量缓存 + 相似度门槛）；传 undefined 关闭 */
  public setSemantic(cache: EmbeddingCache | undefined, gate: SemanticGate = { minSimilarity: 0.5, minMargin: 0.16 }): void {
    this.semantic = cache === undefined ? undefined : { cache, gate };
    if (cache === undefined) return;
    this.refresh();
    void cache.warm(this.chunks.map(embeddingText));
  }

  /**
   * 检索最相关的 limit 段（BM25 + 字面精确匹配）。查询为空或没有任何命中时返回空数组。
   * 给了 chatKey 时，别的会话的私有笔记（chats/<别的会话>/）不参与检索。
   */
  public search(query: string, limit = 5, chatKey?: string): NoteHit[] {
    this.refresh();
    return this.rank(query, limit, (file) => visibleTo(file, chatKey));
  }

  /**
   * 同 search，再加向量语义一路。没挂语义检索、接口失败或超时时等同于 search。
   * 笔记向量在后台补算，还没算好的段这一轮只是不参与语义一路。
   * sharedOnly：只检索共享笔记，跳过所有会话私有笔记（开团时本群的跑团笔记交给团况注入，不走自动召回）。
   */
  public async searchHybrid(query: string, limit = 5, chatKey?: string, options: { sharedOnly?: boolean } = {}): Promise<NoteHit[]> {
    this.refresh();
    const visible = options.sharedOnly === true
      ? (file: string): boolean => chatOwnerOf(file) === undefined
      : (file: string): boolean => visibleTo(file, chatKey);
    const semantic = this.semantic;
    if (semantic === undefined || this.chunks.length === 0) return this.rank(query, limit, visible);
    void semantic.cache.warm(this.chunks.map(embeddingText));
    const queryVector = await semantic.cache.embedQuery(query);
    if (queryVector === undefined) return this.rank(query, limit, visible);

    const vectors: Array<{ id: string; vector: Float32Array }> = [];
    this.chunks.forEach((chunk, index) => {
      if (!visible(chunk.file)) return;
      const vector = semantic.cache.vectorFor(embeddingText(chunk));
      if (vector !== undefined) vectors.push({ id: String(index), vector });
    });
    return this.rank(query, limit, visible, gateSimilarities(queryVector, vectors, semantic.gate));
  }

  /** 会话私有笔记的标题（每个文件的一级标题，没有就用文件名），给团况注入列个目录 */
  public chatNoteTitles(chatKey: string): string[] {
    this.refresh();
    const dir = chatNotesDir(chatKey);
    const titles = new Map<string, string>();
    for (const chunk of this.chunks) {
      if (chatOwnerOf(chunk.file) !== dir || titles.has(chunk.file)) continue;
      titles.set(chunk.file, chunk.heading.split(' › ')[0]!);
    }
    return [...titles.values()];
  }

  /** BM25 粗检索 + 字面精确 + （可选）语义相似度，三路 RRF 融合 */
  private rank(query: string, limit: number, visible: (file: string) => boolean, similarity?: ReadonlyMap<string, number>): NoteHit[] {
    const queryTerms = [...new Set(tokenize(query))];
    if ((queryTerms.length === 0 && (similarity?.size ?? 0) === 0) || this.chunks.length === 0) return [];

    const total = this.chunks.length;
    const knownTerms = queryTerms.filter((term) => this.docFreq.has(term)).length;
    const candidates: Array<NoteHit & { id: string; terms: Map<string, number> }> = [];
    this.chunks.forEach((chunk, index) => {
      if (!visible(chunk.file)) return;
      let score = 0;
      let matched = 0;
      for (const term of queryTerms) {
        const tf = chunk.terms.get(term);
        if (tf === undefined) continue;
        matched++;
        const df = this.docFreq.get(term) ?? 0;
        const idf = Math.log(1 + (total - df + 0.5) / (df + 0.5));
        const norm = BM25_K1 * (1 - BM25_B + BM25_B * (chunk.length / (this.avgLength || 1)));
        score += idf * ((tf * (BM25_K1 + 1)) / (tf + norm));
      }
      candidates.push({
        id: String(index),
        terms: chunk.terms,
        file: chunk.file,
        heading: chunk.heading,
        text: chunk.text,
        score,
        matched,
        coverage: matched / (knownTerms || 1),
      });
    });
    const hits = candidates.filter((c) => c.matched > 0).sort((a, b) => b.score - a.score);

    // 精确一路扫全部 BM25 命中段而不是只扫粗检索前几名：字面量的切词必然也是 BM25 词，
    // 含有它的段一定在 hits 里，这样被粗检索截断的段也能被捞回来
    const exact = scoreExact(
      query,
      hits.map((hit) => ({ id: hit.id, text: embeddingText(hit), terms: hit.terms })),
      candidates.length,
    );
    // 语义一路从全部可见段里召回：同义/换说法的段可能一个词都没和查询撞上
    const fused = fuseRankings(hits.slice(0, COARSE_POOL), (hit) => hit.id, { exact, semantic: similarity, extra: candidates });

    // 同一段内容被复制到多个文件时只留排名最高的一份
    const seenText = new Set<string>();
    const result: NoteHit[] = [];
    for (const { item, exact: exactScore, similarity: sim } of fused) {
      if (result.length >= Math.max(0, limit)) break;
      const key = item.text.replace(/\s+/g, ' ').trim();
      if (seenText.has(key)) continue;
      seenText.add(key);
      const { id: _id, terms: _terms, ...hit } = item;
      result.push({
        ...hit,
        ...(exactScore === undefined ? {} : { exact: exactScore }),
        ...(sim === undefined ? {} : { similarity: sim }),
      });
    }
    return result;
  }

  /** 写入一条笔记：新标题建文件，指定已有文件则追加为一个小节 */
  public save(input: SaveNoteInput): SaveNoteResult {
    const title = input.title.replace(/\s+/g, ' ').trim().slice(0, 80);
    const content = input.content.trim();
    if (title.length === 0) throw new Error('笔记标题不能为空');
    if (content.length === 0) throw new Error('笔记内容不能为空');
    if (content.length > MAX_SAVE_CHARS) throw new Error(`笔记内容过长（${content.length} 字，上限 ${MAX_SAVE_CHARS}）`);

    const dir = input.chatKey === undefined ? this.root : join(this.root, CHAT_NOTES_DIR, chatNotesDir(input.chatKey));
    mkdirSync(dir, { recursive: true });
    const fileName = sanitizeNoteFileName(input.file ?? title);
    const path = join(dir, fileName);
    const shownName = input.chatKey === undefined ? fileName : `${CHAT_NOTES_DIR}/${chatNotesDir(input.chatKey)}/${fileName}`;
    const meta = `> 记录于 ${today()}${input.source ? ` · 来源：${input.source}` : ''}`;
    const created = !existsSync(path);

    if (created) {
      writeFileSync(path, `# ${title}\n\n${meta}\n\n${content}\n`, 'utf8');
    } else {
      appendFileSync(path, `\n## ${title}\n\n${meta}\n\n${content}\n`, 'utf8');
    }
    this.lastScan = 0; // 下次检索立即重建索引

    this.logger?.info(`im-qqbot: 笔记${created ? '新建' : '追加'} ${shownName}（${content.length} 字）`);
    const audience = input.chatKey === undefined ? '所有会话' : '只有本会话';
    return {
      file: fileName,
      created,
      chars: content.length,
      message: `${created ? '已新建笔记' : '已追加到笔记'} ${fileName}「${title}」（${content.length} 字），${audience}下次检索即可用。`,
    };
  }

  /** 目录有变化时重建索引（节流） */
  private refresh(): void {
    const now = Date.now();
    if (now - this.lastScan < RESCAN_INTERVAL_MS) return;
    this.lastScan = now;

    const files = this.listFiles();
    const signature = files.map((f) => `${f.rel}:${f.mtimeMs}:${f.size}`).join('|');
    if (signature === this.signature) return;
    this.signature = signature;

    const chunks: IndexedChunk[] = [];
    for (const file of files) {
      let markdown: string;
      try {
        markdown = readFileSync(file.abs, 'utf8');
      } catch {
        continue;
      }
      for (const chunk of chunkMarkdown(file.rel, markdown)) {
        const tokens = tokenize(`${chunk.heading}\n${chunk.text}`);
        chunks.push({ ...chunk, terms: countTerms(tokens), length: tokens.length });
      }
    }

    const docFreq = new Map<string, number>();
    let totalLength = 0;
    for (const chunk of chunks) {
      totalLength += chunk.length;
      for (const term of chunk.terms.keys()) docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
    }
    this.chunks = chunks;
    this.docFreq = docFreq;
    this.avgLength = chunks.length > 0 ? totalLength / chunks.length : 0;
    this.logger?.debug(`im-qqbot: 笔记索引重建 files=${files.length} chunks=${chunks.length}`);
  }

  private listFiles(): Array<{ abs: string; rel: string; mtimeMs: number; size: number }> {
    const result: Array<{ abs: string; rel: string; mtimeMs: number; size: number }> = [];
    if (!existsSync(this.root)) return result;

    const walk = (dir: string, depth: number): void => {
      if (depth > MAX_DEPTH || result.length >= MAX_FILES) return;
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (result.length >= MAX_FILES) return;
        if (entry.name.startsWith('.')) continue;
        const abs = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(abs, depth + 1);
        } else if (entry.isFile() && extname(entry.name).toLowerCase() === '.md') {
          try {
            const info = statSync(abs);
            if (info.size > MAX_FILE_BYTES) continue;
            result.push({ abs, rel: relative(this.root, abs).split('\\').join('/'), mtimeMs: info.mtimeMs, size: info.size });
          } catch {
            /* 文件刚被删掉之类，跳过 */
          }
        }
      }
    };
    walk(this.root, 0);
    return result;
  }
}

/** 自动注入至少要命中的不同查询词数：「哈哈」「随便」这类只撞上一个词的短消息不注入 */
const INJECT_MIN_MATCHED_TERMS = 2;

/**
 * 把检索结果格式化成注入到用户消息前的提示块；没有足够相关的结果返回空串。
 */
export function formatNotesHint(
  hits: readonly NoteHit[],
  options: { topK: number; maxChars: number; minCoverage: number },
): string {
  const relevant = hits
    .filter((hit) =>
      (hit.coverage >= options.minCoverage && hit.matched >= INJECT_MIN_MATCHED_TERMS)
      // 引号原文/别名/编号这类强字面命中，即便查询里闲聊词多、覆盖率被拉低也值得注入
      || (hit.exact?.score ?? 0) >= EXACT_STRONG_SCORE
      // 带 similarity 说明已过语义门槛：同义/换说法的段一个词都没撞上，覆盖率为 0，只能靠这一条进来
      || hit.similarity !== undefined)
    .slice(0, options.topK);
  if (relevant.length === 0) return '';

  const perHit = Math.max(80, Math.floor(options.maxChars / relevant.length));
  const lines = ['[共享笔记 · 可能相关]'];
  for (const hit of relevant) {
    const text = hit.text.replace(/\s+/g, ' ').trim();
    const owner = chatOwnerOf(hit.file);
    const name = owner === undefined ? hit.file : `[本会话] ${hit.file.split('/').slice(2).join('/')}`;
    lines.push(`- ${name} › ${hit.heading}`);
    lines.push(`  ${text.length > perHit ? `${text.slice(0, perHit)}…` : text}`);
  }
  lines.push('（来自笔记库，仅供参考；不带 [本会话] 的是所有群共享的笔记，不是这个群发生过的事。和当前话题无关就忽略；要看更多用 qqbot_notes_search。）');
  return lines.join('\n');
}
