import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import type { Roller } from './dice.ts';
import {
  type Adventure,
  AdventureLibrary,
  adventureFromDungeon,
  adventureWarnings,
  validateAdventure,
} from './adventure.ts';
import {
  CampaignStore,
  applyDamage,
  createCampaign,
  explored,
  moveParty,
  parseCampaign,
  partyPositions,
  summarize,
  upsertCharacter,
  visibleExits,
} from './campaign.ts';
import { DndService } from './dnd-service.ts';
import { lookup, storyAction } from './dnd-tools.ts';
import { buildMapSvg } from './map-render.ts';
import { parseSkill } from './rules.ts';
import { SUNKEN_BELL } from './dungeons/sunken-bell.ts';
import { afterChange, evalCondition, npcAlive, roomView } from './story.ts';

function fixed(...values: number[]): Roller {
  let i = 0;
  return () => values[i++ % values.length]!;
}

const rat = { srd: 'giant-rat', name: '巨鼠', count: 2, hp: 7, ac: 12, initBonus: 2, attackBonus: 4, damage: '1d4+2' };

/** 测试用的原创小模组：营地 + 矿坑两个场景，覆盖线索、任务、触发器、出口门槛和检定 */
function fixture(): Adventure {
  return validateAdventure({
    id: 'grey-mine',
    name: '灰岩矿坑',
    truth: ['工头被矿坑深处的东西控制了。'],
    hook: '矿镇的矿工接连失踪。',
    start: 'camp-gate',
    chapters: [
      { id: 'town', name: '矿镇', mode: 'hub', goal: '打听矿坑的事', dmGuide: '让玩家和老矿工聊天。', exitWhen: { lead: 'mine-map' }, next: 'mine' },
      { id: 'mine', name: '矿坑', mode: 'dungeon', goal: '找到工头', dmGuide: '矿坑里很暗。' },
    ],
    flags: [{ id: 'alarm' }, { id: 'vault-open', label: '金库已开' }, { id: 'mine-cleared', label: '矿坑清理完毕' }, { id: 'cellar-known' }],
    sites: [
      {
        // 城镇：地点不写坐标和出口，加载时自动排版，彼此随便走
        id: 'camp', name: '矿镇营地', kind: 'hub', chapter: 'town', entry: 'camp-gate',
        rooms: [
          { id: 'camp-gate', name: '营地大门', playerView: '木栅栏围着几顶帐篷。', dmNotes: '安全区。' },
          { id: 'camp-tavern', name: '酒棚', playerView: '几张长凳。', dmNotes: '老矿工在角落喝酒。' },
          { id: 'camp-shop', name: '杂货铺', playerView: '货架上堆着绳子和火把。', shop: { sells: '绳子、火把、口粮', maxPrice: 25 } },
          { id: 'camp-cellar', name: '地窖', playerView: '潮湿的地窖。', dmNotes: '侄子的日记。', knownWhen: 'cellar-known' },
        ],
      },
      {
        id: 'mine', name: '灰岩矿坑', chapter: 'mine', entry: 'mine-mouth', knownWhen: { lead: 'mine-map' },
        features: '没有光；碎石是困难地形。', arrival: '山腰上黑洞洞的矿口吹出冷风。',
        rooms: [
          {
            id: 'mine-mouth', name: '矿口', x: 0, y: 0, w: 3, h: 3, playerView: '矿车倒在铁轨边。', dmNotes: '往下是竖井。',
            exits: [
              { to: 'mine-shaft', label: '竖井', check: { skill: '运动', dc: 12, fail: '滑下去摔伤 1d6' } },
              { to: 'mine-vault', label: '铁门', requires: 'vault-open', lockedText: '铁门锁着，口令在老矿工那里' },
            ],
            triggers: [{ id: 'mouth-alarm', when: '队伍在矿口大声喧哗', then: '巨鼠被惊动冲出来', set: ['alarm'], spawn: [rat] }],
          },
          {
            id: 'mine-shaft', name: '竖井底', x: 0, y: 4, w: 3, h: 3, playerView: '一片寂静。', dmNotes: '工头在这里。', exits: [],
            variants: [{ when: 'alarm', playerView: '远处传来尖叫声。' }],
          },
          { id: 'mine-vault', name: '金库', x: 4, y: 0, w: 3, h: 3, playerView: '一排排矿石箱。', dmNotes: '50 gp。', exits: [] },
        ],
      },
    ],
    npcs: [
      {
        id: 'old-miner', name: '老矿工', role: '退休矿工，知道矿坑的事', look: '满脸煤灰的老头', motive: '想找回失踪的侄子',
        home: { room: 'camp-tavern' }, attitude: 'friendly', offers: ['clear-mine'],
        knows: [
          { id: 'mine-rumor', text: '矿坑在北边山腰上。', via: 'ask', leads: ['mine-map'] },
          { id: 'vault-word', text: '铁门口令是「灰岩」。', via: 'persuade', dc: 13, set: ['vault-open'] },
          { id: 'cellar-hint', text: '酒棚底下有个地窖，侄子以前常躲在那。', via: 'ask', set: ['cellar-known'] },
        ],
      },
      {
        id: 'foreman', name: '工头', role: '被控制的工头', look: '眼神空洞的壮汉', motive: '听从深处的声音',
        home: { room: 'mine-shaft' }, attitude: 'hostile', knows: [],
        stat: { name: '工头', count: 1, hp: 20, ac: 13, initBonus: 1, attackBonus: 5, damage: '1d8+3' },
      },
      {
        id: 'guard', name: '守卫', role: '营地守卫', look: '拿长矛的年轻人', motive: '保护营地', home: { room: 'camp-gate' },
        attitude: 'indifferent', knows: [], canJoin: true,
      },
    ],
    leads: [
      { id: 'mine-map', text: '矿坑在北边山腰', points: { site: 'mine' }, resolvedWhen: { visited: 'mine' } },
      { id: 'mine-tracks', text: '车辙通往山腰矿口', points: { room: 'mine-mouth' } },
    ],
    quests: [
      {
        id: 'clear-mine', name: '清理矿坑', giver: 'old-miner', brief: '找到工头，查明失踪的原因。',
        target: { site: 'mine' }, completeWhen: { npc: 'foreman', alive: false },
        reward: { gp: 50, items: ['矿灯'], set: ['mine-cleared'], atGiver: true },
      },
    ],
    milestones: [{ level: 2, when: { quest: 'clear-mine', status: ['completed', 'rewarded'] } }],
  });
}

function party(adv: Adventure) {
  const c = createCampaign('group:mine', adv);
  upsertCharacter(c, { name: '艾琳', player: '小鱼', abilities: { str: 14 }, skills: ['athletics'], maxHp: 10 });
  upsertCharacter(c, { name: '布洛克', abilities: { str: 8 }, maxHp: 12 });
  return c;
}

describe('模组校验', () => {
  it('合法模组通过，旧地城能包成模组', () => {
    expect(() => fixture()).not.toThrow();
    expect(() => validateAdventure(adventureFromDungeon(SUNKEN_BELL))).not.toThrow();
  });

  it('房间 id 全局唯一、条件里的 flag 要声明、出口不能直接跨场景', () => {
    const base = fixture();
    const dupRoom = structuredClone(base);
    dupRoom.sites[1]!.rooms[0]!.id = 'camp-gate';
    expect(() => validateAdventure(dupRoom)).toThrow(/重复/);
    const badFlag = structuredClone(base);
    badFlag.sites[1]!.rooms[0]!.exits[1]!.requires = 'no-such-flag';
    expect(() => validateAdventure(badFlag)).toThrow(/没声明的 flag/);
    const crossExit = structuredClone(base);
    crossExit.sites[0]!.rooms[0]!.exits.push({ to: 'mine-mouth', label: '捷径' });
    expect(() => validateAdventure(crossExit)).toThrow(/不存在的房间/);
    const badNpc = structuredClone(base);
    badNpc.npcs[0]!.home.room = 'nowhere';
    expect(() => validateAdventure(badNpc)).toThrow(/home.room/);
  });

  it('警告：没人设置的 flag、线索太少的场景', () => {
    const adv = fixture();
    expect(adventureWarnings(adv)).toEqual([]);
    const thin = structuredClone(adv);
    thin.leads = thin.leads.filter((l) => l.id !== 'mine-tracks');
    thin.npcs[0]!.knows[1]!.set = [];
    const warnings = adventureWarnings(validateAdventure(thin));
    expect(warnings.some((w) => w.includes('vault-open'))).toBe(true);
    expect(warnings.some((w) => w.includes('场景 mine 只有 1 条线索'))).toBe(true);
  });
});

describe('存档升级', () => {
  it('v1 存档读出来是 v2，undo 回升级前的快照也能用', () => {
    const v1 = { ...createCampaign('group:old', adventureFromDungeon(SUNKEN_BELL)) } as Record<string, unknown>;
    for (const k of ['chapter', 'flags', 'leads', 'facts', 'firedTriggers', 'quests', 'npcs', 'knownSites', 'announced', 'adventureId']) delete v1[k];
    v1.version = 1;
    v1.dungeonId = 'sunken-bell';
    const c = parseCampaign(JSON.stringify(v1))!;
    expect(c.version).toBe(2);
    expect(c.adventureId).toBe('sunken-bell');
    expect(c.knownSites).toEqual(['sunken-bell']);
    expect(c.flags).toEqual([]);

    const root = mkdtempSync(join(tmpdir(), 'dnd-v1-'));
    writeFileSync(join(root, 'group_old.json'), JSON.stringify(v1));
    const store = new CampaignStore(root);
    expect(store.load('group:old')?.adventureId).toBe('sunken-bell');
    store.update('group:old', (x) => upsertCharacter(x, { name: '艾琳' }), '建卡');
    // 快照存的是升级后的 JSON；手动塞一份 v1 快照模拟升级前的历史
    writeFileSync(join(root, 'history', 'group_old.json'), JSON.stringify([{ at: 0, label: '旧', state: JSON.stringify(v1) }]));
    store.undo('group:old', 1);
    expect(store.load('group:old')?.version).toBe(2);
    expect(parseCampaign(JSON.stringify({ version: 9 }))).toBeUndefined();
  });
});

describe('跨场景移动与出口', () => {
  it('不知道的场景去不了；得到线索后从城镇任何地点出发，离开地城要回入口', () => {
    const adv = fixture();
    const c = party(adv);
    expect(c.knownSites).toEqual(['camp']);
    expect(() => moveParty(c, adv, 'mine-mouth')).toThrow(/还不知道/);

    moveParty(c, adv, 'camp-tavern');
    const fact = storyAction(c, adv, 'fact', 'mine-rumor', {});
    expect(fact.join('\n')).toContain('玩家知道了「灰岩矿坑」');
    expect(afterChange(c, adv).join()).toContain('可以进入「矿坑」');
    expect(visibleExits(c, adv).map((e) => e.label)).toContain('前往灰岩矿坑');

    const r = moveParty(c, adv, '灰岩矿坑');
    expect(r.room.id).toBe('mine-mouth');
    expect(r.firstSiteVisit).toBe(true);
    expect(r.travelledFrom?.id).toBe('camp');
    expect(r.site.arrival).toContain('矿口');
    // 整队走进下一章的场景：自动翻章，回城不会翻回去
    expect(r.story).toContain('进入章节「矿坑」：找到工头');
    expect(c.chapter).toBe('mine');
    expect(summarize(c, adv)).toContain('场景：灰岩矿坑');
    // 进过矿坑之后线索算解决了
    expect(summarize(c, adv)).not.toContain('未解决的线索');

    // 地城只能从入口离开；回城镇落在城镇入口
    c.characters.forEach((ch) => { ch.room = 'mine-shaft'; });
    c.currentRoom = 'mine-shaft';
    c.revealed.push('mine-shaft');
    expect(() => moveParty(c, adv, '矿镇营地')).toThrow(/先回到入口/);
    c.characters.forEach((ch) => { ch.room = 'mine-mouth'; });
    c.currentRoom = 'mine-mouth';
    expect(moveParty(c, adv, '矿镇营地').room.id).toBe('camp-gate');
    expect(c.chapter).toBe('mine');
  });

  it('只有一人去了下一章的场景时不翻章', () => {
    const adv = fixture();
    const c = party(adv);
    storyAction(c, adv, 'lead', 'mine-map', {});
    moveParty(c, adv, '灰岩矿坑', false, ['艾琳']);
    expect(c.chapter).toBe('town');
  });

  it('上锁的出口要条件满足；检定出口没过的人留在原地', () => {
    const adv = fixture();
    const c = party(adv);
    c.knownSites.push('mine');
    moveParty(c, adv, 'mine-mouth');
    expect(visibleExits(c, adv).find((e) => e.to === 'mine-vault')?.locked).toBe(true);
    expect(() => moveParty(c, adv, 'mine-vault')).toThrow(/口令在老矿工那里/);

    // 艾琳 运动 +4（力量 +2 熟练 +2）掷 10 → 14 过；布洛克 力量 -1 掷 10 → 9 不过
    const r = moveParty(c, adv, 'mine-shaft', false, undefined, fixed(10));
    expect(r.checks.map((x) => x.passed)).toEqual([true, false]);
    expect(r.movers).toEqual(['艾琳']);
    expect(r.failText).toContain('摔伤');
    expect([...partyPositions(c).keys()].sort()).toEqual(['mine-mouth', 'mine-shaft']);
  });

  it('一半人过、一半人没过（人数打平）时，没过的人不会被带走', () => {
    const adv = fixture();
    const c = party(adv);
    // 刚建卡的角色没有 room，跟着 currentRoom 走
    c.knownSites.push('mine');
    c.currentRoom = 'mine-mouth';
    expect(c.characters.every((ch) => ch.room === undefined)).toBe(true);
    moveParty(c, adv, 'mine-shaft', false, undefined, fixed(10));
    expect(c.characters.map((ch) => ch.room)).toEqual(['mine-shaft', 'mine-mouth']);
  });
});

describe('城镇（hub）', () => {
  it('自动排版、地点随便走，藏着的地点问出来之后才能去', () => {
    const adv = fixture();
    const camp = adv.sites[0]!;
    expect(camp.rooms.map((r) => [r.x, r.y])).toEqual([[0, 0], [5, 0], [10, 0], [15, 0]]);
    const c = party(adv);
    expect(visibleExits(c, adv).map((e) => e.to)).toEqual(['camp-tavern', 'camp-shop']);
    expect(explored(c, adv)).toMatchObject({ seen: 1, total: 3 });
    expect(() => moveParty(c, adv, '地窖')).toThrow(/还不知道「地窖」/);

    moveParty(c, adv, 'camp-shop');
    expect(summarize(c, adv)).toContain('城镇：矿镇营地');
    expect(summarize(c, adv)).toContain('店铺：卖 绳子、火把、口粮（单价超过 25 gp 的不卖）');
    // 杂货铺和地窖不相邻也能直接走，前提是知道地窖
    storyAction(c, adv, 'fact', 'cellar-hint', {});
    expect(afterChange(c, adv)).toEqual(['玩家知道了矿镇营地的「地窖」']);
    expect(explored(c, adv)).toMatchObject({ seen: 2, total: 4 });
    expect(moveParty(c, adv, '地窖').room.id).toBe('camp-cellar');
  });

  it('地图画出已知地点（没去过的虚线），不画藏着的地点和通道', () => {
    const adv = fixture();
    const c = party(adv);
    const svg = buildMapSvg(c, adv);
    expect(svg).toContain('杂货铺');
    expect(svg).toContain('stroke-dasharray="8 6"');
    expect(svg).not.toContain('地窖');
    // 通道那一组是空的；画布只到第三个地点（地窖那一格不画进来）
    expect(svg).toContain('<g stroke="#b9a77c" stroke-width="6" stroke-linecap="round"></g>');
    expect(svg).toContain('width="576"');
    expect(svg).toContain('已探索 1/3');
  });

  it('knownWhen 只能用在城镇地点，入口不能藏', () => {
    const base = fixture();
    const dungeonHidden = structuredClone(base);
    dungeonHidden.sites[1]!.rooms[1]!.knownWhen = 'alarm';
    expect(() => validateAdventure(dungeonHidden)).toThrow(/只用于城镇/);
    const hiddenEntry = structuredClone(base);
    hiddenEntry.sites[0]!.rooms[0]!.knownWhen = 'alarm';
    expect(() => validateAdventure(hiddenEntry)).toThrow(/入口不能藏/);
    const badKind = structuredClone(base) as unknown as { sites: Array<{ kind: string }> };
    badKind.sites[0]!.kind = 'castle';
    expect(() => validateAdventure(badKind)).toThrow(/kind 只能/);
  });
});

describe('剧情动作', () => {
  it('触发器：设 flag、刷怪、换描述，只能触发一次', () => {
    const adv = fixture();
    const c = party(adv);
    const shaft = adv.sites[1]!.rooms[1]!;
    expect(roomView(c, adv, shaft).playerView).toBe('一片寂静。');
    const lines = storyAction(c, adv, 'trigger', 'mouth-alarm', {});
    expect(lines.join('\n')).toContain('巨鼠1 HP7');
    expect(c.characters.filter((ch) => ch.room === 'mine-mouth').map((ch) => ch.name)).toEqual(['巨鼠1', '巨鼠2']);
    expect(c.flags).toEqual(['alarm']);
    expect(roomView(c, adv, shaft).playerView).toBe('远处传来尖叫声。');
    expect(() => storyAction(c, adv, 'trigger', 'mouth-alarm', {})).toThrow(/已经触发过/);
    expect(() => storyAction(c, adv, 'flag', 'nope', {})).toThrow(/没有 flag/);
  });

  it('信息：有 DC 的要先检定，透露后设 flag，重复问不重复生效', () => {
    const adv = fixture();
    const c = party(adv);
    expect(() => storyAction(c, adv, 'fact', 'vault-word', {})).toThrow(/DC 13/);
    storyAction(c, adv, 'fact', 'vault-word', { passed: true });
    expect(c.flags).toContain('vault-open');
    expect(c.npcs['old-miner']?.met).toBe(true);
    expect(storyAction(c, adv, 'fact', 'vault-word', { passed: true })[0]).toContain('已经说过');
    expect(lookup(c, adv, 'npc', '老矿工')).toContain('[已说] vault-word');
    expect(lookup(c, adv, 'npc', 'old-miner')).toContain('[未说] mine-rumor');
    // 传了模组 id 当场景 id：列出全部场景，不报错
    expect(lookup(c, adv, 'site', 'grey-mine')).toContain('没有场景「grey-mine」，模组里的场景：\n- camp 矿镇营地');
  });

  it('任务：工头死了自动达成，领奖要 to，发钱发物品，里程碑只提示一次', () => {
    const adv = fixture();
    const c = party(adv);
    storyAction(c, adv, 'quest', 'clear-mine', { status: 'active' });
    expect(() => storyAction(c, adv, 'quest', 'clear-mine', { status: 'rewarded', to: '艾琳' })).toThrow(/目标达成/);

    // 工头上场战斗：建成怪物卡，留在自己的房间，不跟队伍走
    const fight = storyAction(c, adv, 'npc', 'foreman', { fight: true });
    expect(fight[0]).toContain('和队伍敌对');
    const foreman = c.characters.find((ch) => ch.npcId === 'foreman')!;
    expect(foreman).toMatchObject({ kind: 'monster', room: 'mine-shaft', hp: 20, ac: 13 });
    expect(partyPositions(c).size).toBe(1);

    applyDamage(c, '工头', 30);
    expect(npcAlive(c, 'foreman')).toBe(false);
    const story = afterChange(c, adv);
    expect(story.join()).toContain('回去找 老矿工 才能领奖');
    expect(story.join()).toContain('全队升到 2 级');
    expect(afterChange(c, adv)).toEqual([]);

    expect(() => storyAction(c, adv, 'quest', 'clear-mine', { status: 'rewarded' })).toThrow(/找不到角色/);
    const paid = storyAction(c, adv, 'quest', 'clear-mine', { status: 'rewarded', to: '艾琳' });
    expect(paid.join()).toContain('艾琳 拿到：50 gp、矿灯');
    expect(c.characters[0]).toMatchObject({ gp: 50, inventory: ['矿灯'] });
    expect(c.flags).toContain('mine-cleared');
    expect(summarize(c, adv)).toContain('剧情进展：矿坑清理完毕');
  });

  it('NPC 入队：建同行卡，跟着队伍走', () => {
    const adv = fixture();
    const c = party(adv);
    expect(summarize(c, adv)).toContain('在场 NPC');
    storyAction(c, adv, 'npc', 'guard', { join: true });
    const guard = c.characters.find((ch) => ch.npcId === 'guard')!;
    expect(guard).toMatchObject({ kind: 'npc', hp: 4, ac: 10 });
    expect(summarize(c, adv)).not.toContain('在场 NPC');
    moveParty(c, adv, 'camp-tavern');
    expect(guard.room).toBe('camp-tavern');
    expect(evalCondition(c, adv, { npc: 'guard', attitude: 'friendly', met: true })).toBe(true);
  });
});

describe('摘要、注入与加载', () => {
  it('摘要有章节、任务、可能发生的事件；注入有背景、本章要点和场景规则', () => {
    const root = mkdtempSync(join(tmpdir(), 'dnd-adv-'));
    const advDir = join(root, 'adventures', 'grey-mine');
    mkdirSync(join(advDir, 'sites'), { recursive: true });
    const adv = fixture();
    const [camp, mine] = adv.sites;
    writeFileSync(join(advDir, 'adventure.json'), JSON.stringify({ ...adv, sites: [camp] }));
    writeFileSync(join(advDir, 'sites', 'mine.json'), JSON.stringify(mine));
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const library = new AdventureLibrary({ adventures: join(root, 'adventures') }, logger as never);
    expect(library.get('grey-mine')?.sites.map((s) => s.id)).toEqual(['camp', 'mine']);
    expect(library.list().map((a) => a.id)).toContain('sunken-bell');
    expect(logger.warn).not.toHaveBeenCalled();

    const service = new DndService({ store: new CampaignStore(join(root, 'campaigns')), library, mapDir: root });
    service.start('group:g', 'grey-mine', false);
    service.store.update('group:g', (c) => {
      c.knownSites.push('mine');
      c.quests['clear-mine'] = 'active';
      c.currentRoom = 'mine-mouth';
      c.begun = true;
    });
    const state = service.promptSections('group:g')[1]!.text;
    expect(state).toContain('章节：矿镇｜目标：打听矿坑的事');
    expect(state).toContain('任务：清理矿坑(clear-mine，进行中)');
    expect(state).toContain('mouth-alarm：队伍在矿口大声喧哗');
    expect(state).toContain('模组背景：工头被矿坑深处的东西控制了。');
    expect(state).toContain('本章要点：让玩家和老矿工聊天。');
    expect(state).toContain('「灰岩矿坑」通用规则：没有光');
  });

  it('坏模组只打警告不影响其他模组', () => {
    const root = mkdtempSync(join(tmpdir(), 'dnd-bad-'));
    mkdirSync(join(root, 'adventures'));
    writeFileSync(join(root, 'adventures', 'broken.json'), JSON.stringify({ id: 'broken', name: 'x', sites: [] }));
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const library = new AdventureLibrary({ adventures: join(root, 'adventures') }, logger as never);
    expect(library.get('broken')).toBeUndefined();
    expect(library.get('sunken-bell')).toBeDefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('broken.json'));
  });
});

describe('开场', () => {
  function withStartEncounter(): Adventure {
    const adv = structuredClone(fixture());
    adv.opening = ['介绍角色', '定行进队形'];
    adv.sites[0]!.rooms[0]!.encounter = [{ ...rat, count: 1 }];
    return validateAdventure(adv);
  }

  it('新团先开场：注入开场步骤、不注入第一个场景的 DM 笔记；begin 后给出场景并刷出起始房间的敌人', () => {
    const root = mkdtempSync(join(tmpdir(), 'dnd-open-'));
    const advDir = join(root, 'adventures');
    mkdirSync(advDir);
    writeFileSync(join(advDir, 'grey-mine.json'), JSON.stringify(withStartEncounter()));
    const service = new DndService({ store: new CampaignStore(join(root, 'campaigns')), library: new AdventureLibrary({ adventures: advDir }), mapDir: root });
    service.start('group:o', 'grey-mine', false);
    const state = service.promptSections('group:o')[1]!.text;
    expect(state).toContain('【开场还没做完】');
    expect(state).toContain('1. 介绍角色');
    expect(state).not.toContain('本房间 DM 笔记');
    expect(state).toContain('开场：还没开始');

    const adv = service.require('group:o').adventure;
    const lines = service.store.update('group:o', (c) => storyAction(c, adv, 'begin', '', {}));
    expect(lines.join('\n')).toContain('【玩家视角，可以描述】木栅栏围着几顶帐篷。');
    expect(lines.join('\n')).toContain('【DM 机密】这里的敌人：巨鼠');
    const after = service.require('group:o').campaign;
    expect(after.begun).toBe(true);
    expect(after.characters.some((ch) => ch.name === '巨鼠' && ch.room === 'camp-gate')).toBe(true);
    expect(service.promptSections('group:o')[1]!.text).toContain('本房间 DM 笔记（只给你裁定用，不要直接念）：安全区。');
    expect(() => service.store.update('group:o', (c) => storyAction(c, adv, 'begin', '', {}))).toThrow(/已经开场/);
  });

  it('没 begin 就直接走动也算开场结束，起始房间的敌人照样刷出；旧存档不算在开场', () => {
    const adv = withStartEncounter();
    const c = party(adv);
    expect(c.begun).toBe(false);
    moveParty(c, adv, 'camp-tavern');
    expect(c.begun).toBe(true);
    expect(c.characters.find((ch) => ch.name === '巨鼠')?.room).toBe('camp-gate');

    const old = party(adv);
    delete old.begun;
    expect(summarize(old, adv)).not.toContain('开场');
  });
});

describe('技能别名', () => {
  it('常见的其他中文译名也认得', () => {
    expect(parseSkill('生存')).toBe('survival');
    expect(parseSkill('求生')).toBe('survival');
    expect(parseSkill('潜行')).toBe('stealth');
    expect(parseSkill('说服')).toBe('persuasion');
    expect(parseSkill('不存在')).toBeUndefined();
  });
});
