/**
 * 跑团权威状态 — 每个群（或私聊）一份 campaign JSON。
 *
 * 角色卡、HP、状态、先攻、当前房间、已揭示房间都只在这里改，模型通过工具读写；
 * 每回合只把 summarize() 的精简摘要注入 prompt，不注入整份 JSON。
 * 剧情状态（flag、线索、任务、NPC）的读写在 story.ts，这里只存字段。
 * 写法参考 sticker-store：先写 .tmp 再 rename，避免写一半崩掉留下坏文件。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { rollD20, type Roller, cryptoRoller } from './dice.ts';
import { type Adventure, type QuestStatus, type Site, findSite, roomGraph, siteOfRoom } from './adventure.ts';
import {
  type DungeonExit,
  type DungeonMonster,
  type ExitCheck,
  type DungeonRoom,
  exitBetween,
  exitKey,
  exitsOf,
  findRoom,
} from './dungeon.ts';
import { ABILITIES, type Ability, type Skill, abilityModifier, parseAbility, parseSkill, proficiencyBonus, SKILLS } from './rules.ts';
import { type NpcState, afterChange, describeCondition, evalCondition, roomView, storySummaryLines } from './story.ts';

export type CharacterKind = 'pc' | 'npc' | 'monster';

export interface Character {
  name: string;
  kind: CharacterKind;
  /** 玩家群昵称（pc 才有） */
  player?: string;
  /** 玩家 openid：绑定后只有这个人能宣告该角色的行动 */
  playerId?: string;
  className?: string;
  level: number;
  abilities: Record<Ability, number>;
  /** 熟练技能 */
  skills: Skill[];
  /** 熟练豁免 */
  saves: Ability[];
  hp: number;
  maxHp: number;
  tempHp: number;
  ac: number;
  conditions: string[];
  /** 怪物/NPC 的命中加值与伤害（PC 按属性+熟练算） */
  attackBonus?: number;
  damage?: string;
  /** 先攻加值覆盖（怪物用；PC 取敏捷调整值） */
  initBonus?: number;
  /** 所在房间。怪物离开房间就不进先攻；PC/NPC 缺省时跟着队伍主位置（currentRoom） */
  room?: string;
  srd?: string;
  /** 模组里的具名 NPC（入队或上场战斗时建的卡） */
  npcId?: string;
  notes?: string;
  /** 武器：攻击时按名字取伤害和属性，避免模型临时编伤害骰 */
  weapons?: Weapon[];
  /** 0 HP 时的死亡豁免计数 */
  deathSaves?: { successes: number; failures: number };
  /** 工具会自动处理的特性，如「不死坚韧」 */
  traits?: string[];
  /** 有次数的资源：法术位、圣疗池、诗人激励、职业特性 */
  resources?: Record<string, Resource>;
  /** 生命骰（如 d10）与已用数量；总数 = 等级 */
  hitDie?: string;
  hitDiceUsed?: number;
  inventory?: string[];
  gp?: number;
}

export interface Resource {
  current: number;
  max: number;
  /** 什么休息后回满；none 表示只能手动恢复（如一次性物品） */
  reset: 'short' | 'long' | 'none';
}

export interface Weapon {
  name: string;
  /** 伤害表达式（不含属性调整），如 1d12 */
  damage: string;
  /** 命中/伤害用的属性；缺省取力量（灵巧武器传 dex） */
  ability?: Ability;
  /** 伤害类型、特性等备注 */
  notes?: string;
}

export interface InitiativeEntry {
  name: string;
  init: number;
}

export interface InitiativeState {
  round: number;
  /** 当前行动者在 order 里的下标 */
  turn: number;
  order: InitiativeEntry[];
}

export interface CampaignSummary {
  at: number;
  text: string;
}

export interface Campaign {
  version: 2;
  key: string;
  /** v1 叫 dungeonId；旧的单地城会被包成同 id 的模组 */
  adventureId: string;
  active: boolean;
  createdAt: number;
  updatedAt: number;
  currentRoom: string;
  revealed: string[];
  discoveredExits: string[];
  /** 遭遇已经刷出过的房间（离开再回来不重刷） */
  spawned: string[];
  characters: Character[];
  initiative?: InitiativeState;
  summaries: CampaignSummary[];
  /** 最近的关键事件（伤害、倒地、移动），摘要里展示最后几条 */
  log: string[];

  // ── 剧情状态（story.ts 读写） ──
  chapter: string;
  flags: string[];
  /** 玩家知道的线索，按得知顺序 */
  leads: string[];
  /** 已经透露过的信息 */
  facts: string[];
  firedTriggers: string[];
  quests: Record<string, QuestStatus>;
  npcs: Record<string, NpcState>;
  /** 玩家知道的场景 */
  knownSites: string[];
  /** 只提示一次的事（里程碑、章节推进） */
  announced: string[];
}

const MAX_LOG = 30;
const MAX_SNAPSHOTS = 40;
const MAX_SUMMARIES = 10;
const SUMMARY_LOG_LINES = 5;

/** 不在这里列出的状态也允许，只是不做特殊处理 */
export const KNOWN_CONDITIONS = [
  '目盲', '魅惑', '耳聋', '恐慌', '擒抱', '失能', '隐形', '麻痹', '石化', '中毒', '倒地', '束缚', '震慑', '昏迷', '力竭', '死亡', '稳定',
];

export function createCampaign(key: string, adv: Adventure, now = Date.now()): Campaign {
  const startSite = siteOfRoom(adv, adv.start);
  return {
    version: 2,
    key,
    adventureId: adv.id,
    active: true,
    createdAt: now,
    updatedAt: now,
    currentRoom: adv.start,
    revealed: [adv.start],
    discoveredExits: [],
    spawned: [],
    characters: [],
    summaries: [],
    log: [],
    chapter: startSite?.chapter ?? adv.chapters[0]?.id ?? '',
    flags: [],
    leads: [],
    facts: [],
    firedTriggers: [],
    quests: {},
    npcs: {},
    knownSites: adv.sites.filter((s) => s.knownWhen === undefined || s.id === startSite?.id).map((s) => s.id),
    announced: [],
  };
}

/**
 * 解析存档 JSON，旧版本就地升级。load 和 undo 都走这里：
 * undo 恢复的快照可能是升级前存的 v1。
 */
export function parseCampaign(json: string): Campaign | undefined {
  const data = JSON.parse(json) as Record<string, unknown>;
  if (data.version === 2) return data as unknown as Campaign;
  if (data.version !== 1) return undefined;
  const { dungeonId, ...rest } = data;
  return {
    ...(rest as unknown as Campaign),
    version: 2,
    adventureId: String(dungeonId),
    // 旧团只会是单地城，包出来的模组只有 main 一章、场景 id 就是地城 id
    chapter: 'main',
    flags: [],
    leads: [],
    facts: [],
    firedTriggers: [],
    quests: {},
    npcs: {},
    knownSites: [String(dungeonId)],
    announced: [],
  };
}

export function pushLog(c: Campaign, line: string): void {
  c.log.push(line);
  if (c.log.length > MAX_LOG) c.log.splice(0, c.log.length - MAX_LOG);
}

export function findCharacter(c: Campaign, name: string): Character | undefined {
  const q = name.trim();
  const lower = q.toLowerCase();
  if (lower.length === 0) return undefined;
  const exact = c.characters.find((ch) => ch.name === q)
    ?? c.characters.find((ch) => ch.player === q && ch.kind === 'pc')
    ?? c.characters.find((ch) => ch.name.toLowerCase() === lower || ch.player?.trim().toLowerCase() === lower);
  if (exact !== undefined) return exact;
  // 「刻德温」能找到「刻德温 Kodwin」：按空格拆出的名字片段匹配，唯一命中才算
  const partial = c.characters.filter((ch) => ch.name.toLowerCase().split(/\s+/).includes(lower));
  return partial.length === 1 ? partial[0] : undefined;
}

export function requireCharacter(c: Campaign, name: string): Character {
  const found = findCharacter(c, name);
  if (found === undefined) {
    const names = c.characters.map((ch) => ch.name).join('、') || '（还没有角色）';
    throw new Error(`找不到角色「${name}」。现有：${names}`);
  }
  return found;
}

export interface CharacterInput {
  name: string;
  kind?: CharacterKind;
  player?: string;
  playerId?: string;
  className?: string;
  level?: number;
  abilities?: Partial<Record<Ability, number>>;
  skills?: Skill[];
  saves?: Ability[];
  maxHp?: number;
  hp?: number;
  ac?: number;
  attackBonus?: number;
  damage?: string;
  initBonus?: number;
  weapons?: Weapon[];
  notes?: string;
  traits?: string[];
  srd?: string;
  room?: string;
  hitDie?: string;
  npcId?: string;
}

/** 新建或更新角色卡；只覆盖传入的字段 */
export function upsertCharacter(c: Campaign, input: CharacterInput): { character: Character; created: boolean } {
  const name = input.name.trim();
  if (name.length === 0) throw new Error('角色名不能为空');
  const existing = c.characters.find((ch) => ch.name === name);
  const base: Character = existing ?? {
    name,
    kind: input.kind ?? 'pc',
    level: 1,
    abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
    skills: [],
    saves: [],
    hp: 10,
    maxHp: 10,
    tempHp: 0,
    ac: 10,
    conditions: [],
  };
  const next: Character = { ...base, abilities: { ...base.abilities } };
  if (input.kind !== undefined) next.kind = input.kind;
  if (input.player !== undefined) next.player = input.player;
  if (input.playerId !== undefined) next.playerId = input.playerId;
  if (input.className !== undefined) next.className = input.className;
  if (input.level !== undefined) next.level = clampInt(input.level, 1, 20);
  for (const ability of ABILITIES) {
    const score = input.abilities?.[ability];
    if (score !== undefined) next.abilities[ability] = clampInt(score, 1, 30);
  }
  if (input.skills !== undefined) next.skills = [...new Set(input.skills)];
  if (input.saves !== undefined) next.saves = [...new Set(input.saves)];
  if (input.ac !== undefined) next.ac = clampInt(input.ac, 1, 30);
  if (input.maxHp !== undefined) {
    next.maxHp = clampInt(input.maxHp, 1, 999);
    if (existing === undefined && input.hp === undefined) next.hp = next.maxHp;
  }
  if (input.hp !== undefined) next.hp = clampInt(input.hp, 0, next.maxHp);
  if (input.attackBonus !== undefined) next.attackBonus = Math.trunc(input.attackBonus);
  if (input.damage !== undefined) next.damage = input.damage;
  if (input.initBonus !== undefined) next.initBonus = Math.trunc(input.initBonus);
  if (input.weapons !== undefined) next.weapons = input.weapons;
  if (input.notes !== undefined) next.notes = input.notes;
  if (input.traits !== undefined) next.traits = [...new Set(input.traits)];
  if (input.srd !== undefined) next.srd = input.srd;
  if (input.room !== undefined) next.room = input.room;
  if (input.hitDie !== undefined) next.hitDie = input.hitDie;
  if (input.npcId !== undefined) next.npcId = input.npcId;
  next.hp = Math.min(next.hp, next.maxHp);

  if (existing === undefined) c.characters.push(next);
  else c.characters[c.characters.indexOf(existing)] = next;
  return { character: next, created: existing === undefined };
}

export function removeCharacter(c: Campaign, name: string): Character {
  const ch = requireCharacter(c, name);
  c.characters = c.characters.filter((x) => x !== ch);
  if (c.initiative !== undefined) removeFromInitiative(c.initiative, ch.name);
  return ch;
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function setCondition(ch: Character, condition: string, on: boolean): boolean {
  const has = ch.conditions.includes(condition);
  if (on && !has) ch.conditions.push(condition);
  if (!on && has) ch.conditions = ch.conditions.filter((x) => x !== condition);
  return has !== on;
}

export interface HpChange {
  name: string;
  before: number;
  after: number;
  maxHp: number;
  tempHp: number;
  /** 伤害被临时 HP 吸收的部分 */
  absorbed: number;
  /** 新增的状态，如 昏迷、死亡 */
  events: string[];
  /** 怪物/NPC：给玩家听的伤势描述（不报数字） */
  wound?: string;
}

/** 怪物伤势的口头描述：DM 只说这个，不报 HP 数字 */
export function woundLabel(ch: Character): string {
  if (ch.conditions.includes('死亡')) return '死了';
  if (ch.hp === 0) return '倒下';
  const ratio = ch.hp / ch.maxHp;
  if (ratio >= 1) return '毫发无伤';
  if (ratio > 0.5) return '受了点伤';
  if (ratio > 0.25) return '伤得不轻';
  return '摇摇欲坠';
}

function woundOf(ch: Character): { wound?: string } {
  return ch.kind === 'pc' ? {} : { wound: woundLabel(ch) };
}

export interface DamageOptions {
  /** 重击：不死坚韧不生效 */
  crit?: boolean;
  /** 伤害类型，如 光耀 */
  damageType?: string;
  roller?: Roller;
}

export const UNDEAD_FORTITUDE = '不死坚韧';

/**
 * 伤害：先扣临时 HP；怪物到 0 死亡，PC 到 0 昏迷，溢出伤害 ≥ 最大 HP 即死。
 * 有「不死坚韧」的怪物被打到 0 时（非光耀、非重击）自动过体质豁免 DC 5+伤害，成功留 1 HP。
 */
export function applyDamage(c: Campaign, name: string, amount: number, options: DamageOptions = {}): HpChange {
  const ch = requireCharacter(c, name);
  if (ch.conditions.includes('死亡')) throw new Error(`${ch.name} 已经死亡`);
  const dmg = Math.max(0, Math.trunc(amount));
  const before = ch.hp;
  const absorbed = Math.min(ch.tempHp, dmg);
  ch.tempHp -= absorbed;
  const rest = dmg - absorbed;
  const overflow = rest - ch.hp;
  ch.hp = Math.max(0, ch.hp - rest);
  const events: string[] = [];
  if (ch.hp === 0 && before > 0 && rest > 0 && ch.kind !== 'pc' && ch.traits?.includes(UNDEAD_FORTITUDE)
    && options.crit !== true && !/光耀|radiant/i.test(options.damageType ?? '')) {
    const dc = 5 + rest;
    const save = rollD20(abilityModifier(ch.abilities.con), 'none', options.roller ?? cryptoRoller);
    if (save.total >= dc) {
      ch.hp = 1;
      events.push(`${UNDEAD_FORTITUDE}：体质豁免 ${save.detail} vs DC ${dc} 成功，撑住剩 1 HP`);
    } else {
      events.push(`${UNDEAD_FORTITUDE}：体质豁免 ${save.detail} vs DC ${dc} 失败`);
    }
  }
  if (ch.hp === 0 && rest > 0) {
    if (ch.kind !== 'pc' || overflow >= ch.maxHp) {
      if (setCondition(ch, '死亡', true)) events.push('死亡');
    } else if (before > 0) {
      if (setCondition(ch, '昏迷', true)) events.push('昏迷');
      setCondition(ch, '倒地', true);
      setCondition(ch, '稳定', false);
    } else {
      // 已经昏迷的 PC 再受伤：记一次死亡豁免失败（重击由调用方再记一次）
      events.push(...addDeathFailures(ch, 1));
    }
  }
  pushLog(c, `${ch.name} 受到 ${dmg} 点伤害（${before}→${ch.hp}/${ch.maxHp}）${events.length > 0 ? `，${events.join('、')}` : ''}`);
  return { name: ch.name, before, after: ch.hp, maxHp: ch.maxHp, tempHp: ch.tempHp, absorbed, events, ...woundOf(ch) };
}

/** 治疗：不超过最大 HP；从 0 恢复时清掉昏迷/稳定 */
export function heal(c: Campaign, name: string, amount: number): HpChange {
  const ch = requireCharacter(c, name);
  if (ch.conditions.includes('死亡')) throw new Error(`${ch.name} 已经死亡，普通治疗无效`);
  const before = ch.hp;
  ch.hp = Math.min(ch.maxHp, ch.hp + Math.max(0, Math.trunc(amount)));
  const events: string[] = [];
  if (before === 0 && ch.hp > 0) {
    setCondition(ch, '昏迷', false);
    setCondition(ch, '稳定', false);
    delete ch.deathSaves;
    events.push('苏醒');
  }
  pushLog(c, `${ch.name} 恢复 ${ch.hp - before} 点 HP（${before}→${ch.hp}/${ch.maxHp}）`);
  return { name: ch.name, before, after: ch.hp, maxHp: ch.maxHp, tempHp: ch.tempHp, absorbed: 0, events, ...woundOf(ch) };
}

/** 临时 HP 不叠加，取较大值 */
export function grantTempHp(c: Campaign, name: string, amount: number): HpChange {
  const ch = requireCharacter(c, name);
  ch.tempHp = Math.max(ch.tempHp, Math.max(0, Math.trunc(amount)));
  return { name: ch.name, before: ch.hp, after: ch.hp, maxHp: ch.maxHp, tempHp: ch.tempHp, absorbed: 0, events: [] };
}

export function changeCondition(c: Campaign, name: string, condition: string, on: boolean): Character {
  const ch = requireCharacter(c, name);
  const value = condition.trim();
  if (value.length === 0) throw new Error('状态名不能为空');
  if (!on && value === '死亡' && ch.conditions.includes('死亡')) {
    throw new Error('不能手动解除「死亡」。判错了要回滚用 dnd_undo；不死坚韧之类的特性工具会自动处理');
  }
  if (setCondition(ch, value, on)) pushLog(c, `${ch.name} ${on ? '获得' : '解除'}状态「${value}」`);
  return ch;
}

// ── 死亡豁免 ──

function addDeathFailures(ch: Character, n: number): string[] {
  const saves = ch.deathSaves ?? { successes: 0, failures: 0 };
  saves.failures = Math.min(3, saves.failures + n);
  ch.deathSaves = saves;
  setCondition(ch, '稳定', false);
  if (saves.failures >= 3) {
    setCondition(ch, '死亡', true);
    return [`死亡豁免失败 ${saves.failures}/3，死亡`];
  }
  return [`死亡豁免失败 ${saves.failures}/3`];
}

/** 额外记死亡豁免失败（如倒地时被重击） */
export function recordDeathFailures(c: Campaign, name: string, n: number): string[] {
  const ch = requireCharacter(c, name);
  const events = addDeathFailures(ch, n);
  pushLog(c, `${ch.name} ${events.join('，')}`);
  return events;
}

export interface DeathSaveResult {
  name: string;
  detail: string;
  successes: number;
  failures: number;
  outcome: 'success' | 'failure' | 'stable' | 'dead' | 'revived';
}

/** 0 HP 的 PC 掷死亡豁免：≥10 成功，天然 1 记两次失败，天然 20 回到 1 HP */
export function deathSave(c: Campaign, name: string, roller: Roller = cryptoRoller): DeathSaveResult {
  const ch = requireCharacter(c, name);
  if (ch.kind !== 'pc' || ch.hp > 0) throw new Error(`${ch.name} 不需要死亡豁免（只有 0 HP 的 PC 才掷）`);
  if (ch.conditions.includes('死亡')) throw new Error(`${ch.name} 已经死亡`);
  if (ch.conditions.includes('稳定')) throw new Error(`${ch.name} 已经稳定，不再掷死亡豁免`);
  const roll = rollD20(0, 'none', roller);
  const saves = ch.deathSaves ?? { successes: 0, failures: 0 };
  ch.deathSaves = saves;
  let outcome: DeathSaveResult['outcome'];
  if (roll.natural === 20) {
    ch.hp = 1;
    setCondition(ch, '昏迷', false);
    setCondition(ch, '倒地', true);
    delete ch.deathSaves;
    outcome = 'revived';
  } else if (roll.natural === 1) {
    addDeathFailures(ch, 2);
    outcome = ch.conditions.includes('死亡') ? 'dead' : 'failure';
  } else if (roll.total >= 10) {
    saves.successes++;
    if (saves.successes >= 3) {
      setCondition(ch, '稳定', true);
      delete ch.deathSaves;
      outcome = 'stable';
    } else {
      outcome = 'success';
    }
  } else {
    addDeathFailures(ch, 1);
    outcome = ch.conditions.includes('死亡') ? 'dead' : 'failure';
  }
  const label = { success: '成功', failure: '失败', stable: '三次成功，稳定', dead: '死亡', revived: '天然 20，恢复 1 HP 醒来' }[outcome];
  pushLog(c, `${ch.name} 死亡豁免 ${roll.natural}：${label}`);
  return {
    name: ch.name,
    detail: roll.detail,
    successes: ch.deathSaves?.successes ?? (outcome === 'stable' ? 3 : 0),
    failures: ch.deathSaves?.failures ?? (outcome === 'dead' ? 3 : 0),
    outcome,
  };
}

// ── 先攻 ──

function isOut(ch: Character): boolean {
  return ch.conditions.includes('死亡');
}

/** 角色所在房间：怪物看自己的 room；PC/NPC 没单独移动过时跟着队伍主位置 */
export function roomOf(c: Campaign, ch: Character): string | undefined {
  return ch.kind === 'monster' ? ch.room : (ch.room ?? c.currentRoom);
}

/** 某房间里参与战斗的角色（默认队伍主位置）：在场活着的 PC/NPC + 本房间活着的怪物 */
export function combatants(c: Campaign, room = c.currentRoom): Character[] {
  return c.characters.filter((ch) => !isOut(ch) && roomOf(c, ch) === room);
}

export function initBonusOf(ch: Character): number {
  return ch.initBonus ?? abilityModifier(ch.abilities.dex);
}

export interface InitiativeRoll {
  name: string;
  init: number;
  detail: string;
}

/** 为参战者掷先攻并排序；names 省略时取 room（默认队伍主位置）里的 combatants() */
export function startInitiative(c: Campaign, roller: Roller = cryptoRoller, names?: string[], room?: string): InitiativeRoll[] {
  const members = names === undefined || names.length === 0 ? combatants(c, room) : names.map((n) => requireCharacter(c, n));
  if (members.length === 0) throw new Error('没有可以参战的角色');
  const rolls = members.map((ch) => {
    const r = rollD20(initBonusOf(ch), 'none', roller);
    return { name: ch.name, init: r.total, detail: r.detail, tiebreak: initBonusOf(ch) };
  });
  rolls.sort((a, b) => b.init - a.init || b.tiebreak - a.tiebreak);
  c.initiative = { round: 1, turn: 0, order: rolls.map(({ name, init }) => ({ name, init })) };
  pushLog(c, `进入战斗：${rolls.map((r) => `${r.name}(${r.init})`).join(' > ')}`);
  return rolls.map(({ name, init, detail }) => ({ name, init, detail }));
}

function removeFromInitiative(state: InitiativeState, name: string): void {
  const idx = state.order.findIndex((e) => e.name === name);
  if (idx === -1) return;
  state.order.splice(idx, 1);
  if (idx < state.turn) state.turn--;
  if (state.turn >= state.order.length) state.turn = 0;
}

export function requireInitiative(c: Campaign): InitiativeState {
  if (c.initiative === undefined) throw new Error('当前不在战斗中，先用 dnd_initiative start');
  return c.initiative;
}

/** 推进到下一个还能行动的角色（跳过死亡的；昏迷的 PC 保留，要做死亡豁免） */
export function nextTurn(c: Campaign): { round: number; current: InitiativeEntry; newRound: boolean } {
  const state = requireInitiative(c);
  for (const entry of [...state.order]) {
    const ch = findCharacter(c, entry.name);
    if (ch === undefined || isOut(ch)) removeFromInitiative(state, entry.name);
  }
  if (state.order.length === 0) throw new Error('先攻表里已经没有能行动的角色，用 dnd_initiative end 结束战斗');
  let newRound = false;
  state.turn++;
  if (state.turn >= state.order.length) {
    state.turn = 0;
    state.round++;
    newRound = true;
  }
  return { round: state.round, current: state.order[state.turn]!, newRound };
}

/** 结束战斗：清空先攻，移除已死亡的怪物 */
export function endInitiative(c: Campaign): { rounds: number; defeated: string[] } {
  const rounds = c.initiative?.round ?? 0;
  c.initiative = undefined;
  const defeated = c.characters.filter((ch) => ch.kind === 'monster' && isOut(ch)).map((ch) => ch.name);
  c.characters = c.characters.filter((ch) => !(ch.kind === 'monster' && isOut(ch)));
  pushLog(c, `战斗结束（${rounds} 轮）${defeated.length > 0 ? `，击败 ${defeated.join('、')}` : ''}`);
  return { rounds, defeated };
}

// ── 移动 ──

export interface VisibleExit {
  to: string;
  name: string;
  label: string;
  known: boolean;
  /** 条件不满足、暂时过不去 */
  locked?: boolean;
}

export interface ExitCheckRoll {
  name: string;
  passed: boolean;
  detail: string;
}

export interface MoveResult {
  /** 实际移动的角色名（出口检定失败的人留在原地，不在这里） */
  movers: string[];
  room: DungeonRoom;
  site: Site;
  /** 首次进入这个房间 */
  firstVisit: boolean;
  /** 首次进入这个场景（要念 Site.arrival） */
  firstSiteVisit: boolean;
  /** 套用描述变体之后的玩家视角 / DM 笔记 */
  view: { playerView: string; dmNotes: string };
  spawned: Character[];
  /** 出口检定的结果；没过的人没动 */
  checks: ExitCheckRoll[];
  /** 出口检定失败的后果（DM 视角） */
  failText?: string;
  /** afterChange 产生的剧情提示 */
  story: string[];
  /** 玩家现在能看到的出口 */
  exits: VisibleExit[];
}

/** 场景入口能去的其他已知场景（有 routes 时只算有路相连的） */
function crossSiteExits(c: Campaign, adv: Adventure, roomId: string): DungeonExit[] {
  const site = siteOfRoom(adv, roomId);
  if (site === undefined || site.entry !== roomId) return [];
  return adv.sites
    .filter((s) => s.id !== site.id && c.knownSites.includes(s.id))
    .filter((s) => adv.routes === undefined || adv.routes.some((r) => (r.from === site.id && r.to === s.id) || (r.from === s.id && r.to === site.id)))
    .map((s) => ({ to: s.entry, label: `前往${s.name}` }));
}

/** 列出当前房间对玩家可见的出口（未发现的暗门不列，条件不满足的标 locked） */
export function visibleExits(c: Campaign, adv: Adventure, roomId = c.currentRoom): VisibleExit[] {
  const graph = roomGraph(adv);
  return [...exitsOf(graph, roomId), ...crossSiteExits(c, adv, roomId)]
    .filter((e) => e.hidden !== true || c.discoveredExits.includes(exitKey(roomId, e.to)))
    .map((e) => ({
      to: e.to,
      name: findRoom(graph, e.to)?.name ?? e.to,
      label: e.label,
      known: c.revealed.includes(e.to),
      ...(e.requires !== undefined && !evalCondition(c, adv, e.requires) ? { locked: true } : {}),
    }));
}

/** 按 id、本场景房间名、场景 id/名（→ 场景入口）、全模组房间名的顺序找目标 */
function resolveTarget(adv: Adventure, from: string, query: string): DungeonRoom | undefined {
  const q = query.trim();
  const graph = roomGraph(adv);
  const here = siteOfRoom(adv, from);
  const site = findSite(adv, q) ?? adv.sites.find((s) => s.name === q);
  return findRoom(graph, q)
    ?? here?.rooms.find((r) => r.name === q)
    ?? (site !== undefined ? findRoom(graph, site.entry) : undefined)
    ?? graph.rooms.find((r) => r.name === q);
}

/** 新角色名：重名时加房间后缀，再重名就加序号 */
function freeName(c: Campaign, name: string, roomId: string): string {
  if (!c.characters.some((ch) => ch.name === name)) return name;
  let candidate = `${name}-${roomId}`;
  for (let n = 2; c.characters.some((ch) => ch.name === candidate); n++) candidate = `${name}-${roomId}-${n}`;
  return candidate;
}

/** 把模组里的怪物刷进某个房间（房间遭遇、触发器援兵） */
export function spawnMonsters(c: Campaign, roomId: string, monsters: readonly DungeonMonster[]): Character[] {
  const spawned: Character[] = [];
  for (const monster of monsters) {
    for (let i = 1; i <= monster.count; i++) {
      const ch: Character = {
        name: freeName(c, monster.count > 1 ? `${monster.name}${i}` : monster.name, roomId),
        kind: 'monster',
        level: 1,
        abilities: { str: 10, dex: 10 + monster.initBonus * 2, con: 10, int: 10, wis: 10, cha: 10, ...monster.abilities },
        skills: [],
        saves: [],
        hp: monster.hp,
        maxHp: monster.hp,
        tempHp: 0,
        ac: monster.ac,
        conditions: [],
        attackBonus: monster.attackBonus,
        damage: monster.damage,
        initBonus: monster.initBonus,
        room: roomId,
        ...(monster.srd !== undefined ? { srd: monster.srd } : {}),
        ...(monster.notes !== undefined ? { notes: monster.notes } : {}),
        ...(monster.traits !== undefined ? { traits: [...monster.traits] } : {}),
      };
      c.characters.push(ch);
      spawned.push(ch);
    }
  }
  return spawned;
}

/** 出口检定：skill 或 ability 都可以写中文或英文 */
function rollExitCheck(ch: Character, check: ExitCheck, roller: Roller): ExitCheckRoll {
  const skill = check.skill === undefined ? undefined : parseSkill(check.skill);
  const ability = skill !== undefined ? SKILLS[skill].ability as Ability : parseAbility(check.ability ?? '');
  if (ability === undefined) throw new Error(`出口检定写的技能/属性认不出来: ${check.skill ?? check.ability}`);
  const r = rollD20(checkModifier(ch, skill !== undefined ? 'skill' : 'ability', ability, skill), 'none', roller);
  const passed = r.total >= check.dc;
  return { name: ch.name, passed, detail: `${r.detail}，${passed ? '成功' : '失败'}` };
}

/**
 * 移动到相邻房间。who 省略时整队（全部活着的 PC/NPC）一起走；传了只移动这几个人（分头行动）。
 * 暗门需要 discoverHidden=true（模型在检定成功后才传）。首次进入时揭示房间并刷出遭遇怪物。
 * 战斗中只能单独移动当前回合的角色。
 * 跨场景：从场景入口走到另一个已知场景的入口（有 routes 时要有路）。
 * 出口有 requires 时条件不满足就过不去；有 check 时工具给每个人掷骰，没过的留在原地。
 */
export function moveParty(
  c: Campaign,
  adv: Adventure,
  target: string,
  discoverHidden = false,
  who?: string[],
  roller: Roller = cryptoRoller,
): MoveResult {
  const graph = roomGraph(adv);
  const whole = who === undefined || who.length === 0;
  if (c.initiative !== undefined) {
    if (whole) throw new Error('战斗中不能整队移动；先结束战斗（dnd_initiative end），或用 who 只移动当前回合的角色');
    const current = c.initiative.order[c.initiative.turn]?.name;
    const others = who.map((n) => requireCharacter(c, n).name).filter((n) => n !== current);
    if (others.length > 0) throw new Error(`战斗中只能移动当前回合的角色（${current ?? '无'}）：${others.join('、')} 要等自己的回合`);
  }
  const candidates = whole
    ? c.characters.filter((ch) => ch.kind !== 'monster' && !isOut(ch))
    : [...new Set(who.map((n) => requireCharacter(c, n)))];
  if (candidates.length === 0) throw new Error('没有可以移动的角色');
  const monster = candidates.find((ch) => ch.kind === 'monster');
  if (monster !== undefined) throw new Error(`${monster.name} 是怪物，怪物位置不用 dnd_move`);
  const from = roomOf(c, candidates[0]!)!;
  const fromName = findRoom(graph, from)?.name ?? from;
  const split = candidates.filter((ch) => roomOf(c, ch) !== from);
  if (split.length > 0) {
    throw new Error(`${split.map((ch) => ch.name).join('、')} 不在「${fromName}」，不同房间的人分开移动（who）`);
  }

  const room = resolveTarget(adv, from, target);
  if (room === undefined) throw new Error(`没有这个房间: ${target}`);
  if (room.id === from) throw new Error(`${whole ? '队伍' : candidates.map((ch) => ch.name).join('、')}已经在「${room.name}」了`);
  const fromSite = siteOfRoom(adv, from)!;
  const site = siteOfRoom(adv, room.id)!;
  const exit = site.id === fromSite.id
    ? exitBetween(graph, from, room.id)
    : crossSiteExits(c, adv, from).find((e) => e.to === room.id);
  if (exit === undefined) {
    if (site.id !== fromSite.id) {
      if (!c.knownSites.includes(site.id)) throw new Error(`玩家还不知道「${site.name}」在哪`);
      if (from !== fromSite.entry) throw new Error(`要离开「${fromSite.name}」，先回到入口「${findRoom(graph, fromSite.entry)?.name ?? fromSite.entry}」`);
      if (room.id !== site.entry) throw new Error(`去「${site.name}」要从入口「${findRoom(graph, site.entry)?.name ?? site.entry}」进`);
      throw new Error(`「${fromSite.name}」和「${site.name}」之间没有路`);
    }
    const names = visibleExits(c, adv, from).map((e) => e.name).join('、') || '无';
    throw new Error(`「${room.name}」和「${fromName}」不相邻。可去：${names}`);
  }
  const key = exitKey(from, room.id);
  if (exit.hidden === true && !c.discoveredExits.includes(key)) {
    if (!discoverHidden) throw new Error(`没有可见的路通往「${room.name}」`);
    c.discoveredExits.push(key);
    pushLog(c, `发现暗门：${fromName} ↔ ${room.name}`);
  }
  if (exit.requires !== undefined && !evalCondition(c, adv, exit.requires)) {
    throw new Error(`过不去：${exit.lockedText ?? `需要 ${describeCondition(adv, exit.requires)}`}`);
  }

  const check = exit.check;
  const checks = check === undefined ? [] : candidates.map((ch) => rollExitCheck(ch, check, roller));
  const movers = candidates.filter((ch) => checks.find((r) => r.name === ch.name)?.passed !== false);
  const failText = check !== undefined && checks.some((r) => !r.passed) ? check.fail : undefined;
  if (checks.length > 0) pushLog(c, `${exit.label}检定：${checks.map((r) => `${r.name}${r.passed ? '成功' : '失败'}`).join('、')}`);

  const everyone = whole && movers.length === candidates.length;
  const firstSiteVisit = movers.length > 0 && site.id !== fromSite.id && !site.rooms.some((r) => c.revealed.includes(r.id));
  const firstVisit = movers.length > 0 && !c.revealed.includes(room.id);
  const spawned: Character[] = [];
  if (movers.length > 0) {
    // 没单独移动过的人跟着 currentRoom；它要变之前先把留下的人钉在原地，免得被一起带走
    for (const ch of c.characters) {
      if (ch.kind !== 'monster' && ch.room === undefined && !movers.includes(ch)) ch.room = c.currentRoom;
    }
    for (const ch of movers) ch.room = room.id;
    // 有人检定没过留在原地时，队伍主位置按人数多的一边算
    c.currentRoom = everyone ? room.id : mainRoom(c, room.id);
    if (firstVisit) c.revealed.push(room.id);
    if (!c.knownSites.includes(site.id)) c.knownSites.push(site.id);
    if (!c.spawned.includes(room.id)) {
      c.spawned.push(room.id);
      spawned.push(...spawnMonsters(c, room.id, room.encounter ?? []));
    }
    pushLog(c, `${everyone ? '队伍' : movers.map((ch) => ch.name).join('、')}进入「${room.name}」`);
  }
  const story = afterChange(c, adv);
  for (const line of story) pushLog(c, line);
  return {
    movers: movers.map((ch) => ch.name),
    room,
    site,
    firstVisit,
    firstSiteVisit,
    view: roomView(c, adv, room),
    spawned,
    checks,
    ...(failText !== undefined ? { failText } : {}),
    story,
    exits: visibleExits(c, adv, movers.length > 0 ? room.id : from),
  };
}

/** 队伍主位置：活着的 PC/NPC 最多的房间（平手取 prefer） */
function mainRoom(c: Campaign, prefer: string): string {
  const counts = new Map<string, number>();
  for (const [room, members] of partyPositions(c)) counts.set(room, members.length);
  let best = prefer;
  for (const [room, n] of counts) {
    if (n > (counts.get(best) ?? 0)) best = room;
  }
  return best;
}

/** 按房间分组的队伍位置（活着的 PC/NPC）；全队在一起时只有一组 */
export function partyPositions(c: Campaign): Map<string, Character[]> {
  const groups = new Map<string, Character[]>();
  for (const ch of c.characters) {
    if (ch.kind === 'monster' || isOut(ch)) continue;
    const room = roomOf(c, ch)!;
    groups.set(room, [...(groups.get(room) ?? []), ch]);
  }
  return groups;
}

// ── 行动界限 ──

export interface ActOptions {
  /** 宣告这个行动的玩家 openid（来自消息里的 [昵称 (openid)]） */
  declaredBy?: string;
  /** DM 要求的对抗/反应/借机攻击：不受回合和玩家绑定限制 */
  reaction?: boolean;
  /**
   * 最近真正给 bot 发过消息的人。传入时 declaredBy 必须在里面：
   * 模型照抄角色卡上的 openid 也冒充不了没说话的玩家。
   */
  recentSenders?: readonly string[];
}

/** PC 必须由绑定的玩家本人宣告，且这个人最近确实发过消息 */
function assertDeclaredByOwner(ch: Character, options: ActOptions, what: string): void {
  if (ch.kind !== 'pc' || ch.playerId === undefined) return;
  const owner = `〈${ch.player ?? ch.playerId}〉`;
  if (options.declaredBy !== ch.playerId) {
    throw new Error(
      `${ch.name} 是${owner}的角色，${what}只能由他本人宣告（declared_by 填他的 openid）。`
      + '别人说的只当提议，去问他本人；DM 要求的对抗检定或反应传 reaction=true。',
    );
  }
  if (options.recentSenders !== undefined && !options.recentSenders.includes(ch.playerId)) {
    throw new Error(`${owner}最近没有发消息，不能替他宣告${what}。等他本人说话。`);
  }
}

/**
 * 检查角色此刻能否主动行动；不能时抛出给模型看的原因。
 *   - 绑定了玩家的 PC，只能由该玩家宣告；
 *   - 战斗中只有当前回合的角色能主动行动（反应除外）。
 */
export function assertCanAct(c: Campaign, ch: Character, options: ActOptions = {}): void {
  if (options.reaction === true) return;
  assertDeclaredByOwner(ch, options, '行动');
  const state = c.initiative;
  if (state === undefined) return;
  const current = state.order[state.turn];
  if (current !== undefined && current.name !== ch.name) {
    throw new Error(
      `现在是 ${current.name} 的回合，${ch.name} 不能主动行动。${current.name} 行动完先调用 dnd_initiative next；`
      + '借机攻击/反应传 reaction=true。',
    );
  }
}

/**
 * 结束当前回合（dnd_initiative next）前的检查：当前是绑定玩家的 PC 时，
 * 只有他本人能结束（附赠动作、移动还没用完）；玩家掉线时 DM 传 dmOverride。
 */
export function assertCanEndTurn(c: Campaign, options: ActOptions & { dmOverride?: boolean } = {}): void {
  if (options.dmOverride === true) return;
  const state = requireInitiative(c);
  const current = state.order[state.turn];
  const ch = current === undefined ? undefined : findCharacter(c, current.name);
  if (ch === undefined || ch.hp === 0 || ch.conditions.includes('死亡')) return;
  assertDeclaredByOwner(ch, options, '结束回合');
}

/** 纠正先攻指针：跳到某角色的回合（叙事和状态对不上时用） */
export function gotoTurn(c: Campaign, name: string, round?: number): InitiativeEntry {
  const state = requireInitiative(c);
  const ch = requireCharacter(c, name);
  const idx = state.order.findIndex((e) => e.name === ch.name);
  if (idx === -1) throw new Error(`${ch.name} 不在先攻表里`);
  state.turn = idx;
  if (round !== undefined && round >= 1) state.round = Math.trunc(round);
  pushLog(c, `先攻指针调整到第 ${state.round} 轮 ${ch.name}`);
  return state.order[idx]!;
}

// ── 检定 ──

export type CheckKind = 'skill' | 'ability' | 'save';

/** 角色在某检定上的修正值（属性调整 + 熟练） */
export function checkModifier(ch: Character, kind: CheckKind, ability: Ability, skill?: Skill): number {
  const base = abilityModifier(ch.abilities[ability]);
  const prof = proficiencyBonus(ch.level);
  if (kind === 'skill' && skill !== undefined && ch.skills.includes(skill)) return base + prof;
  if (kind === 'save' && ch.saves.includes(ability)) return base + prof;
  return base;
}

export function findWeapon(ch: Character, name: string): Weapon {
  const q = name.trim();
  const weapon = ch.weapons?.find((w) => w.name === q) ?? ch.weapons?.find((w) => w.name.includes(q) || q.includes(w.name));
  if (weapon === undefined) {
    const list = ch.weapons?.map((w) => w.name).join('、') || '（角色卡上没有武器，先用 dnd_character update 补上）';
    throw new Error(`${ch.name} 没有「${name}」。现有武器：${list}`);
  }
  return weapon;
}

/** 武器伤害表达式：武器骰 + 属性调整值 */
export function weaponDamage(ch: Character, weapon: Weapon): string {
  const mod = abilityModifier(ch.abilities[weapon.ability ?? 'str']);
  return mod === 0 ? weapon.damage : `${weapon.damage}${mod > 0 ? '+' : '-'}${Math.abs(mod)}`;
}

/** PC 攻击加值：取力量/敏捷较高者 + 熟练；怪物用 attackBonus */
export function attackModifier(ch: Character, ability?: Ability): number {
  if (ch.attackBonus !== undefined && ability === undefined) return ch.attackBonus;
  const use = ability ?? (ch.abilities.dex > ch.abilities.str ? 'dex' : 'str');
  return abilityModifier(ch.abilities[use]) + proficiencyBonus(ch.level);
}

// ── 资源、休息、物品 ──

function requireResource(ch: Character, key: string): [string, Resource] {
  const q = key.trim();
  const entries = Object.entries(ch.resources ?? {});
  const found = entries.find(([k]) => k === q) ?? entries.find(([k]) => k.includes(q) || q.includes(k));
  if (found === undefined) {
    const list = entries.map(([k, r]) => `${k} ${r.current}/${r.max}`).join('、') || '（还没有记录，先 dnd_resource set）';
    throw new Error(`${ch.name} 没有资源「${key}」。现有：${list}`);
  }
  return found;
}

/** 建立或改写资源；current 省略时新建取满、已有保持不变（不超过新上限） */
export function setResource(c: Campaign, name: string, key: string, max: number, reset: Resource['reset'], current?: number): Resource {
  const ch = requireCharacter(c, name);
  const k = key.trim();
  if (k.length === 0) throw new Error('资源名不能为空');
  const cap = clampInt(max, 0, 999);
  const existing = ch.resources?.[k];
  const value = current !== undefined ? clampInt(current, 0, cap) : Math.min(existing?.current ?? cap, cap);
  const resource: Resource = { current: value, max: cap, reset };
  ch.resources = { ...ch.resources, [k]: resource };
  return resource;
}

/** 消耗资源，不够时抛错（不会扣成负数） */
export function useResource(c: Campaign, name: string, key: string, amount = 1): { key: string; before: number; resource: Resource } {
  const ch = requireCharacter(c, name);
  const [k, r] = requireResource(ch, key);
  const n = Math.max(1, Math.trunc(amount));
  if (r.current < n) throw new Error(`${ch.name} 的「${k}」只剩 ${r.current}/${r.max}，不够用 ${n}`);
  const before = r.current;
  r.current -= n;
  pushLog(c, `${ch.name} 用掉「${k}」${n}（剩 ${r.current}/${r.max}）`);
  return { key: k, before, resource: r };
}

/** 恢复资源；amount 省略时回满 */
export function restoreResource(c: Campaign, name: string, key: string, amount?: number): { key: string; before: number; resource: Resource } {
  const ch = requireCharacter(c, name);
  const [k, r] = requireResource(ch, key);
  const before = r.current;
  r.current = amount === undefined ? r.max : Math.min(r.max, r.current + Math.max(0, Math.trunc(amount)));
  pushLog(c, `${ch.name} 恢复「${k}」到 ${r.current}/${r.max}`);
  return { key: k, before, resource: r };
}

export interface RestResult {
  name: string;
  lines: string[];
}

/**
 * 休息。短休：short 资源回满，可花生命骰（spend: 角色名 → 骰数）回血；
 * 长休：HP 回满、所有 short/long 资源回满、生命骰回一半（至少 1）。战斗中不能休息。
 */
export function rest(
  c: Campaign,
  kind: 'short' | 'long',
  names?: string[],
  spend: Record<string, number> = {},
  roller: Roller = cryptoRoller,
): RestResult[] {
  if (c.initiative !== undefined) throw new Error('战斗中不能休息');
  const members = names === undefined || names.length === 0
    ? c.characters.filter((ch) => ch.kind !== 'monster' && !isOut(ch))
    : names.map((n) => requireCharacter(c, n));
  const spendFor = new Map<Character, number>();
  for (const [n, dice] of Object.entries(spend)) spendFor.set(requireCharacter(c, n), dice);
  const results = members.map((ch) => {
    const lines: string[] = [];
    for (const [k, r] of Object.entries(ch.resources ?? {})) {
      if ((r.reset === 'short' || (kind === 'long' && r.reset === 'long')) && r.current < r.max) {
        r.current = r.max;
        lines.push(`${k} 回满 ${r.max}`);
      }
    }
    if (kind === 'short') {
      const dice = Math.max(0, Math.trunc(spendFor.get(ch) ?? 0));
      if (dice > 0) {
        if (ch.hitDie === undefined) throw new Error(`${ch.name} 没记录生命骰，先 dnd_character update hit_die（如 d10）`);
        const left = ch.level - (ch.hitDiceUsed ?? 0);
        if (dice > left) throw new Error(`${ch.name} 只剩 ${left} 颗生命骰`);
        const con = abilityModifier(ch.abilities.con);
        let healed = 0;
        const rolls: string[] = [];
        const sides = Number(ch.hitDie.replace(/^\d*d/i, ''));
        if (!Number.isInteger(sides) || sides < 2) throw new Error(`${ch.name} 的生命骰「${ch.hitDie}」写法不对，应为 d6/d8/d10/d12`);
        for (let i = 0; i < dice; i++) {
          const face = roller(sides);
          const gain = Math.max(0, face + con);
          healed += gain;
          rolls.push(`${ch.hitDie}[${face}]${con >= 0 ? '+' : ''}${con}`);
        }
        ch.hitDiceUsed = (ch.hitDiceUsed ?? 0) + dice;
        const before = ch.hp;
        if (!ch.conditions.includes('死亡')) ch.hp = Math.min(ch.maxHp, ch.hp + healed);
        lines.push(`生命骰 ${rolls.join(' ')} = ${healed}，HP ${before}→${ch.hp}/${ch.maxHp}（剩 ${ch.level - ch.hitDiceUsed} 颗）`);
      }
    } else {
      const before = ch.hp;
      ch.hp = ch.maxHp;
      ch.tempHp = 0;
      delete ch.deathSaves;
      setCondition(ch, '昏迷', false);
      setCondition(ch, '稳定', false);
      if (before < ch.maxHp) lines.push(`HP ${before}→${ch.maxHp}`);
      if ((ch.hitDiceUsed ?? 0) > 0) {
        const regained = Math.min(ch.hitDiceUsed ?? 0, Math.max(1, Math.floor(ch.level / 2)));
        ch.hitDiceUsed = (ch.hitDiceUsed ?? 0) - regained;
        lines.push(`生命骰回 ${regained} 颗`);
      }
    }
    return { name: ch.name, lines };
  });
  pushLog(c, `${kind === 'short' ? '短休' : '长休'}：${results.map((r) => r.name).join('、')}`);
  return results;
}

/** 增减物品与金币 */
export function changeInventory(c: Campaign, name: string, add: string[] = [], remove: string[] = [], gpDelta = 0): Character {
  const ch = requireCharacter(c, name);
  const items = [...(ch.inventory ?? [])];
  for (const item of remove) {
    const q = item.trim();
    const idx = items.findIndex((x) => x === q);
    const fuzzy = idx === -1 ? items.findIndex((x) => x.includes(q)) : idx;
    if (fuzzy === -1) throw new Error(`${ch.name} 身上没有「${item}」。现有：${items.join('、') || '无'}`);
    items.splice(fuzzy, 1);
  }
  for (const item of add) if (item.trim().length > 0) items.push(item.trim());
  ch.inventory = items;
  if (gpDelta !== 0) {
    const gp = (ch.gp ?? 0) + Math.trunc(gpDelta);
    if (gp < 0) throw new Error(`${ch.name} 只有 ${ch.gp ?? 0} gp`);
    ch.gp = gp;
  }
  if (add.length > 0 || remove.length > 0 || gpDelta !== 0) {
    pushLog(c, `${ch.name} 物品${add.length > 0 ? ` +${add.join('、')}` : ''}${remove.length > 0 ? ` -${remove.join('、')}` : ''}${gpDelta !== 0 ? ` ${gpDelta > 0 ? '+' : ''}${gpDelta}gp` : ''}`);
  }
  return ch;
}

export function resourceTag(ch: Character): string {
  const parts = Object.entries(ch.resources ?? {}).map(([k, r]) => `${k}${r.current}/${r.max}`);
  if (ch.hitDie !== undefined) parts.push(`生命骰${ch.level - (ch.hitDiceUsed ?? 0)}/${ch.level}`);
  return parts.length > 0 ? ` {${parts.join(' ')}}` : '';
}

// ── 结团摘要 ──

export function addSummary(c: Campaign, text: string, now = Date.now()): void {
  const value = text.trim();
  if (value.length === 0) return;
  c.summaries.push({ at: now, text: value.slice(0, 1500) });
  if (c.summaries.length > MAX_SUMMARIES) c.summaries.splice(0, c.summaries.length - MAX_SUMMARIES);
}

// ── 每回合注入的精简摘要 ──

function hpTag(ch: Character): string {
  const temp = ch.tempHp > 0 ? `+${ch.tempHp}` : '';
  const cond = ch.conditions.length > 0 ? ` [${ch.conditions.join(',')}]` : '';
  return `${ch.name} ${ch.hp}${temp}/${ch.maxHp} AC${ch.ac}${cond}`;
}

/** 队伍主位置所在的场景，以及这个场景探索了几个房间 */
export function explored(c: Campaign, adv: Adventure): { site: Site | undefined; seen: number; total: number } {
  const site = siteOfRoom(adv, c.currentRoom);
  const rooms = site?.rooms ?? [];
  return { site, seen: rooms.filter((r) => c.revealed.includes(r.id)).length, total: rooms.length };
}

export function summarize(c: Campaign, adv: Adventure): string {
  const graph = roomGraph(adv);
  const room = findRoom(graph, c.currentRoom);
  const { site, seen, total } = explored(c, adv);
  const lines: string[] = [];
  const where = adv.sites.length > 1 ? `${adv.name}｜场景：${site?.name ?? '?'}` : `地城：${site?.name ?? adv.name}`;
  lines.push(`${where}｜当前房间：${room?.name ?? c.currentRoom}（${c.currentRoom}）｜已探索 ${seen}/${total}`);
  const exits = visibleExits(c, adv).map((e) => `${e.name}(${e.to})${e.locked === true ? '[过不去]' : ''}`).join('、');
  lines.push(`可见出口：${exits || '无'}`);

  const party = c.characters.filter((ch) => ch.kind !== 'monster');
  lines.push(`队伍：${party.length > 0 ? party.map((ch) => `${hpTag(ch)}${ch.player ? `〈${ch.player}〉` : ''}${resourceTag(ch)}`).join('；') : '还没有角色卡'}`);
  const positions = partyPositions(c);
  if (positions.size > 1) {
    lines.push(`队伍分头行动：${[...positions].map(([room, members]) => `${findRoom(graph, room)?.name ?? room}：${members.map((ch) => ch.name).join('、')}`).join('｜')}`);
  }

  const occupied = positions.size > 1 ? [...positions.keys()] : [c.currentRoom];
  for (const room of occupied) {
    const foes = c.characters.filter((ch) => ch.kind === 'monster' && ch.room === room && !isOut(ch));
    if (foes.length > 0) {
      const at = room === c.currentRoom ? '本房间' : `「${findRoom(graph, room)?.name ?? room}」`;
      lines.push(`${at}敌人（对玩家只说伤势词）：${foes.map((ch) => `${hpTag(ch)} ${woundLabel(ch)}`).join('；')}`);
    }
  }

  if (c.initiative !== undefined) {
    const s = c.initiative;
    const order = s.order.map((e, i) => (i === s.turn ? `▶${e.name}(${e.init})` : `${e.name}(${e.init})`)).join(' > ');
    lines.push(`战斗第 ${s.round} 轮：${order}`);
  }
  lines.push(...storySummaryLines(c, adv, occupied));
  if (c.log.length > 0) lines.push(`最近：${c.log.slice(-SUMMARY_LOG_LINES).join('；')}`);
  return lines.join('\n');
}

/** 给玩家看的团况：PC 的 HP/资源、敌人只给伤势词、先攻顺序；不含 DM 笔记和怪物数值 */
export function playerStatus(c: Campaign, adv: Adventure): string {
  const lines: string[] = [];
  const graph = roomGraph(adv);
  const room = findRoom(graph, c.currentRoom);
  const { site, seen, total } = explored(c, adv);
  lines.push(`📍 ${adv.sites.length > 1 && site !== undefined ? `${site.name} · ` : ''}${room?.name ?? c.currentRoom}｜已探索 ${seen}/${total}`);
  const positions = partyPositions(c);
  for (const [roomId, members] of positions) {
    const where = positions.size > 1 ? `${findRoom(graph, roomId)?.name ?? roomId}：` : '';
    lines.push(`${where}${members.map((ch) => `${ch.name} ${ch.hp}/${ch.maxHp}${ch.conditions.length > 0 ? `[${ch.conditions.join(',')}]` : ''}${resourceTag(ch)}`).join('；')}`);
  }
  const foes = c.characters.filter((ch) => ch.kind === 'monster' && !isOut(ch) && positions.has(ch.room ?? ''));
  if (foes.length > 0) lines.push(`敌人：${foes.map((ch) => `${ch.name}（${woundLabel(ch)}${ch.conditions.length > 0 ? `，${ch.conditions.join(',')}` : ''}）`).join('、')}`);
  if (c.initiative !== undefined) {
    const s = c.initiative;
    lines.push(`⚔ 第 ${s.round} 轮：${s.order.map((e, i) => (i === s.turn ? `▶${e.name}` : e.name)).join(' → ')}`);
  }
  return lines.join('\n');
}

// ── 存储 ──

export interface Snapshot {
  at: number;
  /** 造成这次改动的工具调用，如「dnd_check 恩佐 攻击 巨鼠1」 */
  label: string;
  /** 改动前的整份 campaign JSON */
  state: string;
}

function safeFileName(key: string): string {
  return key.replace(/[^a-zA-Z0-9_-]+/g, '_');
}

export class CampaignStore {
  public readonly root: string;

  public constructor(root: string) {
    this.root = root;
  }

  private pathOf(key: string): string {
    return join(this.root, `${safeFileName(key)}.json`);
  }

  public load(key: string): Campaign | undefined {
    const path = this.pathOf(key);
    if (!existsSync(path)) return undefined;
    try {
      return parseCampaign(readFileSync(path, 'utf8'));
    } catch {
      return undefined;
    }
  }

  public save(c: Campaign, now = Date.now()): void {
    mkdirSync(this.root, { recursive: true });
    c.updatedAt = now;
    const path = this.pathOf(c.key);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(c, null, 2)}\n`, 'utf8');
    try {
      renameSync(tmp, path);
    } catch {
      // Windows 上目标被占用时 rename 可能失败：退化为直接覆盖
      writeFileSync(path, readFileSync(tmp));
    }
  }

  /** 把旧团改名存档（重新开新团时用），返回存档文件名 */
  public archive(key: string, now = Date.now()): string | undefined {
    const path = this.pathOf(key);
    if (!existsSync(path)) return undefined;
    const archived = join(this.root, `${safeFileName(key)}.${now}.json`);
    renameSync(path, archived);
    return archived;
  }

  /** 读取 → 修改 → 保存；fn 抛错时不保存。改动前的状态存一份快照，供 undo 回滚 */
  public update<T>(key: string, fn: (c: Campaign) => T, label = '改动'): T {
    const c = this.load(key);
    if (c === undefined || !c.active) throw new Error('这个群还没有进行中的团。让玩家发送 /dnd start 开团');
    const before = JSON.stringify(c);
    const result = fn(c);
    if (JSON.stringify(c) !== before) {
      this.pushSnapshot(key, { at: Date.now(), label, state: before });
      this.save(c);
    }
    return result;
  }

  private historyPath(key: string): string {
    return join(this.root, 'history', `${safeFileName(key)}.json`);
  }

  public snapshots(key: string): Snapshot[] {
    const path = this.historyPath(key);
    if (!existsSync(path)) return [];
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as Snapshot[];
    } catch {
      return [];
    }
  }

  private pushSnapshot(key: string, snapshot: Snapshot): void {
    const list = this.snapshots(key);
    list.push(snapshot);
    if (list.length > MAX_SNAPSHOTS) list.splice(0, list.length - MAX_SNAPSHOTS);
    this.writeSnapshots(key, list);
  }

  private writeSnapshots(key: string, list: Snapshot[]): void {
    mkdirSync(join(this.root, 'history'), { recursive: true });
    writeFileSync(this.historyPath(key), JSON.stringify(list), 'utf8');
  }

  /** 撤销最近 steps 次改动，返回被撤销的改动标签（新→旧） */
  public undo(key: string, steps: number): string[] {
    const list = this.snapshots(key);
    const n = Math.min(Math.max(1, Math.trunc(steps)), list.length);
    if (n === 0) throw new Error('没有可以撤销的改动');
    const undone = list.splice(list.length - n, n);
    const restored = parseCampaign(undone[0]!.state);
    if (restored === undefined) throw new Error('快照格式不认识，没法撤销');
    restored.active = true;
    this.save(restored);
    this.writeSnapshots(key, list);
    return undone.reverse().map((s) => s.label);
  }
}
