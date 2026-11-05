import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import { registerHistorySearchTool } from './history-tool.ts';

// group-memory 的路径来自 node:os 的 homedir；测试里把它指到临时目录
let fakeHome = '';
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => fakeHome };
});

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

interface Executed {
  name: string;
  execute(args: unknown, ctx: { agent?: unknown }): Promise<Record<string, unknown>>;
}

const created: string[] = [];
afterEach(() => {
  for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true });
  fakeHome = '';
});

function setup(
  entries: Array<{ id: string; name: string; content: string; ts: number }>,
  peerId = 'G1',
): Executed {
  const dir = mkdtempSync(join(tmpdir(), 'hist-'));
  created.push(dir);
  fakeHome = dir;
  const memory = join(dir, '.dsh', 'qqbot-memory');
  mkdirSync(memory, { recursive: true });
  const lines = entries.map((e) => JSON.stringify({
    messageId: e.id, senderId: `openid-${e.name}`, senderName: e.name, content: e.content, timestamp: e.ts,
  }));
  writeFileSync(join(memory, `app1-${peerId}.jsonl`), `${lines.join('\n')}\n`, 'utf8');

  const registered: Executed[] = [];
  const ctx = {
    get: (name: string) => name === 'tools'
      ? { register: (def: Executed) => { registered.push(def); return () => {}; } }
      : undefined,
  } as unknown as Context;
  const manager = { findByAgent: () => ({ scope: 'group', peerId }) };
  registerHistorySearchTool(ctx, 'app1', manager as never, logger);
  return registered[0]!;
}

describe('qqbot_history_search', () => {
  it('按关键词命中，多个词必须全部出现', async () => {
    const tool = setup([
      { id: 'm1', name: '薯条', content: '大肥鱼那个模拟盘跑起来了吗', ts: Date.UTC(2026, 10, 4, 2) },
      { id: 'm2', name: '鱼', content: '跑起来了，五个策略', ts: Date.UTC(2026, 10, 4, 3) },
    ]);

    const hit = await tool.execute({ query: '模拟盘' }, {});
    expect(hit.count).toBe(1);
    expect(String(hit.message)).toContain('薯条');

    const miss = await tool.execute({ query: '模拟盘 不存在的词' }, {});
    expect(miss.count).toBe(0);
  });

  it('时间范围和发言人能过滤', async () => {
    const tool = setup([
      { id: 'm1', name: '薯条', content: '第一天的消息', ts: new Date(2026, 9, 1, 10).getTime() },
      { id: 'm2', name: '小克', content: '第二天的消息', ts: new Date(2026, 10, 4, 10).getTime() },
    ]);

    const bySender = await tool.execute({ sender: '小克' }, {});
    expect(bySender.count).toBe(1);

    const byRange = await tool.execute({ since: '2026-10-15' }, {});
    expect(byRange.count).toBe(1);
    expect(String(byRange.message)).toContain('第二天的消息');
  });

  it('limit 取最新的若干条并标记截断', async () => {
    const entries = Array.from({ length: 5 }, (_, i) => ({
      id: `m${i}`, name: 'u', content: `第 ${i} 条`, ts: new Date(2026, 10, 4, 9 + i).getTime(),
    }));
    const tool = setup(entries);

    const out = await tool.execute({ limit: 2 }, {});
    expect(out.count).toBe(2);
    expect(out.truncated).toBe(true);
    expect(String(out.message)).toContain('第 4 条');
  });

  it('日期写错要报可读的错', async () => {
    const tool = setup([]);
    await expect(tool.execute({ since: '10月4日' }, {})).rejects.toThrow(/YYYY-MM-DD/);
  });
});
