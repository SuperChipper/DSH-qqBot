/**
 * booru 源：safebooru（全年龄）按 tag 搜百合图。
 *
 * safebooru 的 score 字段是空的，没有人气可用；source 指向 pixiv 的帖子会在
 * 后面借 pixiv 收藏数当人气。
 */
import type { HttpGet } from './http.ts';
import {
  hasBlockedTag,
  hasLowQualityTag,
  isLargeEnough,
  pixivIdFromSource,
  type BooruPoolEntry,
  type FanartCandidate,
} from './types.ts';

const API = 'https://safebooru.org/index.php?page=dapi&s=post&q=index&json=1';
const BASE_TAGS = 'yuri rating:general 2girls';
const PAGE_LIMIT = 100;
/** 随机百合池最多随机翻到第几页 */
const RANDOM_MAX_PAGE = 8;

/** safebooru post 里我们用到的字段 */
export interface BooruPost {
  id: number | string;
  width?: number | string;
  height?: number | string;
  tags?: string;
  source?: string;
  sample_url?: string;
  file_url?: string;
}

export function acceptBooruPost(post: BooruPost): boolean {
  if (!post || !post.id || !(post.sample_url || post.file_url)) return false;
  if (!isLargeEnough(Number(post.width), Number(post.height))) return false;
  const tags = String(post.tags ?? '').split(/\s+/).filter(Boolean);
  return !hasBlockedTag(tags) && !hasLowQualityTag(tags);
}

async function queryPage(get: HttpGet, tags: string, pid: number): Promise<BooruPost[]> {
  const res = await get(`${API}&tags=${encodeURIComponent(tags)}&limit=${PAGE_LIMIT}&pid=${pid}`);
  if (res.status !== 200) throw new Error(`booru HTTP ${res.status}`);
  const text = res.body.toString('utf8').trim();
  const posts = text ? JSON.parse(text) as unknown : [];
  return Array.isArray(posts) ? posts as BooruPost[] : [];
}

function toCandidate(post: BooruPost, cp: string | undefined): FanartCandidate {
  const id = String(post.id);
  const source = String(post.source ?? '').trim();
  return {
    source: 'booru',
    id,
    cp,
    width: Number(post.width) || 0,
    height: Number(post.height) || 0,
    imageUrl: post.sample_url || post.file_url,
    pageUrl: /^https?:\/\//.test(source) ? source : `https://safebooru.org/index.php?page=post&s=view&id=${id}`,
    tags: String(post.tags ?? '').split(/\s+/).filter(Boolean),
    pixivId: pixivIdFromSource(source),
  };
}

/**
 * 搜一个 CP（entry）或随机百合池（entry 为 undefined）。
 * 小 CP 只有第 0 页，乱跳页码必然拿到空列表，所以 CP 只查第 0 页；随机池随机翻页。
 */
export async function searchBooru(
  get: HttpGet,
  entry: BooruPoolEntry | undefined,
  seen: ReadonlySet<string>,
  random: () => number = Math.random,
): Promise<FanartCandidate[]> {
  const tags = entry ? `${BASE_TAGS} ${entry.tags}` : BASE_TAGS;
  const pid = entry ? 0 : Math.floor(random() * RANDOM_MAX_PAGE);
  const posts = await queryPage(get, tags, pid);
  return posts
    .filter((p) => !seen.has(String(p.id)) && acceptBooruPost(p))
    .map((p) => toCandidate(p, entry?.name));
}
