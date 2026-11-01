import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { CampaignStore, addSummary, ensureSessionSummary, pushLog, upsertCharacter, type Campaign } from './campaign.ts';
import { AdventureLibrary } from './adventure.ts';
import { DndService } from './dnd-service.ts';
import { registerDndTools } from './dnd-tools.ts';
import { NotesStore } from '../notes/notes-store.ts';
import { registerNotesTools } from '../notes/notes-tools.ts';

type Tool = { name: string; execute(args: unknown, exec: { agent?: unknown }): Promise<unknown> };

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

/** 群 G1 开着沉钟修道院，队里有卡厄斯和一只巨鼠；笔记库有一篇共享、一篇本群私有 */
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'dnd-notes-'));
  const service = new DndService({ store: new CampaignStore(join(root, 'campaigns')), library: new AdventureLibrary(), mapDir: root });
  const key = 'qqbot:app:group:G1';
  service.start(key, 'sunken-bell', false);
  service.store.update(key, (c) => {
    upsertCharacter(c, { name: '卡厄斯', maxHp: 12 });
    upsertCharacter(c, { name: '巨鼠1', kind: 'monster', maxHp: 7, room: c.currentRoom });
  });

  const notesRoot = join(root, 'notes');
  mkdirSync(join(notesRoot, 'chats', 'group_G1'), { recursive: true });
  writeFileSync(join(notesRoot, '跑团入门.md'), '# 跑团入门\n沉钟修道院是新手模组，地窖有巨鼠', 'utf8');
  writeFileSync(join(notesRoot, 'chats', 'group_G1', '待办.md'), '# 沉钟修道院 · 待办\n地窖巨鼠还没清，卡厄斯欠铁匠 5gp', 'utf8');
  const notes = new NotesStore(notesRoot);

  const record = { sessionKey: key, scope: 'group', peerId: 'G1', recentSenders: [] };
  const tools = new Map<string, Tool>();
  const ctx = { get: () => ({ register: (d: Tool) => tools.set(d.name, d) }) };
  const manager = { findByAgent: () => record, dndService: service };
  registerDndTools(ctx as never, { service, manager: manager as never, logger: logger as never, sendImage: vi.fn() });
  registerNotesTools(ctx as never, notes, manager as never, logger as never);
  const call = (name: string, args: Record<string, unknown>) => tools.get(name)!.execute(args, { agent: {} });
  return { service, key, notes, notesRoot, call };
}

describe('dnd_progress', () => {
  it('写进团档但不结团，团况注入的「上次进度」用最新一条', async () => {
    const { service, key, call } = setup();
    await call('dnd_progress', { summary: '队伍在修道院门口，欠铁匠 5gp' });
    await call('dnd_progress', { summary: '清完地窖，铁匠的账已还' });
    expect(service.active(key)).toBeDefined();
    const state = service.promptSections(key).map((s) => s.text).join('\n');
    expect(state).toContain('上次进度：清完地窖，铁匠的账已还');
    expect(state).not.toContain('欠铁匠');
  });
});

describe('停团兜底摘要', () => {
  const campaign = (over: Partial<Campaign>): Campaign => ({ summaries: [], log: [], ...over }) as unknown as Campaign;

  it('这次开团没写进度：上一条进度 + 最近日志拼一条', () => {
    const c = campaign({ sessionStartedAt: 100, log: ['卡厄斯 受到 3 点伤害', '队伍进入「地窖」'] });
    addSummary(c, '上次停在门口', 50);
    expect(ensureSessionSummary(c, 200)).toBe(true);
    expect(c.summaries.at(-1)!.text).toContain('上次停在门口');
    expect(c.summaries.at(-1)!.text).toContain('队伍进入「地窖」');
  });

  it('这次已经写过进度、或者什么都没发生时不补', () => {
    const written = campaign({ sessionStartedAt: 100, log: ['x'] });
    addSummary(written, '刚写的', 150);
    expect(ensureSessionSummary(written, 200)).toBe(false);
    expect(ensureSessionSummary(campaign({ sessionStartedAt: 100 }), 200)).toBe(false);
  });

  it('/dnd end 直接停团时自动补上，下次开团能接上', () => {
    const { service, key } = setup();
    service.store.update(key, (c) => { pushLog(c, '卡厄斯 打开了地窖的门'); });
    service.stop(key);
    service.start(key, 'sunken-bell', false);
    const state = service.promptSections(key).map((s) => s.text).join('\n');
    expect(state).toContain('上次进度：（停团时没写进度');
    expect(state).toContain('卡厄斯 打开了地窖的门');
  });
});

describe('开团时写笔记的 DM 机密拦截', () => {
  it('怪物数值、DC 被拒并提示用 dnd_progress；玩家角色数值照常写', async () => {
    const { call, notesRoot } = setup();
    await expect(call('qqbot_notes_save', { title: '地窖', content: '巨鼠2 HP 7 AC 12' })).rejects.toThrow(/巨鼠.*dnd_progress/);
    await expect(call('qqbot_notes_save', { title: '地窖', content: '门锁 DC 15' })).rejects.toThrow('DC');
    await call('qqbot_notes_save', { title: '队伍', content: '卡厄斯 HP 12 AC 18', scope: 'chat' });
    expect(readdirSync(join(notesRoot, 'chats', 'group_G1'))).toContain('队伍.md');
  });

  it('没开团时不拦', async () => {
    const { service, key, call } = setup();
    service.stop(key);
    await expect(call('qqbot_notes_save', { title: '规则备忘', content: '开锁一般 DC 15', scope: 'chat' })).resolves.toBeDefined();
  });
});

describe('开团时本群笔记不走自动注入', () => {
  it('sharedOnly 只召回共享笔记；本群笔记标题可以列出来', async () => {
    const { notes } = setup();
    const all = await notes.searchHybrid('地窖巨鼠', 4, 'group_G1');
    expect(all.map((h) => h.file)).toContain('chats/group_G1/待办.md');
    const shared = await notes.searchHybrid('地窖巨鼠', 4, 'group_G1', { sharedOnly: true });
    expect(shared.map((h) => h.file)).toEqual(['跑团入门.md']);
    expect(notes.chatNoteTitles('group_G1')).toEqual(['沉钟修道院 · 待办']);
  });
});
