import { describe, it, expect } from 'vitest';
import { isBlankReply } from '../transport/text-guard.ts';
import { BANTER_PROMPT, isBanterGroup } from './banter.ts';
import { BANTER_STREAK_RESET_MS, EngagementTracker } from './reply-desire.ts';

describe('isBanterGroup', () => {
  it('总开关打开且群在列表里才算', () => {
    expect(isBanterGroup({ banter: { enabled: true, groups: ['g1'] } }, 'g1')).toBe(true);
    expect(isBanterGroup({ banter: { enabled: true, groups: ['g1'] } }, 'g2')).toBe(false);
    expect(isBanterGroup({ banter: { enabled: false, groups: ['g1'] } }, 'g1')).toBe(false);
    expect(isBanterGroup({} as never, 'g1')).toBe(false);
  });
});

describe('BANTER_PROMPT', () => {
  it('让模型不说话用的句号确实会被出站丢弃', () => {
    expect(BANTER_PROMPT).toContain('只回一个句号「。」');
    expect(isBlankReply('。')).toBe(true);
  });
});

describe('EngagementTracker 串模式连击', () => {
  it('连续接同一个人到上限后停手，换人或隔太久重新算', () => {
    const tracker = new EngagementTracker();
    tracker.noteBanter('g', 'u1', 0);
    expect(tracker.banterCapped('g', 'u1', 0)).toBe(false);
    tracker.noteBanter('g', 'u1', 1);
    expect(tracker.banterCapped('g', 'u1', 1)).toBe(true);
    expect(tracker.banterCapped('g', 'u2', 1)).toBe(false);
    expect(tracker.banterCapped('g', 'u1', 2 + BANTER_STREAK_RESET_MS)).toBe(false);

    tracker.noteBanter('g', 'u2', 2);
    expect(tracker.banterCapped('g', 'u1', 2)).toBe(false);

    tracker.noteBanter('g', 'u2', 3 + BANTER_STREAK_RESET_MS);
    expect(tracker.banterCapped('g', 'u2', 3 + BANTER_STREAK_RESET_MS)).toBe(false);
  });
});
