import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { StickerStore } from './sticker-store.ts';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function setup(options: { maxBytes?: number; maxAutoEntries?: number; sensitivePaths?: string[] } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'qqbot-stickies-'));
  tempDirs.push(base);
  const media = join(base, 'media');
  const root = join(base, 'stickers');
  mkdirSync(media);
  mkdirSync(root);
  const store = new StickerStore({
    root,
    allowedRoots: [media],
    sensitivePaths: options.sensitivePaths,
    maxBytes: options.maxBytes ?? 1024,
    maxAutoEntries: options.maxAutoEntries ?? 10,
  });
  return { base, media, root, store };
}

function writeImage(dir: string, name: string, content = 'fake-image'): string {
  const path = join(dir, name);
  writeFileSync(path, Buffer.from(content));
  return path;
}

describe('StickerStore', () => {
  it('收藏图片、写索引并生成动态 prompt 清单', () => {
    const { media, root, store } = setup();
    const source = writeImage(media, 'cat.png', 'cat-bytes-1');

    const result = store.save({ source, emotion: '被萌到', note: '这张很适合撒娇' });

    expect(result.saved).toBe(true);
    expect(result.duplicate).toBe(false);
    expect(result.file).toBe('fish_被萌到.png');
    expect(existsSync(join(root, 'fish_被萌到.png'))).toBe(true);

    const index = JSON.parse(readFileSync(join(root, 'index.json'), 'utf8')) as Array<Record<string, unknown>>;
    expect(index).toHaveLength(1);
    expect(index[0]).toMatchObject({ emotion: '被萌到', file: 'fish_被萌到.png', auto: true, note: '这张很适合撒娇' });
    expect(String(index[0].sha256)).toHaveLength(64);

    const sections = store.promptSections();
    expect(sections.map((section) => section.name)).toEqual(['qqbot:sticker-capture', 'qqbot:sticker-catalog']);
    expect(sections[1]?.text).toContain('被萌到=fish_被萌到.png');
    expect(sections[1]?.text).toContain(root);
  });

  it('扩展名撒谎时按文件头命名（.png 里装 GIF）', () => {
    const { media, root, store } = setup();
    const gifBytes = Buffer.concat([Buffer.from('GIF89a', 'ascii'), Buffer.alloc(16, 0x20)]);
    const source = join(media, 'meme.png');
    writeFileSync(source, gifBytes);

    const result = store.save({ source, emotion: '杂鱼' });

    expect(result.file).toBe('fish_杂鱼.gif');
    expect(existsSync(join(root, 'fish_杂鱼.gif'))).toBe(true);
    expect(readFileSync(join(root, 'fish_杂鱼.gif'))).toEqual(gifBytes);
  });

  it('相同内容按 SHA-256 去重，不重复写索引', () => {
    const { media, root, store } = setup();
    const source = writeImage(media, 'cat.png', 'same-bytes');

    expect(store.save({ source, emotion: '开心' }).saved).toBe(true);
    const second = store.save({ source, emotion: '另一个标签' });

    expect(second.saved).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.file).toBe('fish_开心.png');
    expect(second.total).toBe(1);
    const index = JSON.parse(readFileSync(join(root, 'index.json'), 'utf8')) as unknown[];
    expect(index).toHaveLength(1);
  });

  it('按 SHA-256 匹配表情库：命中返回情绪，未命中返回 undefined', () => {
    const { media, store } = setup();
    const source = writeImage(media, 'cat.png', 'match-me-bytes');
    store.save({ source, emotion: '被压扁', note: '躺平专用' });

    const matched = store.match(source);
    expect(matched).toMatchObject({ matched: true, emotion: '被压扁', file: 'fish_被压扁.png', note: '躺平专用', total: 1 });

    const other = writeImage(media, 'other.png', 'different-bytes');
    expect(store.match(other)).toBeUndefined();
  });

  it('匹配同样限制来源目录，不允许的路径直接拒绝', () => {
    const { store } = setup();
    expect(() => store.match('C:/outside/cat.png')).toThrow(/不存在|不在允许的目录内/);
  });

  it('同名文件不会被覆盖，自动追加序号', () => {
    const { media, root, store } = setup();
    writeFileSync(join(root, 'fish_无语.png'), Buffer.from('existing'));
    const source = writeImage(media, 'other.png', 'different-bytes');

    const result = store.save({ source, emotion: '无语' });

    expect(result.file).toBe('fish_无语_2.png');
    expect(readFileSync(join(root, 'fish_无语.png'), 'utf8')).toBe('existing');
  });

  it('拒绝媒体目录之外的来源', () => {
    const { base, media, store } = setup();
    const outside = writeImage(base, 'outside.png');
    writeImage(media, 'inside.png');

    expect(() => store.save({ source: outside, emotion: '测试' })).toThrow(/允许的目录/);
  });

  it('拒绝敏感路径', () => {
    const { media, root } = setup();
    const store = new StickerStore({
      root,
      allowedRoots: [media],
      sensitivePaths: [join(media, 'private')],
      maxBytes: 1024,
      maxAutoEntries: 10,
    });
    mkdirSync(join(media, 'private'));
    const source = writeImage(join(media, 'private'), 'secret.png');

    expect(() => store.save({ source, emotion: '测试' })).toThrow(/敏感目录/);
  });

  it('拒绝超过大小上限的图片', () => {
    const { media, store } = setup({ maxBytes: 4 });
    const source = writeImage(media, 'big.png', 'too-large');

    expect(() => store.save({ source, emotion: '测试' })).toThrow(/过大/);
  });

  it('达到自动收藏上限后拒绝新增', () => {
    const { media, store } = setup({ maxAutoEntries: 1 });
    const first = writeImage(media, 'one.png', 'one');
    const second = writeImage(media, 'two.png', 'two');

    expect(store.save({ source: first, emotion: '一' }).saved).toBe(true);
    expect(() => store.save({ source: second, emotion: '二' })).toThrow(/上限/);
  });

  it('只把 auto 条目放进动态清单，旧手动条目保留在索引里', () => {
    const { media, root, store } = setup();
    writeFileSync(join(root, 'fish_旧图.png'), Buffer.from('old'));
    writeFileSync(join(root, 'index.json'), JSON.stringify([
      { emotion: '旧图', file: 'fish_旧图.png', bytes: 3 },
    ], null, 2));

    const source = writeImage(media, 'new.png', 'new-bytes');
    store.save({ source, emotion: '新图' });

    const sections = store.promptSections();
    expect(sections[1]?.text).toContain('新图=fish_新图.png');
    expect(sections[1]?.text).not.toContain('旧图=fish_旧图.png');

    const index = JSON.parse(readFileSync(join(root, 'index.json'), 'utf8')) as Array<Record<string, unknown>>;
    expect(index).toHaveLength(2);
    expect(index[0]?.sha256).toBeTypeOf('string');
  });

  it('拒绝含路径分隔符的 file 参数', () => {
    const { media, store } = setup();
    const source = writeImage(media, 'cat.png');

    expect(() => store.save({ source, emotion: '测试', file: 'fish_坏/名.png' })).toThrow(/非法字符/);
  });
});
