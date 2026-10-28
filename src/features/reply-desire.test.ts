import { describe, it, expect } from 'vitest';
import { EngagementTracker, scoreReplyDesire, type DesireInput } from './reply-desire.ts';

const base: DesireInput = { content: '', senderId: 'u1', mentionsOthers: false, names: ['小d', 'Dsh'] };

describe('scoreReplyDesire', () => {
  it('空消息 / 命令 / @ 别人 / 语气词直接 0', () => {
    expect(scoreReplyDesire({ ...base, content: '<faceType=1,faceId="1">' }).reasons).toEqual(['empty']);
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

  it('对话窗口内：聊过的人接，其他人只加一点', () => {
    const engagement = { until: Infinity, peers: new Set(['u1']), turns: 0 };
    expect(scoreReplyDesire({ ...base, content: '我觉得也是', engagement }).score).toBeGreaterThanOrEqual(0.6);
    expect(scoreReplyDesire({ ...base, senderId: 'u2', content: '我觉得也是', engagement }).score).toBeLessThan(0.6);
  });
});

describe('EngagementTracker', () => {
  it('窗口过期即清除，touch 只续已开的窗口', () => {
    const t = new EngagementTracker();
    t.touch('g', 0, 100);
    expect(t.get('g', 0)).toBeUndefined();
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
});
