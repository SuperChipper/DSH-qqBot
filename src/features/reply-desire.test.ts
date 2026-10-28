import { describe, it, expect } from 'vitest';
import { EngagementTracker, classifyMessage, scoreReplyDesire, type DesireInput } from './reply-desire.ts';

const base: DesireInput = { content: '', senderId: 'u1', mentionsOthers: false, names: ['小d', 'Dsh'] };

const face = (type: number, text: string): string =>
  `<faceType=${type},faceId="0",ext="${Buffer.from(JSON.stringify({ text })).toString('base64')}">`;
const sticker = (id: string, type = 'image/jpeg') => [{ content_type: type, filename: `${id}.jpg`, url: `https://x/${id}` }];
const STICKER = face(6, '');

describe('classifyMessage', () => {
  it('faceType=6 + 单张图是表情包，标识取文件名（忽略扩展名和大小写）', () => {
    expect(classifyMessage(STICKER, sticker('ad030b48'))).toEqual({ text: '', stickerId: 'AD030B48' });
    expect(classifyMessage('', [{ content_type: 'image/png', filename: 'AD030B48.png' }]).stickerId).toBeUndefined();
    expect(classifyMessage('', sticker('aa', 'image/gif')).stickerId).toBe('AA');
  });

  it('配了文字或多张图就不是表情包', () => {
    expect(classifyMessage(`${STICKER}笑死`, sticker('a')).stickerId).toBeUndefined();
    expect(classifyMessage(STICKER, [...sticker('a'), ...sticker('b')]).stickerId).toBeUndefined();
  });

  it('QQ 小黄脸换成名字，旧格式不留残渣', () => {
    expect(classifyMessage(`好耶${face(1, '[笑哭]')}`).text).toBe('好耶[笑哭]');
    expect(classifyMessage('[<face,id=12/>]').text).toBe('[表情]');
  });
});

describe('scoreReplyDesire 文字', () => {
  it('空消息 / 命令 / @ 别人 / 语气词直接 0', () => {
    expect(scoreReplyDesire({ ...base, content: '<@!123>' }).reasons).toEqual(['empty']);
    expect(scoreReplyDesire({ ...base, content: '/help 小d' }).score).toBe(0);
    expect(scoreReplyDesire({ ...base, content: '小d 你看他', mentionsOthers: true }).score).toBe(0);
    expect(scoreReplyDesire({ ...base, content: '哈哈哈哈' }).reasons).toEqual(['noise']);
  });

  it('点名昵称（忽略大小写）过默认阈值', () => {
    expect(scoreReplyDesire({ ...base, content: 'dsh 在吗' }).score).toBeGreaterThanOrEqual(0.6);
    expect(scoreReplyDesire({ ...base, content: '哈哈小d' }).reasons).toContain('name');
  });

  it('没开窗的普通提问不过阈值', () => {
    expect(scoreReplyDesire({ ...base, content: '今晚吃什么' }).score).toBeLessThan(0.6);
  });

  it('emoji 和小黄脸按文字算：窗口内聊过的人接，其他人只加一点', () => {
    const engagement = { until: Infinity, peers: new Set(['u1']), turns: 0 };
    expect(scoreReplyDesire({ ...base, content: '😂', engagement }).score).toBeGreaterThanOrEqual(0.6);
    expect(scoreReplyDesire({ ...base, content: face(1, '[笑哭]'), engagement }).score).toBeGreaterThanOrEqual(0.6);
    expect(scoreReplyDesire({ ...base, senderId: 'u2', content: '我觉得也是', engagement }).score).toBeLessThan(0.6);
  });

  it('只发照片：窗口外不接，窗口内聊过的人接', () => {
    const photo = [{ content_type: 'image/jpeg', filename: 'p.jpeg' }];
    expect(scoreReplyDesire({ ...base, attachments: photo }).score).toBe(0);
    const engagement = { until: Infinity, peers: new Set(['u1']), turns: 0 };
    expect(scoreReplyDesire({ ...base, attachments: photo, engagement }).score).toBeGreaterThanOrEqual(0.6);
  });
});

describe('scoreReplyDesire 表情包', () => {
  const s = { ...base, content: STICKER, attachments: sticker('abc') };

  it('bot 刚说完话就甩表情包：用表情包回应', () => {
    const r = scoreReplyDesire({ ...s, sinceBotSpoke: 5_000 });
    expect(r).toMatchObject({ mode: 'sticker', stickerId: 'ABC' });
    expect(r.score).toBeGreaterThanOrEqual(0.6);
    expect(scoreReplyDesire({ ...s, sinceBotSpoke: 60_000 }).score).toBe(0);
    expect(scoreReplyDesire(s).score).toBe(0);
  });

  it('已经用表情包接过这个人：不再接（防互刷）', () => {
    expect(scoreReplyDesire({ ...s, sinceBotSpoke: 1_000, stickerAnswered: true }).reasons).toEqual(['sticker-volley']);
  });

  it('不同的人连续复读同一张：跟一张，同一串只跟一次，开团不跟', () => {
    const recent = [{ senderId: 'u2', stickerId: 'ABC' }, { senderId: 'u3', stickerId: 'ABC' }];
    expect(scoreReplyDesire({ ...s, recent })).toMatchObject({ score: 1, mode: 'sticker-chain' });
    expect(scoreReplyDesire({ ...s, recent, chainAnswered: 'ABC' }).mode).toBe('sticker');
    expect(scoreReplyDesire({ ...s, recent, dnd: true }).score).toBe(0);
    const solo = [{ senderId: 'u1', stickerId: 'ABC' }, { senderId: 'u1', stickerId: 'ABC' }];
    expect(scoreReplyDesire({ ...s, recent: solo }).mode).toBe('sticker');
  });
});

describe('EngagementTracker', () => {
  it('窗口过期即清除，touch 只续已开的窗口但总会记下 bot 说话时间', () => {
    const t = new EngagementTracker();
    t.touch('g', 0, 100);
    expect(t.get('g', 0)).toBeUndefined();
    expect(t.sinceBotSpoke('g', 30)).toBe(30);
    t.open('g', 'u1', 0, 100);
    t.touch('g', 50, 100);
    expect(t.get('g', 140)?.peers.has('u1')).toBe(true);
    expect(t.get('g', 151)).toBeUndefined();
  });

  it('靠打分接到上限就关窗，@ 会把轮数清零', () => {
    const t = new EngagementTracker();
    t.open('g', 'u1', 0, 100);
    t.take('g', 'u2', 1, 100, 2);
    expect(t.get('g', 1)?.peers.has('u2')).toBe(true);
    t.open('g', 'u1', 2, 100);
    expect(t.get('g', 2)?.turns).toBe(0);
    t.take('g', 'u1', 3, 100, 2);
    t.take('g', 'u1', 4, 100, 2);
    expect(t.get('g', 4)).toBeUndefined();
  });

  it('maxTurns=0 不开窗', () => {
    const t = new EngagementTracker();
    t.take('g', 'u1', 0, 100, 0);
    expect(t.get('g', 0)).toBeUndefined();
  });

  it('说了文字解除互刷限制，换了表情包结束这串复读', () => {
    const t = new EngagementTracker();
    t.markSticker('g', 'u1', { score: 1, reasons: [], mode: 'sticker', stickerId: 'A' });
    t.markSticker('g', 'u2', { score: 1, reasons: [], mode: 'sticker-chain', stickerId: 'B' });
    t.record('g', { senderId: 'u1', stickerId: 'B' });
    expect(t.stickerAnswered('g', 'u1')).toBe(true);
    expect(t.chainAnswered('g')).toBe('B');
    t.record('g', { senderId: 'u1' });
    expect(t.stickerAnswered('g', 'u1')).toBe(false);
    expect(t.chainAnswered('g')).toBeUndefined();
  });

  it('只保留最近 5 条', () => {
    const t = new EngagementTracker();
    for (let i = 0; i < 7; i++) t.record('g', { senderId: `u${i}` });
    expect(t.recent('g').map((m) => m.senderId)).toEqual(['u2', 'u3', 'u4', 'u5', 'u6']);
  });
});
