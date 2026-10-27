import { describe, it, expect, vi } from 'vitest';
import type { QQBot } from '@tencent-connect/qqbot-nodejs';
import { ReplyLimiter } from './reply-limiter.ts';
import { cacheMsgId, cacheEventId } from './msgid-cache.ts';
import { resolveReplyTarget, sendResolvedMarkdown } from './reply-target.ts';
import type { ReplyTarget } from '../types.ts';

function makeTarget(msgId?: string, targetId = 'peer-1'): ReplyTarget {
  return { scope: 'c2c', targetId, msgId };
}

describe('resolveReplyTarget', () => {
  it('prefers explicit target.msgId', () => {
    const limiter = new ReplyLimiter({ limit: 4 });
    const result = resolveReplyTarget(makeTarget('m1'), limiter, true);
    expect(result.msgId).toBe('m1');
    expect(result.eventId).toBeUndefined();
  });

  it('falls back to cached msgId after target.msgId is exhausted', () => {
    const limiter = new ReplyLimiter({ limit: 1 });
    cacheMsgId('c2c', 'peer-2', 'cached-1');
    limiter.record('m-exhausted');
    const result = resolveReplyTarget(makeTarget('m-exhausted', 'peer-2'), limiter, true);
    expect(result.msgId).toBe('cached-1');
  });

  it('skips explicit group msgId past the 5-minute passive window', () => {
    const limiter = new ReplyLimiter({ limit: 4 });
    cacheMsgId('group', 'grp-1', 'fresh');
    const stale: ReplyTarget = {
      scope: 'group', targetId: 'grp-1', msgId: 'stale', receivedAt: Date.now() - 5 * 60 * 1000 - 1,
    };
    expect(resolveReplyTarget(stale, limiter, true).msgId).toBe('fresh');
  });

  it('keeps explicit group msgId inside the passive window', () => {
    const limiter = new ReplyLimiter({ limit: 4 });
    cacheMsgId('group', 'grp-2', 'newer');
    const target: ReplyTarget = {
      scope: 'group', targetId: 'grp-2', msgId: 'own', receivedAt: Date.now() - 4 * 60 * 1000,
    };
    expect(resolveReplyTarget(target, limiter, true).msgId).toBe('own');
  });

  it('falls back to proactive when the only group msgId is stale', () => {
    const limiter = new ReplyLimiter({ limit: 4 });
    const stale: ReplyTarget = {
      scope: 'group', targetId: 'grp-3', msgId: 'stale', receivedAt: Date.now() - 6 * 60 * 1000,
    };
    const result = resolveReplyTarget(stale, limiter, true);
    expect(result.msgId).toBeUndefined();
    expect(result.eventId).toBeUndefined();
  });

  it('does not age-check c2c msgIds', () => {
    const limiter = new ReplyLimiter({ limit: 4 });
    const target: ReplyTarget = { scope: 'c2c', targetId: 'peer-9', msgId: 'old', receivedAt: Date.now() - 6 * 60 * 1000 };
    expect(resolveReplyTarget(target, limiter, true).msgId).toBe('old');
  });

  it('skips event candidates when allowEvent is false', () => {
    const limiter = new ReplyLimiter({ limit: 4 });
    cacheEventId('c2c', 'peer-3', 'evt-1');
    const result = resolveReplyTarget(makeTarget(undefined, 'peer-3'), limiter, false);
    expect(result.eventId).toBeUndefined();
    expect(result.msgId).toBeUndefined();
  });

  it('returns eventId when allowEvent is true', () => {
    const limiter = new ReplyLimiter({ limit: 4 });
    cacheEventId('c2c', 'peer-4', 'evt-2');
    const result = resolveReplyTarget(makeTarget(undefined, 'peer-4'), limiter, true);
    expect(result.eventId).toBe('INTERACTION_CREATE:evt-2');
    expect(result.msgId).toBeUndefined();
  });
});

describe('sendResolvedMarkdown', () => {
  it('fills event_id via bot.send when target has eventId', async () => {
    const bot = {
      send: vi.fn(async () => ({})),
      sendMarkdown: vi.fn(async () => ({})),
    } as unknown as QQBot;
    const target: ReplyTarget = { scope: 'c2c', targetId: 'p', eventId: 'INTERACTION_CREATE:evt' };
    await sendResolvedMarkdown(bot, target, 'hello');
    expect(bot.send).toHaveBeenCalledWith(expect.objectContaining({
      extra: { event_id: 'INTERACTION_CREATE:evt' },
    }));
    expect(bot.sendMarkdown).not.toHaveBeenCalled();
  });

  it('uses sendMarkdown for msgId targets', async () => {
    const bot = {
      send: vi.fn(async () => ({})),
      sendMarkdown: vi.fn(async () => ({})),
    } as unknown as QQBot;
    const target: ReplyTarget = { scope: 'c2c', targetId: 'p', msgId: 'm1' };
    await sendResolvedMarkdown(bot, target, 'hello');
    expect(bot.sendMarkdown).toHaveBeenCalledWith(target, 'hello', undefined);
    expect(bot.send).not.toHaveBeenCalled();
  });
});
