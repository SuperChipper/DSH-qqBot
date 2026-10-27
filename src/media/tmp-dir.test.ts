import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { cleanupTmpDir, resolveTmpDir } from './tmp-dir.ts';

const HOUR = 60 * 60 * 1000;

/** 把文件/目录的 mtime 设为 now - hoursAgo */
function age(path: string, now: number, hoursAgo: number): void {
  const t = new Date(now - hoursAgo * HOUR);
  utimesSync(path, t, t);
}

describe('resolveTmpDir', () => {
  it('默认 cwd/tmp；相对路径按 cwd；绝对路径原样', () => {
    expect(resolveTmpDir({ cwd: 'C:/w', tmpDir: '' })).toBe(resolve('C:/w', 'tmp'));
    expect(resolveTmpDir({ cwd: 'C:/w', tmpDir: 'scratch' })).toBe(resolve('C:/w', 'scratch'));
    expect(resolveTmpDir({ cwd: 'C:/w', tmpDir: 'D:/t' })).toBe('D:/t');
  });
});

describe('cleanupTmpDir', () => {
  it('删除整体过期的顶层文件/目录，保留仍在用的', async () => {
    const now = Date.now();
    const root = mkdtempSync(join(tmpdir(), 'tmpdir-'));

    writeFileSync(join(root, 'old.png'), 'x');
    age(join(root, 'old.png'), now, 100);

    writeFileSync(join(root, 'fresh.mjs'), 'x');
    age(join(root, 'fresh.mjs'), now, 1);

    // 旧目录：里面全是旧文件 → 整体删除
    mkdirSync(join(root, 'asr-old', 'deep'), { recursive: true });
    writeFileSync(join(root, 'asr-old', 'deep', 'a.wav'), 'x');
    age(join(root, 'asr-old', 'deep', 'a.wav'), now, 200);
    age(join(root, 'asr-old', 'deep'), now, 200);
    age(join(root, 'asr-old'), now, 200);

    // 目录本身旧，但深处有新文件 → 整体保留
    mkdirSync(join(root, 'frames', 'sub'), { recursive: true });
    writeFileSync(join(root, 'frames', 'old.png'), 'x');
    age(join(root, 'frames', 'old.png'), now, 200);
    writeFileSync(join(root, 'frames', 'sub', 'new.png'), 'x');
    age(join(root, 'frames', 'sub', 'new.png'), now, 2);
    age(join(root, 'frames', 'sub'), now, 200);
    age(join(root, 'frames'), now, 200);

    const removed = await cleanupTmpDir(root, 72, undefined, now);

    expect(removed).toBe(2);
    expect(existsSync(join(root, 'old.png'))).toBe(false);
    expect(existsSync(join(root, 'asr-old'))).toBe(false);
    expect(existsSync(join(root, 'fresh.mjs'))).toBe(true);
    expect(existsSync(join(root, 'frames', 'old.png'))).toBe(true);
  });

  it('ttl<=0 或目录不存在时什么都不做', async () => {
    expect(await cleanupTmpDir(join(tmpdir(), 'no-such-tmp-dir-xyz'), 72)).toBe(0);
    const root = mkdtempSync(join(tmpdir(), 'tmpdir-'));
    writeFileSync(join(root, 'a'), 'x');
    age(join(root, 'a'), Date.now(), 1000);
    expect(await cleanupTmpDir(root, 0)).toBe(0);
    expect(existsSync(join(root, 'a'))).toBe(true);
  });
});
