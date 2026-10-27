import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { HttpGet } from './http.ts';
import { pickFanart, type PickDeps } from './pick.ts';
import { renderPickText } from './fanart-tool.ts';
import { FanartSeenStore, candidateFileName, markSentCandidate, parseCandidateFileName } from './seen.ts';
import type { BooruPoolEntry, PixivPoolEntry } from './types.ts';

/** 噪点 PNG：真实可解码，体积也超过下载的最小字节数 */
let IMAGE: Buffer;
beforeAll(async () => {
  IMAGE = await sharp({ create: { width: 200, height: 200, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 40 } } })
    .png()
    .toBuffer();
});

const pixivPool: PixivPoolEntry[] = [
  { name: '芙星', words: 'fufu', requireGroups: [['星'], ['ホタル']] },
];
const booruPool: BooruPoolEntry[] = [{ name: '芙星', tags: 'firefly stelle' }];

function json(body: unknown) {
  return { status: 200, body: Buffer.from(JSON.stringify(body)) };
}

function pixivItem(id: string, user: string) {
  return { id, userName: user, illustType: 0, xRestrict: 0, aiType: 1, pageCount: 1, width: 1200, height: 1600, tags: ['星', 'ホタル'] };
}

/** 假网络：pixiv 搜索 / 详情 / 图片，safebooru 列表 / 图片 */
function fakeGet(opts: { failImages?: Set<string>; booruFails?: boolean } = {}): HttpGet & { urls: string[] } {
  const urls: string[] = [];
  const get = (async (url: string) => {
    urls.push(url);
    if (url.includes('/ajax/search/')) {
      return json({ body: { illustManga: { data: [pixivItem('101', 'A'), pixivItem('102', 'B'), pixivItem('103', 'A'), pixivItem('104', 'C')], total: 3 } } });
    }
    const detail = /\/ajax\/illust\/(\d+)/.exec(url);
    if (detail) {
      const id = detail[1]!;
      return json({ body: { bookmarkCount: Number(id), userName: `u${id}`, urls: { regular: `https://i.pximg.net/${id}.jpg` } } });
    }
    if (url.includes('safebooru.org/index.php')) {
      if (opts.booruFails) return { status: 503, body: Buffer.alloc(0) };
      return json([
        // 和 pixiv 102 是同一幅作品，应被剔除
        { id: 900, width: 1200, height: 1500, tags: '2girls yuri', source: 'https://www.pixiv.net/artworks/102', sample_url: 'https://safebooru.org/s/900.jpg' },
        { id: 901, width: 1200, height: 1500, tags: '2girls yuri', source: 'https://x.com/zzz/status/1', sample_url: 'https://safebooru.org/s/901.jpg' },
      ]);
    }
    const name = url.split('/').pop()!;
    if (opts.failImages?.has(name)) return { status: 404, body: Buffer.alloc(0) };
    return { status: 200, body: IMAGE };
  }) as HttpGet & { urls: string[] };
  get.urls = urls;
  return get;
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fanart-test-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function deps(get: HttpGet, extra: Partial<PickDeps> = {}): PickDeps {
  return {
    get,
    seen: new FanartSeenStore(join(dir, 'seen')),
    pixivPool,
    booruPool,
    candidatesDir: join(dir, 'candidates'),
    random: () => 0,
    ...extra,
  };
}

describe('pickFanart', () => {
  it('并发搜两个源，下载候选、拼对比图，但不记 seen', async () => {
    const get = fakeGet();
    const res = await pickFanart({ count: 3, source: 'mix', cpOnly: true }, deps(get));

    expect(res.candidates).toHaveLength(3);
    for (const c of res.candidates) expect(existsSync(c.path)).toBe(true);
    // 同一画师 A 只出一张；booru 900 与 pixiv 102 是同一作品被剔除
    expect(res.candidates.some((c) => c.path.endsWith('yuri-900.jpg'))).toBe(false);
    expect(res.candidates.filter((c) => c.author === 'A')).toHaveLength(1);
    expect(res.candidates.map((c) => c.index)).toEqual([1, 2, 3]);
    expect(res.sheetPath && existsSync(res.sheetPath)).toBe(true);
    // pixiv 候选带人气
    expect(res.candidates.find((c) => c.source === 'pixiv')?.bookmarks).toBeGreaterThan(0);
    expect(existsSync(join(dir, 'seen'))).toBe(false);
  });

  it('已发过的不再出现', async () => {
    const seen = new FanartSeenStore(join(dir, 'seen'));
    seen.mark('pixiv', '101');
    seen.mark('pixiv', '102');
    seen.mark('pixiv', '103');
    seen.mark('pixiv', '104');
    const res = await pickFanart({ count: 3, source: 'pixiv', cpOnly: false }, deps(fakeGet(), { seen }));
    expect(res.candidates).toHaveLength(0);
    expect(res.failures.join()).toContain('没有可用的图');
  });

  it('个别下载失败时用备用补上；源失败记进 failures', async () => {
    const get = fakeGet({ failImages: new Set(['103.jpg']), booruFails: true });
    const res = await pickFanart({ count: 2, source: 'mix', cpOnly: true }, deps(get));
    expect(res.candidates).toHaveLength(2);
    expect(res.failures.some((f) => f.includes('booru'))).toBe(true);
  });

  it('未知 CP 直接报错并列出可选项', async () => {
    const res = await pickFanart({ count: 3, cp: '不存在', source: 'mix', cpOnly: false }, deps(fakeGet()));
    expect(res.candidates).toEqual([]);
    expect(res.failures[0]).toContain('芙星');
  });

  it('文字结果包含编号、出处和发图说明', async () => {
    const res = await pickFanart({ count: 2, source: 'pixiv', cpOnly: false }, deps(fakeGet()));
    const text = renderPickText(res, false);
    expect(text).toContain('#1');
    expect(text).toContain('https://www.pixiv.net/artworks/');
    expect(text).toContain('qqbot_send_file');
    expect(renderPickText({ candidates: [], failures: ['x'] }, false)).toContain('没抽到');
  });
});

describe('seen', () => {
  it('booru 记数字、pixiv 记字符串（和脚本格式一致），并去重', () => {
    const store = new FanartSeenStore(dir);
    store.mark('booru', '42');
    store.mark('booru', '42');
    store.mark('pixiv', '777');
    expect(JSON.parse(readFileSync(join(dir, 'seen.json'), 'utf8'))).toEqual([42]);
    expect(JSON.parse(readFileSync(join(dir, 'seen-pixiv.json'), 'utf8'))).toEqual(['777']);
    expect(store.load('booru').has('42')).toBe(true);
  });

  it('候选文件名互转', () => {
    expect(candidateFileName('booru', '5', '.jpg')).toBe('yuri-5.jpg');
    expect(parseCandidateFileName('pixiv-123.png')).toEqual({ source: 'pixiv', id: '123' });
    expect(parseCandidateFileName('yuri-9.jpg')).toEqual({ source: 'booru', id: '9' });
    expect(parseCandidateFileName('sheet-1.jpg')).toBeUndefined();
  });

  it('只有候选目录里的候选图发出后才记 seen', () => {
    const store = new FanartSeenStore(join(dir, 'seen'));
    const candidates = join(dir, 'candidates');
    mkdirSync(candidates);
    const inDir = join(candidates, 'pixiv-55.jpg');
    const elsewhere = join(dir, 'pixiv-66.jpg');
    writeFileSync(inDir, IMAGE);
    writeFileSync(elsewhere, IMAGE);

    expect(markSentCandidate(store, candidates, elsewhere)).toBe(false);
    expect(markSentCandidate(store, candidates, join(candidates, 'sheet-1.jpg'))).toBe(false);
    expect(markSentCandidate(store, candidates, inDir)).toBe(true);
    expect([...store.load('pixiv')]).toEqual(['55']);
  });
});
