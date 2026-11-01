import { describe, expect, it, vi } from 'vitest';
import { runInboundTurn } from './agent-turn.ts';

describe('runInboundTurn', () => {
  it('前置处理已经超时的消息不再进入 agent', async () => {
    const controller = new AbortController();
    controller.abort();
    const agent = { followup: vi.fn(), cancel: vi.fn(), whenIdle: vi.fn() };
    const submitted = vi.fn();
    await runInboundTurn(agent, 'stale', controller.signal, submitted);
    expect(agent.followup).not.toHaveBeenCalled();
    expect(agent.cancel).not.toHaveBeenCalled();
    expect(submitted).not.toHaveBeenCalled();
  });

  it('正常收敛后解绑取消监听，旧 ctx 不会取消后来的任务', async () => {
    const controller = new AbortController();
    const agent = { followup: vi.fn(), cancel: vi.fn(), whenIdle: vi.fn(async () => {}) };
    const submitted = vi.fn();
    await runInboundTurn(agent, 'hello', controller.signal, submitted);
    expect(agent.followup).toHaveBeenCalledWith('hello');
    expect(submitted).toHaveBeenCalledTimes(1);
    controller.abort();
    expect(agent.cancel).not.toHaveBeenCalled();
  });

  it('whenIdle 拒绝也解绑监听', async () => {
    const controller = new AbortController();
    const agent = { followup: vi.fn(), cancel: vi.fn(), whenIdle: async () => { throw Error('idle failed'); } };
    await expect(runInboundTurn(agent, 'hello', controller.signal, () => {})).rejects.toThrow('idle failed');
    controller.abort();
    expect(agent.cancel).not.toHaveBeenCalled();
  });
});
