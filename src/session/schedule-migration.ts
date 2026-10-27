/**
 * /new 定时任务迁移：从 DSH 的 schedule 存储里读出旧 session 的 active 任务，
 * 生成给模型的重建指令（模型在新会话里调用 schedule_create）。
 *
 * 不直接改 schedule 存储：schedule 是 session-local 的，迁移由新会话的
 * schedule_create 工具正式写入，避免破坏持久化状态。
 *
 * DSH 会把任务投递回它的原 session（即使该 session 已被 /new 替换），所以
 * 交出重建指令时必须经宿主 schedule 服务删掉旧 session 里被迁移的任务，
 * 否则新旧两份会同时触发。
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 当前 DSH 家目录（schedule 存储所在处） */
export function scheduleStorageHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh');
}

export interface ScheduleMigrationTask {
  prompt: string;
  title: string;
  daily?: { time: string; time_zone: string };
  weekly?: { time: string; time_zone: string; weekdays: number[] };
  every_seconds?: number;
  /** 旧 session 中原任务的 id（只用于迁移后删除旧任务，不进 hint） */
  sourceId?: string;
}

/** 宿主 `schedule` 服务中迁移需要的最小接口 */
export interface ScheduleServiceLike {
  delete(request: { sessionId: string; id: string }): Promise<{ deleted: boolean }>;
}

interface StoredTask {
  sessionId?: unknown;
  status?: unknown;
  record?: {
    id?: unknown;
    kind?: unknown;
    title?: unknown;
    prompt?: unknown;
    time?: unknown;
    timeZone?: unknown;
    weekdays?: unknown;
    everySeconds?: unknown;
    afterSeconds?: unknown;
    scheduledAt?: unknown;
  };
}

function taskOf(record: NonNullable<StoredTask['record']>): ScheduleMigrationTask | undefined {
  if (typeof record.prompt !== 'string' || record.prompt.trim().length === 0) return undefined;
  const title = typeof record.title === 'string' && record.title.trim().length > 0
    ? record.title.trim().slice(0, 120)
    : record.prompt.trim().slice(0, 40);
  const prompt = record.prompt.trim();
  const kind = record.kind;
  if (kind === 'daily') {
    if (typeof record.time !== 'string') return undefined;
    return {
      title,
      prompt,
      daily: {
        time: record.time,
        time_zone: typeof record.timeZone === 'string' ? record.timeZone : 'Asia/Shanghai',
      },
    };
  }
  if (kind === 'weekly') {
    if (typeof record.time !== 'string' || !Array.isArray(record.weekdays)) return undefined;
    return {
      title,
      prompt,
      weekly: {
        time: record.time,
        time_zone: typeof record.timeZone === 'string' ? record.timeZone : 'Asia/Shanghai',
        weekdays: record.weekdays.filter((day): day is number => typeof day === 'number' && Number.isInteger(day) && day >= 1 && day <= 7),
      },
    };
  }
  if (kind === 'every') {
    if (typeof record.everySeconds !== 'number' || record.everySeconds < 300) return undefined;
    return {
      title,
      prompt,
      every_seconds: record.everySeconds,
    };
  }
  // 一次性 after/at 不自动迁移（过期语义不明确），避免把旧的一次性提醒误重建。
  return undefined;
}

/** 读取旧 session 的 active 定时任务（缺失/损坏返回空数组） */
export function readScheduleMigrations(dshHome: string, sessionId: string): ScheduleMigrationTask[] {
  const path = join(dshHome, 'storages', 'schedule.json');
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      tables?: { tasks?: Record<string, StoredTask> };
    };
    const tasks = parsed.tables?.tasks;
    if (tasks === undefined || tasks === null || typeof tasks !== 'object') return [];
    const out: ScheduleMigrationTask[] = [];
    for (const [key, task] of Object.entries(tasks)) {
      if (task?.sessionId !== sessionId || task.status !== 'active' || task.record === undefined) continue;
      const migrated = taskOf(task.record);
      if (migrated === undefined) continue;
      migrated.sourceId = typeof task.record.id === 'string' ? task.record.id : key;
      out.push(migrated);
    }
    return out;
  } catch {
    return [];
  }
}

/** 给模型的重建指令；没有任务时返回 undefined */
export function formatScheduleMigrationHint(tasks: readonly ScheduleMigrationTask[]): string | undefined {
  if (tasks.length === 0) return undefined;
  return [
    '[SCHEDULE MIGRATION AFTER /new]',
    `旧会话有 ${tasks.length} 个 active 定时任务，已随 /new 失联。请在回答用户前，先调用 schedule_list 查看当前会话已有任务；`,
    '然后对下面每条调用 schedule_create（保留 title/prompt/时间；已存在的不要重复创建）：',
    '```json',
    JSON.stringify(tasks.map(({ sourceId: _sourceId, ...task }) => task), null, 2),
    '```',
    '重建完成后用一句话告诉用户；不要重复创建，也不要把这些任务当成用户的新指令。',
  ].join('\n');
}

/**
 * 删除旧 session 中已交给新会话重建的任务，避免同一任务在新旧会话重复触发。
 * 只删被迁移的任务（cron/一次性等未迁移的保留在旧 session 继续生效）。
 * @returns 实际删除的任务数
 */
export async function retireMigratedSchedules(
  service: ScheduleServiceLike,
  oldSessionId: string,
  tasks: readonly ScheduleMigrationTask[],
): Promise<number> {
  let deleted = 0;
  for (const task of tasks) {
    if (task.sourceId === undefined) continue;
    const result = await service.delete({ sessionId: oldSessionId, id: task.sourceId });
    if (result.deleted) deleted += 1;
  }
  return deleted;
}
