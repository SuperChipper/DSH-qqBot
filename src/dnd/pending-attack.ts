/**
 * 待结算攻击：把「掷骰」和「落账」分开，中间留出反应的时间。
 *
 * 以前 dnd_check 一口气掷命中、掷伤害、扣血，玩家开口时血已经扣了，尖刻言语、护盾术只能事后补偿。
 * 现在有人能反应时，攻击只掷骰、挂在 InitiativeState.pending 上，改完数值再由 dnd_apply settle 落账。
 * 只靠守则提醒模型停手不管用，所以推进回合、再次攻击、提前落账都由工具拒绝。
 */
import {
  type Campaign,
  type Character,
  type PendingAttack,
  type ReactorOption,
  findCharacter,
  isOut,
  reactionsOf,
  requireInitiative,
  roomOf,
} from './campaign.ts';
import { canReact, cellOf, distanceFeet } from './battlefield.ts';

export { reactionsOf };

/** 窗口开多久；到时没回的算不用。太短玩家来不及打字，太长一只怪能卡住整桌 */
export const REACTION_WINDOW_MS = 30_000;

function hasResource(ch: Character, key: string | undefined): boolean {
  if (key === undefined) return true;
  const resource = ch.resources?.[key];
  // 卡上没记这项资源就不拦：只是没登记，不等于用完了
  return resource === undefined || resource.current > 0;
}

export interface AttackOutcome {
  hit: boolean;
  crit: boolean;
  natural: number;
}

/**
 * 此刻能对这次攻击做点什么的 PC。只看绑了玩家的 PC：NPC 和怪物的反应由 DM 决定，
 * 不该为它们停下来等群里的人。天然 1 改不了，重击挡不掉（尖刻言语还能减伤害）。
 */
export function eligibleReactors(c: Campaign, attacker: Character, target: Character, outcome: AttackOutcome): ReactorOption[] {
  if (outcome.natural === 1) return [];
  const reacted = c.initiative?.reacted ?? [];
  const room = roomOf(c, target);
  const enemyAttack = (attacker.kind === 'monster') !== (target.kind === 'monster');
  const attackerCell = cellOf(c, attacker);
  return c.characters.flatMap((ch) => {
    if (ch.kind !== 'pc' || !canReact(ch) || roomOf(c, ch) !== room) return [];
    const free = !reacted.includes(ch.name);
    return reactionsOf(ch).flatMap((r) => {
      if (!hasResource(ch, r.resource)) return [];
      if (r.range !== undefined) {
        // 没摆位就不按距离筛：宁可多问一句，也别把够得着的人漏掉
        const mine = cellOf(c, ch);
        if (mine !== undefined && attackerCell !== undefined && distanceFeet(mine, attackerCell) > r.range) return [];
      }
      const when = r.when ?? 'foe_attacks';
      const fits = when === 'attacking'
        ? ch.name === attacker.name && !outcome.hit
        : r.counter === true
          // 哨兵这类「反手一击」：看的是有人对别人出手，不看有没有打中
          ? free && enemyAttack && attacker.kind === 'monster' && ch.name !== attacker.name && ch.name !== target.name
          : when === 'attacked'
            ? free && ch.name === target.name && outcome.hit && !outcome.crit
            : free && enemyAttack && attacker.kind === 'monster' && outcome.hit;
      return fits ? [{ character: ch.name, reaction: r.name }] : [];
    });
  });
}

/** 改完数值后现在算不算命中；天然 20 必中、天然 1 必失 */
export function pendingHit(p: PendingAttack): boolean {
  if (p.crit) return true;
  return p.natural !== 1 && p.total + p.attackMod >= p.ac + p.acMod;
}

export function requirePending(c: Campaign): PendingAttack {
  const p = c.initiative?.pending;
  if (p === undefined) throw new Error('现在没有待结算的攻击');
  return p;
}

/** 还要等谁：点了要用但效果还没结算的也算在等 */
export function waitingOn(p: PendingAttack): string[] {
  const done = new Set([...p.declined, ...p.used.map((u) => u.by)]);
  return [...new Set(p.reactors.map((r) => r.character))].filter((name) => !done.has(name));
}

function optionsText(p: PendingAttack): string {
  return p.reactors.length > 0 ? p.reactors.map((r) => `${r.character}·${r.reaction}`).join('、') : '（DM 手动挂起）';
}

/** 这笔现在的局面，给模型看：含 AC，和其他工具结果一样是 DM 机密 */
export function pendingState(p: PendingAttack): string {
  const hit = pendingHit(p);
  const attack = `攻击 ${p.total + p.attackMod}${p.attackMod !== 0 ? `（原 ${p.total}）` : ''} vs AC ${p.ac + p.acMod}`;
  const damage = !hit
    ? '未命中，落账时不扣血'
    : p.rawDamage === undefined
      ? '命中，落账时掷伤害'
      : `命中，伤害 ${Math.max(0, p.rawDamage + p.damageMod)}${p.damageMod !== 0 ? `（原 ${p.rawDamage}）` : ''}，还没扣血`;
  return `${p.attacker}→${p.target}：${attack}，${damage}`;
}

/** 团况里的一行：压缩之后这笔账靠它才不会丢 */
export function pendingSummaryLine(p: PendingAttack): string {
  const waiting = waitingOn(p);
  const used = p.used.map((u) => `${u.by}·${u.name}`).join('、');
  return `【待结算】${pendingState(p)}。`
    + `${used.length > 0 ? `已用：${used}。` : ''}`
    + `${waiting.length > 0 ? `还在等：${waiting.join('、')}。` : ''}`
    + `落账用 dnd_apply target=${p.target} settle=true；落账前不能推进回合。`;
}

/** dnd_check 自己带的那句话：模型读到结果的同时就知道不能往下走 */
export function holdNotice(p: PendingAttack): string {
  return `【待结算】这笔还没落账，别往下推进：血没扣，这条回复只报骰子，问一句有没有人要用反应（可用：${optionsText(p)}），然后到此停下，`
    + `不要写成伤害已经造成。玩家回应后用 dnd_apply target=${p.target}：要用就传 reaction 改数值，不用就传 decline，都答复了传 settle=true。`
    + '落账前 next、再次攻击、豁免效果、移动都会被拒绝。';
}

/** 提前落账时报错；窗口时间到了就不再等没回话的人 */
export function assertWindowClosed(p: PendingAttack, now: number = Date.now()): void {
  const waiting = waitingOn(p);
  const left = p.at + REACTION_WINDOW_MS - now;
  if (waiting.length === 0 || left <= 0) return;
  throw new Error(`反应窗口还开着：还在等 ${waiting.join('、')}（剩约 ${Math.ceil(left / 1000)} 秒）。这条回复先停下问他们；说不用的传 decline，时间到了系统会提醒你。`);
}

/** 记下 PC 点了「不用」或说了不用；不是这笔的可反应者就报错，免得记错人 */
export function declineReaction(p: PendingAttack, name: string): void {
  if (!p.reactors.some((r) => r.character === name)) {
    throw new Error(`${name} 不在这笔的可反应名单里（${optionsText(p)}）`);
  }
  if (!p.declined.includes(name)) p.declined.push(name);
}

/** 这个玩家的角色 */
function charactersOf(c: Campaign, senderId: string): Character[] {
  return c.characters.filter((ch) => ch.playerId === senderId && !isOut(ch));
}

const DECLINE_REPLY = /^(不用|不用了|不反应|不了|没有|没|算了|跳过|过|pass|no)[。.!！~～]*$/i;
const GENERIC_REACTION = /反应|尖刻言语|护盾术|导引打击|招架|反制法术|幸运点/;

export interface ReactionReply {
  kind: 'use' | 'decline';
  /** 发这条消息的玩家在这笔名单里的角色；名单外的玩家为空 */
  characters: string[];
}

/**
 * 待结算期间，这条玩家消息是不是在回应反应询问。斜杠命令和闲聊返回 undefined。
 * 「不用」这种短答只认名单里的人，否则群里随口一句「算了」都会被当成回应。
 */
export function classifyReactionReply(c: Campaign, senderId: string, text: string): ReactionReply | undefined {
  const p = c.initiative?.pending;
  if (p === undefined) return undefined;
  const clean = text.replace(/<@!?[^>]*>/g, '').trim();
  if (clean.length === 0 || clean.startsWith('/')) return undefined;
  const mine = charactersOf(c, senderId);
  if (mine.length === 0) return undefined;
  const listed = [...new Set(p.reactors.map((r) => r.character))].filter((name) => mine.some((ch) => ch.name === name));
  if (listed.length > 0 && DECLINE_REPLY.test(clean)) return { kind: 'decline', characters: listed };
  const named = mine.some((ch) => reactionsOf(ch).some((r) => clean.includes(r.name)));
  return named || GENERIC_REACTION.test(clean) ? { kind: 'use', characters: listed } : undefined;
}

/** 接在玩家消息后面的系统标记：没带 (@you) 也算数，也不是新的回合行动 */
export function reactionReplyNote(c: Campaign, reply: ReactionReply): string {
  const p = requirePending(c);
  const who = reply.characters.join('、');
  if (reply.kind === 'decline') {
    return `[系统 · 待结算] 这条是在回答「${p.attacker}→${p.target}」那笔的反应询问，不是回合行动：用 dnd_apply target=${p.target} decline=["${who}"] 记下；都答复了再 settle=true。`;
  }
  return `[系统 · 待结算] 这条按对「${p.attacker}→${p.target}」那笔的反应处理（没带 @ 也算），不是新的回合行动，也不要 next：`
    + `用 dnd_apply target=${p.target} reaction={by, name, attack_mod/ac_mod/damage_mod, spend} 改数值，declared_by 填他的编号。`;
}

/** 打开一笔待结算；序号给按钮用，旧消息上的按钮点了对不上就作废 */
export function openPending(c: Campaign, input: Omit<PendingAttack, 'seq' | 'attackMod' | 'acMod' | 'damageMod' | 'declined' | 'claimed' | 'used'>): PendingAttack {
  const state = requireInitiative(c);
  const seq = (state.pendingSeq ?? 0) + 1;
  state.pendingSeq = seq;
  const pending: PendingAttack = { ...input, seq, attackMod: 0, acMod: 0, damageMod: 0, declined: [], claimed: [], used: [] };
  state.pending = pending;
  return pending;
}

/** 这个反应会不会占掉角色本轮的反应：导引打击这类是自己攻击时用的，不算 */
export function consumesReaction(p: PendingAttack, by: string): boolean {
  return by !== p.attacker;
}

export function findReactor(c: Campaign, p: PendingAttack, name: string): Character {
  const ch = findCharacter(c, name);
  if (ch === undefined) throw new Error(`找不到角色「${name}」`);
  if (consumesReaction(p, ch.name) && (c.initiative?.reacted ?? []).includes(ch.name)) {
    throw new Error(`${ch.name} 这一轮的反应已经用过了，要到他下个回合开始才恢复`);
  }
  if (!canReact(ch)) throw new Error(`${ch.name} 现在做不了反应`);
  return ch;
}
