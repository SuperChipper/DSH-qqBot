import { describe, it, expect } from 'vitest';
import { cosineSimilarity, fuseRankings, gateSimilarities } from './rank-fusion.ts';

const id = (x: string): string => x;
const items = (fused: Array<{ item: string }>): string[] => fused.map((f) => f.item);

describe('fuseRankings', () => {
  it('精确命中被提到前面', () => {
    const exact = new Map([['d', { score: 3, matched: ['鱼八股'] }]]);
    const fused = fuseRankings(['a', 'b', 'c', 'd', 'e'], id, { exact });
    expect(items(fused)).toEqual(['d', 'a', 'b', 'c', 'e']);
    expect(fused[0]).toMatchObject({ coarseRank: 4, exactRank: 1 });
  });

  it('两路名次互换时字面命中胜出', () => {
    const exact = new Map([
      ['a', { score: 1.5, matched: ['模板话术'] }],
      ['b', { score: 3, matched: ['鱼八股'] }],
    ]);
    expect(items(fuseRankings(['a', 'b'], id, { exact }))).toEqual(['b', 'a']);
  });

  it('没有字面/语义命中时完全保持粗检索顺序', () => {
    expect(items(fuseRankings(['c', 'a', 'b'], id))).toEqual(['c', 'a', 'b']);
    expect(items(fuseRankings(['c', 'a', 'b'], id, { exact: new Map(), semantic: new Map() }))).toEqual(['c', 'a', 'b']);
  });

  it('合并去重：重复 id 只保留一次，粗检索外的精确命中被补进来', () => {
    const exact = new Map([
      ['a', { score: 2, matched: ['x'] }],
      ['z', { score: 3, matched: ['y'] }],
    ]);
    const fused = fuseRankings(['a', 'b', 'a'], id, { exact, extra: ['a', 'b', 'q', 'z'] });
    expect(items(fused)).toEqual(['a', 'z', 'b']);
    const z = fused.find((f) => f.item === 'z')!;
    expect(z.coarseRank).toBeUndefined();
    expect(z.exactRank).toBe(1);
  });

  it('语义一路能补回 BM25 完全没召回的段，但不压过字面证据', () => {
    const exact = new Map([['b', { score: 3, matched: ['鱼八股'] }]]);
    const semantic = new Map([['s', 0.8], ['b', 0.7]]);
    const fused = fuseRankings(['a', 'b'], id, { exact, semantic, extra: ['a', 'b', 's', 'q'] });
    expect(items(fused)).toEqual(['b', 's', 'a']);
    expect(fused.find((f) => f.item === 's')).toMatchObject({ semanticRank: 1, similarity: 0.8 });
    expect(fused.find((f) => f.item === 'a')!.similarity).toBeUndefined();
  });
});

describe('cosineSimilarity / gateSimilarities', () => {
  /** 与查询 [1,0] 的余弦恰为 c 的单位向量 */
  const at = (id: string, c: number): { id: string; vector: number[] } => ({ id, vector: [c, Math.sqrt(1 - c * c)] });
  const gate = { minSimilarity: 0.5, minMargin: 0.16 };

  it('同向为 1，正交为 0，维度不符或零向量为 0', () => {
    expect(cosineSimilarity([1, 2], [2, 4])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
    expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 0])).toBe(0);
  });

  it('从分布里凸出来的段才过门槛', () => {
    const map = gateSimilarities([1, 0], [at('hit', 0.7), at('a', 0.45), at('b', 0.44), at('c', 0.43), at('d', 0.42)], gate);
    expect([...map.keys()]).toEqual(['hit']);
    expect(map.get('hit')).toBeCloseTo(0.7);
  });

  it('闲聊式的平坦分布：都过了绝对下限也一个不留', () => {
    const map = gateSimilarities([1, 0], [at('a', 0.57), at('b', 0.55), at('c', 0.54), at('d', 0.53), at('e', 0.52)], gate);
    expect(map.size).toBe(0);
  });

  it('绝对下限兜底：中位数很低时凸出但仍不够像的段不留', () => {
    const map = gateSimilarities([1, 0], [at('a', 0.4), at('b', 0.1), at('c', 0.1), at('d', 0.1)], gate);
    expect(map.size).toBe(0);
  });

  it('没有向量时返回空', () => {
    expect(gateSimilarities([1, 0], [], gate).size).toBe(0);
  });
});
