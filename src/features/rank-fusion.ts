/**
 * 检索多路名次融合（加权 RRF）+ 语义一路的相似度工具。纯函数，不依赖宿主，便于单测。
 *
 * 三路：BM25 粗检索、字面精确匹配（exact-match.ts）、向量语义相似度。
 * 只看名次不看原始分，三种分数量纲不同也不用对齐；哪一路没有这段就不加那一项。
 * 精确和语义两路都没有结果时，融合顺序与 BM25 原顺序完全一致。
 */
import type { ExactScore } from './exact-match.ts';

/** RRF 常数：取通用值 60，名次差异被平滑，单路第一名不至于碾压 */
export const RRF_K = 60;
/**
 * 精确一路在 RRF 里的权重。纯 RRF 只看名次，两路名次正好互换时（粗检索第 1 / 精确第 2 vs 反过来）会打平，
 * 平局落回粗检索顺序等于精确匹配白做；略高于 1 让字面命中在这种对峙里胜出，又不至于让弱字面命中碾压 BM25。
 */
export const EXACT_RRF_WEIGHT = 1.5;
/** 语义一路与 BM25 同权：它负责补同义/换说法的召回，不该压过字面证据 */
export const SEMANTIC_RRF_WEIGHT = 1;

export interface FusedItem<T> {
  item: T;
  /** RRF 融合分 */
  fused: number;
  /** 粗检索名次（1 起）；不在粗检索里为 undefined */
  coarseRank?: number;
  /** 精确榜名次（1 起） */
  exactRank?: number;
  exact?: ExactScore;
  /** 语义榜名次（1 起） */
  semanticRank?: number;
  /** 与查询的余弦相似度 */
  similarity?: number;
}

export interface FuseOptions<T> {
  /** 精确分（id → 分），只含过门槛的段 */
  exact?: ReadonlyMap<string, ExactScore>;
  /** 语义相似度（id → 余弦），只含过门槛的段 */
  semantic?: ReadonlyMap<string, number>;
  /** 全部可召回的段：精确/语义命中、但不在粗检索名单里的从这里补进来 */
  extra?: readonly T[];
  k?: number;
}

/** 按分数从高到低给 id 排名次，只给已在候选里的 id */
function assignRanks(scores: ReadonlyMap<string, number>, present: (id: string) => boolean): Map<string, number> {
  const ranks = new Map<string, number>();
  [...scores.entries()]
    .filter(([id]) => present(id))
    .sort((a, b) => b[1] - a[1])
    .forEach(([id], index) => ranks.set(id, index + 1));
  return ranks;
}

/**
 * 加权 RRF：fused = 1/(k+粗名次) + w_e/(k+精确名次) + w_s/(k+语义名次)。
 * 输入的 coarse 已按粗检索排好序；同 id 只保留一次（先出现的为准）。
 */
export function fuseRankings<T>(
  coarse: readonly T[],
  idOf: (item: T) => string,
  options: FuseOptions<T> = {},
): Array<FusedItem<T>> {
  const { exact = new Map(), semantic = new Map(), extra = [], k = RRF_K } = options;
  const byId = new Map<string, FusedItem<T>>();
  for (const item of coarse) {
    const id = idOf(item);
    if (!byId.has(id)) byId.set(id, { item, fused: 0, coarseRank: byId.size + 1 });
  }
  for (const item of extra) {
    const id = idOf(item);
    if ((exact.has(id) || semantic.has(id)) && !byId.has(id)) byId.set(id, { item, fused: 0 });
  }

  const present = (id: string): boolean => byId.has(id);
  const exactRanks = assignRanks(new Map([...exact].map(([id, s]) => [id, s.score])), present);
  const semanticRanks = assignRanks(semantic, present);

  const fused = [...byId.entries()].map(([id, entry]) => {
    entry.exactRank = exactRanks.get(id);
    entry.exact = entry.exactRank === undefined ? undefined : exact.get(id);
    entry.semanticRank = semanticRanks.get(id);
    entry.similarity = entry.semanticRank === undefined ? undefined : semantic.get(id);
    entry.fused = (entry.coarseRank === undefined ? 0 : 1 / (k + entry.coarseRank))
      + (entry.exactRank === undefined ? 0 : EXACT_RRF_WEIGHT / (k + entry.exactRank))
      + (entry.semanticRank === undefined ? 0 : SEMANTIC_RRF_WEIGHT / (k + entry.semanticRank));
    return entry;
  });
  // 同分时先看精确分，再看相似度，最后保持粗检索顺序
  return fused.sort((a, b) =>
    b.fused - a.fused
    || (b.exact?.score ?? 0) - (a.exact?.score ?? 0)
    || (b.similarity ?? 0) - (a.similarity ?? 0)
    || (a.coarseRank ?? Infinity) - (b.coarseRank ?? Infinity));
}

/** 余弦相似度；维度不同或零向量返回 0 */
export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

export interface SemanticGate {
  /** 绝对下限：再怎么突出也得过这条线 */
  minSimilarity: number;
  /** 相对门槛：要高出本次查询对全库相似度的中位数这么多 */
  minMargin: number;
}

/**
 * 查询向量对每段算相似度，只留「明显比全库一般水平更像」的段（id → 相似度）。
 *
 * 为什么不用固定门槛：bge-m3 的余弦挤在很窄的区间里，而且每条查询的基线不同——
 * 「好的收到」对全库的中位数有 0.47，「GPT小姐长什么样」只有 0.32。闲聊对哪段都「有点像」，
 * 分布是平的；真问到某件事时，对的那段会从分布里凸出来。所以按中位数 + margin 判，
 * 绝对下限只兜底笔记很少、中位数不可靠的情况。
 */
export function gateSimilarities(
  query: ArrayLike<number>,
  docs: Iterable<{ id: string; vector: ArrayLike<number> }>,
  gate: SemanticGate,
): Map<string, number> {
  const sims = [...docs].map((doc) => ({ id: doc.id, sim: cosineSimilarity(query, doc.vector) }));
  const result = new Map<string, number>();
  if (sims.length === 0) return result;
  const threshold = Math.max(gate.minSimilarity, median(sims.map((s) => s.sim)) + gate.minMargin);
  for (const { id, sim } of sims) if (sim >= threshold) result.set(id, sim);
  return result;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}
