import { describe, it, expect } from 'vitest';
import { PromptLatch } from './prompt-latch.ts';

describe('PromptLatch', () => {
  it('同一 epoch 内一直返回第一次的文字，epoch 变了换新', () => {
    const latch = new PromptLatch();
    expect(latch.peek('k')).toBeUndefined();
    expect(latch.hold('k', 'e1', '旧')).toBe('旧');
    expect(latch.hold('k', 'e1', '新')).toBe('旧');
    expect(latch.peek('k')).toBe('旧');
    expect(latch.hold('k', 'e2', '新')).toBe('新');
  });

  it('不同 key 互不影响，forget 后重新锁', () => {
    const latch = new PromptLatch();
    latch.hold('a', 'e', 'A');
    expect(latch.hold('b', 'e', 'B')).toBe('B');
    latch.forget('a');
    expect(latch.hold('a', 'e', 'A2')).toBe('A2');
  });
});
