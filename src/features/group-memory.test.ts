import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// 群记忆写在 ~/.dsh 下：把 homedir 指到临时目录，测试不碰真实数据
const fakeHome = { dir: '' };
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => fakeHome.dir };
});

const {
  appendGroupMessage,
  readGroupMessagesAfter,
  readRecentGroupMessages,
  readHistoryCursor,
  writeHistoryCursor,
} = await import('./group-memory.ts');

function seed(n: number): void {
  for (let i = 1; i <= n; i++) {
    appendGroupMessage('app', 'g1', { messageId: `m${i}`, senderId: 'u', content: `msg ${i}`, timestamp: i });
  }
}

describe('group memory history cursor', () => {
  beforeEach(() => {
    fakeHome.dir = mkdtempSync(join(tmpdir(), 'gm-home-'));
  });

  it('readRecentGroupMessages 保持原行为：最近 N 条、排除当前', () => {
    seed(6);
    expect(readRecentGroupMessages('app', 'g1', 3, 'm6').map((e) => e.messageId)).toEqual(['m3', 'm4', 'm5']);
  });

  it('只返回游标之后的新消息', () => {
    seed(6);
    expect(readGroupMessagesAfter('app', 'g1', 10, 'm3', 'm6').map((e) => e.messageId)).toEqual(['m4', 'm5']);
  });

  it('游标之后没有新消息时返回空', () => {
    seed(3);
    expect(readGroupMessagesAfter('app', 'g1', 10, 'm2', 'm3')).toEqual([]);
  });

  it('新消息超过 limit 时只取最近 limit 条', () => {
    seed(8);
    expect(readGroupMessagesAfter('app', 'g1', 2, 'm1', 'm8').map((e) => e.messageId)).toEqual(['m6', 'm7']);
  });

  it('游标找不到（被清理过）时退回最近 N 条', () => {
    seed(5);
    expect(readGroupMessagesAfter('app', 'g1', 2, 'gone', 'm5').map((e) => e.messageId)).toEqual(['m3', 'm4']);
  });

  it('游标读写往返；没有/损坏时返回 undefined', () => {
    expect(readHistoryCursor('app', 'g1')).toBeUndefined();
    writeHistoryCursor('app', 'g1', { sessionId: 's1', messageId: 'm9' });
    expect(readHistoryCursor('app', 'g1')).toEqual({ sessionId: 's1', messageId: 'm9' });
    expect(readHistoryCursor('app', 'other')).toBeUndefined();
  });
});
