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

  it('发送汇报式旁白 → 空串', () => {
    const sent = ['这句是真的，刚才那份人物画像烧了小半碗 token。'];
    expect(stripCaptionEcho('表情和图都已经发出去了，还附了一句话：写这段话确实烧了不少token。', sent)).toBe('');
    expect(stripCaptionEcho('已发送～', sent)).toBe('');
    expect(stripCaptionEcho('图配好了，附了一句吐槽', sent)).toBe('');
  });

  it('没发过 caption 时，汇报式文本不受影响', () => {
    expect(stripCaptionEcho('图已经发出去了', [])).toBe('图已经发出去了');
  });

  it('长文本即使提到「发了」也保留', () => {
    const long = '顺便回答你刚才的问题：'.padEnd(120, '这个配置项控制群聊里未被 @ 时的回复概率');
    expect(stripCaptionEcho(`${long}，昨天也发了公告`, captions)).toBe(`${long}，昨天也发了公告`);
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
