import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  acceptBooruRow,
  authorFromSource,
  fetchBooruImage,
  pickBooruPost,
  sanitizeTags,
  sniffImageExt,
  type BooruPostRow,
} from './booru-post.ts';
import type { HttpGet } from './http.ts';

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'booru-post-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function row(id: number, extra: Partial<BooruPostRow> = {}): BooruPostRow {
  return {
    id,
    width: 1200,
    height: 1600,
    tags: '1girl solo',
    rating: 'general',
    file_url: `https://safebooru.org/images/${id}.jpg`,
    ...extra,
  };
}

/** 足够大的假 JPEG（真文件头 + 填充） */
function jpeg(size = 60_000): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(size)]);
}

function jsonGet(rows: BooruPostRow[], images: Record<string, Buffer> = {}) {
  const urls: string[] = [];
  const get: HttpGet = async (url) => {
    urls.push(url);
    if (url.includes('page=dapi')) return { status: 200, body: Buffer.from(JSON.stringify(rows)) };
    const img = images[url];
    return img === undefined ? { status: 404, body: Buffer.alloc(0) } : { status: 200, body: img };
  };
  return { get, urls };
}

describe('sanitizeTags', () => {
  it('压空白、去首尾', () => {
    expect(sanitizeTags('  shinosawa_hiro   rating:general ')).toBe('shinosawa_hiro rating:general');
  });

  it('空 / 非字符串 / 过长返回 undefined', () => {
    expect(sanitizeTags('   ')).toBeUndefined();
    expect(sanitizeTags(undefined)).toBeUndefined();
    expect(sanitizeTags('x'.repeat(301))).toBeUndefined();
  });
});

describe('acceptBooruRow', () => {
  it('收 normal 尺寸的 general 图', () => {
    expect(acceptBooruRow(row(1))).toBe(true);
  });

  it('挡掉没有 id/图、explicit、太小、屏蔽 tag 的', () => {
    expect(acceptBooruRow(undefined)).toBe(false);
    expect(acceptBooruRow(row(1, { file_url: undefined, sample_url: undefined }))).toBe(false);
    expect(acceptBooruRow(row(1, { rating: 'explicit' }))).toBe(false);
    expect(acceptBooruRow(row(1, { width: 600, height: 600 }))).toBe(false);
    expect(acceptBooruRow(row(1, { tags: '1girl political' }))).toBe(false);
  });
});

describe('pickBooruPost', () => {
  it('latest 取最新一条没发过的', async () => {
    const { get, urls } = jsonGet([row(5), row(9), row(7)]);
    const picked = await pickBooruPost(get, { tags: 'x', mode: 'latest', seen: new Set(['9']) });
    expect(picked?.row.id).toBe(7);
    expect(picked?.attempts).toBe(1);
    // 一次请求就够，不要按 post 数挨个查
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('pid=0');
  });

  it('latest 全是已发过的返回 undefined', async () => {
    const { get } = jsonGet([row(5), row(9)]);
    expect(await pickBooruPost(get, { tags: 'x', mode: 'latest', seen: new Set(['5', '9']) })).toBeUndefined();
  });

  it('random 翻到全重复的页会重试，拿到就用', async () => {
    let call = 0;
    const get: HttpGet = async () => {
      call += 1;
      // 第一轮只有已发过的，第二轮才有新图
      return call === 1
        ? { status: 200, body: Buffer.from(JSON.stringify([row(1)])) }
        : { status: 200, body: Buffer.from(JSON.stringify([row(2)])) };
    };
    const picked = await pickBooruPost(get, { tags: 'x', mode: 'random', seen: new Set(['1']), random: () => 0 });
    expect(picked?.row.id).toBe(2);
    expect(picked?.attempts).toBe(2);
  });

  it('random 连续撞已发就放弃', async () => {
    const { get } = jsonGet([row(1)]);
    expect(await pickBooruPost(get, { tags: 'x', mode: 'random', seen: new Set(['1']), random: () => 0.5 })).toBeUndefined();
  });
});

describe('sniffImageExt', () => {
  it('认 JPEG / PNG，其它返回 undefined', () => {
    expect(sniffImageExt(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]))).toBe('jpg');
    expect(sniffImageExt(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('png');
    expect(sniffImageExt(Buffer.from('<html>403</html>'))).toBeUndefined();
  });
});

describe('authorFromSource', () => {
  it('推特链接解出账号，pixiv 链接解不出来', () => {
    expect(authorFromSource('https://x.com/kirigoetei/status/2099061857210540168')).toBe('kirigoetei');
    expect(authorFromSource('https://www.pixiv.net/artworks/123456')).toBeUndefined();
    expect(authorFromSource(undefined)).toBeUndefined();
  });
});

describe('fetchBooruImage', () => {
  it('按候选图命名落地 yuri-<id>.<ext>，好让发送回调记为已发', async () => {
    const dir = tempDir();
    const { get } = jsonGet([row(42)], { 'https://safebooru.org/images/42.jpg': jpeg() });
    const result = await fetchBooruImage({ tags: 'shinosawa_hiro', mode: 'latest' }, { get, candidatesDir: dir });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.id).toBe('42');
    expect(readdirSync(dir)).toEqual(['yuri-42.jpg']);
    expect(readFileSync(result.path).subarray(0, 2).toString('hex')).toBe('ffd8');
    expect(result.pageUrl).toContain('id=42');
  });

  it('下载失败 / 不是图 / 太小都不落地', async () => {
    const dir = tempDir();
    const notImage = await fetchBooruImage({ tags: 'x', mode: 'latest' }, {
      get: jsonGet([row(1)], { 'https://safebooru.org/images/1.jpg': Buffer.from('<html>403</html>') }).get,
      candidatesDir: dir,
    });
    expect(notImage.ok).toBe(false);

    const tiny = await fetchBooruImage({ tags: 'x', mode: 'latest' }, {
      get: jsonGet([row(1)], { 'https://safebooru.org/images/1.jpg': jpeg(100) }).get,
      candidatesDir: dir,
    });
    expect(tiny.ok).toBe(false);

    const http404 = await fetchBooruImage({ tags: 'x', mode: 'latest' }, {
      get: jsonGet([row(1)]).get,
      candidatesDir: dir,
    });
    expect(http404.ok).toBe(false);

    expect(readdirSync(dir)).toEqual([]);
  });

  it('没抽到图时给出原因，不写文件', async () => {
    const dir = tempDir();
    const result = await fetchBooruImage({ tags: 'x', mode: 'latest' }, {
      get: jsonGet([]).get,
      candidatesDir: dir,
      seen: new Set<string>(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('没有未发过');
    expect(readdirSync(dir)).toEqual([]);
  });
});
