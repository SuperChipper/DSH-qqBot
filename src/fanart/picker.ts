/**
 * 候选挑选（纯函数，便于单测）：
 *   - 查人气前先限流：每个查询只留面积靠前的一小批，避免对几十张图逐个查详情；
 *   - 最终挑选：按收藏数加权随机抽，同一画师只出一张，优先让 CP 各不相同。
 */
import { authorKey, type FanartCandidate } from './types.ts';

/** 每个查询（一个源 × 一个 CP）最多留多少张去查人气 */
export const ENRICH_PER_QUERY = 8;
/** 查人气前，先按面积取前多少张再随机抽 ENRICH_PER_QUERY 张 */
const AREA_TOP = 30;
/** 人气未知时按这个收藏数算权重（略低于 pixiv 同人图的中位水平，有人气数据的优先） */
const UNKNOWN_BOOKMARKS = 50;

function shuffle<T>(list: readonly T[], random: () => number): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** 一个查询的候选：按面积取前 AREA_TOP，再随机留 limit 张 */
export function trimForEnrichment(
  list: readonly FanartCandidate[],
  random: () => number = Math.random,
  limit = ENRICH_PER_QUERY,
): FanartCandidate[] {
  const byArea = [...list].sort((a, b) => b.width * b.height - a.width * a.height).slice(0, AREA_TOP);
  return shuffle(byArea, random).slice(0, limit);
}

/** 抽样权重：收藏数开根号，热门图更容易被抽到但不至于每次都是同一张 */
export function weightOf(c: FanartCandidate): number {
  return Math.sqrt((c.bookmarks ?? UNKNOWN_BOOKMARKS) + 20);
}

/**
 * 从候选里挑 count 张：同一画师只出一张；第一轮要求 CP 互不相同，不够再放开 CP 限制。
 * 每一轮内按权重不放回抽样。
 */
export function pickDiverse(
  candidates: readonly FanartCandidate[],
  count: number,
  random: () => number = Math.random,
): FanartCandidate[] {
  const picked: FanartCandidate[] = [];
  const authors = new Set<string>();
  const cps = new Set<string>();
  const keyOf = (c: FanartCandidate) => `${c.source}:${c.id}`;
  const used = new Set<string>();

  for (const distinctCp of [true, false]) {
    let pool = candidates.filter((c) => !used.has(keyOf(c)));
    while (picked.length < count) {
      pool = pool.filter((c) => !authors.has(authorKey(c)) && !(distinctCp && cps.has(c.cp ?? '')));
      if (pool.length === 0) break;
      const total = pool.reduce((sum, c) => sum + weightOf(c), 0);
      let r = random() * total;
      let chosen = pool[pool.length - 1]!;
      for (const c of pool) {
        r -= weightOf(c);
        if (r <= 0) {
          chosen = c;
          break;
        }
      }
      picked.push(chosen);
      used.add(keyOf(chosen));
      authors.add(authorKey(chosen));
      cps.add(chosen.cp ?? '');
      pool = pool.filter((c) => c !== chosen);
    }
    if (picked.length >= count) break;
  }
  return picked;
}
