/**
 * 按 tag 取一张 booru 图并落地（qqbot_booru_fetch 的实现）。
 *
 * 为什么走 safebooru 而不是 danbooru：danbooru 的 API 和 cdn 对这台机器的出口都走
 * Cloudflare 质询，直连、系统代理都是 403（只有宿主的 web_fetch 走云端才通）；safebooru
 * 是同一套 tag 语法的镜像站，搜索和原图都通，同一个 post 的图字节完全一致。
 *
 * 落地文件名用 `yuri-<id>.<ext>`：send-file 的发送回调靠这个命名认出候选图并记为已发
 * （见 seen.ts 的 markSentCandidate），所以工具本身不需要「标记已发」这一步。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HttpGet } from './http.ts';
import { hasBlockedTag, isLargeEnough } from './types.ts';

/** safebooru 的 JSON API（danbooru 1.x 的镜像，tag 语法与 danbooru 相同） */
export const BOORU_API = 'https://safebooru.org/index.php?page=dapi&s=post&q=index&json=1';

const PAGE_LIMIT = 100;
/** random 模式最多随机翻到第几页 */
const RANDOM_MAX_PAGE = 8;
/** random 模式最多抽几轮（都撞已发就放弃） */
const RANDOM_ATTEMPTS = 5;
/** tag 串最长多少字符，挡掉把整段 prompt 塞进来的调用 */
const MAX_TAGS_LENGTH = 300;
/** 小于这个字节数的多半是错误页/占位图 */
const MIN_BYTES = 50_000;

export type BooruFetchMode = 'latest' | 'random';

/** safebooru post 里用到的字段 */
export interface BooruPostRow {
  id?: number | string;
  width?: number | string;
  height?: number | string;
  tags?: string;
  source?: string;
  sample_url?: string;
  file_url?: string;
  hash?: string;
  rating?: string;
}

export interface BooruFetchSuccess {
  ok: true;
  id: string;
  /** 落地的本地绝对路径，直接喂给 qqbot_send_file */
  path: string;
  ext: string;
  bytes: number;
  width: number;
  height: number;
  pageUrl: string;
  sourceUrl?: string;
  /** 推特来源时解出的画师账号 */
  author?: string;
  tags: string[];
}

export interface BooruFetchFailure {
  ok: false;
  reason: string;
}

export type BooruFetchResult = BooruFetchSuccess | BooruFetchFailure;

/** 规范化 tag 串：压空白、去首尾、限长；空串返回 undefined */
export function sanitizeTags(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const tags = raw.replace(/\s+/g, ' ').trim();
  if (tags === '' || tags.length > MAX_TAGS_LENGTH) return undefined;
  return tags;
}

export function booruPageUrl(id: string): string {
  return `https://safebooru.org/index.php?page=post&s=view&id=${id}`;
}

/** 没 id / 没图 / 太小 / 命中屏蔽 tag 的不要 */
export function acceptBooruRow(row: BooruPostRow | undefined, minEdge = 800): boolean {
  if (!row || !row.id || !(row.file_url || row.sample_url)) return false;
  if (row.rating !== undefined && row.rating !== 'general' && row.rating !== 'sensitive') return false;
  if (!isLargeEnough(Number(row.width), Number(row.height), minEdge)) return false;
  const tags = String(row.tags ?? '').split(/\s+/).filter(Boolean);
  return !hasBlockedTag(tags);
}

export function parseBooruRows(body: Buffer): BooruPostRow[] {
  const text = body.toString('utf8').trim();
  if (text === '') return [];
  try {
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed) ? parsed as BooruPostRow[] : [];
  } catch {
    return [];
  }
}

async function queryPage(get: HttpGet, tags: string, pid: number, limit = PAGE_LIMIT): Promise<BooruPostRow[]> {
  const url = `${BOORU_API}&tags=${encodeURIComponent(tags)}&limit=${limit}&pid=${pid}`;
  const res = await get(url);
  if (res.status !== 200) throw new Error(`booru HTTP ${res.status}`);
  return parseBooruRows(res.body);
}

export interface PickBooruOptions {
  tags: string;
  mode: BooruFetchMode;
  /** 已发过的 post id */
  seen: ReadonlySet<string>;
  minEdge?: number;
  random?: () => number;
}

/** 抽一条可发的 post：latest 取最新未发过的，random 随机翻阅 */
export async function pickBooruPost(
  get: HttpGet,
  opts: PickBooruOptions,
): Promise<{ row: BooruPostRow; attempts: number } | undefined> {
  const random = opts.random ?? Math.random;
  const minEdge = opts.minEdge ?? 800;
  const usable = (row: BooruPostRow): boolean =>
    !opts.seen.has(String(row.id)) && acceptBooruRow(row, minEdge);

  if (opts.mode === 'latest') {
    const rows = await queryPage(get, opts.tags, 0);
    const hit = rows
      .filter(usable)
      .sort((a, b) => Number(b.id) - Number(a.id))[0];
    return hit === undefined ? undefined : { row: hit, attempts: 1 };
  }

  for (let attempt = 1; attempt <= RANDOM_ATTEMPTS; attempt += 1) {
    const rows = await queryPage(get, opts.tags, Math.floor(random() * RANDOM_MAX_PAGE));
    const pool = rows.filter(usable);
    if (pool.length > 0) return { row: pool[Math.floor(random() * pool.length)]!, attempts: attempt };
  }
  return undefined;
}

/** 按文件头认图片类型；JPEG / PNG 之外的不发（webp 在部分客户端显示不稳） */
export function sniffImageExt(bytes: Buffer): 'jpg' | 'png' | undefined {
  if (bytes.length < 8) return undefined;
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  return undefined;
}

/** 从 source 链接里认画师（只有推特来源认得出来，pixiv 的作品页没有账号） */
export function authorFromSource(source: string | undefined): string | undefined {
  if (!source) return undefined;
  return /(?:twitter|x)\.com\/([A-Za-z0-9_]+)\//.exec(source)?.[1];
}

export interface FetchBooruDeps {
  get: HttpGet;
  /** 候选图落地目录（send-file 的已发标记只认这个目录里的候选图） */
  candidatesDir: string;
  seen?: ReadonlySet<string>;
  minEdge?: number;
  random?: () => number;
}

export interface FetchBooruRequest {
  tags: string;
  mode: BooruFetchMode;
}

/** 搜索 + 下载 + 校验 + 落地，一条龙 */
export async function fetchBooruImage(req: FetchBooruRequest, deps: FetchBooruDeps): Promise<BooruFetchResult> {
  const picked = await pickBooruPost(deps.get, {
    tags: req.tags,
    mode: req.mode,
    seen: deps.seen ?? new Set<string>(),
    ...(deps.minEdge === undefined ? {} : { minEdge: deps.minEdge }),
    ...(deps.random === undefined ? {} : { random: deps.random }),
  });
  if (picked === undefined) {
    return { ok: false, reason: req.mode === 'latest' ? '这个 tag 没有未发过的新图' : `${RANDOM_ATTEMPTS} 轮都抽到已发过的图` };
  }

  const { row } = picked;
  const id = String(row.id);
  const imageUrl = row.file_url ?? row.sample_url!;
  let bytes: Buffer;
  try {
    const res = await deps.get(imageUrl);
    if (res.status !== 200) return { ok: false, reason: `下载 HTTP ${res.status}（id ${id}）` };
    bytes = res.body;
  } catch (err) {
    return { ok: false, reason: `下载失败（id ${id}）：${err instanceof Error ? err.message : String(err)}` };
  }

  const ext = sniffImageExt(bytes);
  if (ext === undefined) return { ok: false, reason: `不是 JPEG/PNG（id ${id}）` };
  if (bytes.length < MIN_BYTES) return { ok: false, reason: `文件只有 ${bytes.length} 字节，疑似错误页（id ${id}）` };

  const path = join(deps.candidatesDir, `yuri-${id}.${ext}`);
  mkdirSync(deps.candidatesDir, { recursive: true });
  writeFileSync(path, bytes);

  const source = typeof row.source === 'string' && /^https?:\/\//.test(row.source) ? row.source : undefined;
  const author = authorFromSource(source);
  return {
    ok: true,
    id,
    path,
    ext,
    bytes: bytes.length,
    width: Number(row.width) || 0,
    height: Number(row.height) || 0,
    pageUrl: booruPageUrl(id),
    ...(source === undefined ? {} : { sourceUrl: source }),
    ...(author === undefined ? {} : { author }),
    tags: String(row.tags ?? '').split(/\s+/).filter(Boolean),
  };
}
