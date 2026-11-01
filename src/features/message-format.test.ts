import { describe, it, expect } from 'vitest';
import { formatMessageTime, GROUP_MESSAGE_FORMAT_PROMPT, makeSenderLabeler, quoteHeader, senderTag } from './message-format.ts';

describe('senderTag', () => {
  it('昵称 + 群内短别名，不带 openid', () => {
    expect(senderTag('U3', '阿乙')).toBe('[阿乙 #U3]');
  });

  it('没有昵称时只有别名', () => {
    expect(senderTag('U3')).toBe('[#U3]');
    expect(senderTag('U3', '  ')).toBe('[#U3]');
  });

  it('makeSenderLabeler 用给定的别名函数把 openid 换成标签', () => {
    const label = makeSenderLabeler((id) => (id === 'E4F4AEA33253A2797FB897C50B81D7ED' ? 'U1' : 'U2'));
    expect(label('E4F4AEA33253A2797FB897C50B81D7ED', '甲')).toBe('[甲 #U1]');
    expect(label('other')).toBe('[#U2]');
  });
});

describe('quoteHeader', () => {
  it('带被引用人的标签', () => {
    expect(quoteHeader('[乙 #U2]')).toBe('[Quoted message from [乙 #U2]]');
  });

  it('查不到发送者时明说未知', () => {
    expect(quoteHeader(undefined)).toBe('[Quoted message from 未知发送者]');
  });
});

describe('formatMessageTime', () => {
  const now = new Date(2026, 9, 29, 21, 30).getTime();

  it('当天只写 HH:mm', () => {
    expect(formatMessageTime(new Date(2026, 9, 29, 9, 5).getTime(), now)).toBe('09:05');
  });

  it('跨天带月-日', () => {
    expect(formatMessageTime(new Date(2026, 9, 27, 23, 59).getTime(), now)).toBe('10-27 23:59');
  });

  it('接受 ISO 字符串（QQ 事件的 timestamp）', () => {
    const iso = new Date(2026, 9, 29, 21, 0).toISOString();
    expect(formatMessageTime(iso, now)).toBe('21:00');
  });

  it('缺失或无效时返回空串', () => {
    expect(formatMessageTime(undefined, now)).toBe('');
    expect(formatMessageTime('', now)).toBe('');
    expect(formatMessageTime('not a date', now)).toBe('');
  });
});

describe('GROUP_MESSAGE_FORMAT_PROMPT', () => {
  it('说明了 prompt 里出现的每个标注，并且按别名认人', () => {
    for (const marker of ['[昵称 #U3]', '#U 编号', '[Current message]', '(@you)', '[Chat history begins]', '[Quoted message from', '未知发送者', 'declared_by']) {
      expect(GROUP_MESSAGE_FORMAT_PROMPT).toContain(marker);
    }
    expect(GROUP_MESSAGE_FORMAT_PROMPT).not.toContain('openid');
  });
});
