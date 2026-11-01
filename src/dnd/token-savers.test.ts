import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import type { Roller } from './dice.ts';
import { CampaignStore, createCampaign, findCharacter, startInitiative, upsertCharacter } from './campaign.ts';
import { AdventureLibrary, adventureFromDungeon, type Npc, roomGraph } from './adventure.ts';
import { SUNKEN_BELL } from './dungeons/sunken-bell.ts';
import { DndService } from './dnd-service.ts';
import { combatTurnPrompt, registerDndTools, turnPrompt } from './dnd-tools.ts';
import { parseSaveTargets, resolveSaveEffect, saveDamage } from './save-effect.ts';
import { applyProgressPatch, parseProgress, parseProgressPatch } from './progress-patch.ts';
import { editDistance, resolveSrdQuery, SRD_MONSTER_ZH, SRD_SPELL_ZH } from './srd-lookup.ts';
import { npcBrief, roomBrief } from './story.ts';
import { findRoom } from './dungeon.ts';

const BELL = adventureFromDungeon(SUNKEN_BELL);
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

/** 按顺序吐出固定点数，用完从头再来 */
function fixed(...values: number[]): Roller {
  let i = 0;
  return () => values[i++ % values.length]!;
}

type Tool = { name: string; execute(args: unknown, exec: { agent?: unknown }): Promise<{ text: string }> };

function setup(roller: Roller) {
  const root = mkdtempSync(join(tmpdir(), 'dnd-savers-'));
  const service = new DndService({ store: new CampaignStore(join(root, 'campaigns')), library: new AdventureLibrary(), mapDir: root, roller });
  const key = 'qqbot:app:group:G1';
  service.start(key, 'sunken-bell', false);
  service.store.update(key, (c) => {
    upsertCharacter(c, { name: '法师', maxHp: 10, abilities: { int: 16 } });
    upsertCharacter(c, { name: '地精1', kind: 'monster', maxHp: 7, abilities: { dex: 14 }, room: c.currentRoom });
    upsertCharacter(c, { name: '地精2', kind: 'monster', maxHp: 20, abilities: { dex: 14 }, room: c.currentRoom });
    upsertCharacter(c, { name: '地精3', kind: 'monster', maxHp: 20, abilities: { dex: 14 }, room: c.currentRoom });
  });
  const record = { sessionKey: key, scope: 'group', peerId: 'G1', recentSenders: [] };
  const tools = new Map<string, Tool>();
  const ctx = { get: () => ({ register: (d: Tool) => tools.set(d.name, d) }) };
  registerDndTools(ctx as never, { service, manager: { findByAgent: () => record } as never, logger: logger as never, sendImage: vi.fn() });
  const call = async (name: string, args: Record<string, unknown>) => (await tools.get(name)!.execute(args, { agent: {} })).text;
  const campaign = () => service.store.load(key)!;
  return { call, campaign, service, key };
}

describe('豁免效果一次结算', () => {
  it('减半、抗性、免疫、易伤按 5e 顺序向下取整', () => {
    expect(saveDamage(27, false, 'half')).toBe(27);
    expect(saveDamage(27, true, 'half')).toBe(13);
    expect(saveDamage(27, true, 'none')).toBe(0);
    expect(saveDamage(27, false, 'half', 'resistant')).toBe(13);
    // 先减半再抗性：27 → 13 → 6
    expect(saveDamage(27, true, 'half', 'resistant')).toBe(6);
    expect(saveDamage(27, false, 'half', 'immune')).toBe(0);
    expect(saveDamage(27, true, 'half', 'vulnerable')).toBe(26);
  });

  it('targets 接受名字或对象，非法 defense 报错', () => {
    expect(parseSaveTargets(['地精1', { name: '地精2', defense: '抗性', advantage: 'advantage' }])).toEqual([
      { name: '地精1' }, { name: '地精2', defense: 'resistant', advantage: 'advantage' },
    ]);
    expect(() => parseSaveTargets([{ name: '地精2', defense: 'tough' }])).toThrow(/defense/);
  });

  it('伤害只掷一次，每个目标各自豁免、扣血、判死亡', () => {
    const c = createCampaign('k', BELL);
    upsertCharacter(c, { name: '地精1', kind: 'monster', maxHp: 7, abilities: { dex: 14 } });
    upsertCharacter(c, { name: '地精2', kind: 'monster', maxHp: 20, abilities: { dex: 14 } });
    upsertCharacter(c, { name: '骷髅', kind: 'monster', maxHp: 20 });
    // 伤害 2d6 = 6+6；豁免 d20：地精1 3（失败），地精2 18（成功），骷髅 10（失败，免疫）
    const r = resolveSaveEffect(c, {
      targets: [{ name: '地精1' }, { name: '地精2' }, { name: '骷髅', defense: 'immune' }],
      ability: 'dex', dc: 13, damage: '2d6', roller: fixed(6, 6, 3, 18, 10),
    });
    expect(r.damageRoll?.total).toBe(12);
    const [g1, g2, sk] = r.outcomes;
    expect(g1).toMatchObject({ saved: false, damage: 12 });
    expect(g1!.change?.events).toContain('死亡');
    expect(g2).toMatchObject({ saved: true, damage: 6 });
    expect(findCharacter(c, '地精2')!.hp).toBe(14);
    expect(sk).toMatchObject({ saved: false, damage: 0, defense: 'immune' });
    expect(findCharacter(c, '骷髅')!.hp).toBe(20);
  });

  it('已死的目标跳过；找不到的目标在改动前报错', () => {
    const c = createCampaign('k', BELL);
    upsertCharacter(c, { name: '地精1', kind: 'monster', maxHp: 7 });
    findCharacter(c, '地精1')!.conditions.push('死亡');
    const r = resolveSaveEffect(c, { targets: [{ name: '地精1' }], ability: 'dex', dc: 13, damage: '1d6', roller: fixed(3) });
    expect(r.outcomes[0]!.skipped).toBe('已死亡');
    expect(() => resolveSaveEffect(c, { targets: [{ name: '不存在' }], ability: 'dex', dc: 13, damage: '1d6', roller: fixed(3) })).toThrow();
  });

  it('dnd_check 一次调用结算火球，扣施法者法术位', async () => {
    const { call, campaign } = setup(fixed(6, 6, 3, 18, 18));
    await call('dnd_resource', { action: 'set', character: '法师', resource: '3环法术位', max: 2 });
    const text = await call('dnd_check', {
      character: '法师', type: 'save', ability: '敏捷', dc: 13, damage: '2d6', damage_type: '火焰',
      targets: ['地精1', '地精2', { name: '地精3', defense: 'resistant' }], spend: '3环法术位',
    });
    expect(text).toContain('伤害 2d6');
    expect(text).toMatch(/地精1 .*失败.*受 12/);
    expect(text).toMatch(/地精2 .*成功.*受 6/);
    expect(text).toMatch(/地精3 .*成功.*抗性 受 3/);
    expect(text).toContain('剩 1/2');
    const c = campaign();
    expect(findCharacter(c, '地精1')!.conditions).toContain('死亡');
    expect(findCharacter(c, '地精3')!.hp).toBe(17);
  });

  it('旧用法不变：没有 targets、没有 damage 的豁免只报点数', async () => {
    const { call, campaign } = setup(fixed(12));
    const text = await call('dnd_check', { character: '地精1', type: 'save', ability: '敏捷', dc: 13 });
    expect(text).toContain('地精1 敏捷豁免：d20[12] + 2 = 14 vs DC 13 → 成功');
    expect(findCharacter(campaign(), '地精1')!.hp).toBe(7);
  });

  it('没有 targets 但带 damage：掷豁免的人自己挨伤害（陷阱）', async () => {
    const { call, campaign } = setup(fixed(4, 2));
    const text = await call('dnd_check', { character: '地精2', type: 'save', ability: '敏捷', dc: 13, damage: '1d4' });
    expect(text).toMatch(/地精2 .*失败.*受 4/);
    expect(findCharacter(campaign(), '地精2')!.hp).toBe(16);
  });
});

describe('回合提示去重', () => {
  const pc = () => {
    const c = createCampaign('k', BELL);
    upsertCharacter(c, { name: '卡厄斯', player: '阿丙', playerId: 'P3', maxHp: 12 });
    upsertCharacter(c, { name: '恩佐', player: '阿乙', playerId: 'P2', maxHp: 10 });
    upsertCharacter(c, { name: '地精1', kind: 'monster', maxHp: 7, room: c.currentRoom });
    upsertCharacter(c, { name: '地精2', kind: 'monster', maxHp: 7, room: c.currentRoom });
    return c;
  };

  it('不带战斗状态时仍是完整提示（旧调用方式）', () => {
    const c = pc();
    expect(turnPrompt(findCharacter(c, '卡厄斯'), '卡厄斯')).toContain('不要替他选目标');
  });

  it('每场战斗 PC、怪物各给一次完整规则，之后精简；新战斗重新给', () => {
    const c = pc();
    startInitiative(c, fixed(20, 15, 10, 5), ['卡厄斯', '地精1', '恩佐', '地精2']);
    const first = combatTurnPrompt(c, '卡厄斯');
    expect(first).toContain('不要替他选目标');
    expect(combatTurnPrompt(c, '地精1')).toContain('直到轮到某个 PC 为止');
    const second = combatTurnPrompt(c, '恩佐');
    expect(second).not.toContain('不要替他选目标');
    expect(second).toContain('停下等他本人宣告');
    expect(second.length).toBeLessThan(first.length / 2);
    expect(combatTurnPrompt(c, '地精2')).toBe('轮到 地精2（你决定），结算完 next。');
    startInitiative(c, fixed(20, 15), ['卡厄斯', '地精1']);
    expect(combatTurnPrompt(c, '卡厄斯')).toContain('不要替他选目标');
  });

  it('破例：反应之后或 goto 修正后，下一个 PC 回合再给完整规则；玩家不在时提醒', () => {
    const c = pc();
    startInitiative(c, fixed(20, 15, 10), ['卡厄斯', '地精1', '恩佐']);
    combatTurnPrompt(c, '卡厄斯');
    c.initiative!.rebrief = true;
    expect(combatTurnPrompt(c, '恩佐')).toContain('不要替他选目标');
    expect(combatTurnPrompt(c, '卡厄斯')).not.toContain('不要替他选目标');
    expect(combatTurnPrompt(c, '地精1', { force: true })).toContain('直到轮到某个 PC 为止');
    expect(combatTurnPrompt(c, '卡厄斯')).toContain('不要替他选目标');
    expect(combatTurnPrompt(c, '恩佐', { recentSenders: ['P3'] })).toContain('阿乙 最近 10 分钟没发过言');
    expect(combatTurnPrompt(c, '卡厄斯', { recentSenders: ['P3'] })).not.toContain('没发过言');
  });

  it('dnd_initiative next 逐回合推进时只有第一次是完整提示', async () => {
    const { call } = setup(fixed(20, 15, 10, 5));
    const start = await call('dnd_initiative', { action: 'start', participants: ['地精1', '地精2', '地精3'] });
    expect(start).toContain('直到轮到某个 PC 为止');
    expect(await call('dnd_initiative', { action: 'next' })).toContain('（你决定），结算完 next。');
  });
});

describe('卡片摘要', () => {
  it('roomBrief 一行列出在场角色的 HP 和状态', () => {
    const c = createCampaign('k', BELL);
    upsertCharacter(c, { name: '卡厄斯', maxHp: 12 });
    upsertCharacter(c, { name: '巨鼠1', kind: 'monster', maxHp: 7, room: c.currentRoom });
    findCharacter(c, '巨鼠1')!.conditions.push('倒地');
    const room = findRoom(roomGraph(BELL), c.currentRoom)!;
    const line = roomBrief(c, BELL, room);
    expect(line).not.toContain('\n');
    expect(line).toContain('卡厄斯 HP12/12');
    expect(line).toContain('巨鼠1 HP7/7[倒地]');
  });

  it('npcBrief 给态度、位置和没说的信息 id', () => {
    const c = createCampaign('k', BELL);
    const npc: Npc = {
      id: 'old-miner', name: '老矿工', role: '退休矿工', look: '老头', motive: '找侄子', home: { room: 'gate' }, attitude: 'friendly',
      knows: [{ id: 'mine-rumor', text: '矿坑在北边。', via: 'ask' }, { id: 'vault-word', text: '口令。', via: 'persuade', dc: 13 }],
    } as Npc;
    c.facts.push('mine-rumor');
    const line = npcBrief(c, npc);
    expect(line).toBe('老矿工(old-miner)｜友善｜@gate｜没见过｜未说：vault-word');
  });

  it('dnd_lookup room brief=true 比完整卡片短', async () => {
    const { call } = setup(fixed(10));
    const full = await call('dnd_lookup', { kind: 'room' });
    const brief = await call('dnd_lookup', { kind: 'room', brief: true });
    expect(brief.length).toBeLessThan(full.length);
    expect(brief).toContain('地精1 HP7/7');
    expect(await call('dnd_character', { action: 'show', name: '地精2', brief: true })).toMatch(/^地精2 HP 20\/20 AC \d+/);
  });
});

describe('进度增量写入', () => {
  const base = '【位置】修道院门口\n【物品与欠账】\n- 欠铁匠 5gp\n- 绳子一捆\n【待办】\n- 清地窖\n- 问老矿工侄子的事';

  it('按段解析，开头没段头的内容算无名段', () => {
    expect(parseProgress(`旧摘要一句\n${base}`).map((s) => s.name)).toEqual(['', '位置', '物品与欠账', '待办']);
  });

  it('set 换段、append 加条目、remove 删条目，其他段原样保留', () => {
    const r = applyProgressPatch(base, {
      set: { 位置: '地窖里' },
      append: { 待办: ['回去找铁匠'], 任务与线头: ['钟声与失踪有关'] },
      remove: { 待办: ['清地窖'], 物品与欠账: ['铁匠'] },
    });
    expect(r.text).toBe('【位置】地窖里\n【物品与欠账】- 绳子一捆\n【待办】\n- 问老矿工侄子的事\n- 回去找铁匠\n【任务与线头】- 钟声与失踪有关');
    expect(r.changed.sort()).toEqual(['任务与线头', '位置', '物品与欠账', '待办'].sort());
    expect(r.missed).toEqual([]);
  });

  it('删不到的条目报回来，重复追加不重复写，set 空串删段', () => {
    const r = applyProgressPatch(base, { remove: { 待办: ['杀龙'] }, append: { 待办: ['清地窖'] }, set: { '【位置】': '' } });
    expect(r.missed).toEqual(['待办：杀龙']);
    expect(r.text.match(/清地窖/g)).toHaveLength(1);
    expect(r.text).not.toContain('位置');
  });

  it('参数里的字符串和数组都认', () => {
    expect(parseProgressPatch({ append: { 待办: '一条' }, remove: { 待办: ['a', 'b'] }, set: { 位置: ['第一行', '第二行'] } })).toEqual({
      append: { 待办: ['一条'] }, remove: { 待办: ['a', 'b'] }, set: { 位置: '第一行\n第二行' },
    });
  });

  it('dnd_progress 只交改动，注入的「上次进度」是合并后的整份；summary 整份写入仍然可用', async () => {
    const { call, service, key } = setup(fixed(10));
    await call('dnd_progress', { summary: base });
    const text = await call('dnd_progress', { remove: { 待办: ['清地窖'] }, append: { 待办: ['回去找铁匠'] } });
    expect(text).toContain('改了：待办');
    const state = service.promptSections(key).map((s) => s.text).join('\n');
    expect(state).toContain('上次进度：【位置】修道院门口');
    expect(state).toContain('- 回去找铁匠');
    expect(state).not.toContain('清地窖');
    await expect(call('dnd_progress', {})).rejects.toThrow(/summary/);
  });
});

describe('SRD 模糊查找', () => {
  const monsters = [
    { index: 'goblin', name: 'Goblin' }, { index: 'hobgoblin', name: 'Hobgoblin' }, { index: 'owlbear', name: 'Owlbear' },
    { index: 'zombie', name: 'Zombie' }, { index: 'ogre-zombie', name: 'Ogre Zombie' },
    { index: 'young-red-dragon', name: 'Young Red Dragon' }, { index: 'adult-red-dragon', name: 'Adult Red Dragon' },
  ];
  const spells = [{ index: 'cure-wounds', name: 'Cure Wounds' }, { index: 'mass-cure-wounds', name: 'Mass Cure Wounds' }, { index: 'fireball', name: 'Fireball' }];

  it('编辑距离算相邻交换', () => {
    expect(editDistance('fierball', 'fireball')).toBe(1);
    expect(editDistance('goblin', 'goblim')).toBe(1);
  });

  it('大小写、空格、连字符差异算精确命中', () => {
    expect(resolveSrdQuery('Owl Bear', monsters, {})).toEqual({ kind: 'exact', index: 'owlbear' });
    expect(resolveSrdQuery('cure_wounds', spells, {})).toEqual({ kind: 'exact', index: 'cure-wounds' });
  });

  it('拼错一两个字母直接纠正', () => {
    expect(resolveSrdQuery('goblim', monsters, {})).toMatchObject({ kind: 'fuzzy', index: 'goblin' });
    expect(resolveSrdQuery('fierball', spells, {})).toMatchObject({ kind: 'fuzzy', index: 'fireball' });
    expect(resolveSrdQuery('cure wound', spells, {})).toMatchObject({ kind: 'fuzzy', index: 'cure-wounds' });
    expect(resolveSrdQuery('zombi', monsters, {})).toMatchObject({ kind: 'fuzzy', index: 'zombie' });
  });

  it('中文名：全名精确、简称按包含', () => {
    expect(resolveSrdQuery('枭熊', monsters, SRD_MONSTER_ZH)).toEqual({ kind: 'exact', index: 'owlbear' });
    expect(resolveSrdQuery('火球', spells, SRD_SPELL_ZH)).toMatchObject({ kind: 'fuzzy', index: 'fireball' });
  });

  it('几个差不多的候选时列出来，不猜', () => {
    const r = resolveSrdQuery('red dragon', monsters, {});
    expect(r.kind).toBe('ambiguous');
    expect(r.kind === 'ambiguous' && r.candidates.map((c) => c.index).sort()).toEqual(['adult-red-dragon', 'young-red-dragon']);
    expect(resolveSrdQuery('红龙', monsters, SRD_MONSTER_ZH).kind).toBe('ambiguous');
  });

  it('差太远就是没有', () => {
    expect(resolveSrdQuery('beholder', monsters, {})).toEqual({ kind: 'none' });
    expect(resolveSrdQuery('眼魔', monsters, SRD_MONSTER_ZH)).toEqual({ kind: 'none' });
  });

  it('中文名表的 index 都是合法 slug', () => {
    for (const index of [...Object.values(SRD_MONSTER_ZH), ...Object.values(SRD_SPELL_ZH)]) expect(index).toMatch(/^[a-z0-9-]+$/);
  });
});
