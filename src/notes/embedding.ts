/**
 * 笔记语义检索用的向量：OpenAI 兼容 embeddings 接口（默认硅基流动 BAAI/bge-m3）+ 内存缓存。
 *
 *   - 笔记段的向量按内容哈希缓存，索引重建后没改过的段不重算；
 *   - 补算笔记向量在后台跑，不阻塞消息：还没算好的段这一轮只是不参与语义一路；
 *   - 接口失败后冷却一段时间，期间直接跳过语义一路，避免每条群消息都去撞一个挂掉的服务。
 */
import { createHash } from 'node:crypto';
import type { NotesSemanticConfig } from '../config.ts';
import type { Logger } from '../types.ts';

/** 单次请求最多几段：bge-m3 单条上限 8k token，笔记段 ≤1200 字，16 段一批足够稳 */
const BATCH_SIZE = 16;
/** 接口失败后的冷却时间(ms) */
const FAILURE_COOLDOWN_MS = 60_000;
/** 查询向量缓存条数：同一段话（重发、排队合并）不重复请求 */
const QUERY_CACHE_SIZE = 64;
/** 送去算向量的查询最长字数：长消息后半段多半是闲聊，截掉省 token */
const MAX_QUERY_CHARS = 1000;

export interface Embedder {
  readonly model: string;
  embed(texts: readonly string[], signal?: AbortSignal): Promise<number[][]>;
}

/** 读取接口密钥（配置为空时退到环境变量） */
export function resolveEmbeddingApiKey(semantic: NotesSemanticConfig): string {
  return semantic.apiKey || process.env.QQBOT_EMBEDDING_API_KEY || '';
}

/** POST {baseUrl}/embeddings，按 index 还原顺序 */
export function createOpenAIEmbedder(semantic: NotesSemanticConfig, fetchImpl: typeof fetch = fetch): Embedder {
  const url = `${semantic.baseUrl.replace(/\/+$/, '')}/embeddings`;
  return {
    model: semantic.model,
    async embed(texts, signal) {
      const apiKey = resolveEmbeddingApiKey(semantic);
      const resp = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({ model: semantic.model, input: texts, encoding_format: 'float' }),
        signal: signal ?? AbortSignal.timeout(semantic.timeoutMs),
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        throw new Error(`HTTP ${resp.status} ${body.slice(0, 200)}`);
      }
      const json = await resp.json() as { data?: Array<{ index?: number; embedding?: unknown }> };
      const data = json.data ?? [];
      if (data.length !== texts.length) throw new Error(`embeddings 返回 ${data.length} 条，期望 ${texts.length} 条`);
      const vectors: number[][] = new Array(texts.length);
      data.forEach((item, i) => {
        if (!Array.isArray(item.embedding)) throw new Error('embeddings 返回格式不对（缺 embedding 数组）');
        vectors[item.index ?? i] = item.embedding as number[];
      });
      return vectors;
    },
  };
}

function hashText(model: string, text: string): string {
  return createHash('sha1').update(model).update('\u0000').update(text).digest('hex');
}

export class EmbeddingCache {
  private readonly docVectors = new Map<string, Float32Array>();
  private readonly queryVectors = new Map<string, Float32Array>();
  private warming: Promise<void> | undefined;
  private cooldownUntil = 0;

  public constructor(
    private readonly embedder: Embedder,
    private readonly timeoutMs: number,
    private readonly logger?: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  /** 已算好的段向量；没算好返回 undefined */
  public vectorFor(text: string): Float32Array | undefined {
    return this.docVectors.get(hashText(this.embedder.model, text));
  }

  /** 后台补算缺失的段向量，并丢掉已不在笔记里的旧向量；已有一轮在跑或在冷却期就跳过 */
  public warm(texts: readonly string[]): Promise<void> {
    if (this.warming !== undefined) return this.warming;
    const wanted = new Map(texts.map((t) => [hashText(this.embedder.model, t), t]));
    for (const key of this.docVectors.keys()) if (!wanted.has(key)) this.docVectors.delete(key);
    const missing = [...wanted].filter(([key]) => !this.docVectors.has(key));
    if (missing.length === 0 || this.coolingDown()) return Promise.resolve();

    this.warming = (async () => {
      try {
        for (let i = 0; i < missing.length; i += BATCH_SIZE) {
          const batch = missing.slice(i, i + BATCH_SIZE);
          const vectors = await this.embedder.embed(batch.map(([, t]) => t));
          batch.forEach(([key], j) => this.docVectors.set(key, Float32Array.from(vectors[j]!)));
        }
        this.logger?.debug(`im-qqbot: 笔记向量补算 ${missing.length} 段（共 ${this.docVectors.size} 段）`);
      } catch (err) {
        this.fail('笔记向量补算', err);
      } finally {
        this.warming = undefined;
      }
    })();
    return this.warming;
  }

  /** 查询向量；冷却期、超时或失败时返回 undefined（调用方退回 BM25 + 精确匹配） */
  public async embedQuery(query: string): Promise<Float32Array | undefined> {
    const text = query.trim().slice(0, MAX_QUERY_CHARS);
    if (text.length === 0 || this.coolingDown()) return undefined;
    const cached = this.queryVectors.get(text);
    if (cached !== undefined) return cached;
    try {
      const [vector] = await this.embedder.embed([text], AbortSignal.timeout(this.timeoutMs));
      const result = Float32Array.from(vector!);
      this.queryVectors.set(text, result);
      if (this.queryVectors.size > QUERY_CACHE_SIZE) this.queryVectors.delete(this.queryVectors.keys().next().value!);
      return result;
    } catch (err) {
      this.fail('查询向量', err);
      return undefined;
    }
  }

  private coolingDown(): boolean {
    return this.now() < this.cooldownUntil;
  }

  private fail(what: string, err: unknown): void {
    this.cooldownUntil = this.now() + FAILURE_COOLDOWN_MS;
    this.logger?.warn(`im-qqbot: ${what}失败，语义检索暂停 ${FAILURE_COOLDOWN_MS / 1000}s：${err instanceof Error ? err.message : String(err)}`);
  }
}
