/**
 * 剧情状态：flag、线索、信息、任务、NPC、章节，以及条件求值。
 *
 * 这里只改 Campaign 上的剧情字段，不碰 HP、先攻、刷怪：
 * 触发器要刷的怪、任务奖励要发的金币由调用方（工具层）用 campaign.ts 的函数处理，
 * 所以这个文件只从 campaign.ts 引类型，不会形成运行时循环依赖。
 * 每个改动函数返回几行事件文字，调用方写进日志、拼进工具结果。
 */
import {
  type Adventure,
  type Attitude,
  type Condition,
  type Fact,
  type Npc,
  type Quest,
  type QuestReward,
  type QuestStatus,
  type Trigger,
  allFacts,
  allTriggers,
  findLead,
  findNpc,
  findQuest,
  findSite,
  siteOfRoom,
} from './adventure.ts';
import type { Campaign, Character, CharacterInput } from './campaign.ts';
import type { DungeonMonster, DungeonRoom } from './dungeon.ts';

export interface NpcState {
  met?: boolean;
  /** 覆盖 Npc.attitude */
  attitude?: Attitude;
  /** 覆盖 Npc.home.room（被带走、搬了家） */
  room?: string;
  /** 没上场就被说死了（剧情里死掉）；上场后的生死看角色卡 */
  alive?: boolean;
}

const ATTITUDE_NAMES: Record<Attitude, string> = { friendly: '友善', indifferent: '中立', hostile: '敌对' };
const STATUS_NAMES: Record<QuestStatus, string> = {
  offered: '已提出', active: '进行中', completed: '目标达成，待领奖', rewarded: '已领奖', failed: '失败',
};

// ── NPC 派生状态：上场后以角色卡为准 ──

export function npcCharacter(c: Campaign, npcId: string): Character | undefined {
  return c.characters.find((ch) => ch.npcId === npcId);
}

export function npcAlive(c: Campaign, npcId: string): boolean {
  const ch = npcCharacter(c, npcId);
  if (ch !== undefined) return !ch.conditions.includes('死亡');
  return c.npcs[npcId]?.alive !== false;
}

export function npcAttitude(c: Campaign, npc: Npc): Attitude {
  return c.npcs[npc.id]?.attitude ?? npc.attitude;
}

export function npcRoom(c: Campaign, npc: Npc): string {
  const ch = npcCharacter(c, npc.id);
  if (ch !== undefined) return ch.kind === 'monster' ? (ch.room ?? npc.home.room) : (ch.room ?? c.currentRoom);
  return c.npcs[npc.id]?.room ?? npc.home.room;
}

function partyLevel(c: Campaign): number {
  const pcs = c.characters.filter((ch) => ch.kind === 'pc');
  return pcs.length === 0 ? 0 : Math.min(...pcs.map((ch) => ch.level));
}

// ── 条件 ──

export function evalCondition(c: Campaign, adv: Adventure, cond: Condition): boolean {
  if (typeof cond === 'string') return c.flags.includes(cond);
  if ('all' in cond) return cond.all.every((x) => evalCondition(c, adv, x));
  if ('any' in cond) return cond.any.some((x) => evalCondition(c, adv, x));
  if ('not' in cond) return !evalCondition(c, adv, cond.not);
  if ('flag' in cond) return c.flags.includes(cond.flag);
  if ('visited' in cond) {
    const site = findSite(adv, cond.visited);
    return site !== undefined ? site.rooms.some((r) => c.revealed.includes(r.id)) : c.revealed.includes(cond.visited);
  }
  if ('quest' in cond) {
    const status = c.quests[cond.quest];
    const wanted = Array.isArray(cond.status) ? cond.status : [cond.status];
    return status !== undefined && wanted.includes(status);
  }
  if ('npc' in cond) {
    const npc = findNpc(adv, cond.npc);
    if (npc === undefined) return false;
    if (cond.alive !== undefined && npcAlive(c, npc.id) !== cond.alive) return false;
    if (cond.attitude !== undefined && npcAttitude(c, npc) !== cond.attitude) return false;
    if (cond.met !== undefined && (c.npcs[npc.id]?.met === true) !== cond.met) return false;
    return true;
  }
  if ('lead' in cond) return c.leads.includes(cond.lead);
  if ('level' in cond) return partyLevel(c) >= cond.level;
  return false;
}

/** 条件的可读说明（给模型看为什么过不去） */
export function describeCondition(adv: Adventure, cond: Condition): string {
  if (typeof cond === 'string') return `flag ${cond}`;
  if ('all' in cond) return cond.all.map((x) => describeCondition(adv, x)).join(' 且 ');
  if ('any' in cond) return `(${cond.any.map((x) => describeCondition(adv, x)).join(' 或 ')})`;
  if ('not' in cond) return `非(${describeCondition(adv, cond.not)})`;
  if ('flag' in cond) return `flag ${cond.flag}`;
  if ('visited' in cond) return `去过 ${cond.visited}`;
  if ('quest' in cond) return `任务 ${cond.quest} 为 ${[cond.status].flat().join('/')}`;
  if ('npc' in cond) {
    const parts = [
      cond.alive === undefined ? '' : (cond.alive ? '活着' : '死了'),
      cond.attitude === undefined ? '' : ATTITUDE_NAMES[cond.attitude],
      cond.met === undefined ? '' : (cond.met ? '见过' : '没见过'),
    ].filter(Boolean);
    return `NPC ${findNpc(adv, cond.npc)?.name ?? cond.npc}${parts.join('、')}`;
  }
  if ('lead' in cond) return `知道线索 ${cond.lead}`;
  if ('level' in cond) return `全队 ≥${cond.level} 级`;
  return JSON.stringify(cond);
}

// ── 改动 ──

function addUnique(list: string[], id: string): boolean {
  if (list.includes(id)) return false;
  list.push(id);
  return true;
}

function requireFlag(adv: Adventure, id: string): void {
  if (!adv.flags.some((f) => f.id === id)) {
    throw new Error(`模组里没有 flag「${id}」。可用：${adv.flags.map((f) => f.id).join('、') || '（无）'}`);
  }
}

function applyFlags(c: Campaign, adv: Adventure, set: string[] = [], clear: string[] = []): string[] {
  const lines: string[] = [];
  for (const id of set) {
    requireFlag(adv, id);
    if (addUnique(c.flags, id)) lines.push(`flag +${id}`);
  }
  for (const id of clear) {
    requireFlag(adv, id);
    if (c.flags.includes(id)) {
      c.flags = c.flags.filter((f) => f !== id);
      lines.push(`flag -${id}`);
    }
  }
  return lines;
}

export function setFlag(c: Campaign, adv: Adventure, id: string, on: boolean): string[] {
  const lines = on ? applyFlags(c, adv, [id]) : applyFlags(c, adv, [], [id]);
  return lines.length > 0 ? lines : [`flag ${id} 本来就是${on ? '开' : '关'}的`];
}

export function learnLead(c: Campaign, adv: Adventure, id: string): string[] {
  const lead = findLead(adv, id);
  if (lead === undefined) throw new Error(`模组里没有线索「${id}」`);
  if (!addUnique(c.leads, lead.id)) return [`线索 ${lead.id} 玩家已经知道了`];
  const lines = [`新线索：${lead.text}`];
  const siteId = lead.points.site ?? (lead.points.room !== undefined ? siteOfRoom(adv, lead.points.room)?.id : undefined);
  const site = siteId === undefined ? undefined : findSite(adv, siteId);
  if (site !== undefined && addUnique(c.knownSites, site.id)) lines.push(`玩家知道了「${site.name}」这个地方`);
  return lines;
}

export interface TriggerResult {
  trigger: Trigger;
  room: DungeonRoom;
  lines: string[];
  /** 要刷在 room 里的怪，由调用方 spawnMonsters */
  spawn: DungeonMonster[];
}

export function fireTrigger(c: Campaign, adv: Adventure, id: string): TriggerResult {
  const found = allTriggers(adv).find((t) => t.trigger.id === id.trim());
  if (found === undefined) throw new Error(`模组里没有触发器「${id}」`);
  const { trigger, room } = found;
  if (trigger.once !== false && c.firedTriggers.includes(trigger.id)) throw new Error(`触发器 ${trigger.id} 已经触发过了`);
  if (trigger.requires !== undefined && !evalCondition(c, adv, trigger.requires)) {
    throw new Error(`触发器 ${trigger.id} 的条件还不满足：${describeCondition(adv, trigger.requires)}`);
  }
  addUnique(c.firedTriggers, trigger.id);
  const lines = [`触发「${trigger.id}」：${trigger.then}`, ...applyFlags(c, adv, trigger.set, trigger.clear)];
  for (const lead of trigger.leads ?? []) lines.push(...learnLead(c, adv, lead));
  return { trigger, room, lines, spawn: trigger.spawn ?? [] };
}

/** 揭示一条信息。有 DC 的要先检定成功（passed=true） */
export function revealFact(c: Campaign, adv: Adventure, id: string, passed: boolean): { fact: Fact; lines: string[] } {
  const found = allFacts(adv).find((f) => f.fact.id === id.trim());
  if (found === undefined) throw new Error(`模组里没有信息「${id}」`);
  const { fact, npc, holder } = found;
  if (c.facts.includes(fact.id)) return { fact, lines: [`（已经说过）${fact.text}`] };
  if (fact.requires !== undefined && !evalCondition(c, adv, fact.requires)) {
    throw new Error(`这条信息还问不出来：${describeCondition(adv, fact.requires)}`);
  }
  if (fact.dc !== undefined && !passed) {
    throw new Error(`这条信息要${fact.via}检定 DC ${fact.dc}：先 dnd_check，成功后再传 passed=true`);
  }
  if (npc !== undefined && npcCharacter(c, npc.id) === undefined && !npcAlive(c, npc.id)) throw new Error(`${npc.name} 已经死了`);
  c.facts.push(fact.id);
  if (npc !== undefined) c.npcs[npc.id] = { ...c.npcs[npc.id], met: true };
  const lines = [`${holder} 透露：${fact.text}`, ...applyFlags(c, adv, fact.set)];
  for (const lead of fact.leads ?? []) lines.push(...learnLead(c, adv, lead));
  return { fact, lines };
}

export interface QuestChange {
  quest: Quest;
  lines: string[];
  /** 变成 rewarded 时要发的奖励（金币、物品由调用方发给角色） */
  reward?: QuestReward;
}

export function setQuestStatus(c: Campaign, adv: Adventure, id: string, status: QuestStatus): QuestChange {
  const quest = findQuest(adv, id);
  if (quest === undefined) throw new Error(`模组里没有任务「${id}」。有：${adv.quests.map((q) => q.id).join('、') || '（无）'}`);
  const before = c.quests[quest.id];
  if (before === status) return { quest, lines: [`任务「${quest.name}」本来就是${STATUS_NAMES[status]}`] };
  if (before === 'rewarded') throw new Error(`任务「${quest.name}」已经领过奖了`);
  if (status === 'rewarded' && before !== 'completed') {
    throw new Error(`任务「${quest.name}」现在是${before === undefined ? '没接' : STATUS_NAMES[before]}，目标达成（completed）后才能领奖`);
  }
  c.quests[quest.id] = status;
  const lines = [`任务「${quest.name}」：${before === undefined ? '' : `${STATUS_NAMES[before]} → `}${STATUS_NAMES[status]}`];
  if (status !== 'rewarded') return { quest, lines };
  lines.push(...applyFlags(c, adv, quest.reward.set));
  if (quest.reward.text) lines.push(`奖励：${quest.reward.text}`);
  return { quest, lines, reward: quest.reward };
}

export function updateNpc(c: Campaign, adv: Adventure, id: string, patch: NpcState): { npc: Npc; lines: string[] } {
  const npc = findNpc(adv, id);
  if (npc === undefined) throw new Error(`模组里没有 NPC「${id}」`);
  if (patch.room !== undefined && siteOfRoom(adv, patch.room) === undefined) throw new Error(`没有这个房间: ${patch.room}`);
  const state: NpcState = { ...c.npcs[npc.id] };
  const lines: string[] = [];
  if (patch.attitude !== undefined && patch.attitude !== npcAttitude(c, npc)) {
    lines.push(`${npc.name} 态度：${ATTITUDE_NAMES[npcAttitude(c, npc)]} → ${ATTITUDE_NAMES[patch.attitude]}`);
    state.attitude = patch.attitude;
  }
  if (patch.room !== undefined) {
    state.room = patch.room;
    lines.push(`${npc.name} 现在在 ${patch.room}`);
  }
  if (patch.met !== undefined) state.met = patch.met;
  if (patch.alive !== undefined) {
    if (npcCharacter(c, npc.id) !== undefined) throw new Error(`${npc.name} 已经上场，生死看角色卡（用 dnd_apply）`);
    state.alive = patch.alive;
    lines.push(`${npc.name} ${patch.alive ? '还活着' : '死了'}`);
  }
  c.npcs[npc.id] = state;
  return { npc, lines: lines.length > 0 ? lines : [`${npc.name} 已更新`] };
}

/**
 * NPC 上场用的角色卡字段。join = 入队（kind npc，跟着队伍走）；
 * fight = 和队伍打起来（kind monster，留在自己的房间，进那个房间的先攻）。
 * 只有这两种情况才建卡：不战斗、不同行的 NPC 只活在 campaign.npcs 里。
 */
export function npcCharacterInput(c: Campaign, npc: Npc, mode: 'join' | 'fight', srdBase?: Omit<CharacterInput, 'name'>): CharacterInput {
  const room = mode === 'join' ? c.currentRoom : npcRoom(c, npc);
  const base: CharacterInput = { name: npc.name, kind: mode === 'join' ? 'npc' : 'monster', npcId: npc.id, room };
  if (npcCharacter(c, npc.id) !== undefined) return base;
  const stat = npc.stat;
  if (stat !== undefined && 'hp' in stat) {
    return {
      ...base,
      maxHp: stat.hp, ac: stat.ac, attackBonus: stat.attackBonus, damage: stat.damage, initBonus: stat.initBonus,
      ...(stat.abilities !== undefined ? { abilities: stat.abilities } : {}),
      ...(stat.traits !== undefined ? { traits: stat.traits } : {}),
      ...(stat.srd !== undefined ? { srd: stat.srd } : {}),
      notes: stat.notes ?? npc.role,
    };
  }
  if (srdBase !== undefined) return { ...srdBase, ...base, notes: npc.role };
  // 平民（SRD commoner）
  return { ...base, maxHp: 4, ac: 10, attackBonus: 2, damage: '1d4', notes: npc.role };
}

export function setChapter(c: Campaign, adv: Adventure, id: string): string[] {
  const chapter = adv.chapters.find((ch) => ch.id === id.trim());
  if (chapter === undefined) throw new Error(`模组里没有章节「${id}」。有：${adv.chapters.map((ch) => ch.id).join('、')}`);
  c.chapter = chapter.id;
  return [`进入章节「${chapter.name}」${chapter.goal ? `：${chapter.goal}` : ''}`];
}

/**
 * 每次改动后统一检查一遍：新知道的场景、任务达成/失败、里程碑、章节可以推进。
 * 提示类（里程碑、章节）记在 announced 里，只提示一次。
 */
export function afterChange(c: Campaign, adv: Adventure): string[] {
  const lines: string[] = [];
  for (const site of adv.sites) {
    if (site.knownWhen !== undefined && !c.knownSites.includes(site.id) && evalCondition(c, adv, site.knownWhen)) {
      c.knownSites.push(site.id);
      lines.push(`玩家知道了「${site.name}」这个地方`);
    }
  }
  for (const site of adv.sites) {
    if (site.kind !== 'hub') continue;
    for (const room of site.rooms) {
      const key = `loc:${room.id}`;
      if (room.knownWhen === undefined || c.revealed.includes(room.id) || c.announced.includes(key)) continue;
      if (evalCondition(c, adv, room.knownWhen)) {
        c.announced.push(key);
        lines.push(`玩家知道了${site.name}的「${room.name}」`);
      }
    }
  }
  for (const quest of adv.quests) {
    const status = c.quests[quest.id];
    if (status !== 'offered' && status !== 'active') continue;
    if (quest.failWhen !== undefined && evalCondition(c, adv, quest.failWhen)) {
      c.quests[quest.id] = 'failed';
      lines.push(`任务「${quest.name}」失败了`);
    } else if (evalCondition(c, adv, quest.completeWhen)) {
      c.quests[quest.id] = 'completed';
      const giver = quest.giver === undefined ? undefined : findNpc(adv, quest.giver);
      lines.push(`任务「${quest.name}」目标达成${quest.reward.atGiver === true && giver !== undefined
        ? `，回去找 ${giver.name} 才能领奖`
        : '，结算奖励用 dnd_story quest status=rewarded'}`);
    }
  }
  for (const m of adv.milestones ?? []) {
    const key = `level:${m.level}`;
    if (!c.announced.includes(key) && evalCondition(c, adv, m.when)) {
      c.announced.push(key);
      lines.push(`里程碑：全队升到 ${m.level} 级${m.text ? `（${m.text}）` : ''}，用 dnd_character update level 改`);
    }
  }
  const chapter = adv.chapters.find((ch) => ch.id === c.chapter);
  // 全队都走进了下一章的场景：自动翻章（只往前翻，回到旧场景不会翻回去；有人先去探路不算）
  const party = c.characters.filter((ch) => ch.kind !== 'monster' && !ch.conditions.includes('死亡'));
  const allThere = party.length > 0 && party.every((ch) => siteOfRoom(adv, ch.room ?? c.currentRoom)?.chapter === chapter?.next);
  if (chapter?.next !== undefined && allThere) {
    lines.push(...setChapter(c, adv, chapter.next));
    return lines;
  }
  if (chapter?.exitWhen !== undefined && chapter.next !== undefined && !c.announced.includes(`chapter:${chapter.id}`)
    && evalCondition(c, adv, chapter.exitWhen)) {
    c.announced.push(`chapter:${chapter.id}`);
    const next = adv.chapters.find((ch) => ch.id === chapter.next);
    lines.push(`本章目标完成，可以进入「${next?.name ?? chapter.next}」（dnd_story chapter id=${chapter.next}）`);
  }
  return lines;
}

// ── 开场 ──

/** 还在开场：新团从 false 开始；旧存档没有这个字段，当作已经开始 */
export function inOpening(c: Campaign): boolean {
  return c.begun === false;
}

/** 开场做完，进入第一个场景：返回给 DM 叙述用的抵达描述和房间的玩家视角 */
export function beginAdventure(c: Campaign, adv: Adventure): { lines: string[]; room: DungeonRoom | undefined } {
  if (!inOpening(c)) throw new Error('已经开场了，不用再 begin');
  c.begun = true;
  const site = siteOfRoom(adv, c.currentRoom);
  const room = site?.rooms.find((r) => r.id === c.currentRoom);
  const lines = ['开场结束，进入第一个场景。'];
  if (site?.arrival) lines.push(`【抵达「${site.name}」，可以念】${site.arrival}`);
  if (room !== undefined) {
    const view = roomView(c, adv, room);
    lines.push(`【玩家视角，可以描述】${view.playerView}`, `【DM 机密，勿念】${view.dmNotes}`);
  }
  return { lines, room };
}

/** 开场阶段注入给 DM 的说明 */
export function openingLines(c: Campaign, adv: Adventure): string[] {
  if (!inOpening(c)) return [];
  const steps = adv.opening ?? [];
  return [
    '【开场还没做完】/dnd new 已经把开场白发到群里了。先带玩家做下面的事，一步一步来、等玩家回应；'
      + '不要描述第一个场景、不要提任何敌人或危险、不要掷骰。玩家都准备好了（或者说「开始吧」）再调用 dnd_story action=begin，按它返回的玩家视角描述第一个场景。',
    ...(steps.length > 0
      ? steps.map((s, i) => `${i + 1}. ${s}`)
      : ['1. 让每个人介绍自己的角色（名字、职业、一两句来历）。', '2. 问清楚队伍怎么上路、谁走前面谁殿后。']),
  ];
}

// ── 读取 ──

/** 房间当前的描述：后面满足条件的变体覆盖前面的 */
export function roomView(c: Campaign, adv: Adventure, room: DungeonRoom): { playerView: string; dmNotes: string } {
  let view = { playerView: room.playerView, dmNotes: room.dmNotes };
  for (const v of room.variants ?? []) {
    if (evalCondition(c, adv, v.when)) view = { playerView: v.playerView ?? view.playerView, dmNotes: v.dmNotes ?? view.dmNotes };
  }
  return view;
}

/** 城镇地点玩家知不知道：去过的、没写 knownWhen 的、条件满足的都算 */
export function locationKnown(c: Campaign, adv: Adventure, room: DungeonRoom): boolean {
  return c.revealed.includes(room.id) || room.knownWhen === undefined || evalCondition(c, adv, room.knownWhen);
}

/** 在某个房间里、没入队也没在打的具名 NPC */
export function npcsIn(c: Campaign, adv: Adventure, roomId: string): Npc[] {
  return adv.npcs.filter((npc) => npcRoom(c, npc) === roomId && npcAlive(c, npc.id) && npcCharacter(c, npc.id) === undefined);
}

/** 某房间里还能触发的事件 */
export function pendingTriggers(c: Campaign, adv: Adventure, roomId: string): Trigger[] {
  const room = siteOfRoom(adv, roomId)?.rooms.find((r) => r.id === roomId);
  return (room?.triggers ?? []).filter((t) => t.once === false || !c.firedTriggers.includes(t.id));
}

export function shopLine(shop: NonNullable<DungeonRoom['shop']>): string {
  return `卖 ${shop.sells}${shop.maxPrice !== undefined ? `（单价超过 ${shop.maxPrice} gp 的不卖）` : ''}`;
}

function short(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 团况摘要里的剧情行；单地城、没有剧情内容时返回空 */
export function storySummaryLines(c: Campaign, adv: Adventure, rooms: string[]): string[] {
  const lines: string[] = [];
  if (inOpening(c)) lines.push('开场：还没开始（先做开场，做完调用 dnd_story action=begin；之前别描述第一个场景）');
  const chapter = adv.chapters.find((ch) => ch.id === c.chapter);
  if (chapter !== undefined && (adv.chapters.length > 1 || chapter.goal)) {
    lines.push(`章节：${chapter.name}${chapter.goal ? `｜目标：${chapter.goal}` : ''}`);
  }
  const present = rooms.flatMap((r) => npcsIn(c, adv, r));
  if (present.length > 0) {
    lines.push(`在场 NPC（dnd_lookup npc 看详情）：${present.map((n) => `${n.name}(${n.id}，${ATTITUDE_NAMES[npcAttitude(c, n)]}，${short(n.role, 24)})`).join('；')}`);
  }
  const quests = adv.quests.filter((q) => ['offered', 'active', 'completed'].includes(c.quests[q.id] ?? ''));
  if (quests.length > 0) lines.push(`任务：${quests.map((q) => `${q.name}(${q.id}，${STATUS_NAMES[c.quests[q.id]!]})`).join('；')}`);
  const open = c.leads
    .map((id) => findLead(adv, id))
    .filter((l): l is NonNullable<typeof l> => l !== undefined && (l.resolvedWhen === undefined || !evalCondition(c, adv, l.resolvedWhen)));
  if (open.length > 0) lines.push(`未解决的线索：${open.slice(-5).map((l) => short(l.text, 30)).join('；')}`);
  for (const id of rooms) {
    const shop = siteOfRoom(adv, id)?.rooms.find((r) => r.id === id)?.shop;
    if (shop !== undefined) lines.push(`店铺：${shopLine(shop)}；买卖用 dnd_character 的 add_items / gp_change`);
  }
  const pending = inOpening(c) ? [] : rooms.flatMap((r) => pendingTriggers(c, adv, r));
  if (pending.length > 0) lines.push(`这里可能发生的事件（情况吻合时 dnd_story trigger）：${pending.map((t) => `${t.id}：${t.when}`).join('；')}`);
  const flags = adv.flags.filter((f) => f.label !== undefined && c.flags.includes(f.id));
  if (flags.length > 0) lines.push(`剧情进展：${flags.map((f) => f.label).join('、')}`);
  return lines;
}

// ── dnd_lookup 用的 DM 卡片 ──

export function npcCard(c: Campaign, adv: Adventure, npc: Npc): string {
  const ch = npcCharacter(c, npc.id);
  const lines = [
    `${npc.name}${npc.aliases?.length ? `（${npc.aliases.join('、')}）` : ''}｜${npc.id}${npc.faction ? `｜${npc.faction}` : ''}`,
    `定位：${npc.role}`,
    `外貌（可描述）：${npc.look}`,
    npc.voice ? `扮演：${npc.voice}` : '',
    `动机：${npc.motive}`,
    `态度：${ATTITUDE_NAMES[npcAttitude(c, npc)]}｜位置：${npcRoom(c, npc)}｜${npcAlive(c, npc.id) ? '活着' : '已死'}｜${c.npcs[npc.id]?.met === true ? '见过' : '没见过'}`
      + `${ch !== undefined ? `｜已上场：${ch.name}（${ch.kind === 'npc' ? '同行' : '敌对'}）` : ''}${npc.canJoin === true ? '｜可以入队' : ''}`,
  ];
  if (npc.offers?.length) {
    lines.push(`发布任务：${npc.offers.map((id) => {
      const q = findQuest(adv, id);
      return `${q?.name ?? id}(${id}，${c.quests[id] === undefined ? '还没提' : STATUS_NAMES[c.quests[id]!]})`;
    }).join('；')}`);
  }
  if (npc.knows.length > 0) lines.push('知道的事（说之前先 dnd_story fact）：', ...npc.knows.map((f) => factLine(c, adv, f)));
  return lines.filter(Boolean).join('\n');
}

function factLine(c: Campaign, adv: Adventure, f: Fact): string {
  const gate = [
    f.via === 'ask' ? '' : f.via,
    f.dc !== undefined ? `DC ${f.dc}` : '',
    f.requires !== undefined ? `需要 ${describeCondition(adv, f.requires)}` : '',
  ].filter(Boolean).join('，');
  return `- [${c.facts.includes(f.id) ? '已说' : '未说'}] ${f.id}${gate ? `（${gate}）` : ''}：${f.text}`;
}

export function questCard(c: Campaign, adv: Adventure, quest: Quest): string {
  const giver = quest.giver === undefined ? undefined : findNpc(adv, quest.giver);
  const r = quest.reward;
  const reward = [r.gp ? `${r.gp} gp` : '', ...(r.items ?? []), r.text ?? ''].filter(Boolean).join('、');
  return [
    `${quest.name}｜${quest.id}｜${c.quests[quest.id] === undefined ? '还没提出' : STATUS_NAMES[c.quests[quest.id]!]}`,
    giver !== undefined ? `发布人：${giver.name}` : '',
    `说明（可以讲给玩家）：${quest.brief}`,
    quest.dmNotes ? `DM：${quest.dmNotes}` : '',
    `目标：${[quest.target.site, quest.target.room].filter(Boolean).join(' / ') || '—'}`,
    `达成条件：${describeCondition(adv, quest.completeWhen)}`,
    quest.failWhen !== undefined ? `失败条件：${describeCondition(adv, quest.failWhen)}` : '',
    `奖励：${reward || '无'}${r.atGiver === true ? '（回去找发布人领）' : ''}`,
  ].filter(Boolean).join('\n');
}

export function siteCard(c: Campaign, adv: Adventure, siteId: string): string {
  const site = findSite(adv, siteId);
  if (site === undefined) throw new Error(`模组里没有场景「${siteId}」。有：${adv.sites.map((s) => s.id).join('、')}`);
  const lines = [
    `${site.name}｜${site.id}｜${c.knownSites.includes(site.id) ? '玩家已知' : '玩家还不知道'}`,
    site.summary ? `概述：${site.summary}` : '',
    site.features ? `通用规则：${site.features}` : '',
    site.arrival ? `抵达时（可念）：${site.arrival}` : '',
    `房间：${site.rooms.map((r) => `${r.name}(${r.id}${c.revealed.includes(r.id) ? '' : '，未探索'})`).join('、')}`,
  ];
  for (const block of site.knowledge ?? []) lines.push(`${block.holder} 知道：`, ...block.facts.map((f) => factLine(c, adv, f)));
  return lines.filter(Boolean).join('\n');
}

export function roomCard(c: Campaign, adv: Adventure, room: DungeonRoom): string {
  const view = roomView(c, adv, room);
  const lines = [
    `${room.name}｜${room.id}｜${siteOfRoom(adv, room.id)?.name ?? ''}${c.revealed.includes(room.id) ? '' : '｜未探索'}`,
    `【玩家视角】${view.playerView}`,
    `【DM】${view.dmNotes}`,
  ];
  if (room.shop !== undefined) lines.push(`店铺：${shopLine(room.shop)}`);
  if (room.knownWhen !== undefined) lines.push(`${locationKnown(c, adv, room) ? '玩家已知' : '玩家还不知道'}这个地方（需要 ${describeCondition(adv, room.knownWhen)}）`);
  for (const t of room.triggers ?? []) {
    lines.push(`事件 ${t.id}${c.firedTriggers.includes(t.id) ? '（已触发）' : ''}：当 ${t.when}${t.requires !== undefined ? `（需要 ${describeCondition(adv, t.requires)}）` : ''} → ${t.then}`);
  }
  for (const block of room.knowledge ?? []) lines.push(`${block.holder} 知道：`, ...block.facts.map((f) => factLine(c, adv, f)));
  const npcs = npcsIn(c, adv, room.id);
  if (npcs.length > 0) lines.push(`NPC：${npcs.map((n) => `${n.name}(${n.id})`).join('、')}`);
  return lines.join('\n');
}

export function leadsCard(c: Campaign, adv: Adventure): string {
  if (adv.leads.length === 0) return '这个模组没有线索。';
  return adv.leads.map((l) => {
    const known = c.leads.includes(l.id);
    const resolved = l.resolvedWhen !== undefined && evalCondition(c, adv, l.resolvedWhen);
    const to = Object.entries(l.points).map(([k, v]) => `${k}:${v}`).join(' ');
    return `- [${known ? (resolved ? '已解决' : '已知') : '未知'}] ${l.id} → ${to}：${l.text}`;
  }).join('\n');
}
