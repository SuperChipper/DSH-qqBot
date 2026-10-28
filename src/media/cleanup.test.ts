import { existsSync, mkdirSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import {
  CleanupService,
  globToRegExp,
  isStrictlyInside,
  resolveUserRules,
  runCleanupRule,
  type CleanupRule,
} from './cleanup.ts';
import type { CleanupRuleConfig } from '../config.ts';

const HOUR = 60 * 60 * 1000;
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

/** 把文件/目录的 mtime 设为 now - hoursAgo */
function age(path: string, now: number, hoursAgo: number): void {
  const t = new Date(now - hoursAgo * HOUR);
  utimesSync(path, t, t);
}

function file(path: string, now: number, hoursAgo: number, bytes = 1): void {
  writeFileSync(path, 'x'.repeat(bytes));
  age(path, now, hoursAgo);
}

function root(): string {
  return mkdtempSync(join(tmpdir(), 'cleanup-test-'));
}

describe('runCleanupRule unit=entry', () => {
  it('删除整体过期的顶层文件/目录，保留仍在用的', async () => {
    const now = Date.now();
    const dir = root();
    file(join(dir, 'old.png'), now, 100);
    file(join(dir, 'fresh.mjs'), now, 1);

    // 旧目录：里面全是旧文件 → 整体删除
    mkdirSync(join(dir, 'asr-old', 'deep'), { recursive: true });
    file(join(dir, 'asr-old', 'deep', 'a.wav'), now, 200);
    age(join(dir, 'asr-old', 'deep'), now, 200);
    age(join(dir, 'asr-old'), now, 200);

    // 目录本身旧，但深处有新文件 → 整体保留
    mkdirSync(join(dir, 'frames', 'sub'), { recursive: true });
    file(join(dir, 'frames', 'old.png'), now, 200);
    file(join(dir, 'frames', 'sub', 'new.png'), now, 2);
    age(join(dir, 'frames', 'sub'), now, 200);
    age(join(dir, 'frames'), now, 200);

    const r = await runCleanupRule({ name: 'tmp', dir, unit: 'entry', ttlHours: 72 }, { now });

    expect(r.removed).toBe(2);
    expect(existsSync(join(dir, 'old.png'))).toBe(false);
    expect(existsSync(join(dir, 'asr-old'))).toBe(false);
    expect(existsSync(join(dir, 'fresh.mjs'))).toBe(true);
    expect(existsSync(join(dir, 'frames', 'old.png'))).toBe(true);
    expect(r.remaining).toBe(2);
  });

  it('match 只处理命中的条目', async () => {
    const now = Date.now();
    const dir = root();
    mkdirSync(join(dir, 'qqbot-video-abc'));
    file(join(dir, 'qqbot-video-abc', 'frames.jpg'), now, 5);
    age(join(dir, 'qqbot-video-abc'), now, 5);
    file(join(dir, 'someone-else.tmp'), now, 500);

    const r = await runCleanupRule({ name: 'v', dir, unit: 'entry', ttlHours: 1, match: ['qqbot-video-*'] }, { now });

    expect(r.removed).toBe(1);
    expect(existsSync(join(dir, 'qqbot-video-abc'))).toBe(false);
    expect(existsSync(join(dir, 'someone-else.tmp'))).toBe(true);
  });

  it('不跟随符号链接：链接到外部目录的条目只删链接本身', async () => {
    const now = Date.now();
    const dir = root();
    const outside = root();
    file(join(outside, 'precious.txt'), now, 500);
    try {
      symlinkSync(outside, join(dir, 'link'), 'junction');
    } catch {
      return; // 没有创建链接的权限时跳过
    }
    const r = await runCleanupRule({ name: 't', dir, unit: 'entry', ttlHours: 1 }, { now: now + 1000 * HOUR });
    expect(r.removed).toBe(1);
    expect(existsSync(join(outside, 'precious.txt'))).toBe(true);
  });
});

describe('runCleanupRule unit=file', () => {
  it('按文件 mtime 删除，keep 永不删除，默认不进子目录', async () => {
    const now = Date.now();
    const dir = root();
    file(join(dir, 'a.png'), now, 30);
    file(join(dir, 'b.png'), now, 2);
    file(join(dir, 'seen.json'), now, 900);
    mkdirSync(join(dir, 'fanart'));
    file(join(dir, 'fanart', 'old.jpg'), now, 900);

    const r = await runCleanupRule({ name: 'media', dir, unit: 'file', ttlHours: 24, keep: ['*.json'] }, { now });

    expect(r.removed).toBe(1);
    expect(existsSync(join(dir, 'a.png'))).toBe(false);
    expect(existsSync(join(dir, 'b.png'))).toBe(true);
    expect(existsSync(join(dir, 'seen.json'))).toBe(true);
    expect(existsSync(join(dir, 'fanart', 'old.jpg'))).toBe(true);
  });

  it('recursive 时进入子目录', async () => {
    const now = Date.now();
    const dir = root();
    mkdirSync(join(dir, 'sub'));
    file(join(dir, 'sub', 'old.cjs'), now, 100);
    file(join(dir, 'sub', 'poll.log'), now, 100);

    const r = await runCleanupRule(
      { name: 'state', dir, unit: 'file', ttlHours: 72, recursive: true, keep: ['*.log'] },
      { now },
    );
    expect(r.removed).toBe(1);
    expect(existsSync(join(dir, 'sub', 'old.cjs'))).toBe(false);
    expect(existsSync(join(dir, 'sub', 'poll.log'))).toBe(true);
  });

  it('超过 maxTotalMB 时从最旧的删，跳过 10 分钟内改动过的', async () => {
    const now = Date.now();
    const dir = root();
    const MB = 1024 * 1024;
    file(join(dir, 'oldest.bin'), now, 10, MB);
    file(join(dir, 'older.bin'), now, 5, MB);
    file(join(dir, 'newer.bin'), now, 1, MB);
    file(join(dir, 'just-written.bin'), now, 0.01, 2 * MB);

    // 总 5MB，上限 2MB：just-written 太新不删；删 oldest、older、newer 后剩 2MB
    const r = await runCleanupRule({ name: 'm', dir, unit: 'file', ttlHours: 0, maxTotalMB: 2 }, { now });

    expect(r.removed).toBe(3);
    expect(existsSync(join(dir, 'just-written.bin'))).toBe(true);
    expect(r.remainingBytes).toBe(2 * MB);
  });

  it('dryRun 只列出不删除；ttl=0 且无上限时什么都不删', async () => {
    const now = Date.now();
    const dir = root();
    file(join(dir, 'a.png'), now, 100);

    const dry = await runCleanupRule({ name: 'm', dir, unit: 'file', ttlHours: 24 }, { now, dryRun: true });
    expect(dry.wouldRemove).toEqual(['a.png']);
    expect(existsSync(join(dir, 'a.png'))).toBe(true);

    const none = await runCleanupRule({ name: 'm', dir, unit: 'file', ttlHours: 0 }, { now });
    expect(none.removed).toBe(0);
  });

  it('目录不存在时返回空结果', async () => {
    const r = await runCleanupRule({ name: 'x', dir: join(tmpdir(), 'no-such-cleanup-dir-xyz'), unit: 'file', ttlHours: 1 });
    expect(r).toMatchObject({ removed: 0, remaining: 0 });
  });
});

describe('rule helpers', () => {
  it('globToRegExp 支持 * ?，大小写不敏感', () => {
    expect(globToRegExp('*.json').test('Seen.JSON')).toBe(true);
    expect(globToRegExp('dl-hiro?.cjs').test('dl-hiro7.cjs')).toBe(true);
    expect(globToRegExp('dl-hiro?.cjs').test('dl-hiro17.cjs')).toBe(false);
    expect(globToRegExp('a.b').test('axb')).toBe(false);
  });

  it('isStrictlyInside：子目录算，自身和外部不算', () => {
    const base = root();
    mkdirSync(join(base, 'state'));
    expect(isStrictlyInside(join(base, 'state'), base)).toBe(true);
    expect(isStrictlyInside(base, base)).toBe(false);
    expect(isStrictlyInside(join(base, '..', 'elsewhere'), base)).toBe(false);
  });

  it('resolveUserRules 按 cwd 解析相对路径，忽略越界和指向根目录本身的规则', () => {
    const cwd = root();
    const rule = (dir: string): CleanupRuleConfig => ({
      name: '', dir, unit: 'file', ttlHours: 72, recursive: false, keep: [], match: [], maxTotalMB: 0,
    });
    const warn = vi.fn();
    const out = resolveUserRules(
      [rule('state'), rule('.'), rule('../outside'), rule(''), rule(join(cwd, '.tmp'))],
      cwd,
      { ...logger, warn },
      [cwd],
    );
    expect(out.map(r => r.dir)).toEqual([join(cwd, 'state'), join(cwd, '.tmp')]);
    expect(out[0].name).toBe('state');
    expect(warn).toHaveBeenCalledTimes(3);
  });
});

describe('CleanupService', () => {
  it('并发调用合并为一轮；dry run 不覆盖 lastReport', async () => {
    const now = Date.now();
    const dir = root();
    file(join(dir, 'a.png'), now, 100);
    const rules: CleanupRule[] = [{ name: 'm', dir, unit: 'file', ttlHours: 24 }];
    const service = new CleanupService(rules, false, logger);

    const dry = await service.run(true);
    expect(dry.results[0].wouldRemove).toEqual(['a.png']);
    expect(service.lastReport).toBeUndefined();

    const [r1, r2] = await Promise.all([service.run(), service.run()]);
    expect(r1).toBe(r2);
    expect(r1.results[0].removed).toBe(1);
    expect(service.lastReport).toBe(r1);
  });
});
