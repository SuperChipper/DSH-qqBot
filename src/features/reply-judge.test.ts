import { describe, it, expect, vi, afterEach } from 'vitest';
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import { REPLY_JUDGE_DEFAULTS, type ReplyJudgeConfig } from '../config.ts';
import type { Logger } from '../types.ts';
import {
  JudgeQueue,
  ReplyJudge,
  buildJudgeSystem,
  buildJudgeTranscript,
  parseDesire,
  pickLowestEffort,
  type JudgeLlm,
} from './reply-judge.ts';

const logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;

describe('pickLowestEffort', () => {
  it('按 none → minimal → low 的顺序挑，挑不到返回 undefined', () => {
    expect(pickLowestEffort([{ id: 'high', name: 'High' }, { id: 'low', name: 'Low' }, { id: 'none', name: 'Off' }])).toBe('none');
    expect(pickLowestEffort([{ id: 'max', name: 'Max' }, { id: 'e1', name: 'Minimal' }])).toBe('e1');
    expect(pickLowestEffort([{ id: 'high', name: 'High' }])).toBeUndefined();
  });
});

describe('buildJudgeSystem', () => {
  it('串模式不再给群友之间的聊天低分，改看有没有具体可接的点', () => {
    expect(buildJudgeSystem(['小d'])).toContain('群友之间在聊自己的事');
    const banter = buildJudgeSystem(['小d'], undefined, true);
    expect(banter).not.toContain('群友之间在聊自己的事');
    expect(banter).toContain('前后矛盾');
    expect(banter).toContain('拿不准就给低分');
  });
});

describe('parseDesire', () => {
  it('解析 JSON 或裸数字，截到 0-1', () => {
    expect(parseDesire('{"desire": 73}')).toBe(0.73);
    expect(parseDesire('```json\n{"desire":150}\n```')).toBe(1);
    expect(parseDesire('desire：20')).toBe(0.2);
    expect(parseDesire('45')).toBe(0.45);
    expect(parseDesire('不想接')).toBeUndefined();
  });
});

describe('buildJudgeTranscript', () => {
  it('bot 的话标 [bot]，最后一条标 ▶，长消息截断', () => {
    const t = buildJudgeTranscript([
      { sender: '阿明', text: '今天好热', timestamp: 0 },
      { text: '开空调啊', timestamp: 1 },
      { sender: '小红', text: 'x'.repeat(500), timestamp: 2 },
    ]);
    const rows = t.split('\n').slice(1);
    expect(rows[1]).toMatch(/\[bot\]: 开空调啊$/);
    expect(rows[2]!.startsWith('▶ ')).toBe(true);
    expect(rows[2]!.length).toBeLessThan(260);
  });
});

function fakeLlm(reply: string, efforts?: Array<{ id: string; name: string }>) {
  const calls: GenerateOptions[] = [];
  const llm: JudgeLlm = {
    async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      calls.push(options);
      yield { type: 'block-start', index: 0, blockType: 'text' } as StreamChunk;
      yield { type: 'text-delta', index: 0, text: reply } as StreamChunk;
      yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } } as StreamChunk;
      yield { type: 'finish', reason: { kind: 'stop' } } as StreamChunk;
    },
    resolveModelInfo: vi.fn(async () => (efforts === undefined ? {} : { reasoning: { efforts } })),
  };
  return { llm, calls };
}

const request = { provider: 'p', model: 'm', names: ['小d'], lines: [{ sender: 'a', text: '在吗', timestamp: 0 }] };

describe('ReplyJudge', () => {
  it('自动用最低推理档，同一模型只查一次档位', async () => {
    const { llm, calls } = fakeLlm('{"desire": 80}', [{ id: 'high', name: 'High' }, { id: 'low', name: 'Low' }]);
    const judge = new ReplyJudge(llm, () => REPLY_JUDGE_DEFAULTS, logger);
    expect(await judge.score(request)).toBe(0.8);
    await judge.score(request);
    expect(calls[0]!.reasoningEffort).toBe('low');
    expect(calls[0]!.system).toContain('小d');
    expect(calls[0]!.system).toContain('名字的变体');
    expect(llm.resolveModelInfo).toHaveBeenCalledTimes(1);
  });

  it('配置了档位就直接用；模型不给档位就不传', async () => {
    const configured = fakeLlm('{"desire": 10}', [{ id: 'low', name: 'Low' }]);
    await new ReplyJudge(configured.llm, () => ({ ...REPLY_JUDGE_DEFAULTS, reasoningEffort: 'medium' }), logger).score(request);
    expect(configured.calls[0]!.reasoningEffort).toBe('medium');
    const none = fakeLlm('{"desire": 10}');
    await new ReplyJudge(none.llm, () => REPLY_JUDGE_DEFAULTS, logger).score(request);
    expect(none.calls[0]!.reasoningEffort).toBeUndefined();
  });

  it('出错按 undefined 处理，不抛', async () => {
    const llm: JudgeLlm = {
      // eslint-disable-next-line require-yield
      async *stream(): AsyncIterable<StreamChunk> { throw new Error('boom'); },
    };
    expect(await new ReplyJudge(llm, () => REPLY_JUDGE_DEFAULTS, logger).score(request)).toBeUndefined();
  });
});

describe('JudgeQueue', () => {
  afterEach(() => { vi.useRealTimers(); });
  const cfg: ReplyJudgeConfig = { ...REPLY_JUDGE_DEFAULTS, debounceMs: 1000, maxWaitMs: 2500 };

  it('连着来的候选只有最后一条去打分', async () => {
    vi.useFakeTimers();
    const q = new JudgeQueue(() => cfg);
    const first = q.enqueue('g', 0);
    vi.advanceTimersByTime(500);
    const second = q.enqueue('g', 500);
    expect(await first).toBe('superseded');
    vi.advanceTimersByTime(1000);
    expect(await second).toBe('judge');
  });

  it('一直有动静时，最早那条排满 maxWaitMs 也要打分', async () => {
    vi.useFakeTimers();
    const q = new JudgeQueue(() => cfg);
    const p = q.enqueue('g', 0);
    let settled: string | undefined;
    void p.then((v) => { settled = v; });
    for (let t = 800; t <= 2400; t += 800) {
      vi.advanceTimersByTime(800);
      q.activity('g', t);
    }
    await vi.advanceTimersByTimeAsync(100);
    expect(settled).toBe('judge');
  });

  it('bot 反正要说话时 cancel 掉候选', async () => {
    vi.useFakeTimers();
    const q = new JudgeQueue(() => cfg);
    const p = q.enqueue('g', 0);
    q.cancel('g');
    expect(await p).toBe('superseded');
  });
});
