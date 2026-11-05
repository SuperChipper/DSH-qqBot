/**
 * 战斗内站位：Character.room 只管在哪个房间，同一房间里谁离谁多远以前只活在模型的叙述里，
 * 上下文一压缩就走样，借机、贴身这类裁定跟着判错。这里把坐标存进 InitiativeState，
 * 团况每次都带，距离和借机由代码算，不靠模型回忆。
 *
 * 一格 5 尺，x 向东、y 向南；斜走也算 5 尺（5e 默认规则）。
 * 只提醒不拦截的地方是故意的：冲刺、触及武器、特性都可能让「超速」「够不到」其实合法，那是 DM 的裁量。
 */
import {
  type BattleCell,
  type Campaign,
  type Character,
  type InitiativeState,
  type Weapon,
  findCharacter,
  isOut,
  isRangedWeapon,
  reactionsOf,
  requireCharacter,
  requireInitiative,
  roomOf,
} from './campaign.ts';

export const CELL_FEET = 5;
export const DEFAULT_SPEED = 30;
const MELEE_REACH_FEET = 5;
const MAX_COORD = 99;

/** 这些状态下做不了反应，不会打借机 */
const CANNOT_REACT = ['昏迷', '麻痹', '石化', '失能', '震慑'];

export function distanceFeet(a: Pick<BattleCell, 'x' | 'y'>, b: Pick<BattleCell, 'x' | 'y'>): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) * CELL_FEET;
}

/** 角色当前的格子；换过房间后旧坐标作废（room 对不上就当没摆位，比沿用错坐标安全） */
export function cellOf(c: Campaign, ch: Character): BattleCell | undefined {
  const cell = c.initiative?.positions?.[ch.name];
  return cell !== undefined && cell.room === roomOf(c, ch) ? cell : undefined;
}

function isHostile(a: Character, b: Character): boolean {
  return (a.kind === 'monster') !== (b.kind === 'monster');
}

export function canReact(ch: Character): boolean {
  return !isOut(ch) && ch.hp > 0 && !ch.conditions.some((cond) => CANNOT_REACT.includes(cond));
}

/** 这个房间里已摆位、还活着的人 */
function placedIn(c: Campaign, room: string): Array<{ ch: Character; cell: BattleCell }> {
  return c.characters.flatMap((ch) => {
    const cell = cellOf(c, ch);
    return cell !== undefined && cell.room === room && !isOut(ch) ? [{ ch, cell }] : [];
  });
}

function occupant(c: Campaign, room: string, at: { x: number; y: number }, except: string): Character | undefined {
  return placedIn(c, room).find(({ ch, cell }) => ch.name !== except && cell.x === at.x && cell.y === at.y)?.ch;
}

function requireCoord(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_COORD) {
    throw new Error(`${label} 要是 0-${MAX_COORD} 的整数格子（一格 5 尺），收到 ${String(value)}`);
  }
  return value;
}

export interface Placement {
  name: string;
  x: number;
  y: number;
  /** 不是角色卡上的东西：门、柱子、没建卡的俘虏 */
  mark?: boolean;
}

/** 摆位/修正：不算移动力、不触发借机。开战摆位、强制位移（推、拖）、纠错都走这里 */
export function setPositions(c: Campaign, placements: readonly Placement[]): string[] {
  const state = requireInitiative(c);
  if (placements.length === 0) throw new Error('set 要给 placements');
  const notes: string[] = [];
  for (const p of placements) {
    const x = requireCoord(p.x, `${p.name} 的 x`);
    const y = requireCoord(p.y, `${p.name} 的 y`);
    if (p.mark === true) {
      const room = markRoom(c, state);
      (state.marks ??= {})[p.name] = { x, y, room };
      continue;
    }
    const ch = requireCharacter(c, p.name);
    const room = roomOf(c, ch);
    if (room === undefined) throw new Error(`${ch.name} 没有所在房间，先 dnd_character update room`);
    (state.positions ??= {})[ch.name] = { x, y, room };
  }
  // 全部放好再查重叠：同一次调用里两个人互换位置不算冲突
  for (const p of placements) {
    if (p.mark === true) continue;
    const ch = requireCharacter(c, p.name);
    const other = occupant(c, roomOf(c, ch)!, { x: p.x, y: p.y }, ch.name);
    if (other !== undefined && !notes.some((n) => n.includes(ch.name))) {
      notes.push(`【DM】${ch.name} 和 ${other.name} 在同一格 (${p.x},${p.y})，不是故意的话改一下。`);
    }
  }
  return notes;
}

/** 标记跟着当前行动者的房间走；战斗跨房间时它才是 DM 正在描述的那一间 */
function markRoom(c: Campaign, state: InitiativeState): string {
  const current = state.order[state.turn];
  const ch = current === undefined ? undefined : findCharacter(c, current.name);
  return (ch === undefined ? undefined : roomOf(c, ch)) ?? c.currentRoom;
}

export function removePosition(c: Campaign, name: string): string {
  const state = requireInitiative(c);
  if (state.marks?.[name] !== undefined) {
    delete state.marks[name];
    return `已移除标记 ${name}`;
  }
  const ch = requireCharacter(c, name);
  delete state.positions?.[ch.name];
  return `${ch.name} 已从站位上拿掉`;
}

export interface MoveRequest {
  x?: number;
  y?: number;
  /** 走到这个人身边最近的空格（比让模型算坐标靠谱） */
  adjacentTo?: string;
  /** 反应/他人回合里的移动：不计入本回合移动力 */
  reaction?: boolean;
}

export interface MoveResult {
  name: string;
  from: BattleCell;
  to: BattleCell;
  feet: number;
  /** 本回合累计 */
  totalFeet: number;
  speed: number;
  /** 这一步离开了谁的触及范围 */
  provokes: string[];
  /** 这一步「进入」了谁的长柄触及范围（长柄大师这类反向触发） */
  enters: Array<{ name: string; reach: number; reaction: string }>;
  notes: string[];
}

/** 按直线走过的格子（含起点终点）；要绕路就分几次 move */
function straightPath(from: { x: number; y: number }, to: { x: number; y: number }): Array<{ x: number; y: number }> {
  const steps = Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y));
  if (steps === 0) return [{ x: from.x, y: from.y }];
  return Array.from({ length: steps + 1 }, (_, i) => ({
    x: Math.round(from.x + ((to.x - from.x) * i) / steps),
    y: Math.round(from.y + ((to.y - from.y) * i) / steps),
  }));
}

/** target 身边离 from 最近的空格；已经贴着就原地不动 */
function cellBeside(c: Campaign, ch: Character, from: BattleCell, target: Character): { x: number; y: number } {
  const anchor = cellOf(c, target);
  if (anchor === undefined || anchor.room !== from.room) throw new Error(`${target.name} 不在这个房间的站位上，先 dnd_position set`);
  if (distanceFeet(from, anchor) <= MELEE_REACH_FEET) return { x: from.x, y: from.y };
  const free: Array<{ x: number; y: number; d: number; e: number }> = [];
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const at = { x: anchor.x + dx, y: anchor.y + dy };
      if ((dx === 0 && dy === 0) || at.x < 0 || at.y < 0 || occupant(c, from.room, at, ch.name) !== undefined) continue;
      // 同样格数时优先不绕斜线的那格，结果才稳定
      free.push({ ...at, d: distanceFeet(from, at), e: (at.x - from.x) ** 2 + (at.y - from.y) ** 2 });
    }
  }
  free.sort((a, b) => a.d - b.d || a.e - b.e || a.x - b.x || a.y - b.y);
  const best = free[0];
  if (best === undefined) throw new Error(`${target.name} 周围已经站满了`);
  return { x: best.x, y: best.y };
}

/** 回合内移动：算走了多少尺，报出会触发谁的借机 */
export function moveOnGrid(c: Campaign, name: string, request: MoveRequest): MoveResult {
  const state = requireInitiative(c);
  const ch = requireCharacter(c, name);
  const from = cellOf(c, ch);
  if (from === undefined) throw new Error(`${ch.name} 还没摆位，先 dnd_position set`);
  const dest = request.adjacentTo !== undefined
    ? cellBeside(c, ch, from, requireCharacter(c, request.adjacentTo))
    : { x: requireCoord(request.x, 'x'), y: requireCoord(request.y, 'y') };
  const blocker = occupant(c, from.room, dest, ch.name);
  if (blocker !== undefined) throw new Error(`(${dest.x},${dest.y}) 已经站着 ${blocker.name}，换一格，或用 adjacent_to`);

  const path = straightPath(from, dest);
  const provokes: string[] = [];
  const enters: Array<{ name: string; reach: number; reaction: string }> = [];
  for (const { ch: other, cell } of placedIn(c, from.room)) {
    if (other.name === ch.name || !isHostile(ch, other) || !canReact(other)) continue;
    const leaves = path.some((step, i) => {
      const next = path[i + 1];
      return next !== undefined && distanceFeet(step, cell) <= MELEE_REACH_FEET && distanceFeet(next, cell) > MELEE_REACH_FEET;
    });
    if (leaves) provokes.push(other.name);
    // 长柄大师：拿着长柄武器时，敌人「进入」触及范围也吃借机——方向反着算，一回合至多一次
    for (const r of reactionsOf(other)) {
      if (r.enter !== true) continue;
      const reach = r.range ?? MELEE_REACH_FEET;
      const steppedIn = path.some((step, i) => {
        const next = path[i + 1];
        return next !== undefined && distanceFeet(step, cell) > reach && distanceFeet(next, cell) <= reach;
      });
      if (steppedIn) enters.push({ name: other.name, reach, reaction: r.name });
    }
  }

  const feet = distanceFeet(from, dest);
  const to: BattleCell = { x: dest.x, y: dest.y, room: from.room };
  (state.positions ??= {})[ch.name] = to;
  const moved = state.moved ?? {};
  if (request.reaction !== true) moved[ch.name] = (moved[ch.name] ?? 0) + feet;
  state.moved = moved;

  const notes: string[] = [];
  if (ch.conditions.includes('倒地')) notes.push(`${ch.name} 还倒地：爬行每尺算两尺；站起来花一半速度，再 dnd_apply 解除倒地`);
  const stuck = ch.conditions.filter((cond) => ['擒抱', '束缚', '麻痹', '石化', '昏迷'].includes(cond));
  if (stuck.length > 0) notes.push(`${ch.name} 处于${stuck.join('、')}，速度应为 0`);
  return { name: ch.name, from, to, feet, totalFeet: moved[ch.name] ?? 0, speed: ch.speed ?? DEFAULT_SPEED, provokes, enters, notes };
}

export function moveResultText(r: MoveResult): string {
  const lines = [`${r.name} (${r.from.x},${r.from.y})→(${r.to.x},${r.to.y})，走 ${r.feet} 尺，本回合累计 ${r.totalFeet}/${r.speed} 尺`];
  if (r.totalFeet > r.speed) lines.push(`【DM】超过速度 ${r.speed}：只有冲刺之类才够，不合法就 dnd_undo。`);
  if (r.provokes.length > 0) {
    lines.push(`【DM】离开了 ${r.provokes.join('、')} 的触及范围：他们可以借机（撤离动作除外；一回合一次反应，5 尺以外的长触及这里没算）。`);
  }
  if (r.enters.length > 0) {
    lines.push(`【DM】进入 ${r.enters.map((e) => `${e.name} 的 ${e.reach} 尺触及（${e.reaction}）`).join('、')}：可以借机，用 dnd_check ... reaction=true 结算。`);
  }
  lines.push(...r.notes.map((n) => `【DM】${n}`));
  return lines.join('\n');
}

/** 敌对且贴身的人 */
function adjacentFoes(c: Campaign, ch: Character, cell: BattleCell): string[] {
  return placedIn(c, cell.room)
    .filter(({ ch: other, cell: at }) => other.name !== ch.name && isHostile(ch, other) && distanceFeet(cell, at) <= MELEE_REACH_FEET)
    .map(({ ch: other }) => other.name);
}

/** 先攻表里还没摆位的人（换了房间的也算） */
export function unplaced(c: Campaign): string[] {
  return (c.initiative?.order ?? []).flatMap((e) => {
    const ch = findCharacter(c, e.name);
    return ch !== undefined && !isOut(ch) && cellOf(c, ch) === undefined ? [ch.name] : [];
  });
}

/** 轮到某人时随回合提示给的一句：他在哪、贴着谁、最近的敌人多远，省得模型再算 */
export function turnPositionNote(c: Campaign, name: string): string {
  const missing = unplaced(c);
  const hint = missing.length > 0 ? `【站位】还没摆位：${missing.join('、')}。先 dnd_position set 再裁定距离。` : '';
  const ch = findCharacter(c, name);
  const cell = ch === undefined ? undefined : cellOf(c, ch);
  if (ch === undefined || cell === undefined) return hint;
  const foes = placedIn(c, cell.room).filter(({ ch: other }) => isHostile(ch, other));
  const adjacent = adjacentFoes(c, ch, cell);
  let where = `【站位】${ch.name}(${cell.x},${cell.y})`;
  if (adjacent.length > 0) where += `，贴身：${adjacent.join('、')}`;
  else if (foes.length > 0) {
    const nearest = foes.map((f) => ({ name: f.ch.name, feet: distanceFeet(cell, f.cell) })).sort((a, b) => a.feet - b.feet)[0]!;
    where += `，最近的敌人 ${nearest.name} ${nearest.feet} 尺`;
  }
  return `${where}。${hint}`;
}

/** 团况和 show 用的全场站位，按房间分行：压缩之后靠这几行恢复现场 */
export function battleLines(c: Campaign, roomName: (id: string) => string): string[] {
  const state = c.initiative;
  if (state === undefined) return [];
  const rooms = new Map<string, Array<{ ch: Character; cell: BattleCell }>>();
  for (const entry of c.characters) {
    const cell = cellOf(c, entry);
    if (cell === undefined || isOut(entry)) continue;
    if (!rooms.has(cell.room)) rooms.set(cell.room, []);
    rooms.get(cell.room)!.push({ ch: entry, cell });
  }
  const marks = Object.entries(state.marks ?? {});
  for (const [, cell] of marks) if (!rooms.has(cell.room)) rooms.set(cell.room, []);

  const lines: string[] = [];
  for (const [room, members] of rooms) {
    const seen = new Set<string>();
    const pairs: string[] = [];
    for (const { ch, cell } of members) {
      for (const foe of adjacentFoes(c, ch, cell)) {
        const key = [ch.name, foe].sort().join('|');
        if (!seen.has(key)) {
          seen.add(key);
          pairs.push(`${ch.name}-${foe}`);
        }
      }
    }
    const roomMarks = marks.filter(([, cell]) => cell.room === room).map(([n, cell]) => `${n}(${cell.x},${cell.y})`);
    lines.push(`站位｜${roomName(room)}（格=5尺，x东y南）：${members.map(({ ch, cell }) => `${ch.name}(${cell.x},${cell.y})`).join('、') || '无'}`
      + `${pairs.length > 0 ? `；贴身：${pairs.join('、')}` : ''}`
      + `${roomMarks.length > 0 ? `；标记：${roomMarks.join('、')}` : ''}`);
  }
  const missing = unplaced(c);
  if (missing.length > 0) lines.push(`未摆位：${missing.join('、')}`);
  return lines;
}

/** show from=某人：他到房间里其他人的距离 */
export function distancesFrom(c: Campaign, name: string): string {
  const ch = requireCharacter(c, name);
  const cell = cellOf(c, ch);
  if (cell === undefined) throw new Error(`${ch.name} 还没摆位，先 dnd_position set`);
  const others = placedIn(c, cell.room)
    .filter(({ ch: other }) => other.name !== ch.name)
    .map(({ ch: other, cell: at }) => ({ name: other.name, feet: distanceFeet(cell, at), foe: isHostile(ch, other) }))
    .sort((a, b) => a.feet - b.feet);
  const marks = Object.entries(c.initiative?.marks ?? {})
    .filter(([, at]) => at.room === cell.room)
    .map(([n, at]) => `${n} ${distanceFeet(cell, at)} 尺`);
  const who = others.map((o) => `${o.foe ? '敌 ' : ''}${o.name} ${o.feet} 尺`).join('、') || '房间里没有别人';
  return `${ch.name}(${cell.x},${cell.y}) 到：${who}${marks.length > 0 ? `；标记：${marks.join('、')}` : ''}`;
}

/** 近战判断只看备注里写明的投掷/触及；其余按普通近战武器 */
function weaponReach(weapon: Weapon): number | undefined {
  if (isRangedWeapon(weapon) || /投掷|thrown/i.test(weapon.notes ?? '')) return undefined;
  return /触及|reach/i.test(weapon.notes ?? '') ? 10 : MELEE_REACH_FEET;
}

/**
 * 攻击时对照站位：报距离，距离不合理就提醒。不拦，因为怪物和法术攻击工具分不清近战远程；
 * 判错了 dnd_undo 能退回去。借机本来就发生在对方走之前，reaction 不查够不够得着。
 */
export function attackRangeNote(
  c: Campaign,
  attacker: Character,
  target: Character,
  options: { weapon?: Weapon; reaction?: boolean; advantage?: string },
): string | undefined {
  const from = cellOf(c, attacker);
  const to = cellOf(c, target);
  if (from === undefined || to === undefined || from.room !== to.room) return undefined;
  const feet = distanceFeet(from, to);
  const parts = [`距离 ${feet} 尺`];
  const reach = options.weapon === undefined ? undefined : weaponReach(options.weapon);
  if (options.weapon === undefined) {
    if (feet > MELEE_REACH_FEET && options.reaction !== true) parts.push(`如果是近战就够不到：应先 dnd_position move，判错了 dnd_undo`);
  } else if (reach !== undefined) {
    if (feet > reach && options.reaction !== true) parts.push(`${options.weapon.name} 够不到（触及 ${reach} 尺）：应先 dnd_position move，判错了 dnd_undo`);
  } else if (isRangedWeapon(options.weapon) && options.advantage !== 'disadvantage') {
    const adjacent = adjacentFoes(c, attacker, from).filter((n) => {
      const foe = findCharacter(c, n);
      return foe !== undefined && canReact(foe);
    });
    if (adjacent.length > 0) parts.push(`${adjacent.join('、')} 贴着射手，这一箭该劣势；判错了 dnd_undo 重掷`);
  }
  return `【站位】${parts.join('；')}`;
}
