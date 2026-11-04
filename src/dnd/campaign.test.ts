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
  fightRooms,
  joinInitiative,
  leaveInitiative,
  moveParty,
  outsideRooms,
  reconcileKnownSites,
  usesGreatWeaponFighting,
  weaponAttackModifier,
  nextTurn,
  startInitiative,
  summarize,
  upsertCharacter,
  visibleExits,
} from './campaign.ts';
import { validateDungeon } from './dungeon.ts';
import { DndService } from './dnd-service.ts';
import { buildMapSvg } from './map-render.ts';
import { combatJoinHint, critExpression, diceCount, greatWeaponRoller } from './dnd-tools.ts';
import { rollExpression } from './dice.ts';
import type { Adventure } from './adventure.ts';
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

describe('中途入战', () => {
  // 艾琳、布洛克先进中殿开打，卡拉留在门口
  function lateFight() {
    const c = party();
    upsertCharacter(c, { name: '卡拉', className: '牧师', abilities: { dex: 10 }, maxHp: 10, ac: 15 });
    moveParty(c, BELL, 'nave', false, ['艾琳', '布洛克']);
    startInitiative(c, fixed(10, 18, 5, 12, 3)); // 布洛克18 > 巨鼠2 14 > 艾琳13 > 巨鼠1 7 > 巨鼠3 5
    return c;
  }
  const names = (c: ReturnType<typeof lateFight>) => c.initiative!.order.map((e) => e.name);

  it('不在先攻表里的队友战斗中也能赶路，表里的人仍要等自己回合', () => {
    const c = lateFight();
    expect(names(c)).not.toContain('卡拉');
    expect(() => moveParty(c, BELL, 'nave', false, ['卡拉'])).not.toThrow();
    expect(() => moveParty(c, BELL, 'gate', false, ['艾琳'])).toThrow(/要等自己的回合/);
  });

  it('join 只给新人掷先攻并插入，不重置轮数，当前行动者不变', () => {
    const c = lateFight();
    nextTurn(c); // 巨鼠2
    const rolls = joinInitiative(c, ['卡拉'], fixed(16));
    expect(rolls).toMatchObject([{ name: '卡拉', init: 16 }]);
    expect(names(c)).toEqual(['布洛克', '卡拉', '巨鼠2', '艾琳', '巨鼠1', '巨鼠3']);
    expect(c.initiative).toMatchObject({ round: 1, turn: 2 });
    expect(c.initiative!.order[c.initiative!.turn]!.name).toBe('巨鼠2');
    // 插在前面的本轮错过，下一轮才轮到
    nextTurn(c);
    nextTurn(c);
    nextTurn(c);
    expect(nextTurn(c)).toMatchObject({ newRound: true, current: { name: '布洛克' } });
    expect(nextTurn(c).current.name).toBe('卡拉');
  });

  it('点数低的新人排到后面，本轮就能行动', () => {
    const c = lateFight();
    joinInitiative(c, ['卡拉'], fixed(1));
    expect(names(c).at(-1)).toBe('卡拉');
    expect(c.initiative).toMatchObject({ round: 1, turn: 0 });
  });

  it('同点数排在已在场的人后面；重复加入、空名单、不在战斗中都报错', () => {
    const c = lateFight();
    joinInitiative(c, ['卡拉'], fixed(13)); // 和艾琳同为 13
    expect(names(c).indexOf('卡拉')).toBe(names(c).indexOf('艾琳') + 1);
    expect(() => joinInitiative(c, ['艾琳'])).toThrow(/已经在先攻表里/);
    expect(() => joinInitiative(c, [])).toThrow(/participants/);
    endInitiative(c);
    expect(() => joinInitiative(c, ['卡拉'])).toThrow(/不在战斗中/);
  });

  it('列出不在交战房间的参战者', () => {
    const c = lateFight();
    expect(outsideRooms(c, ['卡拉', '艾琳'], fightRooms(c))).toMatchObject([{ name: '卡拉' }]);
  });

  it('有人赶到交战房间、或刷出新怪时提示用 join', () => {
    const c = lateFight();
    expect(combatJoinHint(c, 'nave', ['卡拉'], [])).toMatch(/dnd_initiative join participants=\[卡拉\]/);
    expect(combatJoinHint(c, 'gate', ['卡拉'], [])).toBeUndefined();
    expect(combatJoinHint(c, 'gate', [], ['骷髅1'])).toMatch(/骷髅1/);
    expect(combatJoinHint(c, 'nave', ['艾琳'], [])).toBeUndefined();
    endInitiative(c);
    expect(combatJoinHint(c, 'nave', ['卡拉'], [])).toBeUndefined();
  });
});

describe('离场与回合指针', () => {
  // 布洛克18 > 巨鼠2 14 > 艾琳13 > 巨鼠1 7 > 巨鼠3 5
  function fight() {
    const c = party();
    moveParty(c, BELL, 'nave');
    startInitiative(c, fixed(10, 18, 5, 12, 3));
    return c;
  }

  it('当前行动的怪逃走：移出先攻表，next 落到原来排在它后面的人', () => {
    const c = fight();
    nextTurn(c); // 巨鼠2
    expect(leaveInitiative(c, '巨鼠2')).toBe(true);
    expect(c.initiative!.order.map((e) => e.name)).not.toContain('巨鼠2');
    expect(nextTurn(c).current.name).toBe('艾琳');
    expect(leaveInitiative(c, '巨鼠2')).toBe(false);
  });

  it('当前行动者在自己回合里倒下，next 不跳过下一个人', () => {
    const c = fight();
    nextTurn(c); // 巨鼠2
    applyDamage(c, '巨鼠2', 99);
    expect(nextTurn(c).current.name).toBe('艾琳');
  });

  it('排在最后的人倒下时正常进入下一轮', () => {
    const c = fight();
    for (let i = 0; i < 4; i++) nextTurn(c); // 巨鼠3
    applyDamage(c, '巨鼠3', 99);
    expect(nextTurn(c)).toMatchObject({ newRound: true, round: 2, current: { name: '布洛克' } });
  });
});

describe('战斗风格、专精、魔法武器', () => {
  it('命中加值：魔法 +N、不熟练去掉熟练、箭术只加远程', () => {
    const c = party();
    const { character: erin } = upsertCharacter(c, {
      name: '艾琳',
      traits: ['Archery'],
      weapons: [
        { name: '短弓', damage: '1d6', ability: 'dex' },
        { name: '刺剑', damage: '1d8', ability: 'dex', magic: 1 },
        { name: '弯刀', damage: '1d6', ability: 'dex', proficient: false },
      ],
    });
    expect(erin.traits).toEqual(['箭术']);
    // 敏捷 16 → +3，1 级熟练 +2
    expect(weaponAttackModifier(erin, findWeapon(erin, '短弓'))).toBe(7);
    expect(weaponAttackModifier(erin, findWeapon(erin, '刺剑'))).toBe(6);
    expect(weaponDamage(erin, findWeapon(erin, '刺剑'))).toBe('1d8+4');
    expect(weaponAttackModifier(erin, findWeapon(erin, '弯刀'))).toBe(3);
  });

  it('专精：熟练加值翻倍，并自动算熟练', () => {
    const c = party();
    const { character: erin } = upsertCharacter(c, { name: '艾琳', expertise: ['stealth', 'sleight_of_hand'] });
    expect(checkModifier(erin, 'skill', 'dex', 'stealth')).toBe(7);
    expect(checkModifier(erin, 'skill', 'dex', 'sleight_of_hand')).toBe(7);
    expect(erin.skills).toContain('sleight_of_hand');
    expect(checkModifier(erin, 'skill', 'wis', 'perception')).toBe(3);
  });

  it('巨武器战斗只作用在双手近战武器上', () => {
    const c = party();
    const { character: brock } = upsertCharacter(c, {
      name: '布洛克',
      traits: ['巨武器战斗'],
      weapons: [{ name: '巨斧', damage: '1d12', notes: '挥砍，双手、重型' }, { name: '长剑', damage: '1d8', notes: '多用途' }],
    });
    expect(usesGreatWeaponFighting(brock, findWeapon(brock, '巨斧'))).toBe(true);
    expect(usesGreatWeaponFighting(brock, findWeapon(brock, '长剑'))).toBe(false);
    expect(usesGreatWeaponFighting(c.characters.find((ch) => ch.name === '艾琳')!, findWeapon(brock, '巨斧'))).toBe(false);
  });

  it('巨武器战斗重投只重投武器骰里的 1、2，附加骰不动', () => {
    const gwf = greatWeaponRoller(fixed(1, 7, 2, 5, 1), diceCount(critExpression('1d12')));
    const r = rollExpression('2d12+3+1d6', gwf.roller);
    expect(r.total).toBe(7 + 5 + 3 + 1);
    expect(gwf.rerolls).toEqual(['1→7', '2→5']);
    expect(diceCount('2d6+3+1d4')).toBe(3);
  });
});

describe('场景校准', () => {
  it('补上模组里没写 knownWhen 的场景，有条件的不动，只增不减', () => {
    const c = party();
    c.knownSites = ['old'];
    const adv = { sites: [{ id: 'town' }, { id: 'secret', knownWhen: { flag: 'x' } }] } as unknown as Adventure;
    expect(reconcileKnownSites(c, adv)).toEqual(['town']);
    expect(c.knownSites).toEqual(['old', 'town']);
    expect(reconcileKnownSites(c, adv)).toEqual([]);
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

  it('委托来的行动传 dmOverride：不查本人，但仍然只能在轮到他的回合里动', () => {
    const c = fight();
    const brock = c.characters.find((ch) => ch.name === '布洛克')!;
    // 布洛克是当前回合，别人委托他行动：放行
    expect(() => assertCanAct(c, brock, { declaredBy: 'P1', recentSenders: ['P1'], dmOverride: true })).not.toThrow();
    // 不是他的回合，被推/被拖之外也不能替他主动行动
    const erin = c.characters.find((ch) => ch.name === '艾琳')!;
    expect(() => assertCanAct(c, erin, { declaredBy: 'P1', recentSenders: ['P1'], dmOverride: true })).toThrow(/现在是/);
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

    expect(service.promptSections('group:abc')[0]!.name).toBe('qqbot:dnd-dm');
    expect(service.stateSnapshot('group:abc')).toContain('【团况 · DM 视角】');
    service.stop('group:abc');
    expect(service.promptSections('group:abc')).toEqual([]);
    expect(service.stateSnapshot('group:abc')).toBe('');
    expect(() => service.store.update('group:abc', () => 0)).toThrow(/\/dnd start/);

    const again = service.start('group:abc', 'sunken-bell', false);
    expect(again.resumed).toBe(true);
    expect(again.campaign.characters.map((ch) => ch.name)).toEqual(['艾琳']);

    // 新开默认带上 PC 卡（位置清空），空卡才从零开始
    service.store.update('group:abc', (c) => { c.characters[0]!.room = 'nave'; });
    const fresh = service.start('group:abc', undefined, true);
    expect(fresh.carried).toEqual(['艾琳']);
    expect(fresh.campaign.characters[0]?.room).toBeUndefined();
    const blank = service.start('group:abc', undefined, true, { keepParty: false });
    expect(blank.campaign.characters).toHaveLength(0);
    expect(readdirSync(root).filter((f) => f.endsWith('.json'))).toHaveLength(3);
    expect(() => service.start('group:abc', 'nope', false)).toThrow(/没有这个模组/);
  });
});
