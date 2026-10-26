import { describe, it, expect } from 'vitest';
import { captionFromArgs, stripCaptionEcho } from './caption-echo.ts';

describe('stripCaptionEcho', () => {
  const captions = ['才不是大肥鱼！这张给你 🐋'];

  it('没有 caption 时原样返回', () => {
    expect(stripCaptionEcho('hello', [])).toBe('hello');
  });

  it('完全复读 → 空串', () => {
    expect(stripCaptionEcho('才不是大肥鱼！这张给你 🐋', captions)).toBe('');
  });

  it('改了标点/去掉 emoji 的复读 → 空串', () => {
    expect(stripCaptionEcho('才不是大肥鱼，这张给你', captions)).toBe('');
  });

  it('流式前缀（caption 的子串）→ 空串', () => {
    expect(stripCaptionEcho('才不是大肥', captions)).toBe('');
  });

  it('caption 原文 + 新内容 → 只留新内容', () => {
    expect(stripCaptionEcho('才不是大肥鱼！这张给你 🐋\n\n顺便说下明天放假', captions)).toBe('顺便说下明天放假');
  });

  it('无关内容原样保留', () => {
    expect(stripCaptionEcho('明天几点开会？', captions)).toBe('明天几点开会？');
  });

  it('多条 caption 都会被过滤', () => {
    expect(stripCaptionEcho('第二张', ['第一张', '第二张'])).toBe('');
  });
});

describe('captionFromArgs', () => {
  it('取出 caption 并 trim', () => {
    expect(captionFromArgs('{"file_path":"C:/a.png","caption":"  hi  "}')).toBe('hi');
  });

  it('无 caption / 空 caption / 非法 JSON → undefined', () => {
    expect(captionFromArgs('{"file_path":"C:/a.png"}')).toBeUndefined();
    expect(captionFromArgs('{"caption":"   "}')).toBeUndefined();
    expect(captionFromArgs('not json')).toBeUndefined();
  });
});
