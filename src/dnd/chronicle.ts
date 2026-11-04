/**
 * 剧情账本：团档里只增不滚动的记录，DM 记忆的长期来源。
 *
 * 压缩摘要只有几千字，模板还是给写代码用的，剧情留不住；日志只滚动 30 条，进度也只有一条。
 * 所以地点、击败、任务、线索、物品这些由工具自动记（比较每次改动的前后状态，不靠模型想起来），
 * 临场编的人和事、承诺、俘虏由模型用 dnd_chronicle add 记。全文不进上下文，要用时搜；
 * 只有未了结的和最近几条随背景进 system prompt，压缩后也能接上。
 */
import { allFacts, findLead, findNpc, findQuest, type Adventure, roomGraph } from './adventure.ts';
import type { Campaign, Character } from './campaign.ts';
import { findRoom } from './dungeon.ts';
import { ATTITUDE_NAMES, STATUS_NAMES } from './story.ts';

export const CHRONICLE_KINDS = ['event', 'npc', 'promise', 'captive', 'thread', 'backstory', 'ruling'] as const;
export type ChronicleKind = (typeof CHRONICLE_KINDS)[number];

const KIND_NAMES: Record<ChronicleKind, string> = {
  event: '事件', npc: 'NPC', promise: '承诺', captive: '俘虏', thread: '线头', backstory: '背景', ruling: '约定',
};

/** 这几类天生要等一个结果，默认算未了结 */
const OPEN_BY_DEFAULT: ReadonlySet<ChronicleKind> = new Set<ChronicleKind>(['promise', 'captive', 'thread']);

export interface ChronicleEntry {
  id: number;
  at: number;
  kind: ChronicleKind;
  text: string;
  /** 未了结：承诺、俘虏、线头，close 之后去掉 */
  open?: boolean;
}

/** 防止存档无限长；满了先丢最老的已了结条目 */
const MAX_ENTRIES = 1000;
const MAX_TEXT = 400;
const SEARCH_LIMIT = 15;

function entriesOf(c: Campaign): ChronicleEntry[] {
  c.chronicle ??= [];
  return c.chronicle;
}

export function addEntry(c: Campaign, input: { kind?: ChronicleKind; text: string; open?: boolean; repeatable?: boolean }, now = Date.now()): ChronicleEntry {
  const text = input.text.trim().slice(0, MAX_TEXT);
  if (text.length === 0) throw new Error('账本内容不能为空');
  const entries = entriesOf(c);
  // 模型重试时不重复写；自动记录是真的又发生了一次（又拿到一瓶药水），要留着
  const same = input.repeatable === true ? undefined : entries.find((e) => e.text === text);
  if (same !== undefined) return same;
  const kind = input.kind ?? 'event';
  const entry: ChronicleEntry = { id: (entries.at(-1)?.id ?? 0) + 1, at: now, kind, text };
  if (input.open ?? OPEN_BY_DEFAULT.has(kind)) entry.open = true;
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) {
    const oldest = entries.findIndex((e) => e.open !== true);
    entries.splice(oldest === -1 ? 0 : oldest, 1);
  }
  return entry;
}

/** 了结一条：去掉未了结标记，可以补一句结果 */
export function closeEntry(c: Campaign, id: number, outcome?: string): ChronicleEntry {
  const entry = entriesOf(c).find((e) => e.id === id);
  if (entry === undefined) throw new Error(`账本里没有 #${id}`);
  delete entry.open;
  const note = outcome?.trim();
  if (note) entry.text = `${entry.text} → ${note}`.slice(0, MAX_TEXT);
  return entry;
}

export function formatEntry(e: ChronicleEntry): string {
  const d = new Date(e.at);
  const date = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return `#${e.id} ${date} [${KIND_NAMES[e.kind]}${e.open === true ? '·未了结' : ''}] ${e.text}`;
}

/** 按关键词搜：命中词多的在前，一样多时新的在前。空格分隔多个词，命中任意一个就算 */
export function searchEntries(c: Campaign, query: string, limit = SEARCH_LIMIT): ChronicleEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  return (c.chronicle ?? [])
    .map((entry) => ({ entry, score: words.filter((w) => entry.text.toLowerCase().includes(w)).length }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || b.entry.id - a.entry.id)
    .slice(0, limit)
    .map((r) => r.entry);
}

export function openEntries(c: Campaign): ChronicleEntry[] {
  return (c.chronicle ?? []).filter((e) => e.open === true);
}

export function recentEntries(c: Campaign, limit: number): ChronicleEntry[] {
  return (c.chronicle ?? []).slice(-limit);
}

/** 从末尾往前取，取到字数上限为止：最新的最要紧 */
function fit(entries: readonly ChronicleEntry[], maxChars: number): { lines: string[]; dropped: number } {
  const lines: string[] = [];
  let used = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const line = formatEntry(entries[i]!);
    if (used + line.length > maxChars) return { lines: lines.reverse(), dropped: i + 1 };
    lines.push(line);
    used += line.length;
  }
  return { lines: lines.reverse(), dropped: 0 };
}

const PROMPT_OPEN_CHARS = 1000;
const PROMPT_RECENT_CHARS = 600;
const PROMPT_RECENT_COUNT = 10;

/** 随背景进 system prompt 的部分：未了结的，加最近几条 */
export function chronicleLines(c: Campaign): string[] {
  const open = fit(openEntries(c), PROMPT_OPEN_CHARS);
  const recent = fit(recentEntries(c, PROMPT_RECENT_COUNT).filter((e) => e.open !== true), PROMPT_RECENT_CHARS);
  return [
    ...(open.lines.length > 0 ? [`账本·未了结：\n${open.lines.join('\n')}${open.dropped > 0 ? `\n（还有 ${open.dropped} 条，dnd_chronicle list 看）` : ''}`] : []),
    ...(recent.lines.length > 0 ? [`账本·最近：\n${recent.lines.join('\n')}`] : []),
  ];
}

// ── 自动记录：比较一次改动前后的状态 ──

export interface ChronicleMark {
  revealed: string[];
  quests: Campaign['quests'];
  leads: string[];
  facts: string[];
  flags: string[];
  chapter: string;
  attitudes: Record<string, string | undefined>;
  dead: string[];
  /** PC 的物品；只比较改动前就有的 PC，建卡时的初始装备不算剧情 */
  items: Record<string, string[]>;
}

function isDead(ch: Character): boolean {
  return ch.conditions.includes('死亡');
}

export function markChronicle(c: Campaign): ChronicleMark {
  return {
    revealed: [...c.revealed],
    quests: { ...c.quests },
    leads: [...c.leads],
    facts: [...c.facts],
    flags: [...c.flags],
    chapter: c.chapter,
    attitudes: Object.fromEntries(Object.entries(c.npcs).map(([id, n]) => [id, n.attitude])),
    dead: c.characters.filter(isDead).map((ch) => ch.name),
    items: Object.fromEntries(c.characters.filter((ch) => ch.kind === 'pc').map((ch) => [ch.name, [...(ch.inventory ?? [])]])),
  };
}

function short(text: string, max = 200): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function roomLine(adv: Adventure, id: string): string {
  const room = findRoom(roomGraph(adv), id);
  return `到达「${room?.name ?? id}」`;
}

/** 这次改动带来的剧情变化，一条一行；没有变化返回空数组 */
export function chronicleChanges(before: ChronicleMark, c: Campaign, adv: Adventure): string[] {
  const lines: string[] = [];
  const added = (now: readonly string[], old: readonly string[]) => now.filter((x) => !old.includes(x));

  for (const id of added(c.revealed, before.revealed)) lines.push(roomLine(adv, id));
  if (c.chapter !== before.chapter) lines.push(`进入章节「${adv.chapters.find((ch) => ch.id === c.chapter)?.name ?? c.chapter}」`);
  for (const [id, status] of Object.entries(c.quests)) {
    if (before.quests[id] !== status) lines.push(`任务「${findQuest(adv, id)?.name ?? id}」：${STATUS_NAMES[status]}`);
  }
  for (const id of added(c.leads, before.leads)) lines.push(`得知线索：${short(findLead(adv, id)?.text ?? id)}`);
  if (added(c.facts, before.facts).length > 0) {
    const facts = allFacts(adv);
    for (const id of added(c.facts, before.facts)) {
      const found = facts.find((f) => f.fact.id === id);
      lines.push(`${found?.npc?.name ?? found?.holder ?? '有人'}透露：${short(found?.fact.text ?? id)}`);
    }
  }
  for (const id of added(c.flags, before.flags)) {
    const label = adv.flags.find((f) => f.id === id)?.label;
    if (label !== undefined) lines.push(`剧情进展：${label}`);
  }
  for (const [id, state] of Object.entries(c.npcs)) {
    if (state.attitude !== undefined && state.attitude !== before.attitudes[id]) {
      lines.push(`${findNpc(adv, id)?.name ?? id} 的态度变为${ATTITUDE_NAMES[state.attitude]}`);
    }
  }
  const died = c.characters.filter((ch) => isDead(ch) && !before.dead.includes(ch.name));
  const foes = died.filter((ch) => ch.kind === 'monster').map((ch) => ch.name);
  if (foes.length > 0) lines.push(`击败：${foes.join('、')}`);
  for (const ch of died.filter((x) => x.kind !== 'monster')) lines.push(`${ch.name} 死亡`);
  for (const ch of c.characters) {
    const old = before.items[ch.name];
    if (old === undefined || ch.kind !== 'pc') continue;
    const now = ch.inventory ?? [];
    const gained = added(now, old);
    const lost = added(old, now);
    if (gained.length > 0) lines.push(`${ch.name} 得到：${gained.join('、')}`);
    if (lost.length > 0) lines.push(`${ch.name} 失去：${lost.join('、')}`);
  }
  return lines;
}

/** 把这次改动的变化写进账本 */
export function recordChanges(before: ChronicleMark, c: Campaign, adv: Adventure, now = Date.now()): void {
  for (const line of chronicleChanges(before, c, adv)) addEntry(c, { text: line, repeatable: true }, now);
}

/**
 * 账本上线前的老团：先把存档里还留着的事实补记一份，否则「老巢早就清空了」这种事搜不到。
 * 这些事的先后顺序已经不可考，统一标成补记。
 */
export function seedChronicle(c: Campaign, adv: Adventure, now = Date.now()): void {
  if (c.chronicle !== undefined) return;
  c.chronicle = [];
  const blank: ChronicleMark = { revealed: [], quests: {}, leads: [], facts: [], flags: [], chapter: c.chapter, attitudes: {}, dead: [], items: {} };
  for (const line of chronicleChanges(blank, c, adv)) addEntry(c, { text: `（开账前）${line}` }, now);
  // 按行拆开：整条进度塞一个条目会被截断，每个关键词也都只能搜到同一大段
  for (const line of c.summaries.at(-1)?.text.split(/\r?\n/) ?? []) {
    if (line.trim() !== '') addEntry(c, { text: `（开账前的进度）${line.trim()}` }, now);
  }
}
