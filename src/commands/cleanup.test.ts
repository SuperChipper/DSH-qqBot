import { describe, expect, it } from 'vitest';
import type { ImQQBotConfig } from '../config.ts';
import { cleanupCommand, renderCleanupReport } from './cleanup.ts';

const config = { ownerOpenid: 'owner', adminOpenids: ['admin'] } as unknown as ImQQBotConfig;

function ctx(senderId: string) {
  return { command: { name: 'bot-cleanup', args: [], raw: '' }, message: { senderId } } as never;
}

describe('/bot-cleanup', () => {
  it('仅 owner/admin 可用', () => {
    const cmd = cleanupCommand({ manager: {} as never, config });
    expect(cmd.authorized?.(ctx('stranger'))).toMatch(/只有/);
    expect(cmd.authorized?.(ctx('admin'))).toBe(true);
    expect(cmd.authorized?.(ctx('owner'))).toBe(true);
  });

  it('报告列出占用、限制、本轮删除和试跑条目', () => {
    const text = renderCleanupReport(
      {
        at: Date.now(),
        dryRun: true,
        results: [
          { rule: 'tmp', dir: '/x', removed: 0, freedBytes: 0, remaining: 3, remainingBytes: 3 * 1024 ** 3, wouldRemove: ['asr-whisper'] },
          { rule: 'media', dir: '/m', removed: 2, freedBytes: 1024 * 1024, remaining: 10, remainingBytes: 5 * 1024 * 1024, wouldRemove: [] },
        ],
      },
      [{ name: 'tmp', ttlHours: 72, maxTotalMB: 4096 }, { name: 'media', ttlHours: 24 }],
    );
    expect(text).toContain('清理试跑');
    expect(text).toContain('· tmp：3 项 3.0GB（72h，上限 4.0GB）');
    expect(text).toContain('会删：asr-whisper');
    expect(text).toContain('· media：10 项 5.0MB（24h），本轮删 2 项 1.0MB');
  });
});
