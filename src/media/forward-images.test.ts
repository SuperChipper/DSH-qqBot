import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import type { MediaConfig } from '../config.ts';
import type { Logger, RawAttachment } from '../types.ts';
import {
  createForwardTagger,
  downloadForwardImages,
  extractForwardImages,
} from './forward-images.ts';
import { buildForwardHint } from '../transport/inbound.ts';

const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const media = { enabled: true, maxMB: 10, ttlHours: 24 } as MediaConfig;

const URL_A = 'https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=AAA&rkey=r1&spec=0';
const URL_B = 'https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=BBB&rkey=r2&spec=0';
const URL_C = 'https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=CCC&rkey=r3&spec=0';

/** 和 QQ 下发的合并转发 content 同形（取自真实群记忆，URL 已替换） */
const FORWARD = [
  '[群聊的聊天记录]',
  '=== 消息 1 ===',
  '[消息内容] 笑死我了',
  '[发送者] 甲',
  '',
  '=== 消息 2 ===',
  '[消息内容] <faceType=6,faceId="0",ext="eyJ0ZXh0IjoiIn0=">',
  '[发送者] 乙',
  `[附件1] 类型:图片 文件名:3424958F.jpg 尺寸:240x240 大小:30.6KB URL:${URL_A}`,
  '',
  '=== 消息 3 ===',
  '[消息内容] 看这个\r后面还有',
  '[发送者] 甲',
  `[附件1] 类型:图片 文件名:65AD2C81.png 尺寸:1200x2608 大小:532.6KB URL:${URL_B}\r`,
  '[附件2] 类型:文件 文件名:a.zip 大小:1KB URL:https://example.com/a.zip',
  '[关联消息]',
  '--- 第1条 ---',
  `    [附件1] 类型:图片 文件名:C.jpg 尺寸:10x10 大小:1KB URL:${URL_C}`,
].join('\n');

/** 假下载器：每个 URL 写一个临时文件，返回本地路径 */
function fakeDownloader(fail: Set<string> = new Set()) {
  const dir = mkdtempSync(join(tmpdir(), 'fwd-img-'));
  return vi.fn(async (atts: RawAttachment[]) => atts
    .filter((a) => !fail.has(a.url))
    .map((a) => {
      const localPath = join(dir, a.filename);
      writeFileSync(localPath, 'x');
      return { filename: a.filename, contentType: 'image' as const, localPath };
    }));
}

describe('extractForwardImages', () => {
  it('按出现顺序提取图片附件行（含 \\r 行尾和嵌套的关联消息），跳过非图片', () => {
    expect(extractForwardImages(FORWARD)).toEqual([
      { url: URL_A, filename: '3424958F.jpg' },
      { url: URL_B, filename: '65AD2C81.png' },
      { url: URL_C, filename: 'C.jpg' },
    ]);
  });

  it('当前消息和引用原文一起提取，同一 URL 只出现一次', () => {
    expect(extractForwardImages(FORWARD, FORWARD, undefined).map((i) => i.url)).toEqual([URL_A, URL_B, URL_C]);
  });

  it('普通消息不误判', () => {
    expect(extractForwardImages('图片在这 https://q/a.jpg', '类型:图片 URL:https://q/b.jpg')).toEqual([]);
  });
});

describe('downloadForwardImages', () => {
  it('下载前 limit 张并写回 localPath，失败的保留 URL', async () => {
    const images = extractForwardImages(FORWARD);
    const downloader = fakeDownloader(new Set([URL_B]));
    await downloadForwardImages(images, media, logger, 2, downloader);

    expect(downloader).toHaveBeenCalledTimes(2);
    expect(images[0]!.localPath).toMatch(/3424958F\.jpg$/);
    expect(images[1]!.localPath).toBeUndefined();
    expect(images[2]!.localPath).toBeUndefined();
  });

  it('media 关闭时不下载', async () => {
    const images = extractForwardImages(FORWARD);
    const downloader = fakeDownloader();
    await downloadForwardImages(images, { ...media, enabled: false }, logger, 8, downloader);
    expect(downloader).not.toHaveBeenCalled();
    expect(images.every((i) => i.localPath === undefined)).toBe(true);
  });
});

describe('createForwardTagger', () => {
  it('把图片附件行改写成 [图片#n: 路径]，编号接在历史图片后面', () => {
    const images = [
      { url: URL_A, filename: '3424958F.jpg', localPath: '/m/a.jpg' },
      { url: URL_B, filename: '65AD2C81.png' },
      { url: URL_C, filename: 'C.jpg', localPath: '/m/c.jpg' },
    ];
    const tagger = createForwardTagger(images, 3);
    const text = tagger.rewrite(FORWARD);

    expect(text).toContain('[附件1] [图片#4: /m/a.jpg] 尺寸:240x240');
    expect(text).toContain(`[附件1] [图片#5: ${URL_B}] 尺寸:1200x2608\r`);
    expect(text).toContain('    [附件1] [图片#6: /m/c.jpg] 尺寸:10x10');
    expect(text).toContain('[附件2] 类型:文件 文件名:a.zip');
    expect(text).not.toContain(URL_A);
    expect(tagger.tagged.map((i) => [i.index, i.localPath])).toEqual([
      [4, '/m/a.jpg'],
      [5, undefined],
      [6, '/m/c.jpg'],
    ]);
  });

  it('当前消息和引用原文共用编号，同一张图不重复编号', () => {
    const tagger = createForwardTagger([{ url: URL_A, localPath: '/m/a.jpg' }], 0);
    const line = `[附件1] 类型:图片 文件名:x.jpg 尺寸:1x1 大小:1KB URL:${URL_A}`;
    expect(tagger.rewrite(line)).toBe('[附件1] [图片#1: /m/a.jpg] 尺寸:1x1');
    expect(tagger.rewrite(`引用：\n${line}`)).toBe('引用：\n[附件1] [图片#1: /m/a.jpg] 尺寸:1x1');
    expect(tagger.tagged).toHaveLength(1);
  });

  it('没有转发图片时原样返回', () => {
    const tagger = createForwardTagger(undefined, 0);
    expect(tagger.rewrite(FORWARD)).toBe(FORWARD);
    expect(tagger.tagged).toEqual([]);
  });
});

describe('buildForwardHint', () => {
  it('区分已下载和只有 URL 的图片', () => {
    const hint = buildForwardHint([
      { index: 2, url: URL_A, localPath: '/m/a.jpg' },
      { index: 3, url: URL_B },
    ]);
    expect(hint).toContain('#2 已下载到本地');
    expect(hint).toContain('#3 未下载');
    expect(hint).toContain('qqbot_describe_image');
    expect(buildForwardHint([])).toBe('');
  });
});
