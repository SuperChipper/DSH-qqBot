/**
 * 群聊回复欲望 — 未 @bot 的消息按规则打分决定是否接话，外加「对话窗口」。
 *
 * 打分（0-1，越高越想接）：
 *   - 空消息 / 斜杠命令 / @ 了别人 / 纯语气词：直接 0
 *   - 点名 bot 昵称：+0.7
 *   - 对话窗口内：刚和 bot 聊过的人 +0.6，其他人 +0.2
 *   - 像在提问：+0.2
 *
 * 对话窗口：bot 被 @ 或接话后开窗（turn/end 时从回复结束起续期），窗口内刚聊过的人
 * 再说话基本都会被接，表现为连续对话；靠打分接的轮数到上限就关窗，避免和人无限对聊。
 */

export interface DesireInput {
  /** 原始消息内容（可含 <@…>、表情标签） */
  content: string;
  senderId: string;
  /** 消息 @ 了别人（且没 @ bot） */
  mentionsOthers: boolean;
  /** bot 昵称/别名 */
  names: readonly string[];
  /** 当前群的对话窗口（未开窗为 undefined） */
  engagement?: EngagementState;
}

export interface DesireResult {
  score: number;
  reasons: string[];
}

export interface EngagementState {
  until: number;
  /** 窗口内和 bot 聊过的人 */
  peers: Set<string>;
  /** 窗口内靠打分接过的轮数 */
  turns: number;
}

const TAG_RE = /<[^>]*>/g;
const NOISE_RE = /^[哈嘿呵嗯哦噢啊草笑乐wW6\s!！。.,，~～…?？]*$/;
const QUESTION_RE = /[?？]|吗|呢$|怎么|为什么|为啥|什么|咋|谁|哪/;

export function scoreReplyDesire(input: DesireInput): DesireResult {
  const text = input.content.replace(TAG_RE, '').trim();
  if (text === '') return { score: 0, reasons: ['empty'] };
  if (text.startsWith('/')) return { score: 0, reasons: ['command'] };
  if (input.mentionsOthers) return { score: 0, reasons: ['other-mention'] };

  const lower = text.toLowerCase();
  const named = input.names.some((name) => name.trim() !== '' && lower.includes(name.trim().toLowerCase()));
  if (!named && NOISE_RE.test(text)) return { score: 0, reasons: ['noise'] };

  let score = 0;
  const reasons: string[] = [];
  if (named) {
    score += 0.7;
    reasons.push('name');
  }
  if (input.engagement !== undefined) {
    if (input.engagement.peers.has(input.senderId)) {
      score += 0.6;
      reasons.push('engaged-peer');
    } else {
      score += 0.2;
      reasons.push('engaged');
    }
  }
  if (QUESTION_RE.test(text)) {
    score += 0.2;
    reasons.push('question');
  }
  return { score: Math.min(1, score), reasons };
}

/** 按群维护对话窗口 */
export class EngagementTracker {
  private readonly groups = new Map<string, EngagementState>();

  /** 当前窗口（过期即清除） */
  public get(groupId: string, now: number): EngagementState | undefined {
    const state = this.groups.get(groupId);
    if (state === undefined) return undefined;
    if (now > state.until) {
      this.groups.delete(groupId);
      return undefined;
    }
    return state;
  }

  /** 被 @ / 随机触发：开窗或续窗，轮数清零（明确叫了 bot，重新算） */
  public open(groupId: string, senderId: string, now: number, ms: number): void {
    const state = this.get(groupId, now) ?? { until: 0, peers: new Set<string>(), turns: 0 };
    state.until = now + ms;
    state.peers.add(senderId);
    state.turns = 0;
    this.groups.set(groupId, state);
  }

  /** 靠打分接话：计一轮并续窗，到上限关窗（本条仍然接） */
  public take(groupId: string, senderId: string, now: number, ms: number, maxTurns: number): void {
    if (maxTurns <= 0) return;
    const state = this.get(groupId, now) ?? { until: 0, peers: new Set<string>(), turns: 0 };
    state.turns += 1;
    if (state.turns >= maxTurns) {
      this.groups.delete(groupId);
      return;
    }
    state.until = now + ms;
    state.peers.add(senderId);
    this.groups.set(groupId, state);
  }

  /** bot 回复结束：从现在起续期（只续已开的窗口） */
  public touch(groupId: string, now: number, ms: number): void {
    const state = this.get(groupId, now);
    if (state !== undefined) state.until = now + ms;
  }
}

let shared: EngagementTracker | undefined;

/** 进程内共享实例：入站门控开窗，出站 turn/end 续期 */
export function getEngagementTracker(): EngagementTracker {
  shared ??= new EngagementTracker();
  return shared;
}
