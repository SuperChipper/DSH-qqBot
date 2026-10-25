/**
 * 文件访问与敏感路径拦截。
 * 所有会话统一使用工程目录（config.cwd）作为 agent cwd；
 * 敏感路径（fileAccess.sensitivePaths）下的文件禁止访问/发送。
 */
import { resolve, relative, isAbsolute } from 'node:path';
import type { ImQQBotConfig } from '../config.ts';
import type { ChatScope } from '../types.ts';

/** 判断 path 是否位于 root 目录内（含 root 本身） */
function isWithin(path: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** 判断绝对路径是否命中敏感路径（拦截名单） */
export function isSensitivePath(path: string, config: ImQQBotConfig): boolean {
  const abs = resolve(path);
  return (config.fileAccess?.sensitivePaths ?? []).some((root) => isWithin(abs, root));
}

/** 解析会话 agent cwd：统一工程目录（config.cwd），主人/非主人同源 */
export function resolveSessionCwd(_scope: ChatScope, _senderId: string, config: ImQQBotConfig): string {
  return config.cwd || process.cwd();
}
