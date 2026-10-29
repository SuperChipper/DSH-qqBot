/**
 * 回复欲望的模型打分 — 规则拿不准的文字消息，交给模型判断 bot 现在该不该接话。
 *
 * 只在规则既没放行也没明确拦下时才调用（点名、窗口内的人、语气词、表情包都不走这里），
 * 再加上 JudgeQueue 的防抖：群里连着说的几条只给最后一条打一次分。
 * 打分只要一个数字，推理档位默认取模型支持的最低档：思考内容按输出计费，还会拖慢判断。
 */
import { createUserMessage, BlockAssembler } from '@deepseek-ai/dsh-llm';
import type { ContentBlock, GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { ReplyJudgeConfig } from '../config.ts';
import type { Logger } from '../types.ts';

/** llm 服务里打分用到的部分 */
export interface JudgeLlm {
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
  resolveModelInfo?(provider: string, model: string, signal?: AbortSignal): Promise<{
    reasoning?: { efforts: ReadonlyArray<{ id: string; name: string }>; defaultEffort?: string };
  }>;
}

export interface JudgeLine {
  /** 发送者昵称；bot 自己说的话为 undefined */
  sender?: string;
  text: string;
  timestamp: number;
}

export interface JudgeRequest {
  provider: string;
  model: string;
  names: readonly string[];
  /** 群聊额外 system prompt（bot 人设），截断后给模型参考 */
  persona?: string;
  /** 最近的群聊（旧→新），最后一条是待判断的消息 */
  lines: readonly JudgeLine[];
}

/** 推理档位按这个顺序找最低档（id 或名字里含这些词） */
const LOW_EFFORT_HINTS = ['none', 'off', 'disable', 'minimal', 'min', 'low', 'fast'];
const PERSONA_MAX_CHARS = 600;
const LINE_MAX_CHARS = 200;

/** 从模型支持的档位里挑最低的；挑不出来就不传（用 provider 默认） */
export function pickLowestEffort(efforts: ReadonlyArray<{ id: string; name: string }>): string | undefined {
  for (const hint of LOW_EFFORT_HINTS) {
    const hit = efforts.find((e) => e.id.toLowerCase().includes(hint) || e.name.toLowerCase().includes(hint));
    if (hit !== undefined) return hit.id;
  }
  return undefined;
}

function clock(ts: number): string {
  const d = new Date(ts);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
}

export function buildJudgeSystem(names: readonly string[], persona?: string): string {
  const who = names.length > 0 ? `「${names.join('」「')}」` : '「bot」';
  const lines = [
    `你在帮 QQ 群里的机器人 ${who} 判断：看到最新这条消息，它现在要不要主动接话（没人 @ 它）。`,
    '群友叫它不一定用全名：名字的变体（叠字、只叫一半、换个字、加「小」「老」「子」）、照人设起的外号或调侃'
      + '（人设里的特点、爱好、梗），或者直接冲它说话（「起床」「在吗」「懒虫」），都算在叫它。',
    '像一个有分寸的群友那样判断：',
    '- 高分：在叫 bot、逗 bot、问 bot 或明显想听 bot 的意见；聊到 bot 感兴趣、能接得上的话题；有人求助一直没人回；话说到一半在等人接。',
    '- 低分：群友之间在聊自己的事；已经有人回答了；刷屏、发泄、只是附和；bot 刚说过话没人理它；插进去会显得突兀。',
    '- 拿不准就给低分，宁可少说。',
    '只输出 JSON，不要解释：{"desire": 0到100的整数}',
  ];
  if (persona !== undefined && persona.trim() !== '') {
    lines.push('', `bot 的人设（用来认出群友是不是在叫它、聊的是不是它会接的话题）：${persona.trim().slice(0, PERSONA_MAX_CHARS)}`);
  }
  return lines.join('\n');
}

export function buildJudgeTranscript(lines: readonly JudgeLine[]): string {
  const rows = lines.map((line, i) => {
    const who = line.sender === undefined ? '[bot]' : line.sender;
    const mark = i === lines.length - 1 ? '▶ ' : '';
    return `${mark}${clock(line.timestamp)} ${who}: ${line.text.replace(/\s+/g, ' ').slice(0, LINE_MAX_CHARS)}`;
  });
  return `最近的群聊（▶ 是最新一条）：\n${rows.join('\n')}`;
}

/** 解析 {"desire": n}，解析不出来返回 undefined */
export function parseDesire(text: string): number | undefined {
  const match = /"?desire"?\s*[:：]\s*(\d+(?:\.\d+)?)/i.exec(text) ?? /\b(\d{1,3})\b/.exec(text);
  if (match === null) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return undefined;
  return Math.max(0, Math.min(100, value)) / 100;
}

/** 调模型打分；推理档位按 provider/model 缓存 */
export class ReplyJudge {
  private readonly efforts = new Map<string, Promise<string | undefined>>();

  public constructor(
    private readonly llm: JudgeLlm,
    private readonly config: () => ReplyJudgeConfig,
    private readonly logger: Logger,
  ) {}

  /** 0-1；超时、出错、解析不出都按 undefined（调用方当不接处理） */
  public async score(request: JudgeRequest): Promise<number | undefined> {
    const cfg = this.config();
    const signal = AbortSignal.timeout(cfg.timeoutMs);
    try {
      const effort = await this.effortFor(request.provider, request.model, cfg.reasoningEffort, signal);
      const options: GenerateOptions = {
        provider: request.provider,
        model: request.model,
        ...(effort !== undefined ? { reasoningEffort: effort as GenerateOptions['reasoningEffort'] } : {}),
        system: buildJudgeSystem(request.names, request.persona),
        messages: [createUserMessage({
          content: [{ type: 'text', text: buildJudgeTranscript(request.lines) }],
          source: { kind: 'plugin', plugin: 'dsh-im-qqbot' },
        })],
        // 低档推理也可能吐一点思考，留余量，不然 JSON 还没写出来就被截断
        maxTokens: 512,
        signal,
      };
      const assembler = new BlockAssembler();
      for await (const chunk of this.llm.stream(options)) assembler.push(chunk);
      const text = assembler.blocks()
        .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
        .map((block) => block.text)
        .join(' ');
      const desire = parseDesire(text);
      if (desire === undefined) this.logger.warn(`reply-judge: 解析不出打分: ${text.slice(0, 120)}`);
      return desire;
    } catch (err) {
      this.logger.warn(`reply-judge: 打分失败: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  private effortFor(provider: string, model: string, configured: string, signal: AbortSignal): Promise<string | undefined> {
    if (configured.trim() !== '') return Promise.resolve(configured.trim());
    const key = `${provider}/${model}`;
    let cached = this.efforts.get(key);
    if (cached === undefined) {
      cached = this.resolveLowest(provider, model, signal);
      this.efforts.set(key, cached);
    }
    return cached;
  }

  private async resolveLowest(provider: string, model: string, signal: AbortSignal): Promise<string | undefined> {
    try {
      const info = await this.llm.resolveModelInfo?.(provider, model, signal);
      const efforts = info?.reasoning?.efforts ?? [];
      const picked = pickLowestEffort(efforts);
      this.logger.info(`reply-judge: ${provider}/${model} 推理档位 [${efforts.map((e) => e.id).join(', ')}]，打分用 ${picked ?? '(provider 默认)'}`);
      return picked;
    } catch (err) {
      this.logger.warn(`reply-judge: 查询推理档位失败，用 provider 默认: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }
}

export type JudgeOutcome = 'judge' | 'superseded';

interface PendingJudge {
  resolve: (outcome: JudgeOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
  firstAt: number;
}

/**
 * 按群防抖：群里安静 debounceMs 才放最后一条去打分，之前排着的都作废；
 * 一直有人说话时，最早那条排了 maxWaitMs 也要打一次，免得热闹的群里 bot 永远插不上话。
 */
export class JudgeQueue {
  private readonly pending = new Map<string, PendingJudge>();

  public constructor(private readonly config: () => ReplyJudgeConfig) {}

  /** 排一条候选消息；返回 judge = 轮到它打分，superseded = 被后来的消息顶掉了 */
  public enqueue(groupId: string, now: number): Promise<JudgeOutcome> {
    const previous = this.pending.get(groupId);
    const firstAt = previous?.firstAt ?? now;
    if (previous !== undefined) {
      clearTimeout(previous.timer);
      previous.resolve('superseded');
    }
    return new Promise<JudgeOutcome>((resolve) => {
      const entry: PendingJudge = { resolve, firstAt, timer: this.arm(groupId, now, firstAt) };
      this.pending.set(groupId, entry);
    });
  }

  /** 群里有新动静但不是候选（语气词、表情包等）：重新计时，候选不变 */
  public activity(groupId: string, now: number): void {
    const entry = this.pending.get(groupId);
    if (entry === undefined) return;
    clearTimeout(entry.timer);
    entry.timer = this.arm(groupId, now, entry.firstAt);
  }

  /** bot 反正要说话了（被 @ / 规则放行）：排着的候选作废 */
  public cancel(groupId: string): void {
    const entry = this.pending.get(groupId);
    if (entry === undefined) return;
    clearTimeout(entry.timer);
    this.pending.delete(groupId);
    entry.resolve('superseded');
  }

  private arm(groupId: string, now: number, firstAt: number): ReturnType<typeof setTimeout> {
    const cfg = this.config();
    const delay = Math.max(0, Math.min(cfg.debounceMs, firstAt + cfg.maxWaitMs - now));
    return setTimeout(() => {
      const entry = this.pending.get(groupId);
      if (entry === undefined) return;
      this.pending.delete(groupId);
      entry.resolve('judge');
    }, delay);
  }
}
