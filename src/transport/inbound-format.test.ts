import { describe, it, expect } from 'vitest';
import type { ResolvedQuote } from '@tencent-connect/qqbot-nodejs';
import { buildAgentBody, buildQuotePart, buildUserMessage } from './inbound.ts';
import { quoteSenderFill } from '../gateway/middleware-setup.ts';
import { makeSenderLabeler } from '../features/message-format.ts';

const ALIASES: Record<string, string> = { u1: 'U1', u2: 'U2', u3: 'U3' };
const label = makeSenderLabeler((id) => ALIASES[id] ?? 'U9');
const group = { tag: label('u1', '甲'), isGroup: true, wasMentioned: true, senderTagged: false, time: '21:05' };

describe('buildUserMessage', () => {
  it('群聊：[Current message] 起头，下一行是 [昵称 #别名] 和 (@you)', () => {
    expect(buildUserMessage('你好', '', group)).toBe('[Current message] 21:05\n[甲 #U1] 你好 (@you)');
  });

  it('群聊没被 @（随机冒泡）时不带 (@you)，没有时间就不写', () => {
    expect(buildUserMessage('你好', '', { ...group, wasMentioned: false, time: '' })).toBe('[Current message]\n[甲 #U1] 你好');
  });

  it('多人合并的内容已按行带标签，不再整体加', () => {
    const content = '[甲 #U1] 一 (@you)\n[乙 #U2] 二';
    expect(buildUserMessage(content, '', { ...group, senderTagged: true })).toBe(`[Current message] 21:05\n${content}`);
  });

  it('引用块带被引用人的别名，在 [Current message] 之前，只出现一次 [Current message]', () => {
    const quote = buildQuotePart({ refKey: 'r', source: 'store', text: '原话', entry: { messageId: 'm', senderId: 'u2', senderName: '乙', content: '原话', timestamp: '' } }, label);
    const body = buildUserMessage('说得对', quote, group);
    expect(body).toBe('[Quoted message from [乙 #U2]]\n原话\n[Quoted message ends]\n[Current message] 21:05\n[甲 #U1] 说得对 (@you)');
    expect(body.match(/\[Current message\]/g)).toHaveLength(1);
  });

  it('私聊不加发送者标签，只在有引用时分隔', () => {
    const c2c = { ...group, tag: '', isGroup: false };
    expect(buildUserMessage('你好', '', c2c)).toBe('你好');
    expect(buildUserMessage('你好', buildQuotePart({ refKey: 'r', source: 'msg_elements', text: '上一句' }, () => '对方'), c2c))
      .toBe('[Quoted message from 未知发送者]\n上一句\n[Quoted message ends]\n[Current message]\n你好');
  });
});

describe('buildAgentBody', () => {
  const now = new Date(2026, 9, 29, 21, 30).getTime();
  const history = [
    { messageId: 'm1', senderId: 'u2', senderName: '乙', content: '昨天的', timestamp: new Date(2026, 9, 28, 22, 0).getTime() },
    { messageId: 'm2', senderId: 'u3', content: '没昵称', timestamp: new Date(2026, 9, 29, 21, 1).getTime() },
  ];

  it('历史行带时间和 [昵称 #别名]，不出现 openid；[Current message] 由当前消息自己给出，不重复', () => {
    const base = buildUserMessage('在吗', '', group);
    const body = buildAgentBody(base, history, true, true, label, [], now);
    expect(body).toContain('10-28 22:00 [乙 #U2] 昨天的');
    expect(body).toContain('21:01 [#U3] 没昵称');
    expect(body).not.toMatch(/\(u\d\)/);
    expect(body.match(/^\[Current message\]/gm)).toHaveLength(1);
    expect(body.endsWith('[Current message] 21:05\n[甲 #U1] 在吗 (@you)')).toBe(true);
  });
});

describe('quoteSenderFill', () => {
  it('msg_elements 解析出的引用补回 store 里的发送者，原文不变', async () => {
    const entry = { messageId: 'm', senderId: 'u2', senderName: '乙', content: '截断的原话', timestamp: '' };
    const ctx = { state: { quote: { refKey: 'r', source: 'msg_elements', text: '完整原话' } as ResolvedQuote } };
    await quoteSenderFill({ get: () => entry, set: () => {} })(ctx as never, async () => {});
    expect(ctx.state.quote.entry).toEqual(entry);
    expect(ctx.state.quote.text).toBe('完整原话');
  });

  it('store 里没有时保持原样', async () => {
    const quote = { refKey: 'r', source: 'msg_elements', text: 'x' } as ResolvedQuote;
    const ctx = { state: { quote } };
    await quoteSenderFill({ get: () => undefined, set: () => {} })(ctx as never, async () => {});
    expect(ctx.state.quote).toBe(quote);
  });
});
