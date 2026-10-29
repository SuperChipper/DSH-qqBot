/**
 * 跑团签到 — /dnd start 的那条消息本身就是签到表，玩家点按钮签到。
 *
 * 少刷屏：点「签到」后群里只发一行小提醒（几秒内连着签到的合成一条），让没点的人看到有人到了；
 * 人到齐了（或有人点「开始」）就不发提醒，让 DM 直接开场，开场叙述本身就是「人齐了」的信号。
 * 完整名单只在有人点「名单」时才发。
 *
 * 签到只是这一次开团的出勤，不进 campaign 存档：存档里的东西会被 dnd_undo 回滚，
 * 签到不该跟着回滚；bot 重启丢了也无所谓，/dnd checkin 再开一张就行。
 * 点击者身份取 QQ 回调里的 openid，按角色卡上绑定的 playerId 对上角色。
 */
import type { Campaign, Character } from './campaign.ts';

export interface CheckIn {
  openedAt: number;
  /** 签到的 openid → 签到时间 */
  arrived: Map<string, number>;
  /** 已经开场（人齐自动开，或有人点了「开始」）；之后再签到不再触发开场 */
  started: boolean;
  /** 上次在群里发名单的时间：「名单」按钮有冷却，连点不会刷屏 */
  rosterPostedAt?: number;
}

export interface Roster {
  /** 已签到、绑定了角色的玩家 */
  arrived: Character[];
  /** 绑定了角色但还没签到 */
  missing: Character[];
  /** 签到了但名下没有角色卡的人数（还没建卡的新玩家） */
  newcomers: number;
  /** 没绑定玩家的 PC：没法按人签到，单独列出来提醒绑定 */
  unbound: Character[];
}

export function createCheckIn(now = Date.now()): CheckIn {
  return { openedAt: now, arrived: new Map(), started: false };
}

/** 签到；已经签过返回 false */
export function markArrived(ci: CheckIn, openid: string, now = Date.now()): boolean {
  if (ci.arrived.has(openid)) return false;
  ci.arrived.set(openid, now);
  return true;
}

export function rosterOf(ci: CheckIn, c: Campaign): Roster {
  const pcs = c.characters.filter((ch) => ch.kind === 'pc' && !ch.conditions.includes('死亡'));
  const bound = pcs.filter((ch) => ch.playerId !== undefined);
  const owners = new Set(bound.map((ch) => ch.playerId!));
  return {
    arrived: bound.filter((ch) => ci.arrived.has(ch.playerId!)),
    missing: bound.filter((ch) => !ci.arrived.has(ch.playerId!)),
    newcomers: [...ci.arrived.keys()].filter((id) => !owners.has(id)).length,
    unbound: pcs.filter((ch) => ch.playerId === undefined),
  };
}

/** 绑定了玩家的角色全都签到了（至少有一个）：可以自动开场 */
export function isComplete(r: Roster): boolean {
  return r.arrived.length > 0 && r.missing.length === 0;
}

function who(ch: Character): string {
  return ch.player !== undefined ? `${ch.name}〈${ch.player}〉` : ch.name;
}

/** 给群里看的签到名单 */
export function rosterText(r: Roster): string {
  const total = r.arrived.length + r.missing.length;
  const lines = [`📋 签到 ${r.arrived.length}/${total}${isComplete(r) ? ' · 全员到齐' : ''}`];
  lines.push(`✅ 已到：${r.arrived.map(who).join('、') || '还没人签到'}`);
  if (r.missing.length > 0) lines.push(`⏳ 未到：${r.missing.map(who).join('、')}`);
  if (r.newcomers > 0) lines.push(`🆕 还有 ${r.newcomers} 位没有角色卡的玩家签到了，@ 我说名字和职业来建卡`);
  if (r.unbound.length > 0) lines.push(`（${r.unbound.map((ch) => ch.name).join('、')} 没绑定玩家，签不了到）`);
  return lines.join('\n');
}

/**
 * 签到后群里的一行小提醒：谁刚到、还差谁。openids 是这一批刚签到的人（按签到顺序）。
 * 名下没有角色卡的人只报个数，顺带提醒建卡。
 */
export function arrivalNotice(openids: readonly string[], r: Roster): string {
  const byOwner = new Map(r.arrived.map((ch) => [ch.playerId!, ch]));
  const named = openids.map((id) => byOwner.get(id)).filter((ch): ch is Character => ch !== undefined);
  const strangers = openids.length - named.length;
  const parts: string[] = [];
  if (named.length > 0) parts.push(`${named.map((ch) => ch.name).join('、')} 到了`);
  if (strangers > 0) parts.push(`${strangers} 位还没角色卡的玩家到了（@我说名字和职业建卡）`);
  const total = r.arrived.length + r.missing.length;
  const tail = total === 0 ? '' : ` · ${r.arrived.length}/${total}${r.missing.length > 0 ? `，还差 ${r.missing.map((ch) => ch.name).join('、')}` : ''}`;
  return `✅ ${parts.join('；')}${tail}`;
}

/** 签到表下面的说明：大家点什么、什么时候开场 */
export function checkInHint(r: Roster): string {
  return r.arrived.length + r.missing.length > 0
    ? '到了的点「签到」，人齐了自动开场；不等了就点「开始」。'
    : '到了的点「签到」；还没有角色卡的先 @ 我说名字和职业建卡，准备好了点「开始」。';
}

/** 给 DM（模型）看的出勤：没到的人轮到时直接 dm_override 跳过，别等他 */
export function rosterPrompt(r: Roster): string {
  const parts = [`本次签到：已到 ${r.arrived.map((ch) => ch.name).join('、') || '无'}`];
  if (r.missing.length > 0) {
    parts.push(`未签到 ${r.missing.map((ch) => ch.name).join('、')}（本人发了言就算到了，只是忘了点）。真没来的角色别替他行动：`
      + '剧情里让他跟着队伍、不做主动行动；战斗中轮到他就 dnd_initiative next dm_override=true 跳过并在回复里说明');
  }
  return parts.join('；');
}

/**
 * 开场时发给 DM 的系统消息。群里不再单独发「人齐了」，由 DM 的开场白一句带过，
 * 少一条消息。begun=false 是新团（按开场叙述），否则先回顾上次进度。
 */
export function kickoffMessage(r: Roster, begun: boolean, reason: 'complete' | 'manual'): string {
  const head = reason === 'complete'
    ? `[系统 · 签到] 人到齐了（${r.arrived.map((ch) => ch.name).join('、')}），开始这次跑团。`
    : `[系统 · 签到] 有人点了「开始」，不等了。已到：${r.arrived.map((ch) => ch.name).join('、') || '无'}`
      + `${r.missing.length > 0 ? `；未到：${r.missing.map((ch) => ch.name).join('、')}` : ''}。`;
  return `${head}开场第一句简短说明谁到了${r.missing.length > 0 ? '、谁没来' : ''}，然后`
    + `${begun ? '用两三句回顾上次的进度，接着描述队伍现在的处境' : '按开场要求叙述'}，最后问大家做什么。不要再列签到名单。`;
}
