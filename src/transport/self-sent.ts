/**
 * bot 自己发出去的消息：messageId → 内容。
 *
 * 背景：SDK 的 quoteRef 中间件只记录**入站**消息，自己发出去的话从来没进过 ref 索引。
 * 于是群友引用 bot 自己的消息时，`quote.entry` 查不到，组装层只能写「未知发送者」，
 * 模型看到一段自己的原文却不知道是自己说的（甚至以为是对面用户说的）。
 *
 * 这里把出站消息 id 记下来，quoteSenderFill 在 store 查不到时过来补一条，
 * 组装层据此标注「你自己」。
 */
export const SELF_SENDER_ID = '__self__';

export interface SelfSentEntry {
  content: string;
  timestamp: string;
}

export class SelfSentIndex {
  private readonly map = new Map<string, SelfSentEntry>();

  public constructor(private readonly maxSize = 500) {}

  public record(id: string | undefined | null, content: string): void {
    if (id === undefined || id === null || id === '') return;
    this.map.set(id, { content, timestamp: new Date().toISOString() });
    // Map 保持插入顺序，超限就丢最早的
    while (this.map.size > this.maxSize) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  public get(id: string): SelfSentEntry | undefined {
    return this.map.get(id);
  }

  public size(): number {
    return this.map.size;
  }
}
