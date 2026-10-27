/**
 * Agent 临时目录 — 让 bot 的脚本/截图/抽帧/下载等中间产物集中放在一个地方，不散落在工作目录根下。
 *
 * 默认是 agent 工作目录（cwd）下的 tmp/；启动时创建，并按 TTL 定期清理。
 * 清理以 tmp/ 下的顶层条目为单位：一个文件或子目录里最新的 mtime 都超过 TTL，才整个删除，
 * 这样一次任务建的临时文件夹作为整体保留或回收，不会被删掉一半。
 */
import { existsSync, mkdirSync } from 'node:fs';
import { readdir, rm, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { ImQQBotConfig } from '../config.ts';
import type { Logger } from '../types.ts';

/** 定期清理间隔（毫秒），固定 1 小时 */
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

/** 解析临时目录：空 = cwd/tmp，相对路径按 cwd 解析 */
export function resolveTmpDir(config: Pick<ImQQBotConfig, 'cwd' | 'tmpDir'>): string {
  const cwd = config.cwd || process.cwd();
  const configured = (config.tmpDir ?? '').trim();
  if (configured === '') return resolve(cwd, 'tmp');
  return isAbsolute(configured) ? configured : resolve(cwd, configured);
}

/** 子树里最新的 mtime（文件或目录本身取较新者）；读不到的条目按「刚修改」处理，避免误删 */
async function newestMtime(path: string, now: number): Promise<number> {
  let info;
  try {
    info = await stat(path);
  } catch {
    return now;
  }
  if (!info.isDirectory()) return info.mtimeMs;
  let newest = info.mtimeMs;
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch {
    return now;
  }
  for (const entry of entries) {
    newest = Math.max(newest, await newestMtime(join(path, entry.name), now));
    if (newest >= now) break;
  }
  return newest;
}

/**
 * 清理临时目录里超过 ttlHours 没动过的顶层条目。
 *
 * @returns 删除的顶层条目数
 */
export async function cleanupTmpDir(root: string, ttlHours: number, logger?: Logger, now = Date.now()): Promise<number> {
  if (ttlHours <= 0 || !existsSync(root)) return 0;
  const ttlMs = ttlHours * 60 * 60 * 1000;
  const entries = await readdir(root, { withFileTypes: true });
  let removed = 0;
  for (const entry of entries) {
    const path = join(root, entry.name);
    try {
      if (now - (await newestMtime(path, now)) <= ttlMs) continue;
      await rm(path, { recursive: true, force: true });
      removed++;
      logger?.debug(`im-qqbot: cleaned expired tmp entry: ${entry.name}`);
    } catch (err) {
      logger?.warn(`im-qqbot: tmp cleanup failed for ${entry.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return removed;
}

/** 创建临时目录并启动定期清理（ttlHours <= 0 时只创建不清理） */
export function startTmpDir(ctx: Context, root: string, ttlHours: number, logger: Logger): void {
  try {
    mkdirSync(root, { recursive: true });
  } catch (err) {
    logger.warn(`im-qqbot: 创建临时目录失败 ${root}: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  if (ttlHours <= 0) {
    logger.info(`im-qqbot: 临时目录 ${root}（不自动清理）`);
    return;
  }
  logger.info(`im-qqbot: 临时目录 ${root}（${ttlHours}h 未改动的条目自动清理）`);

  const run = (): void => {
    void cleanupTmpDir(root, ttlHours, logger)
      .then((n) => {
        if (n > 0) logger.info(`im-qqbot: cleaned ${n} expired tmp entries`);
      })
      .catch((err) => {
        logger.warn(`im-qqbot: tmp cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
      });
  };
  run();

  (ctx as unknown as { effect(fn: () => (() => Promise<void>) | void, name?: string): void })
    .effect(() => {
      const timer = setInterval(run, CLEANUP_INTERVAL_MS);
      return async () => { clearInterval(timer); };
    }, 'im-qqbot.tmp-cleanup');
}
