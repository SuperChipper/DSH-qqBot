import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Middleware, MiddlewareContext } from '@tencent-connect/qqbot-nodejs';
import { serialMerge } from './serial-merge.ts';
import { runInboundTurn } from '../transport/agent-turn.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function context(id: string, peer = 'p'): MiddlewareContext {
  const controller = new AbortController();
  return {
    message: { content: id, messageId: id, replyTarget: { scope: 'c2c', targetId: peer } },
    state: {}, signal: controller.signal,
    abort: vi.fn(() => controller.abort()), stop: vi.fn(),
    log: { warn: vi.fn(), error: vi.fn() },
  } as unknown as MiddlewareContext;
}

function guard(timeout = 100, maxQueue = 20): Middleware {
  return serialMerge({ maxQueue, maxProcessingMs: timeout, onMerge: (contexts) => {
    const first = contexts[0]!;
    first.message.content = contexts.map((c) => c.message.content).join('+');
    return first;
  } });
}

afterEach(() => vi.useRealTimers());

describe('serialMerge', () => {
  it('交接后仍串行：第二批运行时到达的第三批不能并发 followup', async () => {
    const middleware = guard(0);
    const a = deferred(), b = deferred();
    const seen: string[] = [];
    const first = middleware(context('a'), () => a.promise);
    const second = middleware(context('b'), async () => { seen.push('b'); await b.promise; });
    a.resolve();
    await first;
    expect(seen).toEqual(['b']);
    const c = context('c'), d = context('d');
    const third = middleware(c, async () => { seen.push(c.message.content); });
    const fourth = middleware(d, async () => { seen.push('d separately'); });
    await Promise.resolve();
    expect(seen).toEqual(['b']);
    b.resolve();
    await Promise.all([second, third, fourth]);
    expect(seen).toEqual(['b', 'c+d']);
    await middleware(context('e'), async () => { seen.push('e'); });
    expect(seen).toEqual(['b', 'c+d', 'e']);
  });

  it('每批都有 watchdog，取消 agent 收敛后才交接下一批', async () => {
    vi.useFakeTimers();
    const middleware = guard();
    const a = deferred(), idle = deferred();
    const first = middleware(context('a'), () => a.promise);
    const b = context('b');
    const agent = { followup: vi.fn(), cancel: vi.fn(), whenIdle: () => idle.promise };
    const second = middleware(b, () => runInboundTurn(agent, 'wait for singing', b.signal, () => {}));
    await vi.advanceTimersByTimeAsync(80);
    a.resolve();
    await first;
    const next = vi.fn(async () => {});
    const third = middleware(context('c'), next);
    await vi.advanceTimersByTimeAsync(99);
    expect(agent.cancel).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(agent.cancel).toHaveBeenCalledTimes(1);
    expect(next).not.toHaveBeenCalled();
    idle.resolve();
    await Promise.all([second, third]);
    expect(next).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(agent.cancel).toHaveBeenCalledTimes(1);
  });

  it('唱歌作业仍在后台排队时，提交回合结束就允许聊天继续', async () => {
    const middleware = guard(0);
    const submitted = deferred(), song = deferred();
    let finished = false;
    void song.promise.then(() => { finished = true; });
    const submit = middleware(context('song'), () => submitted.promise);
    const chat = vi.fn(async () => {});
    const queued = middleware(context('chat'), chat);
    submitted.resolve();
    await Promise.all([submit, queued]);
    expect(chat).toHaveBeenCalledTimes(1);
    expect(finished).toBe(false);
    song.resolve();
  });

  it('不同 peer 独立，取消排队消息释放容量', async () => {
    const middleware = guard(0, 1), a = deferred();
    const first = middleware(context('a'), () => a.promise);
    const b = context('b'), nextB = vi.fn(async () => {});
    const second = middleware(b, nextB);
    const overflow = context('overflow');
    await middleware(overflow, async () => { throw Error('must not run'); });
    expect(overflow.stop).toHaveBeenCalledWith('concurrency:merge-full');
    const other = vi.fn(async () => {});
    await middleware(context('other', 'other-peer'), other);
    expect(other).toHaveBeenCalledTimes(1);
    b.abort();
    await second;
    const nextC = vi.fn(async () => {});
    const third = middleware(context('c'), nextC);
    a.resolve();
    await Promise.all([first, third]);
    expect(nextB).not.toHaveBeenCalled();
    expect(nextC).toHaveBeenCalledTimes(1);
  });

  it('下游失败仍交接，旧 watchdog 不会误杀后续批次', async () => {
    vi.useFakeTimers();
    const middleware = guard();
    const a = deferred(), b = context('b');
    const first = middleware(context('a'), async () => { await a.promise; throw Error('failed'); });
    const rejected = expect(first).rejects.toThrow('failed');
    const second = middleware(b, async () => { await vi.advanceTimersByTimeAsync(60); });
    await vi.advanceTimersByTimeAsync(60);
    a.resolve();
    await Promise.all([rejected, second]);
    expect(b.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(b.signal.aborted).toBe(false);
  });

  it('合并函数抛错仍逐条处理，不遗留等待者', async () => {
    const middleware = serialMerge({ maxQueue: 20, maxProcessingMs: 0, onMerge: () => { throw Error('merge'); } });
    const a = deferred(), seen: string[] = [];
    const first = middleware(context('a'), () => a.promise);
    const second = middleware(context('b'), async () => { seen.push('b'); });
    const third = middleware(context('c'), async () => { seen.push('c'); });
    a.resolve();
    await Promise.all([first, second, third]);
    expect(seen).toEqual(['b', 'c']);
  });
});
