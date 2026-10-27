/**
 * 掷骰 — 解析 `2d6+3`、`1d20kh1`、`4d6kh3` 之类的表达式并真实掷出。
 *
 * 所有骰点都由这里产生，模型只负责叙事：提示词禁止模型自己编数字。
 * Roller 可注入，测试用固定序列。
 */
import { randomInt } from 'node:crypto';

/** 掷一颗 sides 面骰，返回 1..sides */
export type Roller = (sides: number) => number;

export const cryptoRoller: Roller = (sides) => randomInt(1, sides + 1);

const MAX_DICE = 100;
const MAX_SIDES = 1000;
const MAX_TERMS = 10;

export interface DiceTermResult {
  /** 原始写法，如 `2d6`、`+3` */
  term: string;
  sign: 1 | -1;
  /** 每颗骰子的点数；常数项为空 */
  rolls: number[];
  /** kh/kl 保留下来的点数；没有 keep 时等于 rolls */
  kept: number[];
  value: number;
}

export interface DiceResult {
  expression: string;
  total: number;
  terms: DiceTermResult[];
  /** 人读的明细，如 `2d6[3,5] + 3 = 11` */
  detail: string;
}

/** d20 优劣势：adv 取高、dis 取低 */
export type Advantage = 'none' | 'advantage' | 'disadvantage';

const TERM_RE = /^(\d*)d(\d+)(?:(kh|kl)(\d+))?$/;

/**
 * 解析并掷出表达式。支持：NdM、NdMkhX/klX、整数常数，用 + / - 连接。
 * `d20` 等价 `1d20`。非法表达式抛错（错误信息给模型看）。
 */
export function rollExpression(expression: string, roller: Roller = cryptoRoller): DiceResult {
  const normalized = expression.toLowerCase().replace(/\s+/g, '').replace(/[dD]%/g, 'd100');
  if (normalized.length === 0) throw new Error('骰子表达式为空');
  const parts = normalized.match(/[+-]?[^+-]+/g);
  if (parts === null || parts.join('') !== normalized) throw new Error(`无法解析骰子表达式: ${expression}`);
  if (parts.length > MAX_TERMS) throw new Error(`骰子表达式项数过多（上限 ${MAX_TERMS}）`);

  const terms: DiceTermResult[] = [];
  for (const raw of parts) {
    const sign: 1 | -1 = raw.startsWith('-') ? -1 : 1;
    const body = raw.replace(/^[+-]/, '');
    if (/^\d+$/.test(body)) {
      const value = Number(body);
      terms.push({ term: raw, sign, rolls: [], kept: [], value: sign * value });
      continue;
    }
    const match = TERM_RE.exec(body);
    if (match === null) throw new Error(`无法解析骰子项: ${raw}`);
    const count = match[1] === '' ? 1 : Number(match[1]);
    const sides = Number(match[2]);
    if (count < 1 || count > MAX_DICE) throw new Error(`骰子数量需在 1-${MAX_DICE} 之间: ${raw}`);
    if (sides < 2 || sides > MAX_SIDES) throw new Error(`骰子面数需在 2-${MAX_SIDES} 之间: ${raw}`);

    const rolls = Array.from({ length: count }, () => roller(sides));
    let kept = rolls;
    if (match[3] !== undefined) {
      const keep = Number(match[4]);
      if (keep < 1 || keep > count) throw new Error(`保留数需在 1-${count} 之间: ${raw}`);
      const sorted = [...rolls].sort((a, b) => (match[3] === 'kh' ? b - a : a - b));
      kept = sorted.slice(0, keep);
    }
    const value = sign * kept.reduce((sum, n) => sum + n, 0);
    terms.push({ term: raw, sign, rolls, kept, value });
  }

  const total = terms.reduce((sum, t) => sum + t.value, 0);
  return { expression, total, terms, detail: `${formatTerms(terms)} = ${total}` };
}

function formatTerms(terms: readonly DiceTermResult[]): string {
  return terms.map((t, i) => {
    const op = t.sign < 0 ? '- ' : (i === 0 ? '' : '+ ');
    const body = t.term.replace(/^[+-]/, '');
    if (t.rolls.length === 0) return `${op}${body}`;
    const shown = t.rolls.length === t.kept.length ? t.rolls.join(',') : `${t.rolls.join(',')}→${t.kept.join(',')}`;
    return `${op}${body}[${shown}]`;
  }).join(' ');
}

export interface D20Result {
  /** 实际采用的 d20 点数 */
  natural: number;
  /** 优劣势时两颗都列出 */
  rolls: number[];
  modifier: number;
  total: number;
  detail: string;
}

/** 掷 d20 + 修正，处理优劣势 */
export function rollD20(modifier: number, advantage: Advantage = 'none', roller: Roller = cryptoRoller): D20Result {
  const rolls = advantage === 'none' ? [roller(20)] : [roller(20), roller(20)];
  const natural = advantage === 'advantage'
    ? Math.max(...rolls)
    : (advantage === 'disadvantage' ? Math.min(...rolls) : rolls[0]!);
  const total = natural + modifier;
  const tag = advantage === 'advantage' ? '优势' : (advantage === 'disadvantage' ? '劣势' : '');
  const dice = rolls.length > 1 ? `d20${tag}[${rolls.join(',')}→${natural}]` : `d20[${natural}]`;
  const mod = modifier === 0 ? '' : ` ${modifier > 0 ? '+' : '-'} ${Math.abs(modifier)}`;
  return { natural, rolls, modifier, total, detail: `${dice}${mod} = ${total}` };
}
