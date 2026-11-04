/**
 * 把会变的 system prompt 文字「锁」在一段对话内。
 *
 * system prompt 排在整段历史前面，改一个字后面就全部失去缓存（实测一次 10 万 token 重算）。
 * 表情目录、上次进度这类内容不必实时：锁住旧文字，变化另走对话末尾的快照，等压缩、换会话这些
 * 前缀本来就要重算的时机（epoch 变了）再换成最新的。
 */
export class PromptLatch {
  private readonly held = new Map<string, { epoch: string; text: string }>();

  /** 同一 epoch 内返回第一次看到的文字；epoch 变了换成 current */
  public hold(key: string, epoch: string, current: string): string {
    const entry = this.held.get(key);
    if (entry !== undefined && entry.epoch === epoch) return entry.text;
    this.held.set(key, { epoch, text: current });
    return current;
  }

  /** 当前锁住的文字；还没锁过返回 undefined */
  public peek(key: string): string | undefined {
    return this.held.get(key)?.text;
  }

  public forget(key: string): void {
    this.held.delete(key);
  }
}
