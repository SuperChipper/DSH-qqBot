/**
 * 回复欲望门控中间件 — 接在 mentionGate({ passthrough: true }) 之后。
 *
 * mentionGate 已放行的（被 @ / 随机插嘴 / 私聊）直接通过，群里被 @ 或随机触发时顺带开对话窗口；
 * 没放行的群消息按 scoreReplyDesire 打分，过阈值就当作隐式 @（implicit）放行：
 * 不带 (@you) 标签，群历史回灌照常生效，跑团里也按「插嘴」处理。
 *
 * 规则拿不准的文字消息（没放行、也不是语气词/命令这类明确不接的），开了 judge 时交给模型：
 * 先按群防抖，只给一串里的最后一条打分。中间件在这里挂着等是安全的——网关不等上一条消息的
 * 中间件跑完就分发下一条，等待期间新消息照常进来，也正是靠它们来顶掉旧候选。
 *
 * 开团期间不开、不用对话窗口，也不调模型：跑团时每次行动都 @，窗口会一直开着，bot 会对玩家间的
 * 每句话插嘴，窗口里不 @ 的行动宣告还会被当成插嘴、回了却不结算。
 */
import type { MiddlewareContext } from '@tencent-connect/qqbot-nodejs';
import type { ImQQBotConfig } from '../config.ts';
import type { SessionManager } from '../session/index.ts';
import type { Logger } from '../types.ts';
import {
  classifyMessage,
  getEngagementTracker,
  isJudgeCandidate,
  scoreReplyDesire,
  type DesireAttachment,
  type DesireResult,
} from '../features/reply-desire.ts';
import type { JudgeLine, JudgeQueue, ReplyJudge } from '../features/reply-judge.ts';
import { readRecentGroupMessages } from '../features/group-memory.ts';

interface MentionState {
  wasMentioned: boolean;
  implicit: boolean;
  shouldAnswer: boolean;
  reason: string;
}

export interface JudgeDeps {
  judge: Pick<ReplyJudge, 'score'>;
  queue: JudgeQueue;
}

/** 给模型看的上下文：群记忆里截到当前消息为止，再按时间插进 bot 自己说过的话 */
function judgeLines(config: ImQQBotConfig, groupId: string, messageId: string): JudgeLine[] {
  const limit = config.replyDesire.judge.contextMessages;
  const recent = readRecentGroupMessages(config.appId, groupId, limit + 10);
  const cut = recent.findIndex((e) => e.messageId === messageId);
  const upto = cut >= 0 ? recent.slice(0, cut + 1) : recent;
  const lines: JudgeLine[] = upto.map((e) => {
    const { text, stickerId } = classifyMessage(e.content);
    const shown = text !== '' ? text : (stickerId !== undefined || (e.images?.length ?? 0) > 0 ? '[图片]' : '');
    return { sender: e.senderName ?? e.senderId.slice(-6), text: shown, timestamp: e.timestamp };
  }).filter((line) => line.text !== '');
  const current = lines[lines.length - 1];
  const bot = getEngagementTracker().botLines(groupId)
    .filter((line) => current === undefined || line.timestamp <= current.timestamp)
    .map((line) => ({ text: line.text, timestamp: line.timestamp }));
  // 当前消息必须留在最后（模型按 ▶ 判断），bot 的话只往它前面插
  const before = [...lines.slice(0, -1), ...bot].sort((a, b) => a.timestamp - b.timestamp);
  return [...before, ...(current !== undefined ? [current] : [])].slice(-limit);
}

export function replyDecider(config: ImQQBotConfig, manager: SessionManager, logger: Logger, judgeDeps?: JudgeDeps) {
  const tracker = getEngagementTracker();
  return async (ctx: MiddlewareContext, next: () => Promise<void>): Promise<void> => {
    const msg = ctx.message;
    const groupId = msg.groupOpenid;
    if (msg.kind !== 'group' || groupId === undefined) {
      await next();
      return;
    }

    const rd = config.replyDesire;
    const now = Date.now();
    const content = String(msg.content ?? '');
    const attachments = (msg as { attachments?: DesireAttachment[] }).attachments ?? [];
    const { text, stickerId } = classifyMessage(content, attachments);
    const dnd = manager.dndService?.active(manager.sessionKey('group', groupId)) !== undefined;
    const mention = ctx.state.mention as MentionState | undefined;
    const queue = judgeDeps?.queue;

    const answer = async (result: DesireResult): Promise<void> => {
      queue?.cancel(groupId);
      if (!dnd) tracker.take(groupId, msg.senderId, Date.now(), rd.engagedMs, rd.engagedMaxTurns);
      tracker.markSticker(groupId, msg.senderId, result, Date.now());
      ctx.state.mention = { wasMentioned: mention?.wasMentioned ?? false, implicit: true, shouldAnswer: true, reason: 'passthrough' };
      ctx.state.replyDesire = result;
      logger.info(`reply-desire: answer group=${groupId} score=${result.score.toFixed(2)} [${result.reasons.join(',')}]`);
      await next();
    };

    if (mention === undefined || mention.shouldAnswer) {
      tracker.record(groupId, { senderId: msg.senderId, stickerId });
      queue?.cancel(groupId);
      if (!dnd && rd.engagedMaxTurns > 0 && (mention?.wasMentioned === true || mention?.implicit === true)) {
        tracker.open(groupId, msg.senderId, now, rd.engagedMs);
      }
      await next();
      return;
    }

    // 开团且关了插嘴：只回 @（与 groupReplyProbability 的规则一致）
    if (dnd && config.dnd?.interjections === false) {
      tracker.record(groupId, { senderId: msg.senderId, stickerId });
      ctx.stop('reply-desire:dnd');
      return;
    }

    const mentions = (msg as { mentions?: Array<{ is_you?: boolean } | undefined> }).mentions;
    const result = scoreReplyDesire({
      content,
      attachments,
      senderId: msg.senderId,
      mentionsOthers: Array.isArray(mentions) && mentions.some((m) => m?.is_you !== true),
      names: rd.names,
      engagement: dnd ? undefined : tracker.get(groupId, now),
      recent: tracker.recent(groupId),
      sinceBotSpoke: tracker.sinceBotSpoke(groupId, now),
      stickerAnswered: tracker.stickerAnswered(groupId, msg.senderId),
      chainAnswered: tracker.chainAnswered(groupId),
      sinceStickerReply: tracker.sinceStickerReply(groupId, now),
      dnd,
      collection: stickerId !== undefined ? manager.stickerStore?.collectionKind(stickerId) : undefined,
    });
    tracker.record(groupId, { senderId: msg.senderId, stickerId });
    if (result.score >= rd.threshold) {
      await answer(result);
      return;
    }

    if (judgeDeps === undefined || dnd || !isJudgeCandidate(text, result)) {
      queue?.activity(groupId, now);
      if (config.debug) {
        logger.debug(`reply-desire: skip score=${result.score.toFixed(2)} [${result.reasons.join(',')}]`);
      }
      ctx.stop('reply-desire:low');
      return;
    }

    const outcome = await judgeDeps.queue.enqueue(groupId, now);
    if (outcome === 'superseded') {
      ctx.stop('reply-desire:superseded');
      return;
    }
    const route = manager.getEffectiveModel('group', groupId);
    const provider = rd.judge.provider || route?.provider || config.provider;
    const model = rd.judge.model || route?.model || config.model;
    if (!provider || !model) {
      logger.warn('reply-desire: 没有可用的打分模型（judge.provider/model 和主模型都没配置）');
      ctx.stop('reply-desire:no-model');
      return;
    }
    const desire = await judgeDeps.judge.score({
      provider,
      model,
      names: rd.names,
      persona: config.groupPrompt,
      lines: judgeLines(config, groupId, msg.messageId),
    });
    if (desire === undefined || desire < rd.threshold) {
      logger.info(`reply-desire: judge skip group=${groupId} desire=${desire?.toFixed(2) ?? 'n/a'}`);
      ctx.stop('reply-desire:judge-low');
      return;
    }
    await answer({ score: desire, reasons: [...result.reasons, 'judge'] });
  };
}
