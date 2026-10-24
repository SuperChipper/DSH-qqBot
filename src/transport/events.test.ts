import { describe, it, expect } from 'vitest';
import { parseStreamFrame } from './events.ts';

/** 构造 agent/assistant-stream 的 payload（帧字段按宿主 AssistantStreamFrame 形态） */
function payload(frame: unknown, agentId = 'sess-qq'): unknown {
  return { agent: { id: agentId }, frame };
}

describe('parseStreamFrame', () => {
  it('start 帧归一化为 attempt-start', () => {
    expect(parseStreamFrame(payload({ type: 'start', attemptId: 'a1', revision: 1, turn: 1, step: 1 })))
      .toEqual({ agentId: 'sess-qq', delta: { kind: 'attempt-start', attemptId: 'a1' } });
  });

  it('text-delta chunk 归一化为 text-delta', () => {
    expect(parseStreamFrame(payload({
      type: 'chunk', attemptId: 'a1', revision: 1, index: 0, time: 1,
      chunk: { type: 'text-delta', index: 0, text: 'hi' },
    }))).toEqual({ agentId: 'sess-qq', delta: { kind: 'text-delta', attemptId: 'a1', text: 'hi' } });
  });

  it.each([
    ['reasoning-delta', { type: 'reasoning-delta', index: 0, text: '思考' }],
    ['tool-call-delta', { type: 'tool-call-delta', index: 1, id: 'c1', argumentsDelta: '{}' }],
    ['block-start', { type: 'block-start', index: 0, blockType: 'text' }],
    ['finish', { type: 'finish', reason: { kind: 'stop' } }],
  ])('忽略非文本 %s chunk', (_name, chunk) => {
    expect(parseStreamFrame(payload({ type: 'chunk', attemptId: 'a1', chunk }))).toBeUndefined();
  });

  it('忽略 end 帧（收尾由 durable assistant/message / turn/end 负责）', () => {
    expect(parseStreamFrame(payload({
      type: 'end', attemptId: 'a1',
      outcome: { kind: 'committed', eventType: 'assistant/message', seq: 3 },
    }))).toBeUndefined();
  });

  it.each([
    ['null', null],
    ['非对象', 'x'],
    ['缺 agent', { frame: { type: 'start', attemptId: 'a1' } }],
    ['缺 agent.id', { agent: {}, frame: { type: 'start', attemptId: 'a1' } }],
    ['缺 frame', { agent: { id: 'sess-qq' } }],
    ['frame 为 null', { agent: { id: 'sess-qq' }, frame: null }],
    ['缺 attemptId', { agent: { id: 'sess-qq' }, frame: { type: 'start' } }],
    ['未知帧类型', { agent: { id: 'sess-qq' }, frame: { type: 'future', attemptId: 'a1' } }],
    ['空 text-delta', { agent: { id: 'sess-qq' }, frame: { type: 'chunk', attemptId: 'a1', chunk: { type: 'text-delta', text: '' } } }],
  ])('非法输入返回 undefined：%s', (_name, raw) => {
    expect(parseStreamFrame(raw)).toBeUndefined();
  });
});
