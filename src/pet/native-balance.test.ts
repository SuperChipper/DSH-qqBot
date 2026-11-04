import { describe, expect, it, vi, afterEach } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import { deepseekPricingTier, parseDeepseekBalance, registerPetNativeBalance } from './native-balance.ts';

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('pet native balance', () => {
  it('解析 DeepSeek /user/balance 的 balance_infos，并带峰谷档位', () => {
    const result = parseDeepseekBalance({
      balance_infos: [{ currency: 'CNY', total_balance: '12.34', granted_balance: '2.00', topped_up_balance: '10.34' }],
    }, 'deepseek-native', new Date('2026-10-26T02:00:00Z'));
    expect(result).toEqual({
      ok: true,
      provider: 'deepseek-native',
      shape: 'money',
      data: {
        wallets: [{ currency: 'CNY', total: '12.34', granted: '2.00', toppedUp: '10.34' }],
        tier: 'peak',
      },
    });
  });

  it('峰谷按北京时间工作日 9-12 / 14-18，周末全天谷', () => {
    expect(deepseekPricingTier(new Date('2026-10-26T00:00:00Z'))).toBe('idle'); // 08:00 前
    expect(deepseekPricingTier(new Date('2026-10-26T02:00:00Z'))).toBe('peak'); // 10:00
    expect(deepseekPricingTier(new Date('2026-10-26T04:00:00Z'))).toBe('idle'); // 12:00
    expect(deepseekPricingTier(new Date('2026-10-26T06:00:00Z'))).toBe('peak'); // 14:00
    expect(deepseekPricingTier(new Date('2026-10-26T10:00:00Z'))).toBe('idle'); // 18:00
    expect(deepseekPricingTier(new Date('2026-10-25T02:00:00Z'))).toBe('idle'); // 周日
  });

  it('缺少 balance_infos 时抛错', () => {
    expect(() => parseDeepseekBalance({})).toThrow(/balance_infos/);
  });

  it('给每个自建 DeepSeek 路由都注册余额查询，切模型也能查到', async () => {
    const registrations: Array<{ id: string; fetch: (ctx: { provider: string }) => Promise<unknown> }> = [];
    const pet = {
      balance: {
        register: (def: { id: string; fetch: (ctx: { provider: string }) => Promise<unknown> }) => {
          registrations.push(def);
          return () => {};
        },
      },
    };
    const credentials = { resolve: vi.fn(async () => ({ value: 'test-key' })) };
    const ctx = {
      get: (name: string) => (name === 'petApi7340' ? pet : name === 'credentials' ? credentials : undefined),
      effect: vi.fn(),
    } as unknown as Context;

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ balance_infos: [{ currency: 'CNY', total_balance: '1', granted_balance: '0', topped_up_balance: '1' }] }),
    })));

    registerPetNativeBalance(ctx, logger);
    expect(registrations.map((r) => r.id)).toEqual(['deepseek-native', 'deepseek-max']);

    const result = await registrations[1]!.fetch({ provider: 'deepseek-max' });
    expect(result).toMatchObject({ ok: true, provider: 'deepseek-max', shape: 'money' });
    expect(credentials.resolve).toHaveBeenCalledWith('DEEPSEEK_API_KEY');
  });

  it('某个 id 已被占用时不影响其余路由注册', async () => {
    const registrations: string[] = [];
    const pet = {
      balance: {
        register: (def: { id: string }) => {
          if (def.id === 'deepseek-native') throw new Error('该服务商 id 已被注册: deepseek-native');
          registrations.push(def.id);
          return () => {};
        },
      },
    };
    const ctx = {
      get: (name: string) => (name === 'petApi7340' ? pet : name === 'credentials' ? { resolve: vi.fn() } : undefined),
      effect: vi.fn(),
    } as unknown as Context;

    registerPetNativeBalance(ctx, logger);
    expect(registrations).toEqual(['deepseek-max']);
  });
});
