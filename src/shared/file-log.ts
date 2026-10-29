/**
 * 插件日志落盘 — ~/.dsh/qqbot-logs/YYYY-MM-DD.log，保留最近几天。
 *
 * dsh 不把插件的 logger.info/warn 打到终端，只留在进程内一个 1000 条的内存缓冲里
 * （启动期另收 warn/error），所以回复欲望打分、出站失败这类运行日志事后无处可查。
 * 这里给 cordis logger 挂一个 exporter 写文件；它随插件 fiber 注销，热重载不会重复写。
 */
import { appendFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { format } from 'node:util';

export interface LogMessage {
  ts: number;
  type: string;
  name: string;
  args: unknown[];
}

interface LoggerWithExporter {
  exporter(exporter: { levels?: Record<string, number>; export: (message: LogMessage) => void }): unknown;
}

const LOG_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.log$/;
const RETAIN_DAYS = 7;
/** cordis 的级别：error 0 / info 1 / warn 2 / debug 3，exporter 收 ≤ 这个级别的 */
const LEVEL_WARN = 2;
const LEVEL_DEBUG = 3;

export function defaultLogDir(): string {
  return join(homedir(), '.dsh', 'qqbot-logs');
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

function day(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function formatLogLine(message: LogMessage): string {
  const d = new Date(message.ts);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
  const args = message.args.map((arg) => (arg instanceof Error ? (arg.stack ?? arg.message) : arg));
  return `${time} [${message.type}] ${message.name}: ${format(...args)}\n`;
}

/** 删掉超过保留天数的日志文件 */
export function pruneLogs(dir: string, now: number, retainDays = RETAIN_DAYS): void {
  const cutoff = day(now - retainDays * 24 * 3600 * 1000);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const match = LOG_FILE_RE.exec(entry);
    if (match !== null && match[1]! < cutoff) rmSync(join(dir, entry), { force: true });
  }
}

/** 注册日志落盘；logger 不是 cordis logger（比如回落到 console）时什么都不做 */
export function installFileLog(logger: unknown, debug: boolean, dir = defaultLogDir()): void {
  const target = logger as Partial<LoggerWithExporter> | undefined;
  if (typeof target?.exporter !== 'function') return;
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    return;
  }
  pruneLogs(dir, Date.now());
  let currentDay = day(Date.now());
  target.exporter({
    levels: { default: debug ? LEVEL_DEBUG : LEVEL_WARN },
    export: (message) => {
      const today = day(message.ts);
      if (today !== currentDay) {
        currentDay = today;
        pruneLogs(dir, message.ts);
      }
      try {
        appendFileSync(join(dir, `${today}.log`), formatLogLine(message));
      } catch {
        // 写日志失败不能影响 bot 本身
      }
    },
  });
}
