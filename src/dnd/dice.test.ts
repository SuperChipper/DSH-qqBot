import { describe, it, expect } from 'vitest';
import { rollD20, rollExpression, type Roller } from './dice.ts';
import { critExpression } from './dnd-tools.ts';

/** 按顺序吐出固定点数的骰子 */
function seq(...values: number[]): Roller {
  let i = 0;
  return (sides) => {
    const v = values[i++ % values.length]!;
    if (v > sides) throw new Error(`fixture ${v} > d${sides}`);
    return v;
  };
}

describe('rollExpression', () => {
  it('骰子 + 常数', () => {
    const r = rollExpression('2d6+3', seq(4, 5));
    expect(r.total).toBe(12);
    expect(r.detail).toBe('2d6[4,5] + 3 = 12');
  });

  it('d20 省略数量，支持减号和空格', () => {
    expect(rollExpression('d20 - 1', seq(10)).total).toBe(9);
  });

  it('kh / kl 保留最高/最低', () => {
    const r = rollExpression('4d6kh3', seq(1, 6, 3, 5));
    expect(r.total).toBe(14);
    expect(r.detail).toBe('4d6kh3[1,6,3,5→6,5,3] = 14');
    expect(rollExpression('2d20kl1', seq(17, 4)).total).toBe(4);
  });

  it('非法表达式报错', () => {
    expect(() => rollExpression('')).toThrow();
    expect(() => rollExpression('2d')).toThrow();
    expect(() => rollExpression('1000d6')).toThrow();
    expect(() => rollExpression('3d6kh4')).toThrow();
    expect(() => rollExpression('fireball')).toThrow();
  });

  it('默认骰子结果在范围内', () => {
    for (let i = 0; i < 200; i++) {
      const total = rollExpression('1d20').total;
      expect(total).toBeGreaterThanOrEqual(1);
      expect(total).toBeLessThanOrEqual(20);
    }
  });
});

describe('rollD20', () => {
  it('优势取高、劣势取低', () => {
    expect(rollD20(3, 'advantage', seq(5, 18)).total).toBe(21);
    expect(rollD20(3, 'disadvantage', seq(5, 18)).total).toBe(8);
    expect(rollD20(-1, 'none', seq(12)).detail).toBe('d20[12] - 1 = 11');
  });
});

describe('critExpression', () => {
  it('骰子数量翻倍，常数不变', () => {
    expect(critExpression('1d8+3')).toBe('2d8+3');
    expect(critExpression('2d6+1d4')).toBe('4d6+2d4');
    expect(critExpression('d12')).toBe('2d12');
  });
});
