import { describe, it, expect, vi } from 'vitest';
import type { MiddlewareContext } from '@tencent-connect/qqbot-nodejs';
import { REPLY_JUDGE_DEFAULTS, type ImQQBotConfig } from '../config.ts';
import type { SessionManager } from '../session/index.ts';
import type { Logger } from '../types.ts';
import { getEngagementTracker } from '../features/reply-desire.ts';
import { JudgeQueue } from '../features/reply-judge.ts';
import { replyDecider, type JudgeDeps } from './reply-decider.ts';

const config = {
  debug: false,
  dnd: { interjections: true },
  replyDesire: { enabled: true, threshold: 0.6, names: ['小d'], engagedMs: 60_000, engagedMaxTurns: 8 },
} as unknown as ImQQBotConfig;
const manager = {} as SessionManager;
const dndGroups = new Set(['dnd1']);
const dndManager = {
  sessionKey: (_scope: string, id: string) => id,
  dndService: { active: (key: string) => (dndGroups.has(key) ? {} : undefined) },
} as unknown as SessionManager;
const logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
const STICKER = `<faceType=6,faceId="0",ext="${Buffer.from('{"text":""}').toString('base64')}">`;

function makeCtx(groupId: string, senderId: string, content: string, wasMentioned = false, attachments?: unknown[]) {
  const stop = vi.fn();
  const ctx = {
    message: { kind: 'group', groupOpenid: groupId, senderId, content, attachments },
    state: { mention: { wasMentioned, implicit: false, shouldAnswer: wasMentioned, reason: wasMentioned ? 'passthrough' : 'no_mention' } },
    stop,
  } as unknown as MiddlewareContext;
  return { ctx, stop };
}

async function run(ctx: MiddlewareContext, mgr: SessionManager = manager): Promise<boolean> {
  let passed = false;
  await replyDecider(config, mgr, logger)(ctx, async () => { passed = true; });
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

  it('开团期间 @ 不开窗口，玩家间的闲聊不插嘴', async () => {
    expect(await run(makeCtx('dnd1', 'u1', '我攻击哥布林', true).ctx, dndManager)).toBe(true);
    expect(await run(makeCtx('dnd1', 'u1', '我们先商量一下').ctx, dndManager)).toBe(false);
    expect(await run(makeCtx('dnd1', 'u1', '小d 这怪多少血').ctx, dndManager)).toBe(true);
  });

  describe('模型打分', () => {
    const judgeConfig = { ...REPLY_JUDGE_DEFAULTS, enabled: true, debounceMs: 20, maxWaitMs: 1000 };
    const judgeCfg = {
      ...config,
      appId: 'reply-decider-test',
      model: 'm',
      provider: 'p',
      replyDesire: { ...config.replyDesire, judge: judgeConfig },
    } as unknown as ImQQBotConfig;
    const judgeManager = { getEffectiveModel: () => undefined } as unknown as SessionManager;

    function deps(desire: number | undefined) {
      const score = vi.fn(async () => desire);
      return { score, deps: { judge: { score }, queue: new JudgeQueue(() => judgeConfig) } as JudgeDeps };
    }
    async function runJudge(ctx: MiddlewareContext, d: JudgeDeps, mgr: SessionManager = judgeManager): Promise<boolean> {
      let passed = false;
      await replyDecider(judgeCfg, mgr, logger, d)(ctx, async () => { passed = true; });
      return passed;
    }

    it('连着两条普通文字只给最后一条打分，分够就当隐式 @ 放行', async () => {
      const { score, deps: d } = deps(0.9);
      const first = makeCtx('j1', 'u1', '有人知道这个报错吗');
      const second = makeCtx('j1', 'u2', 'TypeError: x is undefined');
      const [a, b] = await Promise.all([runJudge(first.ctx, d), runJudge(second.ctx, d)]);
      expect(a).toBe(false);
      expect(first.stop).toHaveBeenCalledWith('reply-desire:superseded');
      expect(b).toBe(true);
      expect(score).toHaveBeenCalledTimes(1);
      expect(second.ctx.state.replyDesire).toMatchObject({ score: 0.9, reasons: ['judge'] });
    });

    it('分不够、打分失败都不接', async () => {
      expect(await runJudge(makeCtx('j2', 'u1', '今天好热').ctx, deps(0.3).deps)).toBe(false);
      expect(await runJudge(makeCtx('j3', 'u1', '今天好热').ctx, deps(undefined).deps)).toBe(false);
    });

    it('语气词、开团期间不调模型', async () => {
      const { score, deps: d } = deps(1);
      expect(await runJudge(makeCtx('j4', 'u1', '哈哈哈').ctx, d)).toBe(false);
      const dndJudgeManager = { ...dndManager, getEffectiveModel: () => undefined } as unknown as SessionManager;
      expect(await runJudge(makeCtx('dnd1', 'u1', '我们先商量一下').ctx, d, dndJudgeManager)).toBe(false);
      expect(score).not.toHaveBeenCalled();
    });

    it('等打分时有人 @ bot：候选作废', async () => {
      const { score, deps: d } = deps(1);
      const pending = runJudge(makeCtx('j5', 'u1', '今天好热').ctx, d);
      expect(await runJudge(makeCtx('j5', 'u2', '在吗', true).ctx, d)).toBe(true);
      expect(await pending).toBe(false);
      expect(score).not.toHaveBeenCalled();
    });
  });

  it('bot 刚说完话有人甩表情包：放行并标成表情包回应，同一个人再甩就不接', async () => {
    getEngagementTracker().touch('g3', Date.now(), 60_000);
    const pic = [{ content_type: 'image/png', filename: 'ABC.png' }];
    const first = makeCtx('g3', 'u9', STICKER, false, pic);
    expect(await run(first.ctx)).toBe(true);
    expect(first.ctx.state.replyDesire).toMatchObject({ mode: 'sticker' });
    expect(await run(makeCtx('g3', 'u9', STICKER, false, pic).ctx)).toBe(false);
  });
});
