import { describe, it, expect, vi } from 'vitest';
import { SessionManager } from './session-manager.ts';
import type { SessionRecord } from './types.ts';
import type { CompactOutcome } from './types.ts';

/** 只测触发逻辑：用最小的 this 调用 maybeAutoCompact，compact() 用桩替代 */
function harness(threshold: number, outcome: CompactOutcome = { ok: true, shadowed: 40, tokens: 90000 }) {
  const compact = vi.fn(async () => outcome);
  const self = {
    config: { autoCompactTokens: threshold },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    compact,
  };
  const run = (record: SessionRecord) => SessionManager.prototype.maybeAutoCompact.call(self as never, record);
  return { run, compact };
}

function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionKey: 'k',
    sessionId: 's',
    scope: 'group',
    peerId: 'g1',
    agent: { status: 'idle' },
    contextTokens: 130000,
    ...overrides,
  } as unknown as SessionRecord;
}

describe('SessionManager.maybeAutoCompact', () => {
  it('超过阈值且空闲 → 压缩，完成后清空上下文计数', async () => {
    const { run, compact } = harness(120000);
    const r = record();
    run(r);
    expect(compact).toHaveBeenCalledWith('group', 'g1');
    expect(r.compacting).toBe(true);
    await vi.waitFor(() => expect(r.compacting).toBe(false));
    expect(r.contextTokens).toBeUndefined();
  });

  it('未超阈值 / 不知道大小 / 正忙 / 已在压缩 / 关闭 → 不压缩', () => {
    const { run, compact } = harness(120000);
    run(record({ contextTokens: 100000 }));
    run(record({ contextTokens: undefined }));
    run(record({ agent: { status: 'running' } as never }));
    run(record({ compacting: true }));
    harness(0).run(record());
    expect(compact).not.toHaveBeenCalled();
  });

  it('压缩没成功时保留计数，下一轮还会再试', async () => {
    const { run } = harness(120000, { ok: false, reason: 'busy' });
    const r = record();
    run(r);
    await vi.waitFor(() => expect(r.compacting).toBe(false));
    expect(r.contextTokens).toBe(130000);
  });
});
