/**
 * SDK 中间件编排
 *
 * 根据插件配置组装 SDK 内置中间件链（洋葱模型）。
 * 中间件负责过滤与上下文富化；最终消息统一由 bot.on('message') 处理转发。
 */
import type { MiddlewareContext, QQBot } from '@tencent-connect/qqbot-nodejs';
import {
  errorHandler,
  messageFilter,
  accessPolicy,
  mentionGate,
  contentSanitizer,
  rateLimiter,
  slashCommand,
  typingIndicator,
  quoteRef,
  MemoryRefIndexStore,
  historyBuffer,
  envelopeFormatter,
} from '@tencent-connect/qqbot-nodejs';
import type { Middleware, RefIndexStore, ResolvedQuote } from '@tencent-connect/qqbot-nodejs';
import type { ImQQBotConfig } from '../config.ts';
import type { SessionManager } from '../session/index.ts';
import type { Logger, RawAttachment } from '../types.ts';
import { isImageContentType } from '../transport/attachment.ts';
import { SELF_SENDER_ID, type SelfSentIndex } from '../transport/self-sent.ts';
import { buildCommandList } from '../commands/index.ts';
import { attachmentProcessor } from '../middleware/attachment.ts';
import { questionAnswer } from '../middleware/question-answer.ts';
import { serialMerge } from '../middleware/serial-merge.ts';
import { replyDecider, type JudgeDeps } from '../middleware/reply-decider.ts';
import { JudgeQueue, ReplyJudge, type JudgeLlm } from '../features/reply-judge.ts';
import { accessPolicyFromConfig } from '../shared/permissions.ts';
import { getHistoryStore, historyGroupKey } from '../features/history-store.ts';
import { appendGroupMessage } from '../features/group-memory.ts';
import { makeSenderLabeler, MENTION_MARK, type SenderLabeler } from '../features/message-format.ts';
import { getSenderAliases } from '../features/sender-alias.ts';

/**
 * 排队消息合并：SDK 默认把几条内容直接拼起来、全算在第一条的发送者头上，
 * 群里几个人连着 @ 时，别人的话会被当成第一个人说的（跑团里就成了替别人宣告行动）。
 * 有多个发送者时每一行都带「[昵称 #U3]」（第一个人的后续行也带，否则它会被算到上一行那个人头上），
 * @ 了 bot 的那几行各自带 (@you)；state.senderTagged 告诉入站组装别再整体加一次标签。
 * 所有发送者记到 state.mergedSenders。
 */
export function mergeWithSenders(buffered: MiddlewareContext[], label: SenderLabeler): MiddlewareContext {
  const first = buffered[0]!;
  if (buffered.length === 1) return first;
  const withContent = buffered.filter((ctx) => (ctx.message.content ?? '') !== '');
  const multiSender = new Set(withContent.map((ctx) => ctx.message.senderId)).size > 1;
  const lines = withContent.map((ctx) => {
    const { senderId, senderName, content } = ctx.message as { senderId: string; senderName?: string; content?: string };
    if (!multiSender) return String(content);
    const mentioned = (ctx.state.mention as { wasMentioned?: boolean } | undefined)?.wasMentioned === true;
    return `${label(senderId, senderName)} ${String(content)}${mentioned ? ` ${MENTION_MARK}` : ''}`;
  });
  if (lines.length > 0) (first.message as { content: string }).content = lines.join('\n');
  if (multiSender) first.state.senderTagged = true;
  const attachments = withContent.flatMap((ctx) => (ctx.message as { attachments?: unknown[] }).attachments ?? []);
  if (attachments.length > 0) (first.message as { attachments?: unknown[] }).attachments = attachments;
  first.state.mergedSenders = [...new Set(buffered.map((ctx) => ctx.message.senderId))];
  return first;
}

/** 引用解析走了 msg_elements 时，从 ref store 补回被引用消息的发送者（原文和附件仍用 msg_elements 的） */
export function quoteSenderFill(store: RefIndexStore, selfSent?: SelfSentIndex): Middleware {
  return async (ctx, next) => {
    const quote = ctx.state.quote as ResolvedQuote | undefined;
    if (quote !== undefined && quote.entry === undefined && quote.refKey) {
      const entry = await store.get(quote.refKey);
      if (entry !== undefined) {
        ctx.state.quote = { ...quote, entry };
      } else {
        // SDK 的 ref 索引只记入站消息；自己发出去的那条要单独认回来，
        // 否则模型会把自己引用自己当成「未知发送者」
        const mine = selfSent?.get(quote.refKey);
        if (mine !== undefined) {
          ctx.state.quote = {
            ...quote,
            entry: {
              messageId: quote.refKey,
              senderId: SELF_SENDER_ID,
              content: mine.content,
              timestamp: mine.timestamp,
            },
          };
        }
      }
    }
    await next();
  };
}

export function setupMiddlewares(
  bot: QQBot,
  config: ImQQBotConfig,
  manager: SessionManager,
  logger: Logger,
  llm?: JudgeLlm,
  selfSent?: SelfSentIndex,
): void {
  // 1. 错误兜底（最外层洋葱皮）
  bot.use(errorHandler());

  // 2. 消息过滤：bot 回声 + 消息去重
  bot.use(messageFilter({ skipSelfEcho: false }));

  // 3. 访问控制（白名单/开放/禁用）
  //    allowlist 为空时 SDK 会 fail-closed；这里必须原样传列表，
  //    不能 fallback 成 ['*']（否则「只允许白名单」会变成「允许所有人」）。
  bot.use(accessPolicy({
    ...accessPolicyFromConfig(config),
    onBlock: (_mCtx, reason) => {
      if (config.debug) {
        logger.debug(`Access blocked: ${reason}`);
      }
    },
  }));

  // 4. 群历史缓冲 — 放在门控之前，确保所有消息（含未 @bot）都计入上下文
  //    store 走共享单例（getHistoryStore），groupKey 带 appId 前缀，供回复后清空
  bot.use(historyBuffer({
    limit: config.historyLimit,
    store: getHistoryStore(),
    recordOnSkip: true,
    groupKey: (ctx) => {
      const gid = ctx.message.groupOpenid;
      if (ctx.message.kind !== 'group' || !gid) return undefined;
      return historyGroupKey(config.appId, gid);
    },
  }));

  // 4.5. 持久化群记忆：所有群消息（含未 @bot）落盘 JSONL，供重启后回灌长期上下文
  //      图片只记 URL：未 @bot 的消息不会经过附件下载，等被触发读历史时再按需下载
  bot.use(async (ctx, next) => {
    const msg = ctx.message;
    if (msg.kind === 'group' && msg.groupOpenid) {
      const images = ((msg as { attachments?: RawAttachment[] }).attachments ?? [])
        .filter((a) => isImageContentType(a.content_type) && a.url)
        .map((a) => ({ url: a.url, ...(a.filename ? { filename: a.filename } : {}) }));
      appendGroupMessage(config.appId, msg.groupOpenid, {
        messageId: msg.messageId,
        senderId: msg.senderId,
        senderName: msg.senderName,
        content: String(msg.content ?? '').replace(/<@!?\d+>/g, '').trim(),
        timestamp: Date.now(),
        ...(images.length > 0 ? { images } : {}),
      });
    }
    await next();
  });

  // 5. 群聊 @bot 门控（含概率隐式 @：未 @ 时按 groupReplyProbability 随机放行）
  //    开了回复欲望时 passthrough：没放行的消息不在这里丢，交给 5.5 打分决定
  const replyDesireOn = config.replyDesire?.enabled === true;
  bot.use(mentionGate({
    requireMentionInGroup: config.requireMention,
    passthrough: replyDesireOn,
    isImplicitMention: (ctx) => {
      if (ctx.message.kind !== 'group') return false;
      const p = config.groupReplyProbability ?? 0;
      if (!(p > 0 && Math.random() < p)) return false;
      // 跑团期间默认照样随机插嘴：这类消息不带 (@you)，DM 守则规定只吐槽、不当成行动宣告去结算。
      // dnd.interjections=false 时开团后只回 @
      if (config.dnd?.interjections !== false) return true;
      const groupId = ctx.message.groupOpenid;
      return groupId === undefined || manager.dndService?.active(manager.sessionKey('group', groupId)) === undefined;
    },
  }));

  // 5.5. 回复欲望门控：未 @ 的群消息按规则打分 + 对话窗口决定是否接话
  if (replyDesireOn) {
    let judgeDeps: JudgeDeps | undefined;
    if (config.replyDesire.judge?.enabled === true) {
      if (llm?.stream === undefined) {
        logger.warn('im-qqbot: llm 服务不可用，回复欲望的模型打分未启用（只用规则）');
      } else {
        const judgeConfig = () => config.replyDesire.judge;
        judgeDeps = { judge: new ReplyJudge(llm, judgeConfig, logger), queue: new JudgeQueue(judgeConfig) };
      }
    }
    bot.use(replyDecider(config, manager, logger, judgeDeps));
  }
  if (config.banter?.enabled === true && config.banter.groups.length > 0
    && (!replyDesireOn || config.replyDesire.judge?.enabled !== true)) {
    logger.warn('im-qqbot: 串模式需要同时开启回复欲望和模型打分才会主动接话，现在只改变被 @ 时的语气');
  }

  // 6. 内容清洗（去 @marker、表情标签、多余空白）
  bot.use(contentSanitizer({
    parseFaceTags: true,
  }));

  // 7. 三层限流（sender / group / global）
  bot.use(rateLimiter());

  // 8. 斜杠命令（在 concurrencyGuard 之前，命令匹配后不排队直接响应）
  const slash = slashCommand({
    // 关闭 autoHelp：help 命令由 qqbot 注册为 /bot-help，
    // 避免 SDK 再自动注册一个无前缀的 /help 造成重复
    autoHelp: false,
    commands: buildCommandList({ manager, config }),
  });
  bot.use(slash.middleware);

  // 8.5. 待答问题截获（在 concurrencyGuard 之前，答案消息不排队直接作答）
  bot.use(questionAnswer(manager));

  // 9. 并发串行 + 消息合并（同 peer 排队，避免 session 冲突）
  bot.use(serialMerge({
    maxQueue: config.maxQueue,
    maxProcessingMs: config.processingTimeoutMs,
    onMerge: (buffered) => {
      const peer = buffered[0]!.message.groupOpenid ?? buffered[0]!.message.senderId;
      return mergeWithSenders(buffered, makeSenderLabeler((id) => getSenderAliases().aliasFor(config.appId, peer, id)));
    },
  }));

  // 10. C2C 输入状态指示
  bot.use(typingIndicator());

  // 11. 引用消息解析（记录 + 解析被引用原文）
  //     preferMsgElements 命中时 SDK 只留 msg_elements 的原文和附件，丢掉 store 里的发送者；
  //     自己持有 store，紧接着补回 quote.entry，模型才知道被引用的是谁说的。
  const refStore = new MemoryRefIndexStore(500);
  bot.use(quoteRef({
    store: refStore,
    preferMsgElements: true,
  }));
  bot.use(quoteSenderFill(refStore, selfSent));

  // 11.5. 附件下载（file 附件下载到本地，供 @提及 / 工具访问）
  bot.use(attachmentProcessor(config, logger));

  // 12. 上下文组装（将 history + quote + sender 组成 envelope）
  bot.use(envelopeFormatter({
    historyLimit: config.historyLimit,
    includeQuote: true,
    includeSender: true,
  }));
}
