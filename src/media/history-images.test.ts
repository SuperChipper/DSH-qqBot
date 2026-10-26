import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import type { MediaConfig } from '../config.ts';
import type { Logger, RawAttachment } from '../types.ts';
import {
  downloadRecentHistoryImages,
  historyImageTag,
  numberHistoryImages,
} from './history-images.ts';
import { buildAgentBody, wantsHistoryImages } from '../transport/inbound.ts';

const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const media = { enabled: true, maxMB: 10, ttlHours: 24 } as MediaConfig;

const history = [
  { messageId: 'm1', senderId: 'u1', senderName: '甲', content: '看这个', timestamp: 1, images: [{ url: 'https://q/a.jpg', filename: 'a.jpg' }] },
  { messageId: 'm2', senderId: 'u2', senderName: '乙', content: '', timestamp: 2, images: [{ url: 'https://q/b.jpg' }, { url: 'https://q/c.jpg' }] },
  { messageId: 'm3', senderId: 'u1', senderName: '甲', content: '笑死', timestamp: 3 },
];

/** 假下载器：每个 URL 写一个临时文件，返回本地路径 */
function fakeDownloader(fail: Set<string> = new Set()) {
  const dir = mkdtempSync(join(tmpdir(), 'hist-img-'));
  return vi.fn(async (atts: RawAttachment[]) => atts
    .filter((a) => !fail.has(a.url))
    .map((a) => {
      const localPath = join(dir, a.filename);
      writeFileSync(localPath, 'x');
      return { filename: a.filename, contentType: 'image' as const, localPath };
    }));
}

describe('numberHistoryImages', () => {
  it('按时间正序编号，旧记录没有 images 字段也不报错', () => {
    const images = numberHistoryImages(history);
    expect(images.map((i) => [i.index, i.messageId, i.url])).toEqual([
      [1, 'm1', 'https://q/a.jpg'],
      [2, 'm2', 'https://q/b.jpg'],
      [3, 'm2', 'https://q/c.jpg'],
    ]);
  });
});

describe('downloadRecentHistoryImages', () => {
  it('只下载最近 limit 张，失败的保留 URL', async () => {
    const images = numberHistoryImages(history);
    const downloader = fakeDownloader(new Set(['https://q/c.jpg']));
    await downloadRecentHistoryImages(images, media, logger, 2, downloader);

    expect(downloader).toHaveBeenCalledTimes(2);
    expect(images[0]!.localPath).toBeUndefined();
    expect(images[1]!.localPath).toBeDefined();
    expect(images[2]!.localPath).toBeUndefined();
    expect(historyImageTag(images[2]!)).toBe('[图片#3: https://q/c.jpg]');
  });

  it('同一 URL 第二次命中缓存，不重复下载', async () => {
    const entries = [{ messageId: 'x', images: [{ url: 'https://q/cache-me.jpg' }] }];
    const downloader = fakeDownloader();
    const first = numberHistoryImages(entries);
    await downloadRecentHistoryImages(first, media, logger, 4, downloader);
    const second = numberHistoryImages(entries);
    await downloadRecentHistoryImages(second, media, logger, 4, downloader);

    expect(downloader).toHaveBeenCalledTimes(1);
    expect(second[0]!.localPath).toBe(first[0]!.localPath);
  });

  it('media 关闭时不下载', async () => {
    const downloader = fakeDownloader();
    await downloadRecentHistoryImages(numberHistoryImages(history), { ...media, enabled: false }, logger, 4, downloader);
    expect(downloader).not.toHaveBeenCalled();
  });
});

describe('buildAgentBody 历史图片', () => {
  it('历史行带 [图片#n] 标记，纯图片消息不再是空行', () => {
    const images = numberHistoryImages(history);
    images[1]!.localPath = 'C:/media/b.jpg';
    const body = buildAgentBody('[当前]', history, true, true, images);

    expect(body).toContain('[甲 (u1)] 看这个 [图片#1: https://q/a.jpg]');
    expect(body).toContain('[乙 (u2)] [图片#2: C:/media/b.jpg] [图片#3: https://q/c.jpg]');
    expect(body).toContain('[图片#n] 是历史消息里的图片');
  });

  it('没有历史图片时不加图片说明，但仍提醒只回当前这句', () => {
    const body = buildAgentBody('[当前]', [history[2]!], true, true, []);
    expect(body).not.toContain('[图片#n]');
    expect(body).toContain('回复只针对下面 [Current message] 那一句');
  });
});

describe('wantsHistoryImages', () => {
  it('当前消息在说图/前文 → 附历史图', () => {
    expect(wantsHistoryImages('上面那张图是谁')).toBe(true);
    expect(wantsHistoryImages('刚才那个表情什么意思')).toBe(true);
    expect(wantsHistoryImages('这张笑死')).toBe(true);
  });

  it('只 @ 了 bot 没说话 → 附历史图', () => {
    expect(wantsHistoryImages('')).toBe(true);
    expect(wantsHistoryImages('<@7A3B71762CFE765933AD79E8F2E04B92> ')).toBe(true);
  });

  it('普通的一句话 → 不附历史图', () => {
    expect(wantsHistoryImages('区区')).toBe(false);
    expect(wantsHistoryImages('你今天吃了吗')).toBe(false);
  });
});
