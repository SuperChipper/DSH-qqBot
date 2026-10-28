/**
 * 回复欲望门控中间件 — 接在 mentionGate({ passthrough: true }) 之后。
 *
 * mentionGate 已放行的（被 @ / 随机插嘴 / 私聊）直接通过，群里被 @ 或随机触发时顺带开对话窗口；
 * 没放行的群消息按 scoreReplyDesire 打分，过阈值就当作隐式 @（implicit）放行：
 * 不带 (@you) 标签，群历史回灌照常生效，跑团里也按「插嘴」处理。
 */
import type { MiddlewareContext } from '@tencent-connect/qqbot-nodejs';
import type { ImQQBotConfig } from '../config.ts';
import type { SessionManager } from '../session/index.ts';
import type { Logger } from '../types.ts';
import { getEngagementTracker, scoreReplyDesire } from '../features/reply-desire.ts';

interface MentionState {
  wasMentioned: boolean;
  implicit: boolean;
  shouldAnswer: boolean;
  reason: string;
}

export function replyDecider(config: ImQQBotConfig, manager: SessionManager, logger: Logger) {
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
    const mention = ctx.state.mention as MentionState | undefined;
    if (mention === undefined || mention.shouldAnswer) {
      if (rd.engagedMaxTurns > 0 && (mention?.wasMentioned === true || mention?.implicit === true)) {
        tracker.open(groupId, msg.senderId, now, rd.engagedMs);
      }
      await next();
      return;
    }

    // 开团且关了插嘴：只回 @（与 groupReplyProbability 的规则一致）
    if (config.dnd?.interjections === false
      && manager.dndService?.active(manager.sessionKey('group', groupId)) !== undefined) {
      ctx.stop('reply-desire:dnd');
      return;
    }

    const mentions = (msg as { mentions?: Array<{ is_you?: boolean } | undefined> }).mentions;
    const result = scoreReplyDesire({
      content: String(msg.content ?? ''),
      senderId: msg.senderId,
      mentionsOthers: Array.isArray(mentions) && mentions.some((m) => m?.is_you !== true),
      names: rd.names,
      engagement: tracker.get(groupId, now),
    });
    if (result.score < rd.threshold) {
      if (config.debug) {
        logger.debug(`reply-desire: skip score=${result.score.toFixed(2)} [${result.reasons.join(',')}]`);
      }
      ctx.stop('reply-desire:low');
      return;
    }

    tracker.take(groupId, msg.senderId, now, rd.engagedMs, rd.engagedMaxTurns);
    ctx.state.mention = { ...mention, implicit: true, shouldAnswer: true, reason: 'passthrough' };
    ctx.state.replyDesire = result;
    logger.info(`reply-desire: answer group=${groupId} score=${result.score.toFixed(2)} [${result.reasons.join(',')}]`);
    await next();
  };
}
