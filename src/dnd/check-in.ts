/**
 * 跑团签到 — /dnd start 时开一张签到表，玩家点按钮签到，大家看得到谁到了。
 *
 * 签到只是这一次开团的出勤，不进 campaign 存档：存档里的东西会被 dnd_undo 回滚，
 * 签到不该跟着回滚；bot 重启丢了也无所谓，/dnd 签到 再开一张就行。
 * 点击者身份取 QQ 回调里的 openid，按角色卡上绑定的 playerId 对上角色。
 */
import type { Campaign, Character } from './campaign.ts';

export interface CheckIn {
  openedAt: number;
  /** 签到的 openid → 签到时间 */
  arrived: Map<string, number>;
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
  return { openedAt: now, arrived: new Map() };
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

function who(ch: Character): string {
  return ch.player !== undefined ? `${ch.name}〈${ch.player}〉` : ch.name;
}

/** 给群里看的签到名单 */
export function rosterText(r: Roster): string {
  const total = r.arrived.length + r.missing.length;
  const lines = [`📋 签到 ${r.arrived.length}/${total}${total > 0 && r.missing.length === 0 ? ' · 全员到齐！' : ''}`];
  lines.push(`✅ 已到：${r.arrived.map(who).join('、') || '还没人签到'}`);
  if (r.missing.length > 0) lines.push(`⏳ 未到：${r.missing.map(who).join('、')}`);
  if (r.newcomers > 0) lines.push(`🆕 还有 ${r.newcomers} 位没有角色卡的玩家签到了，@ 我说名字和职业来建卡`);
  if (r.unbound.length > 0) lines.push(`（${r.unbound.map((ch) => ch.name).join('、')} 没绑定玩家，签不了到）`);
  return lines.join('\n');
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
