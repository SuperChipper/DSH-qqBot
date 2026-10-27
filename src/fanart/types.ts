/**
 * 搜图候选的公共类型与过滤规则（pixiv / booru 两个源共用）。
 */

export type FanartSource = 'pixiv' | 'booru';

/** 一张候选图（下载前） */
export interface FanartCandidate {
  source: FanartSource;
  /** 源内作品 id（pixiv 作品 id / safebooru post id） */
  id: string;
  /** 命中的 CP 名；随机百合池为 undefined */
  cp?: string;
  /** 画师名（未知时为 undefined，去重时退化为按出处链接） */
  author?: string;
  title?: string;
  width: number;
  height: number;
  /** 要下载的图片地址（已选好合适尺寸） */
  imageUrl?: string;
  /** 下载图片时要带的 Referer（i.pximg.net 必须） */
  referer?: string;
  /** 给群友看的出处链接 */
  pageUrl: string;
  tags: string[];
  /** pixiv 作品 id（booru 的 source 指向 pixiv 时也有），用来查收藏数 */
  pixivId?: string;
  /** 人气：pixiv 收藏数；未知为 undefined */
  bookmarks?: number;
}

/** pixiv 池条目（scripts/pixiv-tags.json） */
export interface PixivPoolEntry {
  name: string;
  words: string;
  require?: string[];
  requireGroups?: string[][];
  exclude?: string[];
  pairPinned?: boolean;
}

/** booru 池条目（scripts/fanart-tags.json） */
export interface BooruPoolEntry {
  name: string;
  tags: string;
}

/** 短边像素下限：太小的图发群里糊 */
export const MIN_EDGE = 800;

/** 政治化 / 战争拟人一类不进群 */
export const BLOCKED_SUBSTRINGS = [
  'russo', 'ukrain', 'nazi', 'hitler', 'soviet', 'communist',
  'political', 'propaganda', 'countryball', 'military_occupation', 'r-18', 'r18',
];

/** 漫画格、对话框、像素图这类发群里观感差的 tag（booru 英文 tag + pixiv 日文 tag） */
export const LOW_QUALITY_TAGS = [
  'comic', '4koma', 'speech_bubble', 'text_focus', 'translation_request', 'pixel_art', 'sketch', 'lineart', 'monochrome',
  '4コマ', '4コマ漫画', '漫画', 'ドット絵', 'pixelart', 'ラフ', '落書き',
];

/** CP 只锁了一个角色时，靠这些 tag 保证画面里确实是百合 */
export const YURI_TAGS = ['百合', 'yuri', 'ガールズラブ', 'girls_love', 'レズ', '女同', '2girls'];

export function hasBlockedTag(tags: readonly string[]): boolean {
  const lowered = tags.map((t) => t.toLowerCase());
  return lowered.some((t) => BLOCKED_SUBSTRINGS.some((bad) => t.includes(bad)));
}

export function hasLowQualityTag(tags: readonly string[]): boolean {
  const lowered = new Set(tags.map((t) => t.toLowerCase()));
  return LOW_QUALITY_TAGS.some((t) => lowered.has(t));
}

export function isLargeEnough(width: number, height: number, minEdge = MIN_EDGE): boolean {
  return Math.min(width || 0, height || 0) >= minEdge;
}

/** 从 booru 的 source 字段里认出 pixiv 作品 id（artworks 链接 / member_illust / i.pximg 文件名） */
export function pixivIdFromSource(source: string | undefined): string | undefined {
  if (!source) return undefined;
  const m = /pixiv\.net\/(?:\w+\/)?artworks\/(\d+)/.exec(source)
    ?? /illust_id=(\d+)/.exec(source)
    ?? /pximg\.net\/.*\/(\d+)_p\d+/.exec(source);
  return m?.[1];
}

/** 去重键：同一个画师只出一张；画师未知时按出处链接的「账号」部分 */
export function authorKey(c: Pick<FanartCandidate, 'author' | 'pageUrl' | 'source' | 'id'>): string {
  if (c.author) return `author:${c.author.toLowerCase()}`;
  const twitter = /(?:twitter|x)\.com\/([^/]+)/.exec(c.pageUrl);
  if (twitter) return `twitter:${twitter[1]!.toLowerCase()}`;
  return `${c.source}:${c.id}`;
}
