/**
 * 群聊回复欲望 — 未 @bot 的消息按规则打分决定是否接话，外加「对话窗口」。
 *
 * 文字（emoji、QQ 小黄脸都算文字），打分 0-1，越高越想接：
 *   - 空消息 / 斜杠命令 / @ 了别人 / 纯语气词：直接 0
 *   - 点名 bot 昵称：+0.7
 *   - 对话窗口内：刚和 bot 聊过的人 +0.6，其他人 +0.2
 *   - 像在提问：+0.2
 *
 * 表情包（QQ 用 faceType=6 标记的单张图，或单张 gif）：人会用表情包回表情包，但不会每张都回
 *   - 群友在复读同一张表情包（连续 3 条、至少两个人）：跟一张，同一串只跟一次
 *   - bot 刚用表情包接过一张：这个群 5 分钟内不再靠表情包接话（复读除外）
 *   - bot 已经用表情包接过这个人，他还没说过文字又甩一张：不接（防止互刷）
 *   - bot 刚说完话就有人甩表情包（在回应 bot）：+0.4
 *   - 对话窗口内：刚聊过的人 +0.3，其他人 +0.1（表情包多半是在收尾，不像文字那样要接）
 *   - 是 bot 自带的那套表情（画的就是它本人）：+0.7，基本是在逗它
 *   - 是 bot 自己收藏过的表情：+0.2
 *   单独一条理由（除了自带表情）都不够，要「刚说完话 + 窗口里的人」这类叠起来才接：
 *   热闹的群里 bot 几乎一直在说话，「刚说完话」单独放行时差不多每张表情包都会被接
 *
 * 对话窗口：bot 被 @ 或接话后开窗（turn/end 时从回复结束起续期），窗口内刚聊过的人
 * 再说话基本都会被接，表现为连续对话；靠打分接的轮数到上限就关窗，避免和人无限对聊。
 * 开团期间（跑团）不用窗口、也不复读：行动要 @，插嘴只保留点名和对 bot 的表情包回应。
 */
import { isImageContentType } from '../transport/attachment.ts';

export interface DesireAttachment {
  content_type?: string;
  filename?: string;
  url?: string;
}

export interface RecentMessage {
  senderId: string;
  /** 表情包标识（QQ 附件文件名是内容 MD5，同一张表情包跨人一致） */
  stickerId?: string;
}

export interface DesireInput {
  /** 原始消息内容（可含 <@…>、表情标签） */
  content: string;
  attachments?: readonly DesireAttachment[];
  senderId: string;
  /** 消息 @ 了别人（且没 @ bot） */
  mentionsOthers: boolean;
  /** bot 昵称/别名 */
  names: readonly string[];
  /** 当前群的对话窗口（未开窗或开团中为 undefined） */
  engagement?: EngagementState;
  /** 群里最近几条消息（旧→新，不含当前） */
  recent?: readonly RecentMessage[];
  /** bot 上次回复结束距今(ms)；没说过话为 undefined */
  sinceBotSpoke?: number;
  /** bot 已经用表情包接过这个人，之后他还没说过文字 */
  stickerAnswered?: boolean;
  /** 这串复读 bot 已经跟过 */
  chainAnswered?: string;
  /** bot 上次靠表情包接话距今(ms)；没接过为 undefined */
  sinceStickerReply?: number;
  /** 开团中：不复读 */
  dnd?: boolean;
  /** 当前这张表情包在 bot 收藏里的类型（按内容 MD5 比对） */
  collection?: 'pack' | 'auto';
}

export interface DesireResult {
  score: number;
  reasons: string[];
  /** 表情包消息：sticker = 用表情包回应，sticker-chain = 跟着复读 */
  mode?: 'sticker' | 'sticker-chain';
  stickerId?: string;
}

export interface EngagementState {
  until: number;
  /** 窗口内和 bot 聊过的人 */
  peers: Set<string>;
  /** 窗口内靠打分接过的轮数 */
  turns: number;
}

export interface ClassifiedMessage {
  /** 去掉 @/表情包标记后的文字，QQ 小黄脸换成它的名字 */
  text: string;
  stickerId?: string;
}

/** bot 说完话后多久内的表情包算在回应 bot */
export const STICKER_REACT_MS = 30_000;
/** bot 用表情包接过一张后，这个群多久内不再靠表情包接话 */
export const STICKER_COOLDOWN_MS = 5 * 60_000;
/** 复读判定：连续几条同一张表情包（含当前） */
const CHAIN_LENGTH = 3;
/** 靠模型打分连续主动接同一个人几次后停手 */
export const BANTER_MAX_STREAK = 2;
/** 隔多久不算连续 */
export const BANTER_STREAK_RESET_MS = 10 * 60_000;
const RECENT_LIMIT = 5;
/** 给模型打分看的 bot 最近几句话（群记忆只记群友说的，不记 bot 自己的） */
const BOT_LINES_LIMIT = 3;
const BOT_LINE_MAX_CHARS = 300;

/** 规则直接判 0 的原因：这些消息不值得再让模型看 */
const HARD_SKIP_REASONS = new Set(['empty', 'command', 'other-mention', 'noise']);

/** 规则没放行、也没明确拦下的文字消息，可以交给模型打分 */
export function isJudgeCandidate(text: string, result: DesireResult): boolean {
  return result.mode === undefined && text !== '' && !HARD_SKIP_REASONS.has(result.reasons[0] ?? '');
}

const FACE_RE = /<faceType=(\d+),faceId="[^"]*",ext="([^"]*)">/g;
const OLD_FACE_RE = /\[<face,id=\d+\/?>\]/g;
const STICKER_MARK_RE = /<faceType=6,/;
const TAG_RE = /<[^>]*>/g;
const NOISE_RE = /^[哈嘿呵嗯哦噢啊草笑乐wW6\s!！。.,，~～…?？]*$/;
const QUESTION_RE = /[?？]|吗|呢$|怎么|为什么|为啥|什么|咋|谁|哪/;

/** QQ 小黄脸的名字（ext 是 base64 的 {"text":"[笑哭]"}） */
export function faceText(ext: string): string {
  try {
    const parsed = JSON.parse(Buffer.from(ext, 'base64').toString('utf8')) as { text?: unknown };
    if (typeof parsed.text === 'string' && parsed.text.trim() !== '') return parsed.text.trim();
  } catch {
    // ext 解不开就当普通表情
  }
  return '[表情]';
}

function stickerIdOf(attachment: DesireAttachment): string | undefined {
  const name = attachment.filename?.replace(/\.[^.]*$/, '');
  if (name !== undefined && name !== '') return name.toUpperCase();
  return attachment.url;
}

/** 区分文字和表情包：faceType=6 是 QQ 给表情包的标记（附件就是那张图）；没有标记时单张 gif 也算 */
export function classifyMessage(content: string, attachments: readonly DesireAttachment[] = []): ClassifiedMessage {
  const marked = STICKER_MARK_RE.test(content);
  const text = content
    .replace(FACE_RE, (_m, type: string, ext: string) => (type === '6' ? '' : faceText(ext)))
    .replace(OLD_FACE_RE, '[表情]')
    .replace(TAG_RE, '')
    .trim();
  const only = attachments.length === 1 ? attachments[0]! : undefined;
  if (text === '' && only !== undefined && isImageContentType(only.content_type ?? '')
    && (marked || /gif/i.test(only.content_type ?? ''))) {
    const stickerId = stickerIdOf(only);
    if (stickerId !== undefined) return { text, stickerId };
  }
  return { text };
}

/** 当前这张和前面连续几条是同一张表情包，且不止一个人在发 */
function isChain(stickerId: string, senderId: string, recent: readonly RecentMessage[]): boolean {
  const prev = recent.slice(-(CHAIN_LENGTH - 1));
  if (prev.length < CHAIN_LENGTH - 1 || prev.some((m) => m.stickerId !== stickerId)) return false;
  return new Set([senderId, ...prev.map((m) => m.senderId)]).size >= 2;
}

function engagementBonus(input: DesireInput, reasons: string[]): number {
  if (input.engagement === undefined) return 0;
  if (input.engagement.peers.has(input.senderId)) {
    reasons.push('engaged-peer');
    return 0.6;
  }
  reasons.push('engaged');
  return 0.2;
}

function scoreSticker(input: DesireInput, stickerId: string): DesireResult {
  if (!input.dnd && stickerId !== input.chainAnswered && isChain(stickerId, input.senderId, input.recent ?? [])) {
    return { score: 1, reasons: ['sticker-chain'], mode: 'sticker-chain', stickerId };
  }
  if (input.sinceStickerReply !== undefined && input.sinceStickerReply < STICKER_COOLDOWN_MS) {
    return { score: 0, reasons: ['sticker-cooldown'], stickerId };
  }
  if (input.stickerAnswered === true) return { score: 0, reasons: ['sticker-volley'], stickerId };

  let score = 0;
  const reasons: string[] = [];
  if (input.sinceBotSpoke !== undefined && input.sinceBotSpoke <= STICKER_REACT_MS) {
    score += 0.4;
    reasons.push('sticker-react');
  }
  if (input.engagement !== undefined) {
    const peer = input.engagement.peers.has(input.senderId);
    score += peer ? 0.3 : 0.1;
    reasons.push(peer ? 'engaged-peer' : 'engaged');
  }
  if (input.collection === 'pack') {
    score += 0.7;
    reasons.push('sticker-mine');
  } else if (input.collection === 'auto') {
    score += 0.2;
    reasons.push('sticker-known');
  }
  return { score: Math.min(1, score), reasons, mode: 'sticker', stickerId };
}

/** 昵称按子串匹配：设置页里顺手敲的「大肥鱼；」「a, b」会让整条永远匹配不上，先按分隔符拆开 */
export function splitNames(names: readonly string[]): string[] {
  return names
    .flatMap((name) => name.split(/[;；,，、\s]+/))
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name !== '');
}

export function scoreReplyDesire(input: DesireInput): DesireResult {
  const { text, stickerId } = classifyMessage(input.content, input.attachments);
  if (input.mentionsOthers) return { score: 0, reasons: ['other-mention'] };
  if (stickerId !== undefined) return scoreSticker(input, stickerId);

  // 只有图片（照片、截图）没有文字：只有对话窗口能让它被接
  const hasAttachments = (input.attachments?.length ?? 0) > 0;
  if (text === '' && !hasAttachments) return { score: 0, reasons: ['empty'] };
  if (text.startsWith('/')) return { score: 0, reasons: ['command'] };

  const lower = text.toLowerCase();
  const named = splitNames(input.names).some((name) => lower.includes(name));
  if (!named && text !== '' && NOISE_RE.test(text)) return { score: 0, reasons: ['noise'] };

  let score = 0;
  const reasons: string[] = [];
  if (named) {
    score += 0.7;
    reasons.push('name');
  }
  score += engagementBonus(input, reasons);
  if (QUESTION_RE.test(text)) {
    score += 0.2;
    reasons.push('question');
  }
  return { score: Math.min(1, score), reasons };
}

interface GroupReplyState {
  engagement?: EngagementState;
  recent: RecentMessage[];
  botSpokeAt?: number;
  /** bot 用表情包接过、之后还没说过文字的人 */
  stickerAnswered: Set<string>;
  /** bot 已经跟过的那串复读 */
  chainAnswered?: string;
  /** bot 上次靠表情包（回应或复读）接话的时间 */
  stickerReplyAt?: number;
  /** bot 最近说的话 */
  botLines: Array<{ text: string; timestamp: number }>;
  /** bot 靠模型打分连续主动接的那个人 */
  banterStreak?: { senderId: string; count: number; at: number };
}

/** 按群维护对话窗口、最近消息、bot 上次说话时间等接话所需的状态 */
export class EngagementTracker {
  private readonly groups = new Map<string, GroupReplyState>();

  private group(groupId: string): GroupReplyState {
    let state = this.groups.get(groupId);
    if (state === undefined) {
      state = { recent: [], stickerAnswered: new Set(), botLines: [] };
      this.groups.set(groupId, state);
    }
    return state;
  }

  /** 当前窗口（过期即清除） */
  public get(groupId: string, now: number): EngagementState | undefined {
    const state = this.groups.get(groupId);
    const engagement = state?.engagement;
    if (state === undefined || engagement === undefined) return undefined;
    if (now > engagement.until) {
      state.engagement = undefined;
      return undefined;
    }
    return engagement;
  }

  /** 被 @ / 随机触发：开窗或续窗，轮数清零（明确叫了 bot，重新算） */
  public open(groupId: string, senderId: string, now: number, ms: number): void {
    const engagement = this.get(groupId, now) ?? { until: 0, peers: new Set<string>(), turns: 0 };
    engagement.until = now + ms;
    engagement.peers.add(senderId);
    engagement.turns = 0;
    this.group(groupId).engagement = engagement;
  }

  /** 靠打分接话：计一轮并续窗，到上限关窗（本条仍然接） */
  public take(groupId: string, senderId: string, now: number, ms: number, maxTurns: number): void {
    if (maxTurns <= 0) return;
    const state = this.group(groupId);
    const engagement = this.get(groupId, now) ?? { until: 0, peers: new Set<string>(), turns: 0 };
    engagement.turns += 1;
    if (engagement.turns >= maxTurns) {
      state.engagement = undefined;
      return;
    }
    engagement.until = now + ms;
    engagement.peers.add(senderId);
    state.engagement = engagement;
  }

  /** bot 回复结束：记下说话时间，并从现在起续期（只续已开的窗口） */
  public touch(groupId: string, now: number, ms: number): void {
    this.group(groupId).botSpokeAt = now;
    const engagement = this.get(groupId, now);
    if (engagement !== undefined) engagement.until = now + ms;
  }

  /** 群里最近几条消息（旧→新） */
  public recent(groupId: string): readonly RecentMessage[] {
    return this.groups.get(groupId)?.recent ?? [];
  }

  /** 记一条群消息（打分之后再记，打分时 recent 不含当前）；说了文字就解除表情包互刷限制 */
  public record(groupId: string, message: RecentMessage): void {
    const state = this.group(groupId);
    state.recent.push(message);
    if (state.recent.length > RECENT_LIMIT) state.recent.shift();
    if (message.stickerId === undefined) state.stickerAnswered.delete(message.senderId);
    if (state.chainAnswered !== undefined && message.stickerId !== state.chainAnswered) state.chainAnswered = undefined;
  }

  public sinceBotSpoke(groupId: string, now: number): number | undefined {
    const at = this.groups.get(groupId)?.botSpokeAt;
    return at === undefined ? undefined : now - at;
  }

  public stickerAnswered(groupId: string, senderId: string): boolean {
    return this.groups.get(groupId)?.stickerAnswered.has(senderId) ?? false;
  }

  public chainAnswered(groupId: string): string | undefined {
    return this.groups.get(groupId)?.chainAnswered;
  }

  /** 记下 bot 在群里说的话，给模型打分当上下文 */
  public noteBotSaid(groupId: string, text: string, now: number): void {
    const trimmed = text.trim();
    if (trimmed === '') return;
    const lines = this.group(groupId).botLines;
    lines.push({ text: trimmed.slice(0, BOT_LINE_MAX_CHARS), timestamp: now });
    if (lines.length > BOT_LINES_LIMIT) lines.shift();
  }

  public botLines(groupId: string): ReadonlyArray<{ text: string; timestamp: number }> {
    return this.groups.get(groupId)?.botLines ?? [];
  }

  /** 放行了一条表情包：复读记下这一串，回应记下这个人 */
  public markSticker(groupId: string, senderId: string, result: DesireResult, now: number): void {
    if (result.mode === undefined) return;
    const state = this.group(groupId);
    state.stickerReplyAt = now;
    if (result.mode === 'sticker-chain') state.chainAnswered = result.stickerId;
    else state.stickerAnswered.add(senderId);
  }

  /** 模型打分放行了一条：接的还是同一个人就累加，换人或隔太久重新算 */
  public noteBanter(groupId: string, senderId: string, now: number): void {
    const state = this.group(groupId);
    const streak = state.banterStreak;
    const continued = streak !== undefined && streak.senderId === senderId && now - streak.at <= BANTER_STREAK_RESET_MS;
    state.banterStreak = { senderId, count: continued ? streak.count + 1 : 1, at: now };
  }

  /** 这个人已经被连续接到上限（打分放行的文字不走对话窗口，轮数上限管不到这里） */
  public banterCapped(groupId: string, senderId: string, now: number): boolean {
    const streak = this.groups.get(groupId)?.banterStreak;
    return streak !== undefined && streak.senderId === senderId
      && streak.count >= BANTER_MAX_STREAK && now - streak.at <= BANTER_STREAK_RESET_MS;
  }

  public sinceStickerReply(groupId: string, now: number): number | undefined {
    const at = this.groups.get(groupId)?.stickerReplyAt;
    return at === undefined ? undefined : now - at;
  }
}

let shared: EngagementTracker | undefined;

/** 进程内共享实例：入站门控开窗，出站 turn/end 续期 */
export function getEngagementTracker(): EngagementTracker {
  shared ??= new EngagementTracker();
  return shared;
}
