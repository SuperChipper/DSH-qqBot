import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createOutboundHandler } from './outbound.ts';
import type { QQBotSender, StreamSessionLike } from './outbound-buffer.ts';
import type { SessionManager, SessionRecord } from '../session/index.ts';
import type { ImQQBotConfig } from '../config.ts';
import type { Logger, ReplyTarget } from '../types.ts';

function createLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function createSession(): StreamSessionLike {
  return { update: vi.fn().mockResolvedValue(undefined), complete: vi.fn().mockResolvedValue(undefined) };
}

function createBot(session: StreamSessionLike): QQBotSender {
  return {
    sendMarkdown: vi.fn().mockResolvedValue(undefined),
    openStream: vi.fn(() => session),
  };
}

const c2cTarget: ReplyTarget = { scope: 'c2c', targetId: 'user1', msgId: 'msg1' };
const groupTarget: ReplyTarget = { scope: 'group', targetId: 'group1', msgId: 'msg1' };

function createRecord(target: ReplyTarget, sessionId = 'sess-qq'): SessionRecord {
  return {
    sessionKey: 'k',
    sessionId,
    replyTarget: target,
    agent: {},
    handle: {},
    createdAt: 0,
    lastActiveAt: 0,
  } as unknown as SessionRecord;
}

function createConfig(overrides?: Partial<ImQQBotConfig>): ImQQBotConfig {
  return {
    streaming: true,
    textChunkLimit: 4500,
    showToolResults: false,
    ...overrides,
  } as unknown as ImQQBotConfig;
}

/** 组装 handler：manager 按 sessionId 返回 record（默认 c2c 私聊） */
function setup(opts?: { record?: SessionRecord | undefined; config?: ImQQBotConfig }) {
  const session = createSession();
  const bot = createBot(session);
  const record = 'record' in (opts ?? {}) ? opts!.record : createRecord(c2cTarget);
  const manager = {
    findBySessionId: vi.fn((id: string) => (id === 'sess-qq' ? record : undefined)),
    addUnsent: vi.fn(),
  } as unknown as SessionManager;
  const outbound = createOutboundHandler(manager, bot, opts?.config ?? createConfig(), createLogger());
  return { outbound, bot, session, manager };
}

const delta = (attemptId: string, text: string) => ({ kind: 'text-delta' as const, attemptId, text });
const start = (attemptId: string) => ({ kind: 'attempt-start' as const, attemptId });

describe('OutboundRouter.routeStreamFrame', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('流式帧路由到会话 buffer：openStream + update', async () => {
    const { outbound, bot, session } = setup();

    outbound.routeStreamFrame('sess-qq', start('a1'));
    outbound.routeStreamFrame('sess-qq', delta('a1', 'hello'));
    await vi.advanceTimersByTimeAsync(200);

    expect(bot.openStream).toHaveBeenCalledTimes(1);
    expect(session.update).toHaveBeenCalledWith('hello');
  });

  it('attempt 切换 reset：同一条流式消息被新内容全量重写', async () => {
    const { outbound, bot, session } = setup();

    outbound.routeStreamFrame('sess-qq', start('a1'));
    outbound.routeStreamFrame('sess-qq', delta('a1', 'partial'));
    await vi.advanceTimersByTimeAsync(200);
    expect(session.update).toHaveBeenCalledWith('partial');

    outbound.routeStreamFrame('sess-qq', start('a2'));
    outbound.routeStreamFrame('sess-qq', delta('a2', 'full'));
    await vi.advanceTimersByTimeAsync(200);

    expect(bot.openStream).toHaveBeenCalledTimes(1); // 流式会话复用
    expect(session.update).toHaveBeenNthCalledWith(2, 'full'); // 全量替换
  });

  it('agent replacement（attemptId 重叠）：start 帧无条件重置', async () => {
    const { outbound, bot, session } = setup();

    outbound.routeStreamFrame('sess-qq', start('sess-qq:1'));
    outbound.routeStreamFrame('sess-qq', delta('sess-qq:1', 'stale'));
    await vi.advanceTimersByTimeAsync(200);
    expect(session.update).toHaveBeenCalledWith('stale');

    // agent replacement 后 attempt 计数重启，attemptId 与旧 agent 相同
    outbound.routeStreamFrame('sess-qq', start('sess-qq:1'));
    outbound.routeStreamFrame('sess-qq', delta('sess-qq:1', 'fresh'));
    await vi.advanceTimersByTimeAsync(200);

    expect(bot.openStream).toHaveBeenCalledTimes(1);
    expect(session.update).toHaveBeenNthCalledWith(2, 'fresh'); // 全量替换，无残留
  });

  it('迟到帧（旧 attemptId）被丢弃', async () => {
    const { outbound, session } = setup();

    outbound.routeStreamFrame('sess-qq', start('a1'));
    outbound.routeStreamFrame('sess-qq', delta('a1', 'x'));
    outbound.routeStreamFrame('sess-qq', start('a2'));
    outbound.routeStreamFrame('sess-qq', delta('a1', 'late')); // a1 的迟到帧
    await vi.advanceTimersByTimeAsync(200);

    expect(session.update).not.toHaveBeenCalledWith(expect.stringContaining('late'));
  });

  it('非 QQ 会话（无 record）忽略流式帧', async () => {
    const { outbound, bot } = setup({ record: undefined });

    outbound.routeStreamFrame('sess-web', start('a1'));
    outbound.routeStreamFrame('sess-web', delta('a1', 'hello'));
    await vi.advanceTimersByTimeAsync(200);

    expect(bot.openStream).not.toHaveBeenCalled();
    expect(bot.sendMarkdown).not.toHaveBeenCalled();
  });

  it('群聊不流式：帧累积后由 assistant/message 静态发送', async () => {
    const { outbound, bot } = setup({ record: createRecord(groupTarget) });

    outbound.routeStreamFrame('sess-qq', start('a1'));
    outbound.routeStreamFrame('sess-qq', delta('a1', 'group reply'));
    await vi.advanceTimersByTimeAsync(200);

    outbound.routeSessionEvent({ header: { id: 'sess-qq' } }, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: 'group reply' }] } },
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(bot.openStream).not.toHaveBeenCalled();
    expect(bot.sendMarkdown).toHaveBeenCalledWith(groupTarget, 'group reply');
  });

  it('群聊 buffer 静态发送失败：原文挂起到下一次用户消息', async () => {
    const { outbound, bot, manager } = setup({ record: createRecord(groupTarget) });
    vi.mocked(bot.sendMarkdown).mockRejectedValue(new Error('msg_id expired'));

    outbound.routeStreamFrame('sess-qq', start('a1'));
    outbound.routeStreamFrame('sess-qq', delta('a1', 'late reply'));
    outbound.routeSessionEvent({ header: { id: 'sess-qq' } }, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: 'late reply' }] } },
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(manager.addUnsent).toHaveBeenCalledWith('k', 'late reply');
  });

  it('assistant/message 到达时收尾流式：complete 且不重复静态发送', async () => {
    const { outbound, bot, session } = setup();

    outbound.routeStreamFrame('sess-qq', start('a1'));
    outbound.routeStreamFrame('sess-qq', delta('a1', 'hello'));
    await vi.advanceTimersByTimeAsync(200);

    outbound.routeSessionEvent({ header: { id: 'sess-qq' } }, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: 'hello' }] } },
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(session.complete).toHaveBeenCalledTimes(1);
    expect(bot.sendMarkdown).not.toHaveBeenCalled();
  });

  describe('caption 复读去重', () => {
    const sess = { header: { id: 'sess-qq' } };
    const caption = '才不是大肥鱼！这张给你';
    const sendWithCaption = (outbound: ReturnType<typeof setup>['outbound'], callId = 'c1') => {
      outbound.routeSessionEvent(sess, {
        type: 'tool/call',
        data: { callId, name: 'qqbot_send_file', arguments: JSON.stringify({ file_path: 'C:/a.png', caption }) },
      });
      outbound.routeSessionEvent(sess, { type: 'tool/result', data: { message: { source: { callId } } } });
    };

    it('群聊：发图后复读 caption 的 assistant/message 不再发送', async () => {
      const { outbound, bot } = setup({ record: createRecord(groupTarget) });

      sendWithCaption(outbound);
      outbound.routeStreamFrame('sess-qq', start('a1'));
      outbound.routeStreamFrame('sess-qq', delta('a1', caption));
      outbound.routeSessionEvent(sess, {
        type: 'assistant/message',
        data: { message: { content: [{ type: 'text', text: caption }] } },
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(bot.sendMarkdown).not.toHaveBeenCalled();
    });

    it('私聊流式：复读不开流式气泡', async () => {
      const { outbound, bot } = setup();

      sendWithCaption(outbound);
      outbound.routeStreamFrame('sess-qq', start('a1'));
      outbound.routeStreamFrame('sess-qq', delta('a1', '才不是大肥鱼'));
      await vi.advanceTimersByTimeAsync(200);
      outbound.routeStreamFrame('sess-qq', delta('a1', '！这张给你'));
      outbound.routeSessionEvent(sess, { type: 'turn/end', data: { reason: {} } });
      await vi.advanceTimersByTimeAsync(200);

      expect(bot.openStream).not.toHaveBeenCalled();
      expect(bot.sendMarkdown).not.toHaveBeenCalled();
    });

    it('caption 之外的新内容照常发送', async () => {
      const { outbound, bot } = setup({ record: createRecord(groupTarget) });

      sendWithCaption(outbound);
      outbound.routeSessionEvent(sess, {
        type: 'assistant/message',
        data: { message: { content: [{ type: 'text', text: `${caption}\n\n顺便说下明天放假` }] } },
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(bot.sendMarkdown).toHaveBeenCalledWith(groupTarget, '顺便说下明天放假');
    });

    it('发送失败的 caption 不参与去重；turn/end 后清空', async () => {
      const { outbound, bot } = setup({ record: createRecord(groupTarget) });
      const message = { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: caption }] } } };

      outbound.routeSessionEvent(sess, {
        type: 'tool/call',
        data: { callId: 'bad', name: 'qqbot_send_file', arguments: JSON.stringify({ file_path: 'C:/a.png', caption }) },
      });
      outbound.routeSessionEvent(sess, {
        type: 'tool/result',
        data: { message: { source: { callId: 'bad' } }, error: { name: 'Error', code: 'TOOL_FAILED' } },
      });
      outbound.routeSessionEvent(sess, message);
      await vi.advanceTimersByTimeAsync(0);
      const captionSends = () => vi.mocked(bot.sendMarkdown).mock.calls.filter(([, text]) => text === caption).length;
      expect(captionSends()).toBe(1);

      sendWithCaption(outbound);
      outbound.routeSessionEvent(sess, { type: 'turn/end', data: { reason: {} } });
      outbound.routeSessionEvent(sess, message);
      await vi.advanceTimersByTimeAsync(0);
      expect(captionSends()).toBe(2);
    });
  });

  it('assistant/message 的 usage 记为会话上下文大小（输入 + 缓存命中 + 输出）', async () => {
    const record = createRecord(groupTarget);
    const { outbound } = setup({ record });
    outbound.routeSessionEvent({ header: { id: 'sess-qq' } }, {
      type: 'assistant/message',
      data: {
        message: { content: [{ type: 'text', text: 'hi' }] },
        usage: { inputTokens: 419, outputTokens: 206, cacheReadTokens: 64896 },
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(record.contextTokens).toBe(419 + 206 + 64896);
  });

  describe('工具报错展示', () => {
    const sess = { header: { id: 'sess-qq' } };
    const failWebFetch = (outbound: ReturnType<typeof setup>['outbound']) => {
      outbound.routeSessionEvent(sess, {
        type: 'tool/call',
        data: { callId: 'w1', name: 'web_fetch', arguments: JSON.stringify({ url: 'http://app.myzaker.com/x' }) },
      });
      outbound.routeSessionEvent(sess, {
        type: 'tool/result',
        data: { message: { source: { callId: 'w1' } }, error: { name: 'WebError', code: 'WEB_REDIRECT_BLOCKED' } },
      });
    };

    it('群聊默认不发工具报错', async () => {
      const { outbound, bot } = setup({ record: createRecord(groupTarget) });
      failWebFetch(outbound);
      await vi.advanceTimersByTimeAsync(0);
      expect(bot.sendMarkdown).not.toHaveBeenCalled();
    });

    it('私聊照常发工具报错', async () => {
      const { outbound, bot } = setup();
      failWebFetch(outbound);
      await vi.advanceTimersByTimeAsync(0);
      expect(bot.sendMarkdown).toHaveBeenCalledTimes(1);
    });

    it('开了 showToolResults 时群聊也发', async () => {
      const { outbound, bot } = setup({ record: createRecord(groupTarget), config: createConfig({ showToolResults: true }) });
      failWebFetch(outbound);
      await vi.advanceTimersByTimeAsync(0);
      expect(bot.sendMarkdown).toHaveBeenCalledTimes(1);
    });
  });

  it('旧通道回归：durable assistant/chunk 事件仍进 buffer', async () => {
    const { outbound, bot, session } = setup();

    outbound.routeSessionEvent({ header: { id: 'sess-qq' } }, {
      type: 'assistant/chunk',
      data: { chunk: { type: 'text-delta', text: 'legacy' } },
    });
    await vi.advanceTimersByTimeAsync(200);

    expect(bot.openStream).toHaveBeenCalledTimes(1);
    expect(session.update).toHaveBeenCalledWith('legacy');
  });
});
