import { describe, it, expect } from 'vitest';
import { EMPTY_ITEM_NOTE, parseRecord, renderChatRecord, splitQuote } from './chat-record.ts';

const sticker = `<faceType=6,faceId="0",ext="${Buffer.from('{"text":""}').toString('base64')}">`;

describe('parseRecord', () => {
  it('不是消息记录返回 undefined', () => {
    expect(parseRecord('普通的一句话')).toBeUndefined();
    expect(parseRecord('提到 === 消息 1 === 的一句话')).toBeUndefined();
  });

  it('内容可以跨行，含空行；\r 不留在结果里', () => {
    const parsed = parseRecord('=== 消息 1 ===\r\n[消息内容] 第一段\r\n\r\n第二段\r\n[发送者] 甲');
    expect(parsed?.items[0]).toMatchObject({ content: '第一段\n\n第二段', sender: '甲' });
  });
});

describe('renderChatRecord', () => {
  it('合并转发排成编号列表，内层转发标出平台没给内容', () => {
    const text = '[群聊的聊天记录]\n=== 消息 1 ===\n[发送者] Sanae\n\n=== 消息 2 ===\n[消息内容] 念一遍\n[发送者] Hikari\n';
    expect(renderChatRecord(text)).toBe(`[聊天记录，共 2 条]\n1. Sanae：${EMPTY_ITEM_NOTE}\n2. Hikari：念一遍`);
  });

  it('表情标签转成文字，附件行保留（forward 改写后的图片编号不能丢）', () => {
    const text = `[群聊的聊天记录]\n=== 消息 1 ===\n[消息内容] ${sticker}\n[发送者] 甲\n[附件1] [图片#2: C:/m/a.jpg] 尺寸:9x9`;
    expect(renderChatRecord(text)).toBe('[聊天记录，共 1 条]\n1. 甲：[表情包]\n   [附件1] [图片#2: C:/m/a.jpg] 尺寸:9x9');
  });

  it('普通消息原样返回', () => {
    expect(renderChatRecord('你好')).toBe('你好');
  });
});

describe('splitQuote', () => {
  it('普通引用不动', () => {
    expect(splitQuote('念了，一遍就够')).toEqual({ quote: '念了，一遍就够' });
  });

  it('引用一条回复：是这条在回复那条，不是转发', () => {
    const text = '=== 消息 1 ===\n[消息内容]   还有 wet job\n[消息类型] 引用消息\n[关联消息]\n--- 第1条 ---\n    [消息内容] 边实习边干活\n    [发送者] 甲\n    [消息类型] 引用消息\n';
    expect(splitQuote(text)).toEqual({ quote: '还有 wet job\n（这条在回复 甲：边实习边干活）' });
  });

  it('引用一份聊天记录：展开成列表', () => {
    const text = '=== 消息 1 ===\n[消息内容] [群聊的聊天记录]\n[消息类型] 引用消息\n[关联消息]\n--- 第1条 ---\n    [发送者] Sanae\n--- 第2条 ---\n    [消息内容] 念一遍\n    [发送者] Hikari\n';
    expect(splitQuote(text).quote).toBe(`[聊天记录，共 2 条]\n  1. Sanae：${EMPTY_ITEM_NOTE}\n  2. Hikari：念一遍`);
  });

  it('仅 @ + 上下文：空的引用消息是没给原文，后面的是上下文，末尾空条目丢掉', () => {
    const text = '=== 消息 1 ===\n[消息类型] 引用消息\n\n=== 消息 2 ===\n[消息内容] 看见了\n\n后半句\n\n=== 消息 3 ===\n[消息内容] 我写的是十条\n[关联消息]\n--- 第1条 ---\n    [消息内容] 上一句\n    [发送者] 甲\n    [消息类型] 引用消息\n\n=== 消息 4 ===\n';
    expect(splitQuote(text)).toEqual({ context: '1. 看见了\n\n后半句\n2. 我写的是十条\n   （这条在回复 甲：上一句）' });
  });
});
