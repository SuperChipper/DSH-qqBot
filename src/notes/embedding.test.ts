import { describe, it, expect, vi } from 'vitest';
import { EmbeddingCache, createOpenAIEmbedder, type Embedder } from './embedding.ts';
import type { NotesSemanticConfig } from '../config.ts';

const semanticConfig: NotesSemanticConfig = {
  enabled: true, baseUrl: 'https://example.test/v1/', apiKey: 'sk-test', model: 'BAAI/bge-m3', minSimilarity: 0.5, minMargin: 0.16, timeoutMs: 3000,
};

/** 文本长度当向量，便于断言 */
function fakeEmbedder(fail = false): Embedder & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    model: 'fake',
    calls,
    async embed(texts) {
      calls.push([...texts]);
      if (fail) throw new Error('boom');
      return texts.map((t) => [t.length, 1]);
    },
  };
}

describe('createOpenAIEmbedder', () => {
  it('POST {baseUrl}/embeddings，带密钥，按 index 还原顺序', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }],
    })));
    const vectors = await createOpenAIEmbedder(semanticConfig, fetchImpl as typeof fetch).embed(['a', 'b']);
    expect(vectors).toEqual([[1, 0], [0, 1]]);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://example.test/v1/embeddings');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
    expect(JSON.parse(init.body as string)).toMatchObject({ model: 'BAAI/bge-m3', input: ['a', 'b'] });
  });

  it('HTTP 错误和条数不符都抛错', async () => {
    const bad = vi.fn(async () => new Response('nope', { status: 401 }));
    await expect(createOpenAIEmbedder(semanticConfig, bad as typeof fetch).embed(['a'])).rejects.toThrow('HTTP 401');
    const short = vi.fn(async () => new Response(JSON.stringify({ data: [] })));
    await expect(createOpenAIEmbedder(semanticConfig, short as typeof fetch).embed(['a'])).rejects.toThrow('期望 1 条');
  });
});

describe('EmbeddingCache', () => {
  it('补算缺失的段、分批请求，算过的不重算，删掉的段丢弃', async () => {
    const embedder = fakeEmbedder();
    const cache = new EmbeddingCache(embedder, 1000);
    const texts = Array.from({ length: 20 }, (_, i) => `段${i}`);
    await cache.warm(texts);
    expect(embedder.calls.map((c) => c.length)).toEqual([16, 4]);
    expect(cache.vectorFor('段3')).toBeDefined();

    await cache.warm([...texts, '新段']);
    expect(embedder.calls.at(-1)).toEqual(['新段']);

    await cache.warm(['新段']);
    expect(cache.vectorFor('段3')).toBeUndefined();
    expect(cache.vectorFor('新段')).toBeDefined();
  });

  it('查询向量缓存：同一句话只请求一次', async () => {
    const embedder = fakeEmbedder();
    const cache = new EmbeddingCache(embedder, 1000);
    await cache.embedQuery('鱼八股是啥');
    await cache.embedQuery('鱼八股是啥');
    expect(embedder.calls).toHaveLength(1);
  });

  it('失败后冷却：期间不再请求，返回 undefined；冷却结束恢复', async () => {
    let now = 0;
    const embedder = fakeEmbedder(true);
    const logger = { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() };
    const cache = new EmbeddingCache(embedder, 1000, logger as never, () => now);
    expect(await cache.embedQuery('a')).toBeUndefined();
    expect(await cache.embedQuery('b')).toBeUndefined();
    await cache.warm(['x']);
    expect(embedder.calls).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);

    now = 61_000;
    await cache.embedQuery('c');
    expect(embedder.calls).toHaveLength(2);
  });
});
