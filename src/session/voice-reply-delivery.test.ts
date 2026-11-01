import { describe, expect, it, vi } from 'vitest';
import { SessionManager } from './session-manager.ts';

interface Execution {
  name: string;
  arguments: unknown;
  agent?: unknown;
  signal: AbortSignal;
  concludeTurn?: () => void;
}
type Result = { isError?: boolean; error?: unknown };
type Handler = (exec: Execution, next: () => Promise<Result>) => Promise<Result>;

function setup() {
  const agent = {};
  const record: { sessionKey: string; replyTarget: { scope: string; targetId: string }; voiceReplySentAt?: number } = {
    sessionKey: 'qqbot:group:g', replyTarget: { scope: 'group', targetId: 'g' },
  };
  let handler!: Handler;
  const manager = {
    ctx: { on: (event: string, callback: Handler) => { expect(event).toBe('tools/execute'); handler = callback; } },
    logger: { info: vi.fn(), warn: vi.fn() },
    findByAgent: (value: unknown) => value === agent ? record : undefined,
  };
  (SessionManager.prototype as unknown as { registerVoiceReplyDelivery(): void }).registerVoiceReplyDelivery.call(manager);
  const exec: Execution = { name: 'qqbot_speak', arguments: { text: '你好' }, agent,
    signal: new AbortController().signal, concludeTurn: vi.fn() };
  return { handler, exec, manager, record };
}

describe('SessionManager voice reply delivery', () => {
  it('实际发送成功后标记独立文字投递，保留模型继续说话的机会', async () => {
    const { handler, exec, record } = setup();
    let resolve!: (value: Result) => void;
    const next = new Promise<Result>((done) => { resolve = done; });
    const pending = handler(exec, () => next);
    expect(exec.concludeTurn).not.toHaveBeenCalled();
    expect(record.voiceReplySentAt).toBeUndefined();
    const result = { isError: false };
    resolve(result);
    expect(await pending).toBe(result);
    expect(record.voiceReplySentAt).toEqual(expect.any(Number));
    expect(exec.concludeTurn).not.toHaveBeenCalled();
  });

  it.each(['voice.mp3', 'VOICE.WAV', 'record.silk'])('send_file 发语音 %s 后同样保留文字补充', async (file) => {
    const { handler, exec, record } = setup();
    exec.name = 'qqbot_send_file';
    exec.arguments = { file_path: 'C:/tmp/' + file };
    await handler(exec, async () => ({}));
    expect(record.voiceReplySentAt).toEqual(expect.any(Number));
    expect(exec.concludeTurn).not.toHaveBeenCalled();
  });

  it.each([{ isError: true }, { error: { message: 'send failed' } }])('发送失败允许模型继续处理：%j', async (failure) => {
    const { handler, exec, record } = setup();
    await handler(exec, async () => failure);
    expect(exec.concludeTurn).not.toHaveBeenCalled();
    expect(record.voiceReplySentAt).toBeUndefined();
  });

  it('抛错、取消都不把回合误报成语音成功', async () => {
    const { handler, exec, record } = setup();
    await expect(handler(exec, async () => { throw Error('network'); })).rejects.toThrow('network');
    exec.signal = AbortSignal.abort();
    await handler(exec, async () => ({}));
    expect(exec.concludeTurn).not.toHaveBeenCalled();
    expect(record.voiceReplySentAt).toBeUndefined();
  });

  it('只标记向当前 QQ 会话成功发送的语音', async () => {
    const { handler, exec, record } = setup();
    await handler({ ...exec, agent: {} }, async () => ({}));
    await handler({ ...exec, arguments: { target: 'group:other' } }, async () => ({}));
    for (const file_path of ['C:/image.png', 'C:/document.pdf']) {
      await handler({ ...exec, name: 'qqbot_send_file', arguments: { file_path } }, async () => ({}));
    }
    expect(exec.concludeTurn).not.toHaveBeenCalled();
    expect(record.voiceReplySentAt).toBeUndefined();
    await handler({ ...exec, arguments: { target: 'group:g' } }, async () => ({}));
    expect(record.voiceReplySentAt).toEqual(expect.any(Number));
    expect(exec.concludeTurn).not.toHaveBeenCalled();
  });

  it('发送语音后仍允许模型继续执行普通工具', async () => {
    const { handler, exec } = setup();
    await handler(exec, async () => ({}));
    const nextExec = { ...exec, name: 'read', concludeTurn: vi.fn() };
    const next = vi.fn(async () => ({}));
    await handler(nextExec, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(nextExec.concludeTurn).not.toHaveBeenCalled();
  });
});
