/**
 * 豁免类效果的一次结算：火球、吐息、圣火术这类「目标各自豁免、伤害掷一次」的效果。
 *
 * 以前一发火球打五只怪要 dnd_check save ×5 + dnd_roll + dnd_apply ×5，模型还得自己算减半和抗性；
 * 这里一次给出每个目标的豁免、伤害和 HP 变化，减半/抗性/免疫/易伤按 5e 顺序算（先减半再抗性，都向下取整）。
 */
import { type Advantage, type DiceResult, type Roller, rollD20, rollExpression } from './dice.ts';
import { type Campaign, type HpChange, applyDamage, checkModifier, requireCharacter } from './campaign.ts';
import type { Ability } from './rules.ts';

export type Defense = 'resistant' | 'immune' | 'vulnerable';

const DEFENSE_ALIASES: Record<string, Defense> = {
  resistant: 'resistant', resistance: 'resistant', 抗性: 'resistant', 抗: 'resistant',
  immune: 'immune', immunity: 'immune', 免疫: 'immune',
  vulnerable: 'vulnerable', vulnerability: 'vulnerable', 易伤: 'vulnerable',
};

export const DEFENSE_NAMES: Record<Defense, string> = { resistant: '抗性', immune: '免疫', vulnerable: '易伤' };

export function parseDefense(value: unknown): Defense | undefined {
  return typeof value === 'string' ? DEFENSE_ALIASES[value.trim().toLowerCase()] : undefined;
}

/** 豁免成功减半（或无伤），再按抗性/免疫/易伤调整 */
export function saveDamage(total: number, saved: boolean, onSave: 'half' | 'none', defense?: Defense): number {
  let dmg = Math.max(0, Math.trunc(total));
  if (saved) dmg = onSave === 'none' ? 0 : Math.floor(dmg / 2);
  if (defense === 'immune') return 0;
  if (defense === 'resistant') return Math.floor(dmg / 2);
  if (defense === 'vulnerable') return dmg * 2;
  return dmg;
}

export interface SaveTarget {
  name: string;
  advantage?: Advantage;
  bonus?: number;
  defense?: Defense;
}

/** targets 既可以是名字，也可以是 {name, advantage, bonus, defense}；非法项直接报错，免得静默漏掉一个目标 */
export function parseSaveTargets(value: unknown): SaveTarget[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((raw) => {
    if (typeof raw === 'string' && raw.trim().length > 0) return { name: raw.trim() };
    const o = (raw ?? {}) as Record<string, unknown>;
    const name = typeof o.name === 'string' ? o.name.trim() : '';
    if (name.length === 0) throw new Error('targets 每一项要有 name');
    const t: SaveTarget = { name };
    if (o.advantage === 'advantage' || o.advantage === 'disadvantage' || o.advantage === 'none') t.advantage = o.advantage;
    if (typeof o.bonus === 'number' && Number.isFinite(o.bonus)) t.bonus = Math.trunc(o.bonus);
    if (o.defense !== undefined) {
      const d = parseDefense(o.defense);
      if (d === undefined) throw new Error(`${name} 的 defense 只能是 resistant/immune/vulnerable（抗性/免疫/易伤）`);
      t.defense = d;
    }
    return t;
  });
}

export interface SaveEffectInput {
  targets: SaveTarget[];
  ability: Ability;
  /** 不传时只报点数、不判成败，也不结算伤害 */
  dc?: number;
  /** 伤害表达式：所有目标共用一次掷骰 */
  damage?: string;
  damageType?: string;
  onSave?: 'half' | 'none';
  /** 所有目标默认的优劣势和加值；目标自己的设置优先 */
  advantage?: Advantage;
  bonus?: number;
  /** 每个目标各掷一次加在豁免上（祝福术） */
  bonusDice?: string;
  roller: Roller;
}

export interface SaveOutcome {
  name: string;
  /** 已死亡等原因跳过时的说明 */
  skipped?: string;
  detail?: string;
  saved?: boolean;
  natural?: number;
  damage?: number;
  defense?: Defense;
  change?: HpChange;
}

export interface SaveEffectResult {
  damageRoll?: DiceResult;
  outcomes: SaveOutcome[];
}

/** 逐个目标豁免并扣血；任何一个目标找不到都在改动前抛错（mutate 不落盘） */
export function resolveSaveEffect(c: Campaign, input: SaveEffectInput): SaveEffectResult {
  if (input.targets.length === 0) throw new Error('targets 不能为空');
  if (input.damage !== undefined && input.dc === undefined) throw new Error('带伤害的豁免要给 dc，才能判定减半');
  const seen = new Set<string>();
  const resolved = input.targets.flatMap((t) => {
    const ch = requireCharacter(c, t.name);
    if (seen.has(ch.name)) return [];
    seen.add(ch.name);
    return [{ t, ch }];
  });
  const damageRoll = input.damage === undefined ? undefined : rollExpression(input.damage, input.roller);
  const outcomes = resolved.map(({ t, ch }): SaveOutcome => {
    if (ch.conditions.includes('死亡')) return { name: ch.name, skipped: '已死亡' };
    const extra = input.bonusDice === undefined ? undefined : rollExpression(input.bonusDice, input.roller);
    const modifier = checkModifier(ch, 'save', input.ability) + (t.bonus ?? input.bonus ?? 0) + (extra?.total ?? 0);
    const roll = rollD20(modifier, t.advantage ?? input.advantage ?? 'none', input.roller);
    const detail = `${roll.detail}${extra !== undefined ? `（含 ${extra.detail}）` : ''}`;
    if (input.dc === undefined) return { name: ch.name, detail, natural: roll.natural };
    const saved = roll.total >= input.dc;
    const out: SaveOutcome = { name: ch.name, detail, saved, natural: roll.natural };
    if (t.defense !== undefined) out.defense = t.defense;
    if (damageRoll !== undefined) {
      out.damage = saveDamage(damageRoll.total, saved, input.onSave ?? 'half', t.defense);
      if (out.damage > 0) out.change = applyDamage(c, ch.name, out.damage, { damageType: input.damageType, roller: input.roller });
    }
    return out;
  });
  return damageRoll === undefined ? { outcomes } : { damageRoll, outcomes };
}
