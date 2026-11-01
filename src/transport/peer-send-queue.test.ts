import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PeerSendQueue } from './peer-send-queue.ts';
import type { ReplyTarget } from '../types.ts';

const target: ReplyTarget = { scope: 'group', targetId: 'g', msgId: 'm' };
const queues: PeerSendQueue[] = [];
function queue() {
  const q = new PeerSendQueue();
  queues.push(q);
  return q;
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(10000); });
afterEach(() => { for (const q of queues.splice(0)) q.dispose(); vi.useRealTimers(); });

describe('PeerSendQueue', () => {
  it('等语音真正发送完成，再留出间隔发送模型的原文', async () => {
    const q = queue(), seen: string[] = [];
    let resolve!: () => void;
    const sent = new Promise<void>((done) => { resolve = done; });
    const voice = q.run(target, async () => { seen.push('voice-start'); await sent; seen.push('voice-end'); }, true);
    const text = q.run(target, async () => { seen.push('这句话用户仍然要看见'); });
    await vi.advanceTimersByTimeAsync(3000);
    expect(seen).toEqual(['voice-start']);
    resolve();
    await voice;
    await vi.advanceTimersByTimeAsync(1199);
    expect(seen).toEqual(['voice-start', 'voice-end']);
    await vi.advanceTimersByTimeAsync(1);
    await text;
    expect(seen).toEqual(['voice-start', 'voice-end', '这句话用户仍然要看见']);
  });

  it('语音队列暂时空了也保留间隔；不同 peer 不互相阻塞', async () => {
    const q = queue();
    await q.run(target, async () => {}, true);
    await vi.advanceTimersByTimeAsync(500);
    const text = vi.fn(async () => {}), other = vi.fn(async () => {});
    const pending = q.run({ ...target, msgId: 'new-message' }, text);
    await q.run({ ...target, targetId: 'other-group' }, other);
    expect(other).toHaveBeenCalledTimes(1);
    expect(text).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(700);
    await pending;
    expect(text).toHaveBeenCalledTimes(1);
  });

  it('发送失败不锁死队列；未发送成功的语音不额外延迟后续错误说明', async () => {
    const q = queue();
    const failed = q.run(target, async () => { throw Error('voice failed'); }, true);
    const rejection = expect(failed).rejects.toThrow('voice failed');
    const text = vi.fn(async () => {});
    await q.run(target, text);
    await rejection;
    expect(Date.now()).toBe(10000);
    expect(text).toHaveBeenCalledTimes(1);
  });

  it('普通文字、媒体的网络调用串行，保留调用顺序', async () => {
    const q = queue(), seen: string[] = [];
    let finish!: () => void;
    const first = q.run(target, async () => { seen.push('text'); await new Promise<void>((r) => { finish = r; }); });
    const second = q.run(target, async () => { seen.push('image'); });
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual(['text']);
    finish();
    await Promise.all([first, second]);
    expect(seen).toEqual(['text', 'image']);
  });

  it('流式帧也不能越过语音间隔，complete 排在 update 后面', async () => {
    const q = queue();
    await q.run(target, async () => {}, true);
    const stream = { update: vi.fn(async () => {}), complete: vi.fn(async () => {}) };
    const open = vi.fn(() => stream), writer = q.stream(target, open);
    const update = writer.update('后续文字'), complete = writer.complete();
    await vi.advanceTimersByTimeAsync(1199);
    expect(open).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await Promise.all([update, complete]);
    expect(stream.update).toHaveBeenCalledWith('后续文字');
    expect(stream.complete).toHaveBeenCalledTimes(1);
    expect(stream.update.mock.invocationCallOrder[0]).toBeLessThan(stream.complete.mock.invocationCallOrder[0]!);
  });

  it('卸载时清理等待，旧实例不再发迟到的文字', async () => {
    const q = queue();
    await q.run(target, async () => {}, true);
    const text = vi.fn(async () => {});
    const pending = q.run(target, text);
    const rejected = expect(pending).rejects.toThrow('send queue disposed');
    await vi.advanceTimersByTimeAsync(0);
    q.dispose();
    await rejected;
    await vi.advanceTimersByTimeAsync(2000);
    expect(text).not.toHaveBeenCalled();
    await expect(q.run(target, text)).rejects.toThrow('send queue disposed');
  });
});
