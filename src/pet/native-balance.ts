/**
 * 给桌宠（dsh-pet）补上自建 DeepSeek 路由的余额 provider。
 *
 * 桌宠的余额查询按 agentDefaultModel.currentSelection().provider 精确匹配 id，
 * 内置表只有 deepseek-official / deepseek-account / opencode-go / commandcode。
 * 我们在 llm-pi-ai 里自建的路由（deepseek-native、deepseek-max 等）都不在表里
 * → unsupported，切一次模型余额就查不到了。
 *
 * 所以**按 id 全部注册一遍**，而不是只挂 deepseek-native：这些路由指向同一个
 * DeepSeek 账号、同一套 /user/balance 和 DEEPSEEK_API_KEY，差别只在推理档位，
 * 余额本来就该是同一个数。新增自建路由时记得往 DEEPSEEK_ROUTE_IDS 里补一个。
 *
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

/** 指向同一个 DeepSeek 账号的自建路由 id；余额查询要逐个登记，否则切模型就查不到。 */
export const DEEPSEEK_ROUTE_IDS = ['deepseek-native', 'deepseek-max'] as const;

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
  let disposers: Array<() => void> = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let attempts = 0;

  /** 同一个账号的余额，provider 只影响结果里回显的 id */
  const fetcher = (provider: string) => async (): Promise<unknown> => {
    const credentials = ctx.get('credentials') as CredentialsLike | undefined;
    const resolved = await credentials?.resolve('DEEPSEEK_API_KEY');
    if (resolved === undefined || resolved.value.length === 0) {
      throw new Error('缺少 DEEPSEEK_API_KEY');
    }
    const response = await fetch('https://api.deepseek.com/user/balance', {
      headers: { authorization: `Bearer ${resolved.value}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error('deepseek balance HTTP ' + response.status);
    return parseDeepseekBalance(await response.json(), provider);
  };

  const tryRegister = (): void => {
    const pet = ctx.get('petApi7340') as PetBalanceApi | undefined;
    const credentials = ctx.get('credentials') as CredentialsLike | undefined;
    if (pet?.balance?.register === undefined || credentials === undefined) {
      attempts += 1;
      if (attempts <= 30) timer = setTimeout(tryRegister, 1000);
      return;
    }
    const registered: string[] = [];
    for (const id of DEEPSEEK_ROUTE_IDS) {
      try {
        disposers.push(pet.balance.register({ id, fetch: fetcher(id) }));
        registered.push(id);
      } catch (err) {
        // 桌宠重启后残留的旧登记会让这里抛「已被注册」，不该拖垮其他路由
        logger.warn(`im-qqbot: 注册桌宠 ${id} 余额查询失败: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (registered.length > 0) {
      logger.info(`im-qqbot: 已为桌宠注册余额查询 ${registered.join(', ')}`);
    }
  };

  tryRegister();
  (ctx as unknown as { effect(fn: () => () => void, name?: string): void })
    .effect(() => () => {
      if (timer !== undefined) clearTimeout(timer);
      for (const dispose of disposers) dispose();
      disposers = [];
    }, 'im-qqbot: pet native balance');
}
