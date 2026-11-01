import { describe, it, expect } from 'vitest';
import { extractExactTerms, scoreExact, type ExactDoc } from './exact-match.ts';

const kinds = (query: string): string[] => extractExactTerms(query).terms.map((t) => `${t.kind}:${t.text}`);

describe('extractExactTerms', () => {
  it('抽出引号原文、别名、编号、id 和英文专名', () => {
    expect(kinds('「鱼八股」是什么？#U3 说 v2.1 的 BM25 在第 300 条，id a1b2c3d4')).toEqual([
      'quote:鱼八股',
      'alias:u3',
      'id:v2.1',
      'id:bm25',
      'id:a1b2c3d4',
      'number:300',
    ]);
  });

  it('引号内容不再拆成中文片段，单个数字和英文虚词不抽', () => {
    const { terms, hanRuns } = extractExactTerms('“沉钟修道院” and the 2 级');
    expect(terms.map((t) => t.text)).toEqual(['沉钟修道院']);
    expect(hanRuns).toEqual([]);
  });

  it('别名兼容 U3 / #U3 / ＃Ｕ３（全角）', () => {
    expect(kinds('U3 和 #u12 和 ＃Ｕ３')).toEqual(['alias:u3', 'alias:u12']);
  });
});

describe('scoreExact', () => {
  const doc = (id: string, text: string): ExactDoc => ({ id, text });

  it('中文片段贪心取最长命中，整段只算一次', () => {
    const scores = scoreExact('大肥鱼小课堂讲了啥', [doc('a', '大肥鱼小课堂 第四集'), doc('b', '大肥鱼的日常'), doc('c', '无关')], 10);
    expect(scores.get('a')!.matched).toEqual(['大肥鱼小课堂']);
    // 「大肥鱼」只命中 3 字，权重低于整段专名
    expect(scores.get('b')!.matched).toEqual(['大肥鱼']);
    expect(scores.get('b')!.score).toBeLessThan(scores.get('a')!.score);
    expect(scores.has('c')).toBe(false);
  });

  it('单字和二字组不计分', () => {
    expect(scoreExact('鱼', [doc('a', '鱼')]).size).toBe(0);
    expect(scoreExact('鱼八', [doc('a', '鱼八股')]).size).toBe(0);
  });

  it('数字和别名有边界：300 不命中 1300，U3 不命中 U30', () => {
    const docs = [doc('a', '第 1300 条'), doc('b', '#U30 是法师'), doc('c', '第 300 条，U3 是战士')];
    expect([...scoreExact('300 条和 U3', docs, 10).keys()]).toEqual(['c']);
  });

  it('超过一半候选都含有的字面量不计分', () => {
    const docs = ['是什么a', '是什么b', '是什么c', '鱼八股是什么'].map((t, i) => doc(String(i), t));
    const scores = scoreExact('「是什么」', docs, 4);
    expect(scores.size).toBe(0);
  });

  it('有切词表时用二字组预筛，结果不变', () => {
    const terms = new Set(['沉钟', '钟修', '修道', '道院']);
    const withTerms = scoreExact('沉钟修道院在哪', [{ id: 'a', text: '沉钟修道院', terms }], 10);
    const without = scoreExact('沉钟修道院在哪', [doc('a', '沉钟修道院')], 10);
    expect(withTerms.get('a')).toEqual(without.get('a'));
  });
});
