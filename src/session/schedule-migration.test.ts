import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { formatScheduleMigrationHint, readScheduleMigrations } from './schedule-migration.ts';

const dirs: string[] = [];
function homeWith(tasks: Record<string, unknown>): string {
  const home = mkdtempSync(join(tmpdir(), 'dsh-schedule-'));
  dirs.push(home);
  mkdirSync(join(home, 'storages'));
  writeFileSync(join(home, 'storages', 'schedule.json'), JSON.stringify({ tables: { tasks } }), 'utf8');
  return home;
}
afterEach(() => {
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
});
