/**
 * 模组：章节 → 场景 → 房间，加上 NPC、线索、任务和剧情 flag。
 *
 * 模组是只读内容，从 JSON 加载后不改；跑团中变化的东西都在 Campaign 里。
 * 剧情状态只有一种原语：flag。触发器、任务、出口门槛、描述变体都读写 flag。
 * 触发器的「什么时候」用自然语言交给模型判断，「改了什么」是结构化的，由 dnd_story 校验 id。
 *
 * 房间 id 在整本模组里唯一，所以 Character.room / revealed / spawned 不用带场景前缀。
 * 旧的单地城（Dungeon）用 adventureFromDungeon 包成只有一个场景的模组。
 *
 * 加载位置：`<dnd 根目录>/adventures/<id>.json`，或 `adventures/<id>/adventure.json`
 * 加 `adventures/<id>/sites/*.json`（大模组按场景拆文件）。商业模组的文本只放本地，不要提交。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { Logger } from '../types.ts';
import { type Dungeon, type DungeonMonster, type DungeonRoom, DungeonLibrary, type RoomGraph, validateRooms } from './dungeon.ts';
import { BUILTIN_DUNGEONS } from './dungeons/index.ts';

// ── 条件 ──

export type Attitude = 'friendly' | 'indifferent' | 'hostile';
export type QuestStatus = 'offered' | 'active' | 'completed' | 'rewarded' | 'failed';

export const ATTITUDES: readonly Attitude[] = ['friendly', 'indifferent', 'hostile'];
export const QUEST_STATUSES: readonly QuestStatus[] = ['offered', 'active', 'completed', 'rewarded', 'failed'];

/** 字符串是 flag id 的简写 */
export type Condition =
  | string
  | { flag: string }
  /** 房间或场景 id：去过就算 */
  | { visited: string }
  | { quest: string; status: QuestStatus | QuestStatus[] }
  | { npc: string; alive?: boolean; attitude?: Attitude; met?: boolean }
  /** 玩家知道这条线索 */
  | { lead: string }
  /** 全队 PC 最低等级 ≥ n */
  | { level: number }
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition };

// ── 房间里的剧情 ──

/** 模组里的 Developments：条件触发的状态变化 */
export interface Trigger {
  id: string;
  /** 自然语言的触发条件，模型判断，如「队伍在门厅大声喧哗」 */
  when: string;
  /** 满足时才能触发 */
  requires?: Condition;
  /** 发生了什么（DM 视角，模型据此叙述） */
  then: string;
  set?: string[];
  clear?: string[];
  leads?: string[];
  /** 追加的怪物（援兵、挣脱锁链的狼），刷在触发器所在房间 */
  spawn?: DungeonMonster[];
  /** 默认只触发一次；false = 可以重复 */
  once?: boolean;
}

/** 条件满足时换一套描述（后面的变体优先） */
export interface Variant {
  when: Condition;
  playerView?: string;
  dmNotes?: string;
}

/** 一条能被揭示的信息，挂在 NPC 或知识块上 */
export interface Fact {
  id: string;
  /** 玩家得知的内容（转述，可以说出口） */
  text: string;
  /** ask 直接问；persuade/intimidate/insight 要检定；captured/charmed 要求对方处在那个状态；rumor 酒馆传闻 */
  via: 'ask' | 'persuade' | 'intimidate' | 'insight' | 'captured' | 'charmed' | 'rumor';
  /** 有 DC 的要先 dnd_check 成功，再 dnd_story fact passed=true */
  dc?: number;
  requires?: Condition;
  leads?: string[];
  set?: string[];
}

/** 无名群体掌握的信息，如「任意一只被俘的地精」 */
export interface KnowledgeBlock {
  holder: string;
  facts: Fact[];
}

// ── 模组 ──

export interface FlagDef {
  id: string;
  /** 摘要里展示给 DM 的说明；不写就是内部 flag，不进摘要 */
  label?: string;
}

export interface Chapter {
  id: string;
  name: string;
  mode: 'linear' | 'hub' | 'sandbox' | 'dungeon';
  /** 一句话章节目标，进摘要 */
  goal: string;
  /** 本章跑团要点（DM 视角）；只注入当前章，不注入整本书 */
  dmGuide: string;
  /** 满足时摘要提示可以进入 next */
  exitWhen?: Condition;
  next?: string;
}

/**
 * 场景。dungeon（默认）：有坐标的房间图，只能走相邻房间。
 * hub：城镇，地点之间随便走（不用写 exits，坐标可省，加载时自动排版），
 * 地点可以用 knownWhen 藏起来，从任何地点都能出发去别的场景。
 */
export interface Site {
  id: string;
  name: string;
  kind?: 'dungeon' | 'hub';
  chapter?: string;
  /** DM 视角的一两句概述 */
  summary?: string;
  /** 首次抵达时念给玩家的话 */
  arrival?: string;
  /** 全场景通用规则：光照、声音、地形、掩护（General Features） */
  features?: string;
  /** 满足后玩家才知道这个场景；不写 = 一开始就知道 */
  knownWhen?: Condition;
  knowledge?: KnowledgeBlock[];
  /** 从别的场景过来时进入的房间 */
  entry: string;
  rooms: DungeonRoom[];
}

export interface Npc {
  id: string;
  name: string;
  aliases?: string[];
  /** DM 一句话：是谁、和主线什么关系 */
  role: string;
  /** 玩家看得到的：外貌、神态 */
  look: string;
  /** 扮演提示：说话方式、口头禅 */
  voice?: string;
  motive: string;
  faction?: string;
  home: { room: string };
  attitude: Attitude;
  /** 战斗数据：SRD index 或完整怪物数据；不写 = 平民 */
  stat?: { srd: string } | DungeonMonster;
  knows: Fact[];
  /** 这个 NPC 发布的任务 */
  offers?: string[];
  /** 能加入队伍（护送、同行） */
  canJoin?: boolean;
}

/** 线索图的一条边：玩家知道之后，某个场景 / NPC / 任务变成「已知」 */
export interface Lead {
  id: string;
  /** 玩家视角的一句话 */
  text: string;
  points: { site?: string; room?: string; npc?: string; quest?: string };
  /** 满足后这条线索算解决了，不再进摘要 */
  resolvedWhen?: Condition;
}

export interface QuestReward {
  gp?: number;
  items?: string[];
  set?: string[];
  text?: string;
  /** 要回去找发布人才拿得到 */
  atGiver?: boolean;
}

export interface Quest {
  id: string;
  name: string;
  giver?: string;
  /** 玩家视角的任务说明 */
  brief: string;
  dmNotes?: string;
  target: { site?: string; room?: string };
  /** 满足后自动变成 completed（奖励还没发） */
  completeWhen: Condition;
  failWhen?: Condition;
  reward: QuestReward;
}

/** 场景之间的路：有 routes 时跨场景移动必须沿着路走 */
export interface Route {
  from: string;
  to: string;
  days?: number;
  note?: string;
}

export interface Milestone {
  when: Condition;
  level: number;
  text?: string;
}

export interface Adventure {
  id: string;
  name: string;
  credits?: string;
  levels?: { start: number; end: number };
  /** 整本模组的 DM 机密：反派、计划、东西真正在哪；每条一句 */
  truth: string[];
  /** 开团念给玩家的开场 */
  hook: string;
  /** 开局所在的房间 id */
  start: string;
  chapters: Chapter[];
  sites: Site[];
  npcs: Npc[];
  leads: Lead[];
  quests: Quest[];
  /** flag 要先声明，校验和工具都会拒绝没声明的 */
  flags: FlagDef[];
  routes?: Route[];
  milestones?: Milestone[];
}

// ── 索引 ──

interface AdventureIndex {
  graph: RoomGraph;
  siteOf: Map<string, Site>;
}

const indexes = new WeakMap<Adventure, AdventureIndex>();

function indexOf(adv: Adventure): AdventureIndex {
  let index = indexes.get(adv);
  if (index === undefined) {
    const siteOf = new Map<string, Site>();
    for (const site of adv.sites) for (const room of site.rooms) siteOf.set(room.id, site);
    index = { graph: { rooms: adv.sites.flatMap((s) => s.rooms) }, siteOf };
    indexes.set(adv, index);
  }
  return index;
}

/** 整本模组的全部房间，传给 findRoom / exitsOf 这类函数 */
export function roomGraph(adv: Adventure): RoomGraph {
  return indexOf(adv).graph;
}

export function siteOfRoom(adv: Adventure, roomId: string): Site | undefined {
  return indexOf(adv).siteOf.get(roomId);
}

export function findSite(adv: Adventure, siteId: string): Site | undefined {
  return adv.sites.find((s) => s.id === siteId);
}

export function findNpc(adv: Adventure, query: string): Npc | undefined {
  const q = query.trim();
  return adv.npcs.find((n) => n.id === q) ?? adv.npcs.find((n) => n.name === q || n.aliases?.includes(q) === true);
}

export function findQuest(adv: Adventure, query: string): Quest | undefined {
  const q = query.trim();
  return adv.quests.find((x) => x.id === q) ?? adv.quests.find((x) => x.name === q);
}

export function findLead(adv: Adventure, id: string): Lead | undefined {
  return adv.leads.find((l) => l.id === id.trim());
}

export function isHub(site: Site | undefined): boolean {
  return site?.kind === 'hub';
}

const HUB_COLUMNS = 4;

/** 城镇地点没写坐标的按网格排开（地图用），没写 exits 的补空数组 */
function layoutHub(site: Site): void {
  site.rooms.forEach((room, i) => {
    const r = room as Partial<DungeonRoom>;
    if (typeof r.x !== 'number' || typeof r.y !== 'number') {
      r.x = (i % HUB_COLUMNS) * 5;
      r.y = Math.floor(i / HUB_COLUMNS) * 4;
    }
    r.w ??= 4;
    r.h ??= 3;
    r.exits ??= [];
    r.dmNotes ??= '';
  });
}

/** 所有触发器（连同它所在的房间） */
export function allTriggers(adv: Adventure): Array<{ trigger: Trigger; room: DungeonRoom }> {
  return adv.sites.flatMap((s) => s.rooms.flatMap((room) => (room.triggers ?? []).map((trigger) => ({ trigger, room }))));
}

/** 所有可揭示的信息，连同持有者的说明 */
export function allFacts(adv: Adventure): Array<{ fact: Fact; holder: string; npc?: Npc }> {
  const result: Array<{ fact: Fact; holder: string; npc?: Npc }> = [];
  for (const npc of adv.npcs) for (const fact of npc.knows) result.push({ fact, holder: npc.name, npc });
  for (const site of adv.sites) {
    for (const block of site.knowledge ?? []) for (const fact of block.facts) result.push({ fact, holder: block.holder });
    for (const room of site.rooms) {
      for (const block of room.knowledge ?? []) for (const fact of block.facts) result.push({ fact, holder: block.holder });
    }
  }
  return result;
}

// ── 校验 ──

const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

function walkCondition(cond: Condition, visit: (atom: Exclude<Condition, { all: unknown } | { any: unknown } | { not: unknown }>) => void): void {
  if (typeof cond === 'object' && cond !== null) {
    if ('all' in cond) return cond.all.forEach((c) => walkCondition(c, visit));
    if ('any' in cond) return cond.any.forEach((c) => walkCondition(c, visit));
    if ('not' in cond) return walkCondition(cond.not, visit);
  }
  visit(cond as Exclude<Condition, { all: unknown } | { any: unknown } | { not: unknown }>);
}

/** 校验模组结构和所有引用；不合法时抛出带原因的错误 */
export function validateAdventure(input: unknown): Adventure {
  const raw = input as Partial<Adventure>;
  if (typeof raw !== 'object' || raw === null) throw new Error('模组必须是对象');
  if (typeof raw.id !== 'string' || !ID_RE.test(raw.id)) throw new Error('模组 id 只能用小写字母、数字和短横线');
  if (typeof raw.name !== 'string') throw new Error(`模组 ${raw.id} 缺少 name`);
  if (!Array.isArray(raw.sites) || raw.sites.length === 0) throw new Error(`模组 ${raw.id} 缺少 sites`);
  const adv: Adventure = {
    truth: [],
    hook: '',
    chapters: [],
    npcs: [],
    leads: [],
    quests: [],
    flags: [],
    ...raw,
  } as Adventure;
  const where = `模组 ${adv.id}`;

  const unique = (kind: string, ids: string[]): Set<string> => {
    const set = new Set<string>();
    for (const id of ids) {
      if (typeof id !== 'string' || id.length === 0 || set.has(id)) throw new Error(`${where}：${kind} id 缺失或重复: ${id}`);
      set.add(id);
    }
    return set;
  };

  const roomIds = new Set<string>();
  const siteIds = unique('场景', adv.sites.map((s) => s.id));
  for (const site of adv.sites) {
    if (typeof site.name !== 'string' || !Array.isArray(site.rooms) || site.rooms.length === 0) throw new Error(`场景 ${site.id} 缺少 name 或 rooms`);
    if (site.kind !== undefined && site.kind !== 'dungeon' && site.kind !== 'hub') throw new Error(`场景 ${site.id} 的 kind 只能是 dungeon 或 hub`);
    if (isHub(site)) layoutHub(site);
    validateRooms(`场景 ${site.id}`, site.rooms, roomIds);
    if (!site.rooms.some((r) => r.id === site.entry)) throw new Error(`场景 ${site.id} 的 entry 不是本场景的房间`);
  }
  if (!roomIds.has(adv.start)) throw new Error(`${where}：start 不是有效房间`);

  const chapterIds = unique('章节', adv.chapters.map((c) => c.id));
  const npcIds = unique('NPC', adv.npcs.map((n) => n.id));
  const leadIds = unique('线索', adv.leads.map((l) => l.id));
  const questIds = unique('任务', adv.quests.map((q) => q.id));
  const flagIds = unique('flag', adv.flags.map((f) => f.id));
  unique('触发器', allTriggers(adv).map((t) => t.trigger.id));
  unique('信息', allFacts(adv).map((f) => f.fact.id));

  const need = (ok: boolean, message: string): void => {
    if (!ok) throw new Error(`${where}：${message}`);
  };
  const checkCondition = (cond: Condition | undefined, owner: string): void => {
    if (cond === undefined) return;
    walkCondition(cond, (atom) => {
      if (typeof atom === 'string') return need(flagIds.has(atom), `${owner} 的条件用了没声明的 flag「${atom}」`);
      if ('flag' in atom) return need(flagIds.has(atom.flag), `${owner} 的条件用了没声明的 flag「${atom.flag}」`);
      if ('visited' in atom) return need(roomIds.has(atom.visited) || siteIds.has(atom.visited), `${owner} 的条件指向不存在的房间/场景 ${atom.visited}`);
      if ('quest' in atom) return need(questIds.has(atom.quest), `${owner} 的条件指向不存在的任务 ${atom.quest}`);
      if ('npc' in atom) return need(npcIds.has(atom.npc), `${owner} 的条件指向不存在的 NPC ${atom.npc}`);
      if ('lead' in atom) return need(leadIds.has(atom.lead), `${owner} 的条件指向不存在的线索 ${atom.lead}`);
      if ('level' in atom) return need(typeof atom.level === 'number', `${owner} 的 level 条件要是数字`);
      need(false, `${owner} 的条件格式不对: ${JSON.stringify(atom)}`);
    });
  };
  const checkFlags = (ids: string[] | undefined, owner: string): void => {
    for (const id of ids ?? []) need(flagIds.has(id), `${owner} 设置了没声明的 flag「${id}」`);
  };
  const checkLeads = (ids: string[] | undefined, owner: string): void => {
    for (const id of ids ?? []) need(leadIds.has(id), `${owner} 指向不存在的线索 ${id}`);
  };

  for (const chapter of adv.chapters) {
    need(chapter.next === undefined || chapterIds.has(chapter.next), `章节 ${chapter.id} 的 next 不存在`);
    checkCondition(chapter.exitWhen, `章节 ${chapter.id}`);
  }
  for (const site of adv.sites) {
    need(site.chapter === undefined || chapterIds.has(site.chapter), `场景 ${site.id} 的 chapter 不存在`);
    checkCondition(site.knownWhen, `场景 ${site.id}`);
    for (const room of site.rooms) {
      need(room.knownWhen === undefined || isHub(site), `房间 ${room.id} 的 knownWhen 只用于城镇（hub）地点；地城里藏房间用暗门`);
      need(room.knownWhen === undefined || room.id !== site.entry, `场景 ${site.id} 的入口不能藏起来（knownWhen）`);
      checkCondition(room.knownWhen, `地点 ${room.id}`);
      for (const exit of room.exits) checkCondition(exit.requires, `${room.id} → ${exit.to} 的出口`);
      for (const variant of room.variants ?? []) checkCondition(variant.when, `房间 ${room.id} 的描述变体`);
      for (const id of room.npcs ?? []) need(npcIds.has(id), `房间 ${room.id} 列了不存在的 NPC ${id}`);
      for (const t of room.triggers ?? []) {
        checkCondition(t.requires, `触发器 ${t.id}`);
        checkFlags(t.set, `触发器 ${t.id}`);
        checkFlags(t.clear, `触发器 ${t.id}`);
        checkLeads(t.leads, `触发器 ${t.id}`);
      }
    }
  }
  for (const { fact } of allFacts(adv)) {
    checkCondition(fact.requires, `信息 ${fact.id}`);
    checkFlags(fact.set, `信息 ${fact.id}`);
    checkLeads(fact.leads, `信息 ${fact.id}`);
  }
  for (const npc of adv.npcs) {
    need(roomIds.has(npc.home?.room), `NPC ${npc.id} 的 home.room 不存在`);
    need(Array.isArray(npc.knows), `NPC ${npc.id} 缺少 knows`);
    for (const id of npc.offers ?? []) need(questIds.has(id), `NPC ${npc.id} 发布了不存在的任务 ${id}`);
  }
  for (const lead of adv.leads) {
    const p = lead.points ?? {};
    need(p.site === undefined || siteIds.has(p.site), `线索 ${lead.id} 指向不存在的场景 ${p.site}`);
    need(p.room === undefined || roomIds.has(p.room), `线索 ${lead.id} 指向不存在的房间 ${p.room}`);
    need(p.npc === undefined || npcIds.has(p.npc), `线索 ${lead.id} 指向不存在的 NPC ${p.npc}`);
    need(p.quest === undefined || questIds.has(p.quest), `线索 ${lead.id} 指向不存在的任务 ${p.quest}`);
    checkCondition(lead.resolvedWhen, `线索 ${lead.id}`);
  }
  for (const quest of adv.quests) {
    need(quest.giver === undefined || npcIds.has(quest.giver), `任务 ${quest.id} 的发布人不存在`);
    need(quest.target?.site === undefined || siteIds.has(quest.target.site), `任务 ${quest.id} 的目标场景不存在`);
    need(quest.target?.room === undefined || roomIds.has(quest.target.room), `任务 ${quest.id} 的目标房间不存在`);
    need(quest.completeWhen !== undefined, `任务 ${quest.id} 缺少 completeWhen`);
    checkCondition(quest.completeWhen, `任务 ${quest.id}`);
    checkCondition(quest.failWhen, `任务 ${quest.id}`);
    checkFlags(quest.reward?.set, `任务 ${quest.id} 的奖励`);
  }
  for (const route of adv.routes ?? []) {
    need(siteIds.has(route.from) && siteIds.has(route.to), `路线 ${route.from} → ${route.to} 指向不存在的场景`);
  }
  for (const m of adv.milestones ?? []) checkCondition(m.when, `${m.level} 级里程碑`);
  return adv;
}

/**
 * 不致命但多半写漏了的地方：没人设置的 flag、发布人没列出的任务、线索太少的场景。
 * 加载时打警告，不拒绝模组。
 */
export function adventureWarnings(adv: Adventure): string[] {
  const warnings: string[] = [];
  const produced = new Set<string>();
  for (const { trigger } of allTriggers(adv)) for (const f of trigger.set ?? []) produced.add(f);
  for (const { fact } of allFacts(adv)) for (const f of fact.set ?? []) produced.add(f);
  for (const q of adv.quests) for (const f of q.reward.set ?? []) produced.add(f);
  const used = new Set<string>();
  const collect = (cond: Condition | undefined): void => {
    if (cond === undefined) return;
    walkCondition(cond, (atom) => {
      if (typeof atom === 'string') used.add(atom);
      else if ('flag' in atom) used.add(atom.flag);
    });
  };
  for (const site of adv.sites) {
    collect(site.knownWhen);
    for (const room of site.rooms) {
      collect(room.knownWhen);
      room.exits.forEach((e) => collect(e.requires));
      room.variants?.forEach((v) => collect(v.when));
      room.triggers?.forEach((t) => collect(t.requires));
    }
  }
  adv.chapters.forEach((c) => collect(c.exitWhen));
  adv.quests.forEach((q) => { collect(q.completeWhen); collect(q.failWhen); });
  adv.leads.forEach((l) => collect(l.resolvedWhen));
  adv.milestones?.forEach((m) => collect(m.when));
  allFacts(adv).forEach(({ fact }) => collect(fact.requires));
  for (const flag of used) {
    if (!produced.has(flag)) warnings.push(`flag「${flag}」被条件用到，但没有触发器/信息/任务奖励会设置它（只能靠 dnd_story flag 手动设）`);
  }

  for (const quest of adv.quests) {
    const giver = quest.giver === undefined ? undefined : adv.npcs.find((n) => n.id === quest.giver);
    if (giver !== undefined && giver.offers?.includes(quest.id) !== true) warnings.push(`任务 ${quest.id} 的发布人 ${giver.id} 的 offers 里没有它`);
  }

  // 关键场景至少要有两条线索指过去（三线索原则的宽松版）
  const startSite = siteOfRoom(adv, adv.start)?.id;
  for (const site of adv.sites) {
    if (site.id === startSite || site.knownWhen === undefined) continue;
    const incoming = adv.leads.filter((l) => l.points.site === site.id || (l.points.room !== undefined && siteOfRoom(adv, l.points.room)?.id === site.id));
    if (incoming.length < 2) warnings.push(`场景 ${site.id} 只有 ${incoming.length} 条线索指向它，玩家可能找不到`);
  }
  return warnings;
}

/** 旧的单地城 → 只有一个场景、一个章节的模组 */
export function adventureFromDungeon(d: Dungeon): Adventure {
  return {
    id: d.id,
    name: d.name,
    ...(d.credits !== undefined ? { credits: d.credits } : {}),
    truth: d.intro.split('\n').map((l) => l.trim()).filter(Boolean),
    hook: d.hook,
    start: d.start,
    chapters: [{ id: 'main', name: d.name, mode: 'dungeon', goal: '', dmGuide: '' }],
    sites: [{ id: d.id, name: d.name, chapter: 'main', entry: d.start, rooms: d.rooms }],
    npcs: [],
    leads: [],
    quests: [],
    flags: [],
  };
}

// ── 加载 ──

const builtinAdventures = new WeakMap<Dungeon, Adventure>();

function wrapBuiltin(d: Dungeon): Adventure {
  let adv = builtinAdventures.get(d);
  if (adv === undefined) {
    adv = adventureFromDungeon(d);
    builtinAdventures.set(d, adv);
  }
  return adv;
}

/** 内置地城 + dungeons/ 里的单地城 + adventures/ 里的模组（同 id 时后者覆盖前者） */
export class AdventureLibrary {
  private readonly dungeons: DungeonLibrary;
  private readonly adventuresDir: string | undefined;
  private readonly logger: Logger | undefined;
  /** 按文件修改时间缓存，避免每回合都重新解析大模组 */
  private readonly cache = new Map<string, { mtime: number; adventure: Adventure }>();

  public constructor(dirs: { dungeons?: string; adventures?: string } = {}, logger?: Logger) {
    this.dungeons = new DungeonLibrary(dirs.dungeons, logger);
    this.adventuresDir = dirs.adventures;
    this.logger = logger;
  }

  public list(): Adventure[] {
    const byId = new Map<string, Adventure>();
    for (const d of BUILTIN_DUNGEONS) byId.set(d.id, wrapBuiltin(d));
    for (const d of this.dungeons.list()) {
      if (!BUILTIN_DUNGEONS.includes(d)) byId.set(d.id, adventureFromDungeon(d));
    }
    for (const a of this.loadAdventures()) byId.set(a.id, a);
    return [...byId.values()];
  }

  public get(id: string): Adventure | undefined {
    return this.list().find((a) => a.id === id);
  }

  private loadAdventures(): Adventure[] {
    const dir = this.adventuresDir;
    if (dir === undefined || !existsSync(dir)) return [];
    const result: Adventure[] = [];
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      try {
        const loaded = this.loadOne(path, name);
        if (loaded !== undefined) result.push(loaded);
      } catch (err) {
        this.logger?.warn(`im-qqbot: 模组 ${name} 加载失败: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return result;
  }

  private loadOne(path: string, name: string): Adventure | undefined {
    const isDir = statSync(path).isDirectory();
    if (!isDir && extname(name).toLowerCase() !== '.json') return undefined;
    const main = isDir ? join(path, 'adventure.json') : path;
    if (!existsSync(main)) return undefined;
    const siteDir = join(path, 'sites');
    const siteFiles = isDir && existsSync(siteDir)
      ? readdirSync(siteDir).filter((f) => extname(f).toLowerCase() === '.json').sort().map((f) => join(siteDir, f))
      : [];
    const mtime = Math.max(...[main, ...siteFiles].map((f) => statSync(f).mtimeMs));
    const cached = this.cache.get(path);
    if (cached !== undefined && cached.mtime === mtime) return cached.adventure;

    const data = JSON.parse(readFileSync(main, 'utf8')) as Partial<Adventure>;
    const sites = [...(data.sites ?? []), ...siteFiles.map((f) => JSON.parse(readFileSync(f, 'utf8')) as Site)];
    const adventure = validateAdventure({ ...data, sites });
    for (const w of adventureWarnings(adventure)) this.logger?.warn(`im-qqbot: 模组 ${adventure.id}: ${w}`);
    this.cache.set(path, { mtime, adventure });
    return adventure;
  }
}
