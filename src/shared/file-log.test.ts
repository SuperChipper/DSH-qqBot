import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { formatLogLine, installFileLog, pruneLogs, type LogMessage } from './file-log.ts';

describe('file log', () => {
  it('格式化：时间、级别、来源，%s 和对象照 util.format 展开', () => {
    const ts = new Date(2026, 9, 29, 1, 2, 3, 4).getTime();
    expect(formatLogLine({ ts, type: 'info', name: 'im-qqbot', args: ['a=%s', 1, { b: 2 }] }))
      .toBe('01:02:03.004 [info] im-qqbot: a=1 { b: 2 }\n');
  });

  it('只删超过保留天数的日志文件', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qqlog-'));
    for (const name of ['2026-10-20.log', '2026-10-25.log', 'notes.txt']) writeFileSync(join(dir, name), '');
    pruneLogs(dir, new Date(2026, 9, 29).getTime(), 7);
    expect(existsSync(join(dir, '2026-10-20.log'))).toBe(false);
    expect(existsSync(join(dir, '2026-10-25.log'))).toBe(true);
    expect(existsSync(join(dir, 'notes.txt'))).toBe(true);
  });

  it('挂到 logger 的 exporter 上按天写文件；不是 cordis logger 时什么都不做', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qqlog-'));
    let registered: { levels?: Record<string, number>; export: (m: LogMessage) => void } | undefined;
    installFileLog({ exporter: (e: typeof registered) => { registered = e; } }, false, dir);
    expect(registered?.levels).toEqual({ default: 2 });
    const ts = new Date(2026, 9, 29, 12).getTime();
    registered!.export({ ts, type: 'warn', name: 'im-qqbot', args: ['reply-judge: 打分失败'] });
    expect(readFileSync(join(dir, '2026-10-29.log'), 'utf8')).toContain('[warn] im-qqbot: reply-judge: 打分失败');
    expect(() => installFileLog(console, false, dir)).not.toThrow();
  });
});
