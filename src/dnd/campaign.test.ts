import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import type { Roller } from './dice.ts';
import {
  CampaignStore,
  applyDamage,
  assertCanAct,
  assertCanEndTurn,
  checkModifier,
  findWeapon,
  gotoTurn,
  weaponDamage,
  createCampaign,
  deathSave,
  endInitiative,
  heal,
  grantTempHp,
  moveParty,
  nextTurn,
  startInitiative,
  summarize,
  upsertCharacter,
  visibleExits,
} from './campaign.ts';
import { validateDungeon } from './dungeon.ts';
import { DndService } from './dnd-service.ts';
import { buildMapSvg } from './map-render.ts';
import { SUNKEN_BELL } from './dungeons/sunken-bell.ts';
import { AdventureLibrary, adventureFromDungeon } from './adventure.ts';

const BELL = adventureFromDungeon(SUNKEN_BELL);

function fixed(...values: number[]): Roller {
  let i = 0;
  return () => values[i++ % values.length]!;
}

function party() {
  const c = createCampaign('group:abc', BELL);
  upsertCharacter(c, {
    name: '艾琳', player: '小鱼', className: '游荡者', level: 1,
    abilities: { dex: 16, wis: 12 }, skills: ['perception', 'stealth'], saves: ['dex', 'int'], maxHp: 9, ac: 14,
  });
  upsertCharacter(c, { name: '布洛克', className: '战士', abilities: { str: 16, dex: 10 }, maxHp: 12, ac: 16 });
  return c;
}

describe('内置地城', () => {
  it('结构合法', () => {
    expect(() => validateDungeon(SUNKEN_BELL)).not.toThrow();
  });
});

describe('角色卡与 HP', () => {
  it('建卡默认满血，熟练加值进技能修正', () => {
    const c = party();
    const erin = c.characters[0]!;
    expect(erin.hp).toBe(9);
    expect(checkModifier(erin, 'skill', 'wis', 'perception')).toBe(3); // +1 感知 +2 熟练
    expect(checkModifier(erin, 'skill', 'wis', 'insight')).toBe(1);
    expect(checkModifier(erin, 'save', 'dex')).toBe(5);
  });

  it('更新只改传入的字段', () => {
    const c = party();
    upsertCharacter(c, { name: '艾琳', ac: 15 });
    expect(c.characters[0]!.ac).toBe(15);
    expect(c.characters[0]!.abilities.dex).toBe(16);
    expect(c.characters[0]!.player).toBe('小鱼');
  });

  it('临时 HP 先吸收伤害', () => {
    const c = party();
    grantTempHp(c, '艾琳', 4);
    const change = applyDamage(c, '艾琳', 6);
    expect(change.absorbed).toBe(4);
    expect(change.after).toBe(7);
  });

  it('PC 到 0 昏迷，溢出 ≥ 最大 HP 直接死亡', () => {
    const c = party();
    expect(applyDamage(c, '艾琳', 9).events).toContain('昏迷');
    expect(heal(c, '艾琳', 3).events).toContain('苏醒');
    expect(c.characters[0]!.conditions).not.toContain('昏迷');
    expect(applyDamage(c, '布洛克', 24).events).toContain('死亡');
  });

  it('按玩家昵称也能找到角色', () => {
    const c = party();
    expect(applyDamage(c, '小鱼', 1).name).toBe('艾琳');
  });

  it('死亡豁免：三次成功稳定，天然 1 记两次失败', () => {
    const c = party();
    applyDamage(c, '艾琳', 9);
    deathSave(c, '艾琳', fixed(12));
    deathSave(c, '艾琳', fixed(15));
    expect(deathSave(c, '艾琳', fixed(10)).outcome).toBe('stable');

    const d = party();
    applyDamage(d, '艾琳', 9);
    expect(deathSave(d, '艾琳', fixed(1)).failures).toBe(2);
    applyDamage(d, '艾琳', 1); // 倒地时受伤 = 第三次失败
    expect(d.characters[0]!.conditions).toContain('死亡');
  });
});

describe('移动与遭遇', () => {
  it('只能走相邻房间，首次进入揭示并刷怪', () => {
    const c = party();
    expect(() => moveParty(c, BELL, 'bellshaft')).toThrow(/不相邻/);
    const r = moveParty(c, BELL, '钟楼残殿');
    expect(r.firstVisit).toBe(true);
    expect(r.spawned.map((m) => m.name)).toEqual(['巨鼠1', '巨鼠2', '巨鼠3']);
    expect(c.revealed).toEqual(['gate', 'nave']);

    moveParty(c, BELL, 'gate');
    const back = moveParty(c, BELL, 'nave');
    expect(back.firstVisit).toBe(false);
    expect(back.spawned).toHaveLength(0);
  });

  it('暗门要 discover_hidden 才能走，发现后出现在出口里', () => {
    const c = party();
    moveParty(c, BELL, 'nave');
    moveParty(c, BELL, 'ossuary');
    expect(visibleExits(c, BELL).map((e) => e.to)).toEqual(['nave']);
    expect(() => moveParty(c, BELL, 'reliquary')).toThrow(/没有可见的路/);
    moveParty(c, BELL, 'reliquary', true);
    expect(visibleExits(c, BELL).map((e) => e.to)).toContain('ossuary');
  });

  it('战斗中不能整队移动', () => {
    const c = party();
    moveParty(c, BELL, 'nave');
    startInitiative(c, fixed(10));
    expect(() => moveParty(c, BELL, 'gate')).toThrow(/战斗/);
  });
});

describe('先攻', () => {
  it('掷先攻排序，跳过死亡角色，结束时清理死怪', () => {
    const c = party();
    moveParty(c, BELL, 'nave');
    // 艾琳 +3, 布洛克 +0, 巨鼠 +2 ×3
    const rolls = startInitiative(c, fixed(10, 18, 5, 12, 3));
    expect(rolls.map((r) => r.name)).toEqual(['布洛克', '巨鼠2', '艾琳', '巨鼠1', '巨鼠3']);

    applyDamage(c, '巨鼠2', 7);
    const next = nextTurn(c);
    expect(next.current.name).toBe('艾琳');
    nextTurn(c);
    nextTurn(c);
    expect(nextTurn(c)).toMatchObject({ newRound: true, round: 2, current: { name: '布洛克' } });

    const ended = endInitiative(c);
    expect(ended.defeated).toEqual(['巨鼠2']);
    expect(c.characters.some((ch) => ch.name === '巨鼠2')).toBe(false);
    expect(c.initiative).toBeUndefined();
  });
});

describe('行动界限', () => {
  function bound() {
    const c = party();
    upsertCharacter(c, { name: '艾琳', playerId: 'P1' });
    upsertCharacter(c, { name: '布洛克', player: '大块头', playerId: 'P2' });
    return c;
  }
  const erin = (c: ReturnType<typeof bound>) => c.characters.find((ch) => ch.name === '艾琳')!;
  const brock = (c: ReturnType<typeof bound>) => c.characters.find((ch) => ch.name === '布洛克')!;

  it('绑定玩家的 PC 只能由本人宣告，reaction 例外', () => {
    const c = bound();
    expect(() => assertCanAct(c, erin(c), { declaredBy: 'P1' })).not.toThrow();
    expect(() => assertCanAct(c, erin(c), { declaredBy: 'P2' })).toThrow(/小鱼/);
    expect(() => assertCanAct(c, erin(c), {})).toThrow(/declared_by/);
    expect(() => assertCanAct(c, erin(c), { declaredBy: 'P2', reaction: true })).not.toThrow();
  });

  it('没绑定的 PC 和怪物不查玩家', () => {
    const c = party();
    expect(() => assertCanAct(c, c.characters[0]!, {})).not.toThrow();
  });

  it('战斗中只有当前回合的角色能主动行动', () => {
    const c = bound();
    moveParty(c, BELL, 'nave');
    // 布洛克 18 最高，先行动
    startInitiative(c, fixed(10, 18, 5, 12, 3));
    expect(() => assertCanAct(c, brock(c), { declaredBy: 'P2' })).not.toThrow();
    expect(() => assertCanAct(c, erin(c), { declaredBy: 'P1' })).toThrow(/布洛克 的回合/);
    const rat = c.characters.find((ch) => ch.name === '巨鼠2')!;
    expect(() => assertCanAct(c, rat)).toThrow(/dnd_initiative next/);
    nextTurn(c);
    expect(() => assertCanAct(c, rat)).not.toThrow();
    expect(() => assertCanAct(c, erin(c), { declaredBy: 'P1', reaction: true })).not.toThrow();
  });
});

describe('回合结束、指针修正、武器', () => {
  function fight() {
    const c = party();
    upsertCharacter(c, { name: '布洛克', playerId: 'P2', weapons: [{ name: '巨斧', damage: '1d12' }] });
    moveParty(c, BELL, 'nave');
    startInitiative(c, fixed(10, 18, 5, 12, 3)); // 布洛克先
    return c;
  }

  it('PC 回合只有本人能结束，且他最近得真发过消息', () => {
    const c = fight();
    expect(() => assertCanEndTurn(c, { declaredBy: 'P1', recentSenders: ['P1'] })).toThrow(/结束回合/);
    expect(() => assertCanEndTurn(c, { declaredBy: 'P2', recentSenders: ['P1'] })).toThrow(/最近没有发消息/);
    expect(() => assertCanEndTurn(c, { declaredBy: 'P2', recentSenders: ['P2'] })).not.toThrow();
    expect(() => assertCanEndTurn(c, { dmOverride: true })).not.toThrow();
    nextTurn(c);
    // 现在是怪物回合，谁都能推进
    expect(() => assertCanEndTurn(c, {})).not.toThrow();
  });

  it('declared_by 抄了角色卡上的 openid 也过不了发送者核对', () => {
    const c = fight();
    const brock = c.characters.find((ch) => ch.name === '布洛克')!;
    expect(() => assertCanAct(c, brock, { declaredBy: 'P2', recentSenders: ['P1'] })).toThrow(/最近没有发消息/);
  });

  it('goto 修正先攻指针', () => {
    const c = fight();
    gotoTurn(c, '艾琳', 2);
    expect(c.initiative).toMatchObject({ round: 2, turn: 2 });
    expect(() => gotoTurn(c, '不存在')).toThrow();
  });

  it('武器伤害 = 武器骰 + 属性调整值', () => {
    const c = fight();
    const brock = c.characters.find((ch) => ch.name === '布洛克')!;
    expect(weaponDamage(brock, findWeapon(brock, '巨斧'))).toBe('1d12+3');
    expect(() => findWeapon(brock, '巨剑')).toThrow(/现有武器：巨斧/);
  });
});

describe('撤销', () => {
  it('每次改动存快照，undo 一次回到多步之前', () => {
    const root = mkdtempSync(join(tmpdir(), 'dnd-undo-'));
    const service = new DndService({
      store: new CampaignStore(root),
      library: new AdventureLibrary({ dungeons: join(root, 'dungeons') }),
      mapDir: join(root, 'maps'),
    });
    service.start('group:u', undefined, false);
    service.store.update('group:u', (c) => upsertCharacter(c, { name: '艾琳', maxHp: 9 }), '建卡');
    service.store.update('group:u', (c) => applyDamage(c, '艾琳', 3), '受伤 3');
    service.store.update('group:u', (c) => applyDamage(c, '艾琳', 4), '受伤 4');
    // 没有改动的调用不留快照
    service.store.update('group:u', () => 0, '只读');
    expect(service.store.snapshots('group:u').map((s) => s.label)).toEqual(['建卡', '受伤 3', '受伤 4']);

    expect(service.store.undo('group:u', 2)).toEqual(['受伤 4', '受伤 3']);
    expect(service.require('group:u').campaign.characters[0]!.hp).toBe(9);
    expect(service.store.snapshots('group:u')).toHaveLength(1);
  });
});

describe('摘要与地图', () => {
  it('摘要包含房间、队伍、敌人和战斗轮次', () => {
    const c = party();
    moveParty(c, BELL, 'nave');
    startInitiative(c, fixed(10));
    const text = summarize(c, BELL);
    expect(text).toContain('钟楼残殿');
    expect(text).toContain('艾琳 9/9 AC14〈小鱼〉');
    expect(text).toContain('巨鼠1 7/7');
    expect(text).toContain('战斗第 1 轮');
  });

  it('地图只画已揭示的房间', () => {
    const c = party();
    moveParty(c, BELL, 'nave');
    const svg = buildMapSvg(c, BELL);
    expect(svg).toContain('塌陷门厅');
    expect(svg).toContain('钟楼残殿');
    expect(svg).not.toContain('藏骨堂');
    expect(svg).not.toContain('圣物龛');
    // 未探索的出口画成问号小截
    expect(svg).toContain('>?</text>');
  });
});

describe('CampaignStore / DndService', () => {
  it('落盘、续团、换地城时存档旧团', () => {
    const root = mkdtempSync(join(tmpdir(), 'dnd-'));
    const service = new DndService({
      store: new CampaignStore(root),
      library: new AdventureLibrary({ dungeons: join(root, 'dungeons') }),
      mapDir: join(root, 'maps'),
    });
    const first = service.start('group:abc', undefined, false);
    expect(first.resumed).toBe(false);
    service.store.update('group:abc', (c) => upsertCharacter(c, { name: '艾琳' }));

    expect(service.promptSections('group:abc').map((s) => s.name)).toEqual(['qqbot:dnd-dm', 'qqbot:dnd-state']);
    service.stop('group:abc');
    expect(service.promptSections('group:abc')).toEqual([]);
    expect(() => service.store.update('group:abc', () => 0)).toThrow(/\/dnd start/);

    const again = service.start('group:abc', 'sunken-bell', false);
    expect(again.resumed).toBe(true);
    expect(again.campaign.characters.map((ch) => ch.name)).toEqual(['艾琳']);

    const fresh = service.start('group:abc', undefined, true);
    expect(fresh.campaign.characters).toHaveLength(0);
    expect(readdirSync(root).filter((f) => f.endsWith('.json'))).toHaveLength(2);
    expect(() => service.start('group:abc', 'nope', false)).toThrow(/没有这个模组/);
  });
});
