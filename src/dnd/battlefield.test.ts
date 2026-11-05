import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import type { Roller } from './dice.ts';
import { AdventureLibrary, adventureFromDungeon } from './adventure.ts';
import { CampaignStore, applyDamage, changeCondition, createCampaign, findCharacter, nextTurn, startInitiative, summarize, upsertCharacter } from './campaign.ts';
import { SUNKEN_BELL } from './dungeons/sunken-bell.ts';
import { DndService } from './dnd-service.ts';
import { combatTurnPrompt, registerDndTools, srdMonsterInput } from './dnd-tools.ts';
import { attackRangeNote, battleLines, cellOf, distanceFeet, distancesFrom, moveOnGrid, moveResultText, setPositions, turnPositionNote, unplaced } from './battlefield.ts';

const BELL = adventureFromDungeon(SUNKEN_BELL);
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

function arena() {
  const c = createCampaign('group:abc', BELL);
  upsertCharacter(c, { name: '刻德温', maxHp: 25, ac: 20 });
  upsertCharacter(c, { name: 'Kriv', maxHp: 20, ac: 16 });
  upsertCharacter(c, { name: '狼', kind: 'monster', maxHp: 18, room: c.currentRoom, speed: 40 });
  upsertCharacter(c, { name: '大地精', kind: 'monster', maxHp: 11, room: c.currentRoom });
  startInitiative(c, () => 10);
  return c;
}

function ch(c: ReturnType<typeof arena>, name: string) {
  return findCharacter(c, name)!;
}

describe('距离', () => {
  it('一格 5 尺，斜走也算 5 尺', () => {
    expect(distanceFeet({ x: 0, y: 0 }, { x: 1, y: 1 })).toBe(5);
    expect(distanceFeet({ x: 0, y: 0 }, { x: 3, y: 1 })).toBe(15);
  });
});

describe('摆位', () => {
  it('坐标要是范围内的整数，填错直接报错而不是存进去', () => {
    const c = arena();
    expect(() => setPositions(c, [{ name: '狼', x: 1.5, y: 0 }])).toThrow(/整数/);
    expect(() => setPositions(c, [{ name: '狼', x: -1, y: 0 }])).toThrow(/整数/);
    expect(() => setPositions(c, [{ name: '不存在', x: 1, y: 1 }])).toThrow(/找不到角色/);
  });

  it('不在战斗中不能摆', () => {
    const c = createCampaign('group:abc', BELL);
    expect(() => setPositions(c, [{ name: 'x', x: 1, y: 1 }])).toThrow(/不在战斗/);
  });

  it('同格提醒但不拦，同一次调用里互换位置不算冲突', () => {
    const c = arena();
    expect(setPositions(c, [{ name: '狼', x: 1, y: 1 }, { name: '大地精', x: 1, y: 1 }])[0]).toMatch(/同一格/);
    setPositions(c, [{ name: '狼', x: 1, y: 1 }, { name: '大地精', x: 2, y: 2 }]);
    expect(setPositions(c, [{ name: '狼', x: 2, y: 2 }, { name: '大地精', x: 1, y: 1 }])).toEqual([]);
  });

  it('换了房间旧坐标作废，算回没摆位', () => {
    const c = arena();
    setPositions(c, [{ name: 'Kriv', x: 1, y: 1 }]);
    expect(cellOf(c, ch(c, 'Kriv'))).toBeDefined();
    ch(c, 'Kriv').room = 'somewhere-else';
    expect(cellOf(c, ch(c, 'Kriv'))).toBeUndefined();
    expect(unplaced(c)).toContain('Kriv');
  });

  it('标记能进站位行，算距离时也列出来', () => {
    const c = arena();
    setPositions(c, [{ name: 'Kriv', x: 0, y: 0 }, { name: '刚铎', x: 4, y: 0, mark: true }]);
    expect(battleLines(c, (id) => id).join('\n')).toContain('标记：刚铎(4,0)');
    expect(distancesFrom(c, 'Kriv')).toContain('刚铎 20 尺');
  });
});

describe('移动和借机', () => {
  function placed() {
    const c = arena();
    setPositions(c, [
      { name: '刻德温', x: 0, y: 0 },
      { name: 'Kriv', x: 5, y: 0 },
      { name: '狼', x: 1, y: 0 },
      { name: '大地精', x: 8, y: 8 },
    ]);
    return c;
  }

  it('走开贴身的敌人会报借机', () => {
    const c = placed();
    const r = moveOnGrid(c, '刻德温', { x: 0, y: 6 });
    expect(r.feet).toBe(30);
    expect(r.provokes).toEqual(['狼']);
    expect(moveResultText(r)).toContain('借机');
  });

  it('还在触及范围内挪动不算借机', () => {
    const c = placed();
    expect(moveOnGrid(c, '刻德温', { x: 0, y: 1 }).provokes).toEqual([]);
  });

  it('路过敌人身边再走远也算离开触及范围', () => {
    const c = placed();
    // Kriv 沿 y=0 往西走，途中贴过 (3,1) 的狼，终点已经走远
    setPositions(c, [{ name: '刻德温', x: 20, y: 20 }, { name: '狼', x: 3, y: 1 }]);
    expect(moveOnGrid(c, 'Kriv', { x: 0, y: 0 }).provokes).toEqual(['狼']);
  });

  it('友军不触发；昏迷、死了的敌人不打借机', () => {
    const c = placed();
    setPositions(c, [{ name: 'Kriv', x: 0, y: 1 }, { name: '狼', x: 20, y: 20 }]);
    expect(moveOnGrid(c, 'Kriv', { x: 0, y: 7 }).provokes).toEqual([]);
    const d = placed();
    changeCondition(d, '狼', '昏迷', true);
    expect(moveOnGrid(d, '刻德温', { x: 0, y: 6 }).provokes).toEqual([]);
    const e = placed();
    applyDamage(e, '狼', 99);
    expect(moveOnGrid(e, '刻德温', { x: 0, y: 6 }).provokes).toEqual([]);
  });

  it('怪物走开 PC 同样算', () => {
    const c = placed();
    expect(moveOnGrid(c, '狼', { x: 6, y: 6 }).provokes).toContain('刻德温');
  });

  it('本回合累计超速只提醒不拦；指针一动就清零；反应移动不计入', () => {
    const c = placed();
    moveOnGrid(c, '大地精', { x: 8, y: 2 });
    const r = moveOnGrid(c, '大地精', { x: 8, y: 0 });
    expect(r.totalFeet).toBe(40);
    expect(moveResultText(r)).toContain('超过速度 30');
    nextTurn(c);
    expect(c.initiative?.moved).toBeUndefined();
    expect(moveOnGrid(c, '狼', { x: 2, y: 2 }).speed).toBe(40);
    const off = moveOnGrid(c, '大地精', { x: 8, y: 1, reaction: true });
    expect(off.totalFeet).toBe(0);
  });

  it('目标格有人就拒绝；尸体不挡路', () => {
    const c = placed();
    expect(() => moveOnGrid(c, 'Kriv', { x: 1, y: 0 })).toThrow(/已经站着 狼/);
    applyDamage(c, '狼', 99);
    expect(moveOnGrid(c, 'Kriv', { x: 1, y: 0 }).feet).toBe(20);
  });

  it('adjacent_to 走到离自己最近的空格，已经贴着就不动', () => {
    const c = placed();
    const r = moveOnGrid(c, 'Kriv', { adjacentTo: '狼' });
    expect(r.to).toMatchObject({ x: 2, y: 0 });
    expect(r.feet).toBe(15);
    expect(moveOnGrid(c, 'Kriv', { adjacentTo: '狼' }).feet).toBe(0);
  });

  it('没摆位不能 move，免得从不存在的起点算距离', () => {
    const c = arena();
    expect(() => moveOnGrid(c, '狼', { x: 1, y: 1 })).toThrow(/没摆位/);
  });

  it('倒地、擒抱移动时提醒', () => {
    const c = placed();
    changeCondition(c, '刻德温', '倒地', true);
    expect(moveResultText(moveOnGrid(c, '刻德温', { x: 0, y: 1 }))).toContain('倒地');
    changeCondition(c, 'Kriv', '擒抱', true);
    expect(moveResultText(moveOnGrid(c, 'Kriv', { x: 5, y: 1 }))).toContain('速度应为 0');
  });
});

describe('攻击对照站位', () => {
  function placed() {
    const c = arena();
    setPositions(c, [
      { name: '刻德温', x: 0, y: 0 },
      { name: 'Kriv', x: 0, y: 6 },
      { name: '狼', x: 1, y: 0 },
      { name: '大地精', x: 0, y: 3 },
    ]);
    return c;
  }
  const sword = { name: '长剑', damage: '1d8' };
  const bow = { name: '长弓', damage: '1d8' };

  it('近战武器够不到要提醒，够得到只报距离', () => {
    const c = placed();
    expect(attackRangeNote(c, ch(c, '刻德温'), ch(c, '狼'), { weapon: sword })).toBe('【站位】距离 5 尺');
    expect(attackRangeNote(c, ch(c, '刻德温'), ch(c, '大地精'), { weapon: sword })).toContain('够不到');
  });

  it('借机发生在对方走之前，reaction 不查够不够得着', () => {
    const c = placed();
    expect(attackRangeNote(c, ch(c, '刻德温'), ch(c, '大地精'), { weapon: sword, reaction: true })).toBe('【站位】距离 15 尺');
  });

  it('投掷和触及武器按备注放宽', () => {
    const c = placed();
    expect(attackRangeNote(c, ch(c, '刻德温'), ch(c, '大地精'), { weapon: { ...sword, name: '标枪', notes: '投掷 30/120' } })).not.toContain('够不到');
    setPositions(c, [{ name: '大地精', x: 0, y: 2 }]);
    expect(attackRangeNote(c, ch(c, '刻德温'), ch(c, '大地精'), { weapon: { ...sword, name: '长戟', notes: '触及' } })).not.toContain('够不到');
  });

  it('贴身射箭提醒劣势；已经带劣势、对方昏迷、远处没人都不提醒', () => {
    const c = placed();
    expect(attackRangeNote(c, ch(c, '刻德温'), ch(c, '大地精'), { weapon: bow })).toContain('该劣势');
    expect(attackRangeNote(c, ch(c, '刻德温'), ch(c, '大地精'), { weapon: bow, advantage: 'disadvantage' })).not.toContain('该劣势');
    expect(attackRangeNote(c, ch(c, 'Kriv'), ch(c, '狼'), { weapon: bow })).not.toContain('该劣势');
    changeCondition(c, '狼', '昏迷', true);
    expect(attackRangeNote(c, ch(c, '刻德温'), ch(c, '大地精'), { weapon: bow })).not.toContain('该劣势');
  });

  it('怪物和法术分不清近战远程：只说如果是近战', () => {
    const c = placed();
    expect(attackRangeNote(c, ch(c, '狼'), ch(c, 'Kriv'), {})).toContain('如果是近战');
  });

  it('有人没摆位就不说话，不给错误距离', () => {
    const c = arena();
    expect(attackRangeNote(c, ch(c, '狼'), ch(c, 'Kriv'), {})).toBeUndefined();
  });
});

describe('回合提示和团况', () => {
  it('没摆位的会被点名；摆好后给贴身或最近敌人', () => {
    const c = arena();
    expect(turnPositionNote(c, '刻德温')).toContain('还没摆位');
    setPositions(c, [
      { name: '刻德温', x: 0, y: 0 },
      { name: 'Kriv', x: 0, y: 6 },
      { name: '狼', x: 1, y: 0 },
      { name: '大地精', x: 0, y: 3 },
    ]);
    expect(turnPositionNote(c, '刻德温')).toBe('【站位】刻德温(0,0)，贴身：狼。');
    expect(turnPositionNote(c, 'Kriv')).toBe('【站位】Kriv(0,6)，最近的敌人 大地精 15 尺。');
  });

  it('站位进团况：压缩后靠它恢复现场，贴身对子不重复', () => {
    const c = arena();
    setPositions(c, [{ name: '刻德温', x: 0, y: 0 }, { name: '狼', x: 1, y: 0 }]);
    const text = summarize(c, BELL);
    expect(text).toContain('刻德温(0,0)');
    expect(text.match(/贴身：[^\n]*/)?.[0]).toBe('贴身：刻德温-狼');
    expect(text).toContain('未摆位：Kriv、大地精');
  });

  it('战斗结束站位一起清掉，团况不再提', () => {
    const c = arena();
    setPositions(c, [{ name: '刻德温', x: 0, y: 0 }]);
    c.initiative = undefined;
    expect(summarize(c, BELL)).not.toContain('站位');
  });

  it('角色移出先攻表时站位也拿掉', () => {
    const c = arena();
    setPositions(c, [{ name: '狼', x: 3, y: 3 }]);
    applyDamage(c, '狼', 99);
    nextTurn(c);
    expect(c.initiative?.positions?.['狼']).toBeUndefined();
  });

  it('回合提示带上站位一句，没摆位的旧战斗也能被提醒', () => {
    const c = arena();
    expect(combatTurnPrompt(c, '狼')).toContain('【站位】还没摆位');
  });

  it('跨房间战斗不把隔壁的人算进贴身', () => {
    const c = arena();
    ch(c, 'Kriv').room = 'nave';
    setPositions(c, [{ name: 'Kriv', x: 1, y: 0 }, { name: '狼', x: 1, y: 1 }]);
    expect(turnPositionNote(c, 'Kriv')).not.toContain('贴身');
  });
});

describe('SRD 速度', () => {
  it('从 speed.walk 取步行速度', () => {
    expect(srdMonsterInput({ index: 'wolf', speed: { walk: '40 ft.' } }).speed).toBe(40);
    expect(srdMonsterInput({ index: 'x' }).speed).toBeUndefined();
  });
});

describe('dnd_position 工具', () => {
  type Tool = { name: string; execute(args: unknown, exec: { agent?: unknown }): Promise<{ text: string }> };

  function setup(roller: Roller = () => 10) {
    const root = mkdtempSync(join(tmpdir(), 'dnd-position-'));
    const service = new DndService({ store: new CampaignStore(join(root, 'campaigns')), library: new AdventureLibrary(), mapDir: root, roller });
    const key = 'qqbot:app:group:G1';
    service.start(key, 'sunken-bell', false);
    service.store.update(key, (c) => {
      upsertCharacter(c, { name: '卡厄斯', player: 'Chaos', playerId: 'P1', maxHp: 29, abilities: { dex: 20 }, weapons: [{ name: '长剑', damage: '1d8' }] });
      upsertCharacter(c, { name: '地精', kind: 'monster', maxHp: 99, abilities: { dex: 1 }, room: c.currentRoom });
    });
    const record = { sessionKey: key, scope: 'group', peerId: 'G1', recentSenders: [{ id: 'P1', at: Date.now() }] };
    const tools = new Map<string, Tool>();
    const ctx = { get: () => ({ register: (d: Tool) => tools.set(d.name, d) }) };
    registerDndTools(ctx as never, { service, manager: { findByAgent: () => record } as never, logger: logger as never, sendImage: vi.fn() });
    const call = async (name: string, args: Record<string, unknown>) => (await tools.get(name)!.execute(args, { agent: {} })).text;
    return { call, service, key };
  }

  it('摆位、走位、攻击、回合提示串起来，dnd_undo 能退回走位', async () => {
    const { call, service, key } = setup();
    await call('dnd_initiative', { action: 'start' });
    const placedText = await call('dnd_position', { action: 'set', placements: [{ name: '卡厄斯', x: 0, y: 0 }, { name: '地精', x: 4, y: 0 }] });
    expect(placedText).toContain('卡厄斯(0,0)');

    const far = await call('dnd_check', { type: 'attack', character: '卡厄斯', target: '地精', weapon: '长剑', declared_by: 'P1' });
    expect(far).toContain('够不到');

    const moved = await call('dnd_position', { action: 'move', name: '卡厄斯', adjacent_to: '地精', declared_by: 'P1' });
    expect(moved).toContain('走 15 尺');

    const near = await call('dnd_check', { type: 'attack', character: '卡厄斯', target: '地精', weapon: '长剑', declared_by: 'P1' });
    expect(near).toContain('距离 5 尺');
    expect(near).not.toContain('够不到');

    const shown = await call('dnd_position', { action: 'show', from: '卡厄斯' });
    expect(shown).toContain('敌 地精 5 尺');

    const before = service.store.snapshots(key).length;
    await call('dnd_position', { action: 'show' });
    expect(service.store.snapshots(key).length).toBe(before);

    const status = await call('dnd_initiative', { action: 'status' });
    expect(status).toContain('站位｜');

    await call('dnd_undo', { action: 'undo', steps: 2 });
    expect(service.store.load(key)!.initiative!.positions!['卡厄斯']).toMatchObject({ x: 0, y: 0 });
  });

  it('不是他的回合不能走，reaction 可以；玩家本人没发话不能替他走', async () => {
    const { call } = setup();
    await call('dnd_initiative', { action: 'start' });
    await call('dnd_position', { action: 'set', placements: [{ name: '卡厄斯', x: 0, y: 0 }, { name: '地精', x: 4, y: 0 }] });
    await expect(call('dnd_position', { action: 'move', name: '地精', x: 5, y: 0 })).rejects.toThrow(/不能主动行动/);
    expect(await call('dnd_position', { action: 'move', name: '地精', x: 5, y: 0, reaction: true })).toContain('走 5 尺');
    await expect(call('dnd_position', { action: 'move', name: '卡厄斯', x: 1, y: 0 })).rejects.toThrow(/卡厄斯|Chaos/);
  });

  it('dm_override 必须带委托人', async () => {
    const { call } = setup();
    await call('dnd_initiative', { action: 'start' });
    await call('dnd_position', { action: 'set', placements: [{ name: '卡厄斯', x: 0, y: 0 }] });
    await expect(call('dnd_position', { action: 'move', name: '卡厄斯', x: 1, y: 0, dm_override: true })).rejects.toThrow(/declared_by/);
  });

  it('不在战斗中 show 也报错，别让模型以为没有人', async () => {
    const { call } = setup();
    await expect(call('dnd_position', { action: 'show' })).rejects.toThrow(/不在战斗/);
  });

  it('角色卡能设速度，并显示出来', async () => {
    const { call } = setup();
    const text = await call('dnd_character', { action: 'update', name: '卡厄斯', speed: 25 });
    expect(text).toContain('速度 25');
  });

  it('再次进入房间时提醒这是首次进门的剧本', async () => {
    const { call, service, key } = setup();
    const start = service.store.load(key)!.currentRoom;
    const first = await call('dnd_move', { room: 'nave' });
    expect(first).not.toContain('这里来过');
    const back = await call('dnd_move', { room: start });
    expect(back).toContain('这里来过');
  });

  it('secret 检定提示要当场报结果', async () => {
    const { call } = setup();
    const text = await call('dnd_check', { type: 'skill', character: '卡厄斯', skill: '察觉', dc: 10, secret: true, declared_by: 'P1' });
    expect(text).toContain('当场说结果');
  });
});

describe('长柄大师：进入触及范围也吃借机', () => {
  function reachArena() {
    const c = arena();
    // 刻德温只有备注，没有 reactions：走「从备注认能力」这条路
    ch(c, '刻德温').notes = '4 级专长：长柄大师 Polearm Master，手持长戟（触及 10 尺）';
    setPositions(c, [
      { name: '刻德温', x: 10, y: 10 },
      { name: '狼', x: 6, y: 10 },
      { name: 'Kriv', x: 0, y: 20 },
      { name: '大地精', x: 0, y: 25 },
    ]);
    return c;
  }

  it('从 20 尺走进 10 尺触及会报，并指出是哪个反应', () => {
    const c = reachArena();
    const r = moveOnGrid(c, '狼', { x: 8, y: 10 });
    expect(r.enters).toEqual([{ name: '刻德温', reach: 10, reaction: '长柄大师' }]);
    expect(moveResultText(r)).toContain('10 尺触及');
    expect(moveResultText(r)).toContain('长柄大师');
  });

  it('本来就在触及范围里挪动，不算「进入」', () => {
    const c = reachArena();
    setPositions(c, [{ name: '狼', x: 8, y: 10 }]);
    expect(moveOnGrid(c, '狼', { x: 8, y: 9 }).enters).toEqual([]);
  });

  it('没有这个专长的人不会报', () => {
    const c = reachArena();
    ch(c, '刻德温').notes = '普通战士，手里只有长剑';
    expect(moveOnGrid(c, '狼', { x: 8, y: 10 }).enters).toEqual([]);
  });
});
