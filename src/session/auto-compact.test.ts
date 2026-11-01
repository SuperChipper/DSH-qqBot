import { describe, it, expect, vi } from 'vitest';
import { SessionManager } from './session-manager.ts';
import type { SessionRecord } from './types.ts';
import type { CompactOutcome } from './types.ts';

/** 只测触发逻辑：用最小的 this 调用 maybeAutoCompact，compact() 与窗口查询用桩替代 */
function harness(
  threshold: number,
  outcome: CompactOutcome = { ok: true, shadowed: 40, tokens: 90000 },
  opts: { privateRatio?: number; deferOnTools?: boolean; contextWindow?: number } = {},
) {
  const compact = vi.fn(async () => outcome);
  const self = {
    config: {
      autoCompactTokens: threshold,
      autoCompactPrivateRatio: opts.privateRatio ?? 0.5,
      autoCompactDeferOnTools: opts.deferOnTools ?? true,
    },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    compact,
    contextWindowOf: vi.fn(async () => opts.contextWindow),
  };
  Object.assign(self, { autoCompact: (SessionManager.prototype as unknown as { autoCompact: unknown }).autoCompact });
  const run = (record: SessionRecord) => SessionManager.prototype.maybeAutoCompact.call(self as never, record);
  return { run, compact };
}

const TOOL_TURN = [{ type: 'turn/start' }, { type: 'tool/call' }, { type: 'tool/result' }, { type: 'turn/end' }];
const QUIET_TURN = [{ type: 'turn/start' }, { type: 'assistant/message' }, { type: 'turn/end' }];

function record(overrides: Partial<SessionRecord> & { events?: unknown[] } = {}): SessionRecord {
  const { events = QUIET_TURN, ...rest } = overrides;
  return {
    sessionKey: 'k',
    sessionId: 's',
    scope: 'group',
    peerId: 'g1',
    agent: { status: 'idle', session: { events } },
    contextTokens: 130000,
    ...rest,
  } as unknown as SessionRecord;
}

describe('SessionManager.maybeAutoCompact', () => {
  it('超过阈值且空闲 → 压缩，完成后清空上下文计数', async () => {
    const { run, compact } = harness(120000);
    const r = record();
    run(r);
    expect(r.compacting).toBe(true);
    await vi.waitFor(() => expect(r.compacting).toBe(false));
    expect(compact).toHaveBeenCalledWith('group', 'g1');
    expect(r.contextTokens).toBeUndefined();
  });

  it('未超阈值 / 不知道大小 / 正忙 / 已在压缩 / 关闭 → 不压缩', async () => {
    const { run, compact } = harness(120000);
    const records = [
      record({ contextTokens: 100000 }),
      record({ contextTokens: undefined }),
      record({ agent: { status: 'running', session: { events: QUIET_TURN } } as never }),
      record({ compacting: true }),
    ];
    for (const r of records) run(r);
    harness(0).run(record());
    await vi.waitFor(() => expect(records[0]!.compacting).toBe(false));
    expect(compact).not.toHaveBeenCalled();
  });

  it('压缩没成功时保留计数，下一轮还会再试', async () => {
    const { run } = harness(120000, { ok: false, reason: 'busy' });
    const r = record();
    run(r);
    await vi.waitFor(() => expect(r.compacting).toBe(false));
    expect(r.contextTokens).toBe(130000);
  });

  it('私聊按窗口比例放宽：1M 窗口下 130k 不压，50 万才压', async () => {
    const { run, compact } = harness(120000, undefined, { contextWindow: 1_000_000 });
    const small = record({ scope: 'c2c', peerId: 'u1' });
    run(small);
    await vi.waitFor(() => expect(small.compacting).toBe(false));
    expect(compact).not.toHaveBeenCalled();

    const big = record({ scope: 'c2c', peerId: 'u1', contextTokens: 520000 });
    run(big);
    await vi.waitFor(() => expect(big.compacting).toBe(false));
    expect(compact).toHaveBeenCalledWith('c2c', 'u1');
  });

  it('上一轮还在调工具 → 推迟；到 1.5 倍阈值强制压缩', async () => {
    const { run, compact } = harness(120000);
    const busy = record({ events: TOOL_TURN });
    run(busy);
    await vi.waitFor(() => expect(busy.compacting).toBe(false));
    expect(compact).not.toHaveBeenCalled();
    expect(busy.contextTokens).toBe(130000);

    const overflowing = record({ events: TOOL_TURN, contextTokens: 180000 });
    run(overflowing);
    await vi.waitFor(() => expect(overflowing.compacting).toBe(false));
    expect(compact).toHaveBeenCalledTimes(1);
  });

  it('查窗口期间开始了新一轮 → 放弃这次压缩', async () => {
    const { run, compact } = harness(120000);
    const agent = { status: 'idle', session: { events: QUIET_TURN } };
    const r = record({ agent: agent as never });
    run(r);
    agent.status = 'running';
    await vi.waitFor(() => expect(r.compacting).toBe(false));
    expect(compact).not.toHaveBeenCalled();
  });
});
