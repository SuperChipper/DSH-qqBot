import { describe, it, expect } from 'vitest';
import { pickDiverse, trimForEnrichment, weightOf, ENRICH_PER_QUERY } from './picker.ts';
import type { FanartCandidate } from './types.ts';

function cand(id: string, extra: Partial<FanartCandidate> = {}): FanartCandidate {
  return {
    source: 'pixiv',
    id,
    width: 1000,
    height: 1000,
    pageUrl: `https://www.pixiv.net/artworks/${id}`,
    tags: [],
    ...extra,
  };
}

/** 固定序列的伪随机，保证测试可复现 */
function seq(...values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length]!;
}

describe('pickDiverse', () => {
  it('同一画师只出一张', () => {
    const list = [
      cand('1', { author: 'A', cp: '芙星' }),
      cand('2', { author: 'A', cp: '星七' }),
      cand('3', { author: 'B', cp: '织窃' }),
    ];
    const picked = pickDiverse(list, 3, seq(0));
    expect(picked.map((c) => c.author).sort()).toEqual(['A', 'B']);
  });

  it('优先 CP 互不相同，不够再放开', () => {
    const list = [
      cand('1', { author: 'A', cp: '芙星' }),
      cand('2', { author: 'B', cp: '芙星' }),
      cand('3', { author: 'C', cp: '星七' }),
    ];
    const picked = pickDiverse(list, 2, seq(0));
    expect(new Set(picked.map((c) => c.cp))).toEqual(new Set(['芙星', '星七']));

    const all = pickDiverse(list, 3, seq(0));
    expect(all).toHaveLength(3);
  });

  it('画师未知时按 twitter 账号去重', () => {
    const list = [
      cand('1', { source: 'booru', pageUrl: 'https://x.com/foo/status/1', cp: 'a' }),
      cand('2', { source: 'booru', pageUrl: 'https://twitter.com/Foo/status/2', cp: 'b' }),
    ];
    expect(pickDiverse(list, 2, seq(0))).toHaveLength(1);
  });

  it('收藏多的权重高', () => {
    const hot = cand('hot', { author: 'A', bookmarks: 5000 });
    const cold = cand('cold', { author: 'B', bookmarks: 0 });
    expect(weightOf(hot)).toBeGreaterThan(weightOf(cold));
    // r 落在总权重的前 90%：热门那张的权重占了绝大部分
    const picked = pickDiverse([cold, hot], 1, seq(0.9));
    expect(picked[0]!.id).toBe('hot');
  });

  it('候选不够时返回能挑到的全部', () => {
    expect(pickDiverse([cand('1', { author: 'A' })], 3, seq(0))).toHaveLength(1);
    expect(pickDiverse([], 3, seq(0))).toEqual([]);
  });
});

describe('trimForEnrichment', () => {
  it('只留面积靠前的一小批', () => {
    const list = Array.from({ length: 40 }, (_, i) => cand(String(i), { width: 800 + i, height: 800 + i }));
    const trimmed = trimForEnrichment(list, seq(0.5));
    expect(trimmed).toHaveLength(ENRICH_PER_QUERY);
    // 面积最小的 10 张（id 0-9）不在前 30 里
    expect(trimmed.every((c) => Number(c.id) >= 10)).toBe(true);
  });
});
