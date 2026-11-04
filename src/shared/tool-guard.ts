/**
 * QQ 会话的工具拦截 — 在 dsh 的 tools.guard() 上加一道按会话区分的权限。
 *
 * dsh 的沙箱只限制写，不限制读（Windows ACL 只管写；fs 工具读不受限），
 * 群里任何人都能让 bot 用 pwsh/read/grep 去翻 ~/.dsh/.env、别的群的存档。所以：
 *
 *   - 主人私聊、fullAccessUsers 私聊、fullAccessGroups 群，以及主人在聊天里确认加入的会话
 *     （features/tool-access.ts）：不限制（只拦敏感路径）；
 *   - 其它 QQ 会话：
 *       · 终端类工具（pwsh/bash/terminal_*）直接拒绝 —— 命令里能拼任意路径，没法按参数判断；
 *       · 会派生子 agent 的工具拒绝 —— 子 agent 不在会话表里，会绕过本拦截；
 *       · 文件工具（read/grep/glob/write/edit/qqbot_send_file …）只允许 readRoots 内的路径，
 *         grep/glob 必须显式给 path（默认会落到整个工作目录）；
 *   - 本机会话（Web/Desktop，不在 QQ 会话表里）不受影响。
 */
import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type { ImQQBotConfig } from '../config.ts';
import type { ChatScope } from '../types.ts';

/** 终端类工具：命令字符串里可以读任何东西，受限会话一律不给 */
const SHELL_TOOLS = new Set([
  'pwsh', 'bash',
  'terminal_open', 'terminal_send', 'terminal_read', 'terminal_list', 'terminal_signal', 'terminal_close',
]);

/** 派生子 agent / 后台流程的工具：子 agent 查不到所属 QQ 会话，会绕过拦截 */
const AGENT_TOOLS = new Set([
  'subagent', 'subagent_fork', 'workflow', 'spawn_teammate', 'ralph', 'create_worktree',
]);

/** 带路径参数的文件工具 → 参数里哪些字段是路径 */
const PATH_TOOLS: Record<string, readonly string[]> = {
  read: ['file_path', 'path'],
  read_image: ['file_path', 'path'],
  write: ['file_path', 'path'],
  edit: ['file_path', 'path'],
  str_replace_editor: ['path'],
  glob: ['path', 'root', 'paths'],
  grep: ['path', 'root', 'paths'],
  qqbot_send_file: ['file_path'],
};

/** 不给 path 就会默认搜整个工作目录的工具 */
const NEEDS_EXPLICIT_PATH = new Set(['glob', 'grep']);

/** 搜索类工具里写成路径通配的过滤参数：不许带 .. 或绝对路径跳出 path（grep 的 pattern 是正则，不算） */
const FILTER_KEYS: Record<string, readonly string[]> = {
  glob: ['pattern'],
  grep: ['glob', 'include'],
};

export interface ToolGuardSession {
  scope: ChatScope;
  peerId: string;
}

/** 运行时授予的白名单（聊天里由主人确认加入的） */
export interface ToolAccessGrants {
  readonly groups: readonly string[];
  readonly users: readonly string[];
}

export interface ToolGuardDeps {
  config: ImQQBotConfig;
  /** 会话是否有完整工具权限（配置 + 运行时白名单） */
  isFullAccess(session: ToolGuardSession): boolean;
  findSession(agent: unknown): ToolGuardSession | undefined;
  /** 受限会话可读写的根目录（media、表情库、临时目录 + toolAccess.readRoots） */
  roots: readonly string[];
  /** 相对路径按它解析（agent 工作目录） */
  cwd: string;
  /**
   * 所有 QQ 会话（含白名单）都不能用文件工具写的目录：跑团存档只能经 dnd_* 工具改，
   * 模型手改 JSON 会绕过规则校验和 undo 快照。终端命令照旧拦不住，白名单会话本来就信任。
   */
  noWriteRoots?: readonly string[];
}

/** 会改文件的工具 */
const WRITE_TOOLS = new Set(['write', 'edit', 'str_replace_editor']);

interface GuardedExecution {
  readonly name: string;
  readonly arguments: unknown;
  readonly agent?: unknown;
}

/** 这个 QQ 会话是否有完整工具权限（终端 + 任意路径） */
export function hasFullToolAccess(session: ToolGuardSession, config: ImQQBotConfig, grants?: ToolAccessGrants): boolean {
  const access = config.toolAccess;
  if (access === undefined || !access.enabled) return true;
  if (session.scope === 'group') {
    return access.fullAccessGroups.includes(session.peerId) || (grants?.groups.includes(session.peerId) ?? false);
  }
  const owner = config.ownerOpenid?.trim();
  return (owner !== undefined && owner !== '' && session.peerId === owner)
    || access.fullAccessUsers.includes(session.peerId)
    || (grants?.users.includes(session.peerId) ?? false);
}

/** 解析符号链接：路径不存在时取最近的已存在祖先再拼回去 */
export function canonical(path: string): string {
  let current = resolve(path);
  const tail: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return resolve(path);
    tail.unshift(relative(parent, current));
    current = parent;
  }
  try {
    return resolve(realpathSync.native(current), ...tail);
  } catch {
    return resolve(path);
  }
}

function isWithin(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function pathArgs(args: unknown, keys: readonly string[]): string[] {
  if (args === null || typeof args !== 'object') return [];
  const record = args as Record<string, unknown>;
  const paths: string[] = [];
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') paths.push(value);
    if (Array.isArray(value)) paths.push(...value.filter((v): v is string => typeof v === 'string' && v.trim() !== ''));
  }
  return paths;
}

function escapesFilter(name: string, args: unknown): boolean {
  if (args === null || typeof args !== 'object') return false;
  const record = args as Record<string, unknown>;
  return (FILTER_KEYS[name] ?? []).some((key) => {
    const value = record[key];
    return typeof value === 'string' && (/(^|[\\/])\.\.([\\/]|$)/.test(value) || isAbsolute(value) || /^[a-z]:/i.test(value));
  });
}

const DENY_SHELL = '本会话没有终端权限（只有白名单群和主人私聊能用命令行）。不要换别的工具绕过，直接告诉用户这里做不到。';
const DENY_AGENT = '本会话不能派生子 agent 或后台流程（只有白名单群和主人私聊可以）。直接用现有工具完成，或告诉用户做不到。';
const DENY_PATH = '本会话只能访问 bot 自己的媒体、表情和临时目录，这个路径不在允许范围内。不要再尝试别的路径，也别把路径告诉用户。';
const DENY_NO_PATH = '本会话搜索文件时必须用 path 指定 bot 的媒体、表情或临时目录，不能搜整个工作目录。';
const DENY_SENSITIVE = '这个路径在敏感路径名单里，禁止访问。不要再尝试，也别把路径告诉用户。';
const DENY_NO_WRITE = '跑团存档只能通过 dnd_* 工具修改，不能直接改文件。工具做不到的，在回复里说明，让主人处理。';

/** 构造给 tools.guard() 用的拦截函数；返回字符串即拒绝 */
export function createToolGuard(deps: ToolGuardDeps): (exec: GuardedExecution) => string | undefined {
  const roots = deps.roots.map((root) => canonical(resolve(deps.cwd, root)));
  const sensitive = (deps.config.fileAccess?.sensitivePaths ?? [])
    .filter((p) => p.trim() !== '')
    .map((p) => canonical(resolve(deps.cwd, p)));
  const noWrite = (deps.noWriteRoots ?? []).map((p) => canonical(resolve(deps.cwd, p)));

  return (exec) => {
    if (exec.agent === undefined) return undefined;
    const session = deps.findSession(exec.agent);
    if (session === undefined) return undefined; // 本机会话

    const pathKeys = PATH_TOOLS[exec.name];
    const paths = pathKeys === undefined
      ? []
      : pathArgs(exec.arguments, pathKeys).map((p) => canonical(resolve(deps.cwd, p)));
    if (paths.some((p) => sensitive.some((root) => isWithin(p, root)))) return DENY_SENSITIVE;
    if (WRITE_TOOLS.has(exec.name) && paths.some((p) => noWrite.some((root) => isWithin(p, root)))) return DENY_NO_WRITE;

    if (deps.isFullAccess(session)) return undefined;

    if (SHELL_TOOLS.has(exec.name)) return DENY_SHELL;
    if (AGENT_TOOLS.has(exec.name)) return DENY_AGENT;
    if (pathKeys === undefined) return undefined;

    if (paths.length === 0 && NEEDS_EXPLICIT_PATH.has(exec.name)) return DENY_NO_PATH;
    if (escapesFilter(exec.name, exec.arguments)) return DENY_PATH;
    if (paths.some((p) => !roots.some((root) => isWithin(p, root)))) return DENY_PATH;
    return undefined;
  };
}
