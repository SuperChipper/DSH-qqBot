/**
 * 给桌宠（dsh-pet）补一个 deepseek-native 余额 provider。
 *
 * 桌宠的余额查询按 agentDefaultModel.currentSelection().provider 寻址，
 * 内置表只有 deepseek-official / deepseek-account / opencode-go / commandcode。
 * 自定义 deepseek-native 不在表里 → unsupported。
 *
 * 这里通过桌宠暴露的 petApi7340.balance.register 注册第三方 provider：
 * 同样的 /user/balance 接口、同样的 DEEPSEEK_API_KEY，只把 provider id 补上。
 * 桌宠未安装时静默跳过；桌宠晚于本插件加载时做有限重试。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Logger } from '../types.ts';

interface PetBalanceApi {
  balance?: {
    register(def: { id: string; fetch(ctx: { provider: string }): Promise<unknown> }): () => void;
  };
}

interface CredentialsLike {
  resolve(ref: string): Promise<{ value: string } | undefined>;
}

interface DeepseekWallet {
  currency: string;
  total: string;
  granted: string;
  toppedUp: string;
}

export interface DeepseekMoneyBalance {
  ok: true;
  provider: string;
  shape: 'money';
  data: { wallets: DeepseekWallet[]; tier: 'peak' | 'idle' };
}

/**
 * DeepSeek 峰谷档位（与 dsh-pet 内置 deepseek-common 同一口径）：
 * - 北京时间工作日 9:00–12:00、14:00–18:00 为峰；
 * - 其余时间，以及周六/周日全天，为谷。
 */
export function deepseekPricingTier(now: Date = new Date()): 'peak' | 'idle' {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    weekday: 'short',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const pick = (type: Intl.DateTimeFormatPartTypes): string | undefined => parts.find((part) => part.type === type)?.value;
  const weekday = pick('weekday');
  const hour = Number(pick('hour'));
  if (weekday === 'Sat' || weekday === 'Sun') return 'idle';
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18) ? 'peak' : 'idle';
}

/** 解析 DeepSeek /user/balance；失败一律 throw，让桌宠统一落成 fetch-error */
export function parseDeepseekBalance(
  body: unknown,
  provider = 'deepseek-native',
  now: Date = new Date(),
): DeepseekMoneyBalance {
  const infos = (body as { balance_infos?: unknown })?.balance_infos;
  if (!Array.isArray(infos) || infos.length === 0) {
    throw new Error('dsh-pet: deepseek balance 响应缺少 balance_infos');
  }
  const wallets = infos.map((raw) => {
    const w = (raw ?? {}) as Record<string, unknown>;
    const currency = w.currency;
    const total = w.total_balance;
    const granted = w.granted_balance;
    const toppedUp = w.topped_up_balance;
    if (typeof currency !== 'string' || typeof total !== 'string' || typeof granted !== 'string' || typeof toppedUp !== 'string') {
      throw new Error('dsh-pet: deepseek balance 钱包字段非法');
    }
    return { currency, total, granted, toppedUp };
  });
  return { ok: true, provider, shape: 'money', data: { wallets, tier: deepseekPricingTier(now) } };
}

/** 注册桌宠余额 provider；petApi7340 尚未出现时最多重试 30 秒 */
export function registerPetNativeBalance(ctx: Context, logger: Logger): void {
  let dispose: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let attempts = 0;

  const tryRegister = (): void => {
    const pet = ctx.get('petApi7340') as PetBalanceApi | undefined;
    const credentials = ctx.get('credentials') as CredentialsLike | undefined;
    if (pet?.balance?.register === undefined || credentials === undefined) {
      attempts += 1;
      if (attempts <= 30) timer = setTimeout(tryRegister, 1000);
      return;
    }
    try {
      dispose = pet.balance.register({
        id: 'deepseek-native',
        async fetch() {
          const resolved = await credentials.resolve('DEEPSEEK_API_KEY');
          if (resolved === undefined || resolved.value.length === 0) {
            throw new Error('缺少 DEEPSEEK_API_KEY');
          }
          const response = await fetch('https://api.deepseek.com/user/balance', {
            headers: { authorization: `Bearer ${resolved.value}` },
            signal: AbortSignal.timeout(15000),
          });
          if (!response.ok) throw new Error('deepseek balance HTTP ' + response.status);
          return parseDeepseekBalance(await response.json());
        },
      });
      logger.info('im-qqbot: 已为桌宠注册 deepseek-native 余额查询');
    } catch (err) {
      logger.warn(`im-qqbot: 注册桌宠 deepseek-native 余额查询失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  tryRegister();
  (ctx as unknown as { effect(fn: () => () => void, name?: string): void })
    .effect(() => () => {
      if (timer !== undefined) clearTimeout(timer);
      dispose?.();
    }, 'im-qqbot: pet native balance');
}
