import { describe, it, expect } from 'vitest';
import { acceptBooruPost, searchBooru, type BooruPost } from './booru.ts';
import { decodeChunked, parseProxy, parseRawResponse, type HttpGet } from './http.ts';
import { acceptPixivItem, fetchPixivDetail, searchPixivCp, type PixivSearchItem } from './pixiv.ts';
import { authorKey, hasLowQualityTag, pixivIdFromSource, type PixivPoolEntry } from './types.ts';

const fufu: PixivPoolEntry = {
  name: '芙星',
  words: '崩壊スターレイル ホタル',
  requireGroups: [['星(スターレイル)', 'Stelle'], ['ホタル']],
  exclude: ['ステラソラ'],
};

function item(extra: Partial<PixivSearchItem> = {}): PixivSearchItem {
  return {
    id: '1',
    illustType: 0,
    xRestrict: 0,
    aiType: 1,
    pageCount: 1,
    width: 1200,
    height: 1600,
    tags: ['星(スターレイル)', 'ホタル(スターレイル)'],
    ...extra,
  };
}

function json(body: unknown) {
  return { status: 200, body: Buffer.from(JSON.stringify(body)) };
}

describe('acceptPixivItem', () => {
  it('两个角色都命中才收', () => {
    expect(acceptPixivItem(item(), fufu)).toBe(true);
    expect(acceptPixivItem(item({ tags: ['ホタル(スターレイル)'] }), fufu)).toBe(false);
  });

  it('过滤 R-18 / AI / 漫画 / 多页 / 小图 / 排除词 / 低质 tag', () => {
    expect(acceptPixivItem(item({ xRestrict: 1 }), fufu)).toBe(false);
    expect(acceptPixivItem(item({ aiType: 2 }), fufu)).toBe(false);
    expect(acceptPixivItem(item({ illustType: 1 }), fufu)).toBe(false);
    expect(acceptPixivItem(item({ pageCount: 3 }), fufu)).toBe(false);
    expect(acceptPixivItem(item({ width: 600 }), fufu)).toBe(false);
    expect(acceptPixivItem(item({ tags: ['星(スターレイル)', 'ホタル', 'ステラソラ'] }), fufu)).toBe(false);
    expect(acceptPixivItem(item({ tags: ['星(スターレイル)', 'ホタル', 'ドット絵'] }), fufu)).toBe(false);
  });

  it('只锁一个角色的 CP 要带百合 tag', () => {
    const single: PixivPoolEntry = { name: '织窃', words: 'x', requireGroups: [['アグライア']] };
    expect(acceptPixivItem(item({ tags: ['アグライア'] }), single)).toBe(false);
    expect(acceptPixivItem(item({ tags: ['アグライア', '百合'] }), single)).toBe(true);
  });
});

describe('searchPixivCp', () => {
  it('第 1 页 + 随机一页，过滤掉已发过的', async () => {
    const urls: string[] = [];
    const get: HttpGet = async (url) => {
      urls.push(url);
      const page = /[?&]p=(\d+)/.exec(url)![1];
      const data = page === '1'
        ? [item({ id: '10', userName: 'A' }), item({ id: '11' })]
        : [item({ id: '20' }), item({ id: '10' })];
      return json({ body: { illustManga: { data, total: 150 } } });
    };
    const out = await searchPixivCp(get, fufu, new Set(['11']), () => 0);
    expect(urls).toHaveLength(2);
    expect(urls[1]).toContain('p=2');
    expect(out.map((c) => c.id)).toEqual(['10', '20']);
    expect(out[0]).toMatchObject({ source: 'pixiv', cp: '芙星', author: 'A', pixivId: '10' });
  });

  it('结果不满一页时不翻页', async () => {
    let calls = 0;
    const get: HttpGet = async () => {
      calls++;
      return json({ body: { illustManga: { data: [item()], total: 1 } } });
    };
    await searchPixivCp(get, fufu, new Set());
    expect(calls).toBe(1);
  });
});

describe('fetchPixivDetail', () => {
  it('取收藏数 / 画师 / regular 图片地址', async () => {
    const get: HttpGet = async () => json({
      body: { bookmarkCount: 320, userName: 'AnanaS', urls: { regular: 'https://i.pximg.net/r.jpg', original: 'https://i.pximg.net/o.png' } },
    });
    expect(await fetchPixivDetail(get, '1')).toEqual({ bookmarks: 320, author: 'AnanaS', imageUrl: 'https://i.pximg.net/r.jpg' });
  });
});

describe('booru', () => {
  const post = (extra: Partial<BooruPost> = {}): BooruPost => ({
    id: 5,
    width: 1200,
    height: 1500,
    tags: '2girls yuri',
    source: 'https://www.pixiv.net/artworks/123',
    sample_url: 'https://safebooru.org/samples/5.jpg',
    ...extra,
  });

  it('过滤小图、漫画格、政治题材', () => {
    expect(acceptBooruPost(post())).toBe(true);
    expect(acceptBooruPost(post({ width: 700 }))).toBe(false);
    expect(acceptBooruPost(post({ tags: '2girls comic' }))).toBe(false);
    expect(acceptBooruPost(post({ tags: '2girls propaganda_poster' }))).toBe(false);
  });

  it('CP 只查第 0 页；source 指向 pixiv 时带上 pixivId', async () => {
    const urls: string[] = [];
    const get: HttpGet = async (url) => {
      urls.push(url);
      return json([post(), post({ id: 6 })]);
    };
    const out = await searchBooru(get, { name: '芙星', tags: 'a b' }, new Set(['6']), () => 0.9);
    expect(urls[0]).toContain('pid=0');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ source: 'booru', id: '5', cp: '芙星', pixivId: '123', pageUrl: 'https://www.pixiv.net/artworks/123' });
  });

  it('随机池随机翻页', async () => {
    const urls: string[] = [];
    const get: HttpGet = async (url) => {
      urls.push(url);
      return json([]);
    };
    await searchBooru(get, undefined, new Set(), () => 0.5);
    expect(urls[0]).toContain('pid=4');
  });
});

describe('types helpers', () => {
  it('从 booru source 认 pixiv id', () => {
    expect(pixivIdFromSource('https://www.pixiv.net/en/artworks/150305008')).toBe('150305008');
    expect(pixivIdFromSource('https://www.pixiv.net/member_illust.php?mode=medium&illust_id=42')).toBe('42');
    expect(pixivIdFromSource('https://i.pximg.net/img-original/img/2024/01/01/00/00/00/777_p0.png')).toBe('777');
    expect(pixivIdFromSource('https://x.com/foo/status/1')).toBeUndefined();
  });

  it('authorKey：画师名优先，其次 twitter 账号，最后作品本身', () => {
    expect(authorKey({ author: 'Foo', pageUrl: '', source: 'pixiv', id: '1' })).toBe('author:foo');
    expect(authorKey({ pageUrl: 'https://x.com/Bar/status/9', source: 'booru', id: '1' })).toBe('twitter:bar');
    expect(authorKey({ pageUrl: 'https://safebooru.org/x', source: 'booru', id: '1' })).toBe('booru:1');
  });

  it('低质 tag 大小写不敏感', () => {
    expect(hasLowQualityTag(['Speech_Bubble'])).toBe(true);
    expect(hasLowQualityTag(['2girls'])).toBe(false);
  });
});

describe('http helpers', () => {
  it('解析代理地址', () => {
    expect(parseProxy('http://127.0.0.1:7897')).toEqual({ host: '127.0.0.1', port: 7897 });
    expect(parseProxy('127.0.0.1:7897')).toEqual({ host: '127.0.0.1', port: 7897 });
    expect(parseProxy('')).toBeUndefined();
  });

  it('解析原始响应（含 chunked）', () => {
    const raw = Buffer.from('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n');
    const res = parseRawResponse(raw);
    expect(res.status).toBe(200);
    expect(res.body.toString()).toBe('hello world');
    expect(decodeChunked(Buffer.from('0\r\n\r\n')).length).toBe(0);
  });

  it('非 chunked 原样返回 body', () => {
    const res = parseRawResponse(Buffer.from('HTTP/1.1 404 Not Found\r\nContent-Length: 2\r\n\r\nno'));
    expect(res).toMatchObject({ status: 404 });
    expect(res.body.toString()).toBe('no');
  });
});
