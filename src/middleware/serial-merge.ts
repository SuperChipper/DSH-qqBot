import type { Middleware, MiddlewareContext } from '@tencent-connect/qqbot-nodejs';

interface Waiter {
  ctx: MiddlewareContext;
  admit: (run: boolean) => void;
}

interface TargetQueue {
  pending: Waiter[];
}

interface SerialMergeOptions {
  maxQueue: number;
  maxProcessingMs: number;
  onMerge: (buffered: MiddlewareContext[]) => MiddlewareContext;
}

/**
 * SDK 1.0.5 的 merge 分支在唤醒 survivor 后就释放锁，survivor 也没有 watchdog。
 * 把同一把锁直接交给下一批，直到它自己的下游链收敛，避免慢工具期间并发 followup。
 */
export function serialMerge(options: SerialMergeOptions): Middleware {
  const queues = new Map<string, TargetQueue>();

  function handoff(key: string, queue: TargetQueue): void {
    const batch = queue.pending.splice(0);
    const ready = batch.filter((w) => !w.ctx.signal.aborted);
    let survivor: MiddlewareContext | undefined;
    try {
      if (ready.length > 0) {
        const contexts = ready.map((w) => w.ctx);
        const merged = options.onMerge(contexts);
        survivor = contexts.includes(merged) ? merged : contexts[0];
      }
    } catch (error) {
      // 合并失败仍逐条保留消息，不能让所有等待者悬空。
      ready[0]?.ctx.log.error?.(`[concurrency:merge] ${String(error)}`);
      survivor = ready[0]?.ctx;
      queue.pending.unshift(...ready.slice(1));
    }
    if (survivor === undefined) queues.delete(key);
    // 存在 survivor 时保留 Map 中的占用；新消息必须等它完成，不能越过交接窗口。
    for (const waiter of batch) {
      if (!queue.pending.includes(waiter)) waiter.admit(waiter.ctx === survivor);
    }
  }

  return async (ctx, next) => {
    if (ctx.signal.aborted) return;
    const target = ctx.message.replyTarget;
    const key = `${target.scope}:${target.targetId}`;
    let queue = queues.get(key);
    if (queue === undefined) {
      queue = { pending: [] };
      queues.set(key, queue);
    } else {
      if (queue.pending.length >= options.maxQueue) {
        ctx.log.warn?.(`[concurrency:merge] queue full for ${key}`);
        ctx.stop('concurrency:merge-full');
        return;
      }
      const waitingQueue = queue;
      const admitted = await new Promise<boolean>((resolve) => {
        const abort = () => {
          const index = waitingQueue.pending.indexOf(waiter);
          if (index >= 0) waitingQueue.pending.splice(index, 1);
          waiter.admit(false);
        };
        const waiter: Waiter = {
          ctx,
          admit: (run) => {
            ctx.signal.removeEventListener('abort', abort);
            resolve(run);
          },
        };
        waitingQueue.pending.push(waiter);
        ctx.signal.addEventListener('abort', abort, { once: true });
      });
      if (!admitted) return;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (ctx.signal.aborted) return;
      if (options.maxProcessingMs > 0) {
        timer = setTimeout(() => {
          ctx.log.warn?.(`[concurrency] aborting ${key} after ${options.maxProcessingMs}ms`);
          ctx.abort('concurrency:processing-timeout');
        }, options.maxProcessingMs);
        timer.unref?.();
      }
      await next();
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      // abort 只是请求取消；等下游完成清理再交接，避免旧回合取消新回合。
      handoff(key, queue);
    }
  };
}
