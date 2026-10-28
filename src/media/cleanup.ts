/**
 * 统一的过期文件清理 — 按规则定期回收 media / tmp / 用户指定目录里的文件。
 *
 * 每条规则：
 *   - unit 'file'：每个文件单独按 mtime 判断（media 这种只写一次的目录）；
 *   - unit 'entry'：每个顶层条目整体判断，取子树里最新的 mtime（tmp 这种一次任务一个文件夹的目录），
 *     避免把一个还在用的任务目录删掉一半；
 *   - keep：命中的文件/条目永不删除（如 seen.json、*.log 状态文件）；match：只处理命中的条目；
 *   - ttlHours：超过就删（0 = 不按时间删）；maxTotalMB：总量超过上限时从最旧的开始删（0 = 不限）。
 *
 * 安全：不跟随符号链接；最近 MIN_AGE_MS 内改动过的条目即使超量也不删（可能是正在跑的任务）；
 * 用户配置的规则目录必须严格位于 cwd / 插件目录 / 系统临时目录之内，否则忽略。
 * 启动时跑一次，之后每小时一次；dryRun 只记日志不删除。
 */
import { existsSync, realpathSync } from 'node:fs';
import { lstat, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { CleanupRuleConfig, ImQQBotConfig } from '../config.ts';
import type { Logger } from '../types.ts';
import { PLUGIN_ROOT } from '../shared/index.ts';
import { MEDIA_ROOT } from './media-cleaner.ts';
import { resolveTmpDir } from './tmp-dir.ts';

/** 定期清理间隔（毫秒），固定 1 小时 */
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
/** 超量删除时跳过最近这么久内改动过的条目，避免删掉正在写的任务目录 */
const MIN_AGE_MS = 10 * 60 * 1000;

/** 一条清理规则（已解析为绝对路径） */
export interface CleanupRule {
  /** 规则名（日志 / 报告里显示） */
  name: string;
  dir: string;
  unit: 'file' | 'entry';
  /** 超过多少小时未改动就删除（0 = 不按时间删） */
  ttlHours: number;
  /** unit 'file' 时是否进入子目录 */
  recursive?: boolean;
  /** 命中则永不删除（按文件/条目名匹配，支持 * 和 ?） */
  keep?: string[];
  /** 非空时只处理命中的条目 */
  match?: string[];
  /** 总量上限（MB），超出时从最旧的开始删（0 = 不限） */
  maxTotalMB?: number;
}

/** 单条规则一次清理的结果 */
export interface CleanupResult {
  rule: string;
  dir: string;
  removed: number;
  freedBytes: number;
  /** 清理后剩余（只算规则管辖的文件，不含 keep） */
  remaining: number;
  remainingBytes: number;
  /** dryRun 时本来会删的条目 */
  wouldRemove: string[];
  error?: string;
}

/** 一个可回收单位：文件或顶层条目 */
interface Candidate {
  path: string;
  name: string;
  mtimeMs: number;
  bytes: number;
}

/** 简单通配：* 任意串、? 单字符，大小写不敏感（Windows 文件名不区分大小写） */
export function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

function matchesAny(name: string, patterns: readonly string[] | undefined): boolean {
  return (patterns ?? []).some(p => globToRegExp(p).test(name));
}

/** 子树的最新 mtime 与总字节数（lstat，不跟随符号链接）；读不到按「刚改过」处理，避免误删 */
async function measure(path: string, now: number): Promise<{ mtimeMs: number; bytes: number }> {
  let info;
  try {
    info = await lstat(path);
  } catch {
    return { mtimeMs: now, bytes: 0 };
  }
  if (!info.isDirectory()) return { mtimeMs: info.mtimeMs, bytes: info.isFile() ? info.size : 0 };
  let mtimeMs = info.mtimeMs;
  let bytes = 0;
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch {
    return { mtimeMs: now, bytes: 0 };
  }
  for (const entry of entries) {
    const sub = await measure(join(path, entry.name), now);
    mtimeMs = Math.max(mtimeMs, sub.mtimeMs);
    bytes += sub.bytes;
  }
  return { mtimeMs, bytes };
}

/** 列出 unit 'file' 的候选文件（可递归；keep 命中的不列入） */
async function listFiles(dir: string, rule: CleanupRule, out: Candidate[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (rule.recursive) await listFiles(path, rule, out);
      continue;
    }
    if (!entry.isFile() || matchesAny(entry.name, rule.keep)) continue;
    if (rule.match?.length && !matchesAny(entry.name, rule.match)) continue;
    const info = await lstat(path);
    out.push({ path, name: relative(rule.dir, path), mtimeMs: info.mtimeMs, bytes: info.size });
  }
}

/** 列出 unit 'entry' 的候选顶层条目 */
async function listEntries(rule: CleanupRule, now: number): Promise<Candidate[]> {
  const out: Candidate[] = [];
  for (const entry of await readdir(rule.dir, { withFileTypes: true })) {
    if (matchesAny(entry.name, rule.keep)) continue;
    if (rule.match?.length && !matchesAny(entry.name, rule.match)) continue;
    const path = join(rule.dir, entry.name);
    out.push({ path, name: entry.name, ...(await measure(path, now)) });
  }
  return out;
}

/** 按一条规则清理一次 */
export async function runCleanupRule(
  rule: CleanupRule,
  options: { dryRun?: boolean; logger?: Logger; now?: number } = {},
): Promise<CleanupResult> {
  const now = options.now ?? Date.now();
  const result: CleanupResult = {
    rule: rule.name, dir: rule.dir, removed: 0, freedBytes: 0, remaining: 0, remainingBytes: 0, wouldRemove: [],
  };
  if (!existsSync(rule.dir)) return result;

  let candidates: Candidate[];
  try {
    if (rule.unit === 'entry') {
      candidates = await listEntries(rule, now);
    } else {
      candidates = [];
      await listFiles(rule.dir, rule, candidates);
    }
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    return result;
  }

  const ttlMs = rule.ttlHours * 60 * 60 * 1000;
  const doomed = new Set<Candidate>();
  if (rule.ttlHours > 0) {
    for (const c of candidates) if (now - c.mtimeMs > ttlMs) doomed.add(c);
  }

  const capBytes = (rule.maxTotalMB ?? 0) * 1024 * 1024;
  if (capBytes > 0) {
    let total = candidates.filter(c => !doomed.has(c)).reduce((sum, c) => sum + c.bytes, 0);
    const oldestFirst = candidates.filter(c => !doomed.has(c)).sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const c of oldestFirst) {
      if (total <= capBytes) break;
      if (now - c.mtimeMs < MIN_AGE_MS) continue;
      doomed.add(c);
      total -= c.bytes;
    }
  }

  for (const c of candidates) {
    if (!doomed.has(c)) {
      result.remaining++;
      result.remainingBytes += c.bytes;
      continue;
    }
    if (options.dryRun) {
      result.wouldRemove.push(c.name);
      result.remaining++;
      result.remainingBytes += c.bytes;
      continue;
    }
    try {
      await rm(c.path, { recursive: true, force: true });
      result.removed++;
      result.freedBytes += c.bytes;
      options.logger?.debug(`im-qqbot: cleanup[${rule.name}] removed ${c.name}`);
    } catch (err) {
      result.remaining++;
      result.remainingBytes += c.bytes;
      options.logger?.warn(`im-qqbot: cleanup[${rule.name}] failed for ${c.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return result;
}

/** 解析真实路径（不存在时退回 resolve 结果） */
function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** child 是否严格位于 parent 之内（相同目录不算） */
export function isStrictlyInside(child: string, parent: string): boolean {
  const rel = relative(real(parent), real(child));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/** 用户配置的规则 → 绝对路径规则；目录不在允许范围内的忽略并告警 */
export function resolveUserRules(
  rules: readonly CleanupRuleConfig[],
  cwd: string,
  logger?: Logger,
  allowedRoots: readonly string[] = [cwd, PLUGIN_ROOT, tmpdir()],
): CleanupRule[] {
  const out: CleanupRule[] = [];
  for (const [i, r] of rules.entries()) {
    const dir = isAbsolute(r.dir) ? r.dir : resolve(cwd, r.dir);
    if (!r.dir || !allowedRoots.some(root => isStrictlyInside(dir, root))) {
      logger?.warn(`im-qqbot: cleanup.rules[${i}] 已忽略：${dir} 不在工作目录/插件目录/系统临时目录之内`);
      continue;
    }
    out.push({
      name: r.name || r.dir,
      dir,
      unit: r.unit,
      ttlHours: r.ttlHours,
      recursive: r.recursive,
      keep: r.keep,
      match: r.match,
      maxTotalMB: r.maxTotalMB,
    });
  }
  return out;
}

/** 内置规则 + 用户规则 */
export function buildCleanupRules(config: ImQQBotConfig, logger?: Logger): CleanupRule[] {
  const rules: CleanupRule[] = [];
  if (config.media.enabled) {
    rules.push({
      name: 'media', dir: MEDIA_ROOT, unit: 'file',
      ttlHours: config.media.ttlHours, maxTotalMB: config.media.maxTotalMB ?? 0,
    });
    // 发过的同人图只需 seen*.json 去重，图片本身不再读取
    rules.push({ name: 'media/fanart', dir: join(MEDIA_ROOT, 'fanart'), unit: 'file', ttlHours: 7 * 24, keep: ['*.json'] });
  }
  rules.push({
    name: 'tmp', dir: resolveTmpDir(config), unit: 'entry',
    ttlHours: config.tmpTtlHours ?? 72, maxTotalMB: config.tmpMaxTotalMB ?? 0,
  });
  // qqbot_describe_video 的工作目录正常会在 finally 里删，进程崩溃时才会遗留
  rules.push({ name: 'video-work', dir: tmpdir(), unit: 'entry', ttlHours: 1, match: ['qqbot-video-*'] });
  rules.push(...resolveUserRules(config.cleanup?.rules ?? [], config.cwd || process.cwd(), logger));
  return rules;
}

/** 一轮清理的报告 */
export interface CleanupReport {
  at: number;
  dryRun: boolean;
  results: CleanupResult[];
}

/** 字节数格式化 */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)}GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${bytes}B`;
}

/** 清理服务：持有规则、跑定时任务、保留最近一次报告（供 /bot-cleanup 查看） */
export class CleanupService {
  private last?: CleanupReport;
  private running?: Promise<CleanupReport>;

  constructor(
    readonly rules: readonly CleanupRule[],
    private readonly dryRun: boolean,
    private readonly logger: Logger,
  ) {}

  get lastReport(): CleanupReport | undefined {
    return this.last;
  }

  /** 跑一轮（并发调用合并为同一轮）；dryRun 参数可临时覆盖配置 */
  run(dryRun = this.dryRun): Promise<CleanupReport> {
    if (this.running) return this.running;
    this.running = (async () => {
      const results: CleanupResult[] = [];
      for (const rule of this.rules) {
        const r = await runCleanupRule(rule, { dryRun, logger: this.logger });
        results.push(r);
        if (r.error) this.logger.warn(`im-qqbot: cleanup[${rule.name}] failed: ${r.error}`);
        if (r.removed > 0) this.logger.info(`im-qqbot: cleanup[${rule.name}] removed ${r.removed} (${formatBytes(r.freedBytes)})`);
        if (r.wouldRemove.length > 0) this.logger.info(`im-qqbot: cleanup[${rule.name}] dry run, would remove: ${r.wouldRemove.join(', ')}`);
      }
      const report = { at: Date.now(), dryRun, results };
      if (!dryRun) this.last = report;
      return report;
    })().finally(() => { this.running = undefined; });
    return this.running;
  }
}

let service: CleanupService | undefined;

/** 当前的清理服务（插件未启动时为 undefined） */
export function getCleanupService(): CleanupService | undefined {
  return service;
}

/** 启动清理：立即跑一次，之后每小时一次 */
export function startCleanup(ctx: Context, config: ImQQBotConfig, logger: Logger): CleanupService {
  const rules = buildCleanupRules(config, logger);
  const current = new CleanupService(rules, config.cleanup?.dryRun ?? false, logger);
  service = current;
  logger.info(`im-qqbot: cleanup started (${rules.map(r => r.name).join(', ')}; interval=1h${config.cleanup?.dryRun ? ', dry run' : ''})`);

  const run = (): void => {
    void current.run().catch((err) => {
      logger.warn(`im-qqbot: cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  };
  run();

  (ctx as unknown as { effect(fn: () => (() => Promise<void>) | void, name?: string): void })
    .effect(() => {
      const timer = setInterval(run, CLEANUP_INTERVAL_MS);
      return async () => {
        clearInterval(timer);
        if (service === current) service = undefined;
      };
    }, 'im-qqbot.cleanup');
  return current;
}
