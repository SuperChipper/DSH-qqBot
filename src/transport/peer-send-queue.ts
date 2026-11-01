import type { ReplyTarget } from '../types.ts';
import type { StreamSessionLike } from './outbound-buffer.ts';

interface PeerQueue {
  tail: Promise<void>;
  afterVoiceAt: number;
  cleanup?: ReturnType<typeof setTimeout>;
}

/** 网络投递串行化独立于 agent 回合；语音完成后给下一条消息留出间隔。 */
export class PeerSendQueue {
  private readonly peers = new Map<string, PeerQueue>();
  private readonly lifetime = new AbortController();

  public constructor(private readonly voiceGapMs = 1200) {}

  public run<T>(target: ReplyTarget, send: () => Promise<T>, voice = false): Promise<T> {
    if (this.lifetime.signal.aborted) return Promise.reject(new Error('send queue disposed'));
    const key = `${target.scope}:${target.targetId}`;
    let state = this.peers.get(key);
    if (state === undefined) {
      state = { tail: Promise.resolve(), afterVoiceAt: 0 };
      this.peers.set(key, state);
    }
    const peer = state;
    if (peer.cleanup !== undefined) clearTimeout(peer.cleanup);
    const result = peer.tail.then(async () => {
      this.lifetime.signal.throwIfAborted();
      await this.wait(peer.afterVoiceAt - Date.now());
      this.lifetime.signal.throwIfAborted();
      const value = await send();
      if (voice) peer.afterVoiceAt = Date.now() + this.voiceGapMs;
      return value;
    });
    // 失败只影响自己的消息，不能使整个聊天的后续投递永久拒绝。
    const settled = result.then(() => {}, () => {});
    peer.tail = settled;
    void settled.then(() => {
      if (peer.tail !== settled) return;
      const remaining = peer.afterVoiceAt - Date.now();
      if (remaining > 0 && !this.lifetime.signal.aborted) {
        peer.cleanup = setTimeout(() => {
          if (peer.tail === settled) this.peers.delete(key);
        }, remaining);
        peer.cleanup.unref?.();
      } else {
        this.peers.delete(key);
      }
    });
    return result;
  }

  /** 流式帧也走同一队列，否则它会越过刚发出的语音。 */
  public stream(target: ReplyTarget, open: () => StreamSessionLike): StreamSessionLike {
    let session: StreamSessionLike | undefined;
    return {
      update: (content) => this.run(target, () => {
        session ??= open();
        return session.update(content);
      }),
      complete: () => this.run(target, () => session?.complete() ?? Promise.resolve()),
    };
  }

  private wait(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const abort = () => {
        clearTimeout(timer);
        reject(new Error('send queue disposed'));
      };
      const timer = setTimeout(() => {
        this.lifetime.signal.removeEventListener('abort', abort);
        resolve();
      }, ms);
      this.lifetime.signal.addEventListener('abort', abort, { once: true });
    });
  }

  public dispose(): void {
    this.lifetime.abort();
    for (const peer of this.peers.values()) {
      if (peer.cleanup !== undefined) clearTimeout(peer.cleanup);
    }
    this.peers.clear();
  }
}
