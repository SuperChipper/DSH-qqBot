/**
 * pixiv 源：按 CP 关键词搜索（不登录），按 tag 精确过滤，再查收藏数作为人气。
 *
 * 不登录时 order=popular_d 不生效，搜索只能拿到按时间排序的结果；所以搜两页
 * （第 1 页 + 随机一页）扩大候选，再对过滤后的作品逐个查 /ajax/illust/{id}
 * 拿 bookmarkCount 和图片地址。
 */
import type { HttpGet } from './http.ts';
import {
  hasBlockedTag,
  hasLowQualityTag,
  isLargeEnough,
  YURI_TAGS,
  type FanartCandidate,
  type PixivPoolEntry,
} from './types.ts';

const REFERER = 'https://www.pixiv.net/';
const PAGE_SIZE = 60;
/** 搜索结果最多翻到第几页（太靠后的是很久以前的作品，没意义） */
const MAX_PAGE = 5;

/** pixiv 搜索结果里我们用到的字段 */
export interface PixivSearchItem {
  id: string | number;
  title?: string;
  userName?: string;
  illustType?: number;
  xRestrict?: number;
  aiType?: number;
  pageCount?: number | string;
  width?: number;
  height?: number;
  tags?: string[];
}

interface PixivSearchPage {
  items: PixivSearchItem[];
  total: number;
}

/** 单个作品是否满足一个 CP 条目的过滤规则（不含去重） */
export function acceptPixivItem(it: PixivSearchItem, entry: PixivPoolEntry, allowAi = false): boolean {
  if (!it || !it.id || it.xRestrict !== 0) return false;
  if (!allowAi && it.aiType === 2) return false;
  // 只要单张插画：manga/ugoira 的首图经常只是封面或分镜，多页作品只发首页也会断章取义
  if (it.illustType !== 0) return false;
  if (Number(it.pageCount) > 1) return false;
  if (!isLargeEnough(Number(it.width), Number(it.height))) return false;
  const tags = Array.isArray(it.tags) ? it.tags.map(String) : [];
  if (hasBlockedTag(tags) || hasLowQualityTag(tags)) return false;
  // 关键词搜索是全文匹配，要按 tag 精确锁角色
  if (entry.require?.length && !entry.require.every((t) => tags.includes(t))) return false;
  if (entry.requireGroups?.length) {
    const hitAll = entry.requireGroups.every((group) => group.some((alt) => tags.some((tag) => tag.includes(alt))));
    if (!hitAll) return false;
  }
  if (entry.exclude?.length && tags.some((tag) => entry.exclude!.some((bad) => tag.includes(bad)))) return false;
  // 两个角色都被 tag 锁住才算配对；只锁一个的还得自带百合 tag，否则多半是单人图
  const pairPinned = entry.pairPinned === true
    || (entry.requireGroups?.length ?? 0) >= 2
    || (entry.require?.length ?? 0) >= 2;
  if (!pairPinned && !tags.some((tag) => YURI_TAGS.includes(tag))) return false;
  return true;
}

async function searchPage(get: HttpGet, word: string, page: number): Promise<PixivSearchPage> {
  const q = encodeURIComponent(word);
  const url = `https://www.pixiv.net/ajax/search/artworks/${q}?word=${q}&order=date_d&mode=all&p=${page}&s_mode=s_tag&type=all&lang=zh`;
  const res = await get(url, { Referer: REFERER });
  if (res.status !== 200) throw new Error(`pixiv search HTTP ${res.status}`);
  const data = JSON.parse(res.body.toString('utf8')) as {
    error?: boolean;
    body?: { illustManga?: { data?: PixivSearchItem[]; total?: number } };
  };
  if (data.error) throw new Error('pixiv search 返回 error');
  return { items: data.body?.illustManga?.data ?? [], total: Number(data.body?.illustManga?.total ?? 0) };
}

/** 作品详情：收藏数 + 图片地址（regular 约 1200px，发群够用） */
export interface PixivDetail {
  bookmarks: number;
  imageUrl?: string;
  author?: string;
}

export async function fetchPixivDetail(get: HttpGet, id: string): Promise<PixivDetail> {
  const res = await get(`https://www.pixiv.net/ajax/illust/${id}?lang=zh`, { Referer: REFERER });
  if (res.status !== 200) throw new Error(`pixiv illust HTTP ${res.status}`);
  const data = JSON.parse(res.body.toString('utf8')) as {
    error?: boolean;
    body?: { bookmarkCount?: number; userName?: string; urls?: { regular?: string; original?: string } };
  };
  if (data.error || !data.body) throw new Error('pixiv illust 返回 error');
  return {
    bookmarks: Number(data.body.bookmarkCount ?? 0),
    imageUrl: data.body.urls?.regular ?? data.body.urls?.original,
    author: data.body.userName,
  };
}

/** 搜一个 CP：返回过滤后的候选（未查人气、未下载） */
export async function searchPixivCp(
  get: HttpGet,
  entry: PixivPoolEntry,
  seen: ReadonlySet<string>,
  random: () => number = Math.random,
): Promise<FanartCandidate[]> {
  const first = await searchPage(get, entry.words, 1);
  const pages = Math.min(MAX_PAGE, Math.ceil(first.total / PAGE_SIZE));
  let items = first.items;
  if (pages >= 2) {
    const extraPage = 2 + Math.floor(random() * (pages - 1));
    try {
      items = items.concat((await searchPage(get, entry.words, extraPage)).items);
    } catch {
      // 额外那页失败不影响第 1 页的结果
    }
  }
  const out: FanartCandidate[] = [];
  const ids = new Set<string>();
  for (const it of items) {
    const id = String(it.id);
    if (ids.has(id) || seen.has(id) || !acceptPixivItem(it, entry)) continue;
    ids.add(id);
    out.push({
      source: 'pixiv',
      id,
      cp: entry.name,
      author: it.userName,
      title: it.title,
      width: Number(it.width) || 0,
      height: Number(it.height) || 0,
      referer: REFERER,
      pageUrl: `https://www.pixiv.net/artworks/${id}`,
      tags: (it.tags ?? []).map(String),
      pixivId: id,
    });
  }
  return out;
}
