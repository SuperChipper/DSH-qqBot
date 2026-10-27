/**
 * 搜图主流程：并发搜多个源 × 多个 CP → 查人气 → 去重挑选 → 并发下载 → 拼对比图。
 *
 * 只下载被选中的几张（外加两张备用，防下载失败），不在这里记 seen：
 * 发出去的那张由 qqbot_send_file 成功后回调记录。
 */
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { searchBooru } from './booru.ts';
import { buildContactSheet } from './contact-sheet.ts';
import type { HttpGet } from './http.ts';
import { pickDiverse, trimForEnrichment } from './picker.ts';
import { fetchPixivDetail, searchPixivCp } from './pixiv.ts';
import { candidateFileName, type FanartSeenStore } from './seen.ts';
import type { BooruPoolEntry, FanartCandidate, PixivPoolEntry } from './types.ts';

export type PickSourceMode = 'mix' | 'pixiv' | 'booru';

export interface PickOptions {
  count: number;
  cp?: string;
  source: PickSourceMode;
  /** booru 不抽随机百合池，只搜 CP 池 */
  cpOnly: boolean;
}

export interface PickDeps {
  get: HttpGet;
  seen: FanartSeenStore;
  pixivPool: readonly PixivPoolEntry[];
  booruPool: readonly BooruPoolEntry[];
  /** 候选图和对比图落盘目录 */
  candidatesDir: string;
  random?: () => number;
}

export interface PickedCandidate {
  index: number;
  path: string;
  source: FanartCandidate['source'];
  cp?: string;
  author?: string;
  title?: string;
  width: number;
  height: number;
  bookmarks?: number;
  pageUrl: string;
}

export interface PickResult {
  candidates: PickedCandidate[];
  sheetPath?: string;
  /** 各个查询/下载的失败原因（给模型判断要不要换源重试） */
  failures: string[];
}

/** 不指定 CP 时，每个源抽几个 CP 并发搜 */
const PIXIV_CPS_PER_RUN = 3;
const BOORU_CPS_PER_RUN = 2;
/** 多下载几张备用，个别下载失败也能凑够 count */
const SPARE_DOWNLOADS = 2;
const DETAIL_CONCURRENCY = 6;
const MIN_IMAGE_BYTES = 20_000;

/** 读 JSON 池文件；读不了返回空数组 */
export function loadPool<T>(file: string, valid: (e: T) => boolean): T[] {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return Array.isArray(data) ? (data as T[]).filter((e) => e && valid(e)) : [];
  } catch {
    return [];
  }
}

function shuffle<T>(list: readonly T[], random: () => number): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

interface Query {
  label: string;
  run: () => Promise<FanartCandidate[]>;
}

function buildQueries(opts: PickOptions, deps: PickDeps, random: () => number): Query[] | string {
  const pixivSeen = deps.seen.load('pixiv');
  const booruSeen = deps.seen.load('booru');
  const usePixiv = opts.source !== 'booru';
  const useBooru = opts.source !== 'pixiv';
  const queries: Query[] = [];

  const pixivQuery = (e: PixivPoolEntry): Query => ({
    label: `pixiv「${e.name}」`,
    run: () => searchPixivCp(deps.get, e, pixivSeen, random),
  });
  const booruQuery = (e: BooruPoolEntry | undefined): Query => ({
    label: e ? `booru「${e.name}」` : 'booru 随机百合',
    run: () => searchBooru(deps.get, e, booruSeen, random),
  });

  if (opts.cp) {
    const pixivHit = usePixiv ? deps.pixivPool.find((e) => e.name === opts.cp) : undefined;
    const booruHit = useBooru ? deps.booruPool.find((e) => e.name === opts.cp) : undefined;
    if (!pixivHit && !booruHit) {
      const names = [...new Set([...deps.pixivPool, ...deps.booruPool].map((e) => e.name))];
      return `CP 池里没有「${opts.cp}」，可选：${names.join('、')}`;
    }
    if (pixivHit) queries.push(pixivQuery(pixivHit));
    if (booruHit) queries.push(booruQuery(booruHit));
    return queries;
  }

  if (usePixiv) {
    for (const e of shuffle(deps.pixivPool, random).slice(0, PIXIV_CPS_PER_RUN)) queries.push(pixivQuery(e));
  }
  if (useBooru) {
    for (const e of shuffle(deps.booruPool, random).slice(0, BOORU_CPS_PER_RUN)) queries.push(booruQuery(e));
    if (!opts.cpOnly) queries.push(booruQuery(undefined));
  }
  if (queries.length === 0) return 'CP 池是空的（scripts/pixiv-tags.json / fanart-tags.json）';
  return queries;
}

/** 查 pixiv 详情补人气、画师和图片地址；pixiv 候选拿不到图片地址就丢掉 */
async function enrich(get: HttpGet, list: FanartCandidate[], failures: string[]): Promise<FanartCandidate[]> {
  let detailErrors = 0;
  const enriched = await mapLimit(list, DETAIL_CONCURRENCY, async (c) => {
    if (c.pixivId === undefined) return c;
    try {
      const detail = await fetchPixivDetail(get, c.pixivId);
      return {
        ...c,
        bookmarks: detail.bookmarks,
        author: c.author ?? detail.author,
        imageUrl: c.imageUrl ?? detail.imageUrl,
      };
    } catch {
      detailErrors++;
      return c;
    }
  });
  if (detailErrors > 0) failures.push(`pixiv 详情 ${detailErrors} 次失败`);
  return enriched.filter((c) => c.imageUrl !== undefined);
}

/** booru 帖子和 pixiv 候选是同一幅作品时只留 pixiv 那条；已发过的 pixiv 作品经 booru 转载的也剔除 */
function dropCrossSourceDuplicates(list: FanartCandidate[], pixivSeen: ReadonlySet<string>): FanartCandidate[] {
  const pixivIds = new Set(list.filter((c) => c.source === 'pixiv').map((c) => c.id));
  return list.filter((c) => c.source === 'pixiv'
    || c.pixivId === undefined
    || (!pixivIds.has(c.pixivId) && !pixivSeen.has(c.pixivId)));
}

async function download(get: HttpGet, c: FanartCandidate, dir: string): Promise<string> {
  const res = await get(c.imageUrl!, c.referer ? { Referer: c.referer } : {});
  if (res.status !== 200 || res.body.length < MIN_IMAGE_BYTES) {
    throw new Error(`HTTP ${res.status} / ${res.body.length}B`);
  }
  const ext = (extname(new URL(c.imageUrl!).pathname) || '.jpg').toLowerCase();
  const file = join(dir, candidateFileName(c.source, c.id, ext));
  await writeFile(file, res.body);
  return file;
}

export async function pickFanart(opts: PickOptions, deps: PickDeps): Promise<PickResult> {
  const random = deps.random ?? Math.random;
  const failures: string[] = [];
  const queries = buildQueries(opts, deps, random);
  if (typeof queries === 'string') return { candidates: [], failures: [queries] };

  const settled = await Promise.allSettled(queries.map((q) => q.run()));
  const trimmed: FanartCandidate[] = [];
  settled.forEach((r, i) => {
    const label = queries[i]!.label;
    if (r.status === 'rejected') {
      failures.push(`${label}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
    } else if (r.value.length === 0) {
      failures.push(`${label}: 没有可用的图（都发过或被过滤）`);
    } else {
      trimmed.push(...trimForEnrichment(r.value, random));
    }
  });

  const pool = dropCrossSourceDuplicates(await enrich(deps.get, trimmed, failures), deps.seen.load('pixiv'));
  const chosen = pickDiverse(pool, opts.count + SPARE_DOWNLOADS, random);

  await mkdir(deps.candidatesDir, { recursive: true });
  const downloaded = await Promise.all(chosen.map(async (c) => {
    try {
      return { c, path: await download(deps.get, c, deps.candidatesDir) };
    } catch (err) {
      failures.push(`下载 ${c.source}-${c.id}: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }));
  const ok = downloaded.filter((d) => d !== undefined).slice(0, opts.count);

  const candidates: PickedCandidate[] = ok.map(({ c, path }, i) => ({
    index: i + 1,
    path,
    source: c.source,
    ...(c.cp !== undefined ? { cp: c.cp } : {}),
    ...(c.author !== undefined ? { author: c.author } : {}),
    ...(c.title !== undefined ? { title: c.title } : {}),
    width: c.width,
    height: c.height,
    ...(c.bookmarks !== undefined ? { bookmarks: c.bookmarks } : {}),
    pageUrl: c.pageUrl,
  }));

  let sheetPath: string | undefined;
  if (candidates.length > 1) {
    sheetPath = await buildContactSheet(
      candidates.map((c) => c.path),
      join(deps.candidatesDir, `sheet-${Date.now()}.jpg`),
    ).catch(() => undefined);
  }
  return { candidates, ...(sheetPath !== undefined ? { sheetPath } : {}), failures };
}
