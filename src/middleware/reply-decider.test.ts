import { describe, it, expect, vi } from 'vitest';
import type { MiddlewareContext } from '@tencent-connect/qqbot-nodejs';
import type { ImQQBotConfig } from '../config.ts';
import type { SessionManager } from '../session/index.ts';
import type { Logger } from '../types.ts';
import { replyDecider } from './reply-decider.ts';

const config = {
  debug: false,
  dnd: { interjections: true },
  replyDesire: { enabled: true, threshold: 0.6, names: ['小d'], engagedMs: 60_000, engagedMaxTurns: 8 },
} as unknown as ImQQBotConfig;
const manager = {} as SessionManager;
const logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;

function makeCtx(groupId: string, senderId: string, content: string, wasMentioned = false) {
  const stop = vi.fn();
  const ctx = {
    message: { kind: 'group', groupOpenid: groupId, senderId, content },
    state: { mention: { wasMentioned, implicit: false, shouldAnswer: wasMentioned, reason: wasMentioned ? 'passthrough' : 'no_mention' } },
    stop,
  } as unknown as MiddlewareContext;
  return { ctx, stop };
}

async function run(ctx: MiddlewareContext): Promise<boolean> {
  let passed = false;
  await replyDecider(config, manager, logger)(ctx, async () => { passed = true; });
  return passed;
}

describe('replyDecider', () => {
  it('低分消息被拦下，点名昵称当作隐式 @ 放行', async () => {
    const low = makeCtx('g1', 'u1', '今天天气不错');
    expect(await run(low.ctx)).toBe(false);
    expect(low.stop).toHaveBeenCalledWith('reply-desire:low');

    const named = makeCtx('g1', 'u1', '小d 你怎么看');
    expect(await run(named.ctx)).toBe(true);
    expect(named.ctx.state.mention).toMatchObject({ implicit: true, shouldAnswer: true, wasMentioned: false });
  });

  it('被 @ 后开对话窗口，同一个人接着说不用再 @', async () => {
    expect(await run(makeCtx('g2', 'u1', '在吗', true).ctx)).toBe(true);
    expect(await run(makeCtx('g2', 'u1', '我觉得也是').ctx)).toBe(true);
    expect(await run(makeCtx('g2', 'u2', '我觉得也是').ctx)).toBe(false);
  });
});
