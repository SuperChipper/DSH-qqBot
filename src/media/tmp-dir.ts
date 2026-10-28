/**
 * Agent 临时目录 — 让 bot 的脚本/截图/抽帧/下载等中间产物集中放在一个地方，不散落在工作目录根下。
 *
 * 默认是 agent 工作目录（cwd）下的 tmp/；启动时创建。过期清理由 cleanup.ts 的 tmp 规则负责：
 * 以顶层条目为单位，一个文件或子目录里最新的 mtime 都超过 TTL 才整个删除。
 */
import { mkdirSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { ImQQBotConfig } from '../config.ts';
import type { Logger } from '../types.ts';

/** 解析临时目录：空 = cwd/tmp，相对路径按 cwd 解析 */
export function resolveTmpDir(config: Pick<ImQQBotConfig, 'cwd' | 'tmpDir'>): string {
  const cwd = config.cwd || process.cwd();
  const configured = (config.tmpDir ?? '').trim();
  if (configured === '') return resolve(cwd, 'tmp');
  return isAbsolute(configured) ? configured : resolve(cwd, configured);
}

/** 创建临时目录（失败只告警） */
export function ensureTmpDir(root: string, logger: Logger): void {
  try {
    mkdirSync(root, { recursive: true });
    logger.info(`im-qqbot: 临时目录 ${root}`);
  } catch (err) {
    logger.warn(`im-qqbot: 创建临时目录失败 ${root}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
