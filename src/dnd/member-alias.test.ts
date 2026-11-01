import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { CampaignStore, findCharacter, upsertCharacter } from './campaign.ts';
import { AdventureLibrary } from './adventure.ts';
import { DndService } from './dnd-service.ts';
import { registerDndTools } from './dnd-tools.ts';
import { memberIdsFor, SenderAliasStore } from '../features/sender-alias.ts';

const A = 'E4F4AEA33253A2797FB897C50B81D7ED';
const B = '5CA9498C76494A478EA5F9342725E63A';

type Tool = { execute(args: unknown, exec: { agent?: unknown }): Promise<{ text: string }> };

/** 群 G1 里 A 是 U1、B 是 U2；A 是卡厄斯的玩家，正轮到卡厄斯 */
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'dnd-alias-'));
  const service = new DndService({ store: new CampaignStore(join(root, 'campaigns')), library: new AdventureLibrary(), mapDir: root });
  const key = 'group:G1';
  service.start(key, 'sunken-bell', false);
  service.store.update(key, (c) => {
    upsertCharacter(c, { name: '卡厄斯', player: '玩家丙', playerId: A, maxHp: 12 });
    upsertCharacter(c, { name: '巨鼠', kind: 'monster', maxHp: 7, room: c.currentRoom });
    c.initiative = { round: 1, turn: 0, order: [{ name: '卡厄斯', init: 18 }, { name: '巨鼠', init: 10 }] };
  });

  const aliases = new SenderAliasStore(join(root, 'aliases'));
  aliases.aliasFor('app', 'G1', A);
  aliases.aliasFor('app', 'G1', B);

  const now = Date.now();
  const record = { sessionKey: key, scope: 'group', peerId: 'G1', recentSenders: [{ id: A, at: now }, { id: B, at: now }] };
  const tools = new Map<string, Tool>();
  const ctx = { get: () => ({ register: (d: Tool & { name: string }) => tools.set(d.name, d) }) };
  registerDndTools(ctx as never, {
    service,
    manager: { findByAgent: () => record } as never,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
    sendImage: vi.fn(),
    members: memberIdsFor(aliases, 'app'),
  });
  const call = (name: string, args: Record<string, unknown>) => tools.get(name)!.execute(args, { agent: {} });
  return { service, key, call };
}

describe('跑团工具里的成员别名', () => {
  it('declared_by 填 U1 会换回 A 的 openid，本人能结束自己的回合', async () => {
    const { service, key, call } = setup();
    await call('dnd_initiative', { action: 'next', declared_by: 'U1' });
    expect(service.store.load(key)!.initiative!.turn).toBe(1);
  });

  it('#U1 写法同样可以', async () => {
    const { service, key, call } = setup();
    await call('dnd_initiative', { action: 'next', declared_by: '#U1' });
    expect(service.store.load(key)!.initiative!.turn).toBe(1);
  });

  it('别人（U2）的编号换回的是 B，不能替 A 结束回合', async () => {
    const { call } = setup();
    await expect(call('dnd_initiative', { action: 'next', declared_by: 'U2' })).rejects.toThrow(/只能由他本人宣告/);
  });

  it('未知别名直接报错，提示填标签里的编号', async () => {
    const { call } = setup();
    await expect(call('dnd_initiative', { action: 'next', declared_by: 'U9' })).rejects.toThrow(/不认识的成员编号「U9」/);
  });

  it('建卡时 player_id 填别名，角色卡存真实 openid，展示给模型的是 #U2', async () => {
    const { service, key, call } = setup();
    const out = await call('dnd_character', { action: 'create', name: '莉亚', kind: 'pc', player: '阿乙', player_id: 'U2', max_hp: 10 });
    expect(findCharacter(service.store.load(key)!, '莉亚')?.playerId).toBe(B);
    expect(out.text).toContain('〈阿乙 #U2〉');
    expect(out.text).not.toContain(B);
  });

  it('建卡时 player_id 是未知别名：报错，不会把「U7」当 openid 存下来', async () => {
    const { service, key, call } = setup();
    await expect(call('dnd_character', { action: 'create', name: '莉亚', kind: 'pc', player_id: 'U7', max_hp: 10 })).rejects.toThrow(/U7/);
    expect(findCharacter(service.store.load(key)!, '莉亚')).toBeUndefined();
  });
});
