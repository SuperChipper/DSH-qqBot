import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { AdventureLibrary, adventureFromDungeon } from './adventure.ts';
import { CampaignStore, applyDamage, changeInventory, createCampaign, upsertCharacter } from './campaign.ts';
import {
  addEntry,
  chronicleChanges,
  chronicleLines,
  closeEntry,
  markChronicle,
  openEntries,
  recordChanges,
  searchEntries,
  seedChronicle,
} from './chronicle.ts';
import { DndService } from './dnd-service.ts';
import { registerDndTools } from './dnd-tools.ts';
import { SUNKEN_BELL } from './dungeons/sunken-bell.ts';

const BELL = adventureFromDungeon(SUNKEN_BELL);
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

describe('手动记账', () => {
  it('承诺、俘虏、线头默认未了结，close 后去掉并记下结果', () => {
    const c = createCampaign('k', BELL);
    const promise = addEntry(c, { kind: 'promise', text: '答应铁匠三天内还 5gp' });
    const event = addEntry(c, { text: '酒馆老板认出了卡厄斯' });
    expect(promise.open).toBe(true);
    expect(event.open).toBeUndefined();
    expect(openEntries(c).map((e) => e.id)).toEqual([promise.id]);
    closeEntry(c, promise.id, '当天就还了');
    expect(openEntries(c)).toEqual([]);
    expect(promise.text).toContain('→ 当天就还了');
    expect(() => closeEntry(c, 99)).toThrow(/#99/);
  });

  it('同样的内容不重复记，空内容报错', () => {
    const c = createCampaign('k', BELL);
    const first = addEntry(c, { text: '同一件事' });
    expect(addEntry(c, { text: ' 同一件事 ' }).id).toBe(first.id);
    expect(c.chronicle).toHaveLength(1);
    expect(() => addEntry(c, { text: '  ' })).toThrow();
  });

  it('搜索：命中词多的在前，一样多时新的在前，大小写不敏感', () => {
    const c = createCampaign('k', BELL);
    addEntry(c, { text: '红胡子矮人被抓走' });
    addEntry(c, { text: '矮人的地图值一座矿' });
    addEntry(c, { text: 'Kriv 拿到银梳' });
    expect(searchEntries(c, '矮人 地图').map((e) => e.text)).toEqual(['矮人的地图值一座矿', '红胡子矮人被抓走']);
    expect(searchEntries(c, 'kriv')).toHaveLength(1);
    expect(searchEntries(c, '没有的词')).toEqual([]);
    expect(searchEntries(c, '  ')).toEqual([]);
  });
});

describe('自动记录', () => {
  it('比较前后状态：新房间、击败、PC 物品', () => {
    const c = createCampaign('k', BELL);
    upsertCharacter(c, { name: 'Kriv', maxHp: 10 });
    upsertCharacter(c, { name: '巨鼠1', kind: 'monster', maxHp: 3, room: c.currentRoom });
    const before = markChronicle(c);
    c.revealed.push('nave');
    applyDamage(c, '巨鼠1', 3);
    changeInventory(c, 'Kriv', ['银梳'], [], 0);
    const lines = chronicleChanges(before, c, BELL);
    expect(lines).toContain('到达「钟楼残殿」');
    expect(lines).toContain('击败：巨鼠1');
    expect(lines).toContain('Kriv 得到：银梳');
  });

  it('又发生一次的事要再记一条，手动重复才合并', () => {
    const c = createCampaign('k', BELL);
    upsertCharacter(c, { name: 'Kriv', maxHp: 10 });
    for (let i = 0; i < 2; i++) {
      const before = markChronicle(c);
      changeInventory(c, 'Kriv', ['药水'], [], 0);
      recordChanges(before, c, BELL);
      changeInventory(c, 'Kriv', [], ['药水'], 0);
    }
    expect(searchEntries(c, '得到')).toHaveLength(2);
  });

  it('掉血、推进回合这些不进账本', () => {
    const c = createCampaign('k', BELL);
    upsertCharacter(c, { name: '巨鼠1', kind: 'monster', maxHp: 7, room: c.currentRoom });
    const before = markChronicle(c);
    applyDamage(c, '巨鼠1', 3);
    recordChanges(before, c, BELL);
    expect(c.chronicle).toEqual([]);
  });

  it('建卡时带的初始装备不算剧情', () => {
    const c = createCampaign('k', BELL);
    const before = markChronicle(c);
    upsertCharacter(c, { name: 'Kriv', maxHp: 10 });
    changeInventory(c, 'Kriv', ['匕首'], [], 0);
    expect(chronicleChanges(before, c, BELL)).toEqual([]);
  });
});

describe('老团补记', () => {
  it('没有账本的老存档把去过的地方和最新进度补记进去，只补一次', () => {
    const c = createCampaign('k', BELL);
    delete c.chronicle;
    c.revealed.push('nave');
    c.summaries.push({ at: 1, text: '老巢已经清空' });
    seedChronicle(c, BELL);
    expect(searchEntries(c, '钟楼残殿')[0]?.text).toContain('（开账前）');
    expect(searchEntries(c, '老巢')[0]?.text).toContain('老巢已经清空');
    const count = c.chronicle!.length;
    seedChronicle(c, BELL);
    expect(c.chronicle).toHaveLength(count);
  });

  it('新团不补记', () => {
    const c = createCampaign('k', BELL);
    seedChronicle(c, BELL);
    expect(c.chronicle).toEqual([]);
  });
});

describe('进 system prompt 的部分', () => {
  it('未了结的和最近的分开列，有字数上限', () => {
    const c = createCampaign('k', BELL);
    expect(chronicleLines(c)).toEqual([]);
    addEntry(c, { kind: 'promise', text: '答应救矮人' });
    addEntry(c, { text: '到达酒馆' });
    const lines = chronicleLines(c).join('\n');
    expect(lines).toContain('账本·未了结');
    expect(lines).toContain('答应救矮人');
    expect(lines).toContain('账本·最近');

    for (let i = 0; i < 80; i++) addEntry(c, { kind: 'thread', text: `线头 ${i} ${'长'.repeat(30)}` });
    const capped = chronicleLines(c).join('\n');
    expect(capped.length).toBeLessThan(2000);
    expect(capped).toContain('线头 79');
    expect(capped).toMatch(/还有 \d+ 条/);
  });
});

type Tool = { name: string; execute(args: unknown, exec: { agent?: unknown }): Promise<{ text: string }> };

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'dnd-chronicle-'));
  const service = new DndService({ store: new CampaignStore(join(root, 'campaigns')), library: new AdventureLibrary(), mapDir: root, roller: () => 10 });
  const key = 'qqbot:app:group:G1';
  service.start(key, 'sunken-bell', false);
  service.store.update(key, (c) => {
    upsertCharacter(c, { name: '卡厄斯', maxHp: 12 });
    upsertCharacter(c, { name: '巨鼠1', kind: 'monster', maxHp: 3, room: c.currentRoom });
  });
  const record = { sessionKey: key, scope: 'group', peerId: 'G1', recentSenders: [] };
  const tools = new Map<string, Tool>();
  const ctx = { get: () => ({ register: (d: Tool) => tools.set(d.name, d) }) };
  registerDndTools(ctx as never, { service, manager: { findByAgent: () => record } as never, logger: logger as never, sendImage: vi.fn() });
  const call = async (name: string, args: Record<string, unknown>) => (await tools.get(name)!.execute(args, { agent: {} })).text;
  return { call, service, key };
}

describe('dnd_chronicle 工具', () => {
  it('add / search / close / list 走通，查不到时提醒不要否认', async () => {
    const { call } = setup();
    expect(await call('dnd_chronicle', { action: 'add', kind: 'captive', text: '营房里捆着一个红标帮俘虏' })).toContain('未了结');
    expect(await call('dnd_chronicle', { action: 'search', query: '俘虏' })).toContain('营房');
    expect(await call('dnd_chronicle', { action: 'search', query: '眼魔' })).toContain('没记录不等于没发生');
    expect(await call('dnd_chronicle', { action: 'list' })).toContain('未了结（1）');
    expect(await call('dnd_chronicle', { action: 'close', id: 1, outcome: '审完放了' })).toContain('审完放了');
    expect(await call('dnd_chronicle', { action: 'list' })).toContain('未了结（0）');
  });

  it('普通工具调用会自动记账：击败怪物之后搜得到', async () => {
    const { call } = setup();
    await call('dnd_apply', { target: '巨鼠1', damage: 3 });
    expect(await call('dnd_chronicle', { action: 'search', query: '巨鼠1' })).toContain('击败：巨鼠1');
  });

  it('dnd_undo 连账本一起撤销', async () => {
    const { call } = setup();
    await call('dnd_apply', { target: '巨鼠1', damage: 3 });
    await call('dnd_undo', { action: 'undo', steps: 1 });
    expect(await call('dnd_chronicle', { action: 'search', query: '巨鼠1' })).toContain('没搜到');
  });

  it('搜索不产生撤销记录', async () => {
    const { call, service, key } = setup();
    const before = service.store.snapshots(key).length;
    await call('dnd_chronicle', { action: 'search', query: '随便' });
    expect(service.store.snapshots(key).length).toBe(before);
  });

  it('未了结的进 system prompt 背景，同一段对话内不变', async () => {
    const { call, service, key } = setup();
    const first = service.promptSections(key, 's:0');
    await call('dnd_chronicle', { action: 'add', kind: 'promise', text: '答应救矮人' });
    expect(service.promptSections(key, 's:0')).toEqual(first);
    expect(service.promptSections(key, 's:1').map((s) => s.text).join('\n')).toContain('答应救矮人');
  });
});
