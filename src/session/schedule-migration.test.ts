import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  formatScheduleMigrationHint,
  readScheduleMigrations,
  retireMigratedSchedules,
  type ScheduleServiceLike,
} from './schedule-migration.ts';
import { SessionManager } from './session-manager.ts';

const dirs: string[] = [];
function homeWith(tasks: Record<string, unknown>): string {
  const home = mkdtempSync(join(tmpdir(), 'dsh-schedule-'));
  dirs.push(home);
  mkdirSync(join(home, 'storages'));
  writeFileSync(join(home, 'storages', 'schedule.json'), JSON.stringify({ tables: { tasks } }), 'utf8');
  return home;
}
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const oldSession = 'old-session';

describe('schedule migration', () => {
  it('只迁移旧 session 的 active daily/weekly/every 任务', () => {
    const home = homeWith({
      a: {
        sessionId: oldSession,
        status: 'active',
        record: { kind: 'daily', title: '早报', prompt: '读 RSS 写简报', time: '11:00:00.000', timeZone: 'Asia/Shanghai' },
      },
      b: {
        sessionId: oldSession,
        status: 'active',
        record: { kind: 'every', title: '新图', prompt: '查新图', everySeconds: 7200 },
      },
      c: {
        sessionId: oldSession,
        status: 'active',
        record: { kind: 'weekly', prompt: '周报', time: '20:00:00', timeZone: 'Asia/Shanghai', weekdays: [7] },
      },
      d: { sessionId: 'other', status: 'active', record: { kind: 'daily', prompt: 'x', time: '10:00:00' } },
      e: { sessionId: oldSession, status: 'inactive', record: { kind: 'daily', prompt: 'x', time: '10:00:00' } },
      f: { sessionId: oldSession, status: 'active', record: { kind: 'after', prompt: '一次性', afterSeconds: 60 } },
    });

    const tasks = readScheduleMigrations(home, oldSession);
    expect(tasks).toHaveLength(3);
    expect(tasks[0]).toMatchObject({ title: '早报', prompt: '读 RSS 写简报', daily: { time: '11:00:00.000', time_zone: 'Asia/Shanghai' } });
    expect(tasks[1]).toMatchObject({ every_seconds: 7200 });
    expect(tasks[2]).toMatchObject({ weekly: { time: '20:00:00', weekdays: [7] } });
  });

  it('缺失/损坏存储返回空数组，hint 为空', () => {
    expect(readScheduleMigrations(join(tmpdir(), 'no-such-dsh-home'), oldSession)).toEqual([]);
    expect(formatScheduleMigrationHint([])).toBeUndefined();
  });

  it('生成包含 schedule_create 指令和 JSON 的 hint', () => {
    const hint = formatScheduleMigrationHint([
      { title: '早报', prompt: '读 RSS', daily: { time: '11:00:00', time_zone: 'Asia/Shanghai' } },
    ]);
    expect(hint).toContain('schedule_list');
    expect(hint).toContain('schedule_create');
    expect(hint).toContain('"daily": {');
    expect(hint).toContain('"prompt": "读 RSS"');
  });

  it('记录旧任务 id，但 hint 里不暴露', () => {
    const home = homeWith({
      'schedule-a': {
        sessionId: oldSession,
        status: 'active',
        record: { id: 'schedule-a', kind: 'daily', title: '早报', prompt: '读 RSS', time: '11:00:00', timeZone: 'Asia/Shanghai' },
      },
    });
    const tasks = readScheduleMigrations(home, oldSession);
    expect(tasks[0]?.sourceId).toBe('schedule-a');
    expect(formatScheduleMigrationHint(tasks)).not.toContain('schedule-a');
  });

  it('retireMigratedSchedules 只删旧 session 里被迁移的任务', async () => {
    const remove = vi.fn(async () => ({ deleted: true }));
    const count = await retireMigratedSchedules({ delete: remove }, oldSession, [
      { title: '早报', prompt: 'x', every_seconds: 600, sourceId: 'schedule-a' },
      { title: '无 id', prompt: 'y', every_seconds: 600 },
    ]);
    expect(count).toBe(1);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith({ sessionId: oldSession, id: 'schedule-a' });
  });
});

describe('SessionManager schedule migration', () => {
  function harness(schedule: ScheduleServiceLike | undefined) {
    // 只测迁移逻辑：用最小的 this 调用原型方法
    const proto = SessionManager.prototype as unknown as {
      captureScheduleMigrations(key: string, oldSessionId: string): void;
      takeScheduleMigration(scope: string, peerId: string): string | undefined;
      getScheduleService(): ScheduleServiceLike | undefined;
    };
    const self = {
      pendingScheduleMigrations: new Map(),
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      ctx: { get: (name: string) => (name === 'schedule' ? schedule : undefined) },
      sessionKey: (scope: string, peerId: string) => `${scope}:${peerId}`,
      getScheduleService: proto.getScheduleService,
    };
    return {
      capture: (oldSessionId: string) => proto.captureScheduleMigrations.call(self, 'group:g1', oldSessionId),
      take: () => proto.takeScheduleMigration.call(self, 'group', 'g1'),
      logger: self.logger,
    };
  }

  const dailyTask = (id: string, sessionId: string) => ({
    sessionId,
    status: 'active',
    record: { id, kind: 'daily', title: `早报-${id}`, prompt: '读 RSS', time: '11:00:00', timeZone: 'Asia/Shanghai' },
  });

  it('/new 后交出重建指令时删除旧 session 的任务，避免新旧会话重复触发', async () => {
    vi.stubEnv('DSH_HOME', homeWith({
      'schedule-a': dailyTask('schedule-a', oldSession),
      'schedule-cron': { sessionId: oldSession, status: 'active', record: { id: 'schedule-cron', kind: 'cron', prompt: 'c' } },
      'schedule-other': dailyTask('schedule-other', 'other'),
    }));
    const remove = vi.fn(async () => ({ deleted: true }));
    const { capture, take } = harness({ delete: remove });

    capture(oldSession);
    // /new 本身不删：新会话还没重建前，旧任务继续生效
    expect(remove).not.toHaveBeenCalled();

    const hint = take();
    expect(hint).toContain('早报-schedule-a');
    await vi.waitFor(() => expect(remove).toHaveBeenCalledTimes(1));
    expect(remove).toHaveBeenCalledWith({ sessionId: oldSession, id: 'schedule-a' });

    // 只交出一次，也只删一次
    expect(take()).toBeUndefined();
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('连续 /new 时不丢前一批，按各自旧 sessionId 删除', async () => {
    vi.stubEnv('DSH_HOME', homeWith({ 'schedule-a': dailyTask('schedule-a', oldSession) }));
    const remove = vi.fn(async () => ({ deleted: true }));
    const { capture, take } = harness({ delete: remove });

    capture(oldSession);
    capture('middle-session-without-tasks');
    expect(take()).toContain('早报-schedule-a');
    await vi.waitFor(() => expect(remove).toHaveBeenCalledWith({ sessionId: oldSession, id: 'schedule-a' }));
  });

  it('没有 schedule 服务时仍给出 hint 并告警', () => {
    vi.stubEnv('DSH_HOME', homeWith({ 'schedule-a': dailyTask('schedule-a', oldSession) }));
    const { capture, take, logger } = harness(undefined);
    capture(oldSession);
    expect(take()).toContain('早报-schedule-a');
    expect(logger.warn).toHaveBeenCalled();
  });
});
