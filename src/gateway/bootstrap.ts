/**
 * 网关组装 — 创建 bot、编排中间件、注册事件、出站、生命周期
 *
 * 将 QQ 消息平台作为 dsh 前端协议驱动：入站消息 → handleInbound → dsh agent，
 * dsh session/event → createOutboundHandler → QQ 出站。
 */
import type { Context } from '@deepseek-ai/cordis';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { QQBot } from '@tencent-connect/qqbot-nodejs';
import type { GatewayDisconnect, InteractionEvent, MiddlewareContext } from '@tencent-connect/qqbot-nodejs';
import { SessionManager, type DshAgentRegistry } from '../session/index.ts';
import { handleInbound, createOutboundHandler } from '../transport/index.ts';
import { parseStreamFrame } from '../transport/events.ts';
import { ReplyLimiter } from '../transport/reply-limiter.ts';
import { cacheMsgId, cacheEventId } from '../transport/msgid-cache.ts';
import { resolveReplyTarget, sendResolvedMarkdown } from '../transport/reply-target.ts';
import type { ToolsRegistryLike } from '../transport/tool-presenter.ts';
import type { QQBotSender } from '../transport/outbound-buffer.ts';
import { QuestionChannel } from '../features/question-channel.ts';
import { ApprovalChannel, type ApprovalChannelContext } from '../features/approval-channel.ts';
import { BiliClient } from '../bili/client.ts';
import { registerBiliTools } from '../bili/tools.ts';
import { decodeButtonData } from '../features/button-utils.ts';
import { PLUGIN_ROOT, buildUserAgent, isPrivilegedSender, privilegedOpenids } from '../shared/index.ts';
import type { ImQQBotConfig } from '../config.ts';
import type { ChatScope, Logger } from '../types.ts';
import { setupMiddlewares } from './middleware-setup.ts';
import { MEDIA_ROOT, startMediaCleanup } from '../media/media-cleaner.ts';
import { ensureVisionInputModal, registerDescribeImageTool } from '../media/vision-tool.ts';
import { registerSendFileTool, withFreshReplyTarget, type MediaSenderLike } from '../media/send-file-tool.ts';
import { StickerStore } from '../media/sticker-store.ts';
import { registerSaveStickerTool } from '../media/save-sticker-tool.ts';
import { registerMatchStickerTool } from '../media/match-sticker-tool.ts';
import { registerPetNativeBalance } from '../pet/native-balance.ts';
import { NotesStore } from '../notes/notes-store.ts';
import { resolveTmpDir, startTmpDir } from '../media/tmp-dir.ts';
import { registerNotesTools } from '../notes/notes-tools.ts';
import { registerFanartPickTool } from '../fanart/fanart-tool.ts';
import { createHttpGet } from '../fanart/http.ts';
import { FanartSeenStore, markSentCandidate } from '../fanart/seen.ts';
import { CampaignStore } from '../dnd/campaign.ts';
import { DungeonLibrary } from '../dnd/dungeon.ts';
import { DndService } from '../dnd/dnd-service.ts';
import { registerDndTools } from '../dnd/dnd-tools.ts';
import { ACK, DndTurnButtons } from '../dnd/turn-buttons.ts';

/**
 * interaction 统一分发器：按 button_data 的顶层 `t` 判别字段，路由到对应
 * channel（question / approval）。QQ 只有一个 interaction 入口，集中路由
 * 避免多通道各自 try 导致误判。
 */
function dispatchInteraction(event: InteractionEvent, manager: SessionManager, dndButtons?: DndTurnButtons): number {
  const raw = event.data?.resolved?.button_data;
  if (!raw) return ACK.duplicate;
  const button = decodeButtonData(raw);
  if (!button) return ACK.duplicate;
  // 跑团按钮自己决定返回码：不是本人点「结束回合」时回 denied，QQ 会弹无权限提示
  if (button.t === 'dnd') return dndButtons?.handleInteraction(event) ?? ACK.duplicate;
  const matched = button.t === 'question'
    ? manager.questionChannel?.handleInteraction(event) ?? false
    : manager.approvalChannel?.handleInteraction(event) ?? false;
  return matched ? ACK.ok : ACK.duplicate;
}

/** 解析表情包目录与允许来源，构建 StickerStore（关闭时返回 undefined） */
function createStickerStore(config: ImQQBotConfig, logger: Logger): StickerStore | undefined {
  const stickers = config.stickers ?? {
    enabled: true,
    root: '',
    extraRoots: [],
    maxBytes: 8 * 1024 * 1024,
    maxAutoEntries: 200,
  };
  if (!stickers.enabled) return undefined;

  const configuredRoot = stickers.root.trim();
  const root = configuredRoot === ''
    ? resolve(PLUGIN_ROOT, 'stickers')
    : (isAbsolute(configuredRoot) ? configuredRoot : resolve(PLUGIN_ROOT, configuredRoot));

  const allowedRoots = [MEDIA_ROOT];
  // 兼容旧版 media 根目录（升级前下载的图片仍可被收藏）
  const legacyMediaRoot = resolve(homedir(), '.dsh-qqbot', 'media');
  if (existsSync(legacyMediaRoot)) allowedRoots.push(legacyMediaRoot);
  for (const extra of stickers.extraRoots) {
    if (extra.trim() === '') continue;
    allowedRoots.push(isAbsolute(extra) ? extra : resolve(PLUGIN_ROOT, extra));
  }

  const store = new StickerStore({
    root,
    allowedRoots,
    sensitivePaths: config.fileAccess?.sensitivePaths ?? [],
    maxBytes: stickers.maxBytes,
    maxAutoEntries: stickers.maxAutoEntries,
    logger,
  });
  logger.info(`im-qqbot: 表情收藏已启用 root=${store.root}`);
  return store;
}

/** 解析笔记目录，构建共享笔记库（关闭时返回 undefined）；默认放在 agent 工作目录下，不进插件仓库 */
function createNotesStore(config: ImQQBotConfig, logger: Logger): NotesStore | undefined {
  const notes = config.notes;
  if (notes === undefined || !notes.enabled) return undefined;
  const cwd = config.cwd || process.cwd();
  const configuredRoot = notes.root.trim();
  const root = configuredRoot === ''
    ? resolve(cwd, 'notes')
    : (isAbsolute(configuredRoot) ? configuredRoot : resolve(cwd, configuredRoot));
  logger.info(`im-qqbot: 共享笔记库已启用 root=${root}`);
  return new NotesStore(root, logger);
}

/** 解析跑团目录，构建 DndService（关闭时返回 undefined）；数据放在 agent 工作目录下，不进插件仓库 */
function createDndService(config: ImQQBotConfig, logger: Logger): DndService | undefined {
  const dnd = config.dnd;
  if (dnd === undefined || !dnd.enabled) return undefined;
  const cwd = config.cwd || process.cwd();
  const configuredRoot = dnd.root.trim();
  const root = configuredRoot === ''
    ? resolve(cwd, 'dnd')
    : (isAbsolute(configuredRoot) ? configuredRoot : resolve(cwd, configuredRoot));
  logger.info(`im-qqbot: 跑团已启用 root=${root}`);
  return new DndService({
    store: new CampaignStore(join(root, 'campaigns')),
    library: new DungeonLibrary(join(root, 'dungeons'), logger),
    mapDir: join(resolveTmpDir(config), 'dnd-maps'),
  });
}

export async function bootstrapGateway(
  ctx: Context,
  agents: DshAgentRegistry,
  config: ImQQBotConfig,
  logger: Logger,
): Promise<void> {
  const manager = new SessionManager(ctx, agents, config, logger);

  // 配置权限：owner/admin 为空时保持旧行为，但明确提示风险
  if (privilegedOpenids(config).length === 0) {
    logger.warn('im-qqbot: 未配置 ownerOpenid/adminOpenids，配置命令与审批对所有通过访问控制的用户开放');
  }

  // ── 表情收藏存储（工具 + 动态 prompt 清单共用） ──
  const stickerStore = createStickerStore(config, logger);
  manager.stickerStore = stickerStore;

  // ── 共享笔记库（工具 + 自动召回共用） ──
  const notesStore = createNotesStore(config, logger);
  manager.notesStore = notesStore;

  // ── 跑团（/dnd 命令、DM prompt 注入、dnd_* 工具共用） ──
  const dndService = createDndService(config, logger);
  manager.dndService = dndService;

  // ── 初始化 QQ Bot SDK ──
  const userAgent = buildUserAgent();
  const bot = new QQBot({
    appId: config.appId,
    appSecret: config.appSecret,
    transport: 'websocket',
    baseUrl: process.env.QQBOT_BASE_URL?.replace(/\/+$/, '') || 'https://api.bot.qq.com',
    tokenBaseUrl: process.env.QQBOT_TOKEN_BASE_URL?.replace(/\/+$/, '') || 'https://api.bot.qq.com',
    userAgent,
    logger,
  } as ConstructorParameters<typeof QQBot>[0]);
  logger.info(`QQBot SDK initialized (UA: ${userAgent})`);

  // ── 中间件链 ──
  setupMiddlewares(bot, config, manager, logger);

  // ── 入站：经过中间件链后的消息交给 dsh agent ──
  bot.on('message', async (mCtx: MiddlewareContext) => {
    const msg = mCtx.message;
    // 记录最近 msgId，供无上下文的出站发送（文件发送显式 target、主动推送等）获取被动回复目标
    cacheMsgId(mCtx.replyTarget.scope, mCtx.replyTarget.targetId, mCtx.replyTarget.msgId);
    if (config.debug) {
      logger.debug(`← message (post-middleware): ${JSON.stringify(msg, null, 2).slice(0, 500)}`);
    }
    await handleInbound(mCtx, manager, config, logger);
  });

  // ── 出站：dsh session/event → QQ 消息 ──
  // 获取 tools 服务（工具结果结构化展示），可选
  let toolsRegistry: ToolsRegistryLike | undefined;
  try {
    toolsRegistry = ctx.get('tools') as ToolsRegistryLike | undefined;
  } catch {
    toolsRegistry = undefined;
  }

  // 发送适配器：将 QQBot 实例适配为 QQBotSender（openStream 参数形态不同）。
  // sendMarkdown 统一做被动回复限额管控：同一 msgId 超限/过期时降级主动推送。
  const replyLimiter = new ReplyLimiter({ limit: 4 });
  const sender: QQBotSender = {
    sendMarkdown: (target, content, opts) => sendResolvedMarkdown(bot, resolveReplyTarget(target, replyLimiter, true), content, opts),
    openStream: (target) => bot.openStream({
      target: {
        scope: target.scope,
        targetId: target.targetId,
        msgId: target.msgId as string,
      },
    }),
  };

  const outbound = createOutboundHandler(manager, sender, config, logger, toolsRegistry, stickerStore);
  (ctx as unknown as { on(event: string, handler: (...args: unknown[]) => void): void })
    .on('session/event', outbound.routeSessionEvent as (...args: unknown[]) => void);

  // ── 出站流式：agent/assistant-stream → 流式帧路由 ──
  // 实时流式走瞬态 agent/assistant-stream（chunk 不进 session log）。
  // 该事件按 agent 作用域派发，根作用域监听器不带 global 会被过滤（同
  // approval/request），帧到达后自行按 agent.id 路由，非 QQ 会话在 router 内忽略。
  (ctx as unknown as { on(event: string, handler: (...args: unknown[]) => void, options?: { global?: boolean }): void })
    .on('agent/assistant-stream', (payload: unknown) => {
      const parsed = parseStreamFrame(payload);
      if (parsed !== undefined) outbound.routeStreamFrame(parsed.agentId, parsed.delta);
    }, { global: true });

  // ── 问答通道（ask_user_question → QQ 文本 + 按钮） ──
  const questionChannel = new QuestionChannel(manager, sender, config, logger);
  manager.questionChannel = questionChannel;
  questionChannel.install(ctx);

  // ── 审批通道（approval/request → QQ 两按钮审批） ──
  const approvalChannel = new ApprovalChannel(
    manager,
    sender,
    logger,
    (senderId) => isPrivilegedSender(senderId, config),
  );
  manager.approvalChannel = approvalChannel;
  approvalChannel.install(ctx as unknown as ApprovalChannelContext);

  // ── 按钮点击回调（interaction）：统一分发到问答/审批通道 ──
  // ── 跑团回合按钮（轮到 PC 时发「结束回合 / 查看状态」，点击者身份由 QQ 回调决定） ──
  const dndButtons = dndService !== undefined && config.dnd?.turnButtons !== false
    ? new DndTurnButtons(dndService, manager, sender, logger)
    : undefined;

  bot.on('interaction', async (_iCtx: unknown, event: InteractionEvent) => {
    // scope/targetId 推导对齐消息事件（inbound.ts）：按 scene 判定类型，群用 group_openid，私聊用 user_openid
    const scope: ChatScope = event.scene === 'group' ? 'group' : 'c2c';
    const targetId = scope === 'group' ? (event.group_openid ?? event.user_openid) : event.user_openid;
    // 记录互动事件 id，作为后续被动回复候选（event_id）
    cacheEventId(scope, targetId, event.id);

    const code = dispatchInteraction(event, manager, dndButtons);
    await bot.acknowledgeInteraction(event.id, code).catch(() => {});
  });

  bot.on('error', (err: unknown) => {
    logger.error(`bot error: ${err instanceof Error ? err.message : String(err)}`);
  });

  // 掉线可观测：willReconnect=false 表示不会再重连（随后 bot.start() 的 Promise 会失败）。
  // disconnected 事件为 SDK 1.0.5+ 新增：旧版 handlers 表缺该键，bot.on 会抛
  // TypeError（profiles 增量安装可能残留旧版 SDK）——降级为跳过监听而非崩溃
  try {
    bot.on('disconnected', (event: GatewayDisconnect) => {
      const detail = `code=${event.code}${event.reason ? ` reason=${event.reason}` : ''}`;
      if (event.willReconnect) {
        logger.warn(`Bot disconnected (${detail}), reconnecting...`);
      } else {
        logger.error(`Bot disconnected permanently (${detail}), giving up`);
      }
    });
  } catch (err) {
    logger.warn(`qqbot-nodejs SDK 不支持 disconnected 事件（请升级 @tencent-connect/qqbot-nodejs 至 1.0.5+）: ${err instanceof Error ? err.message : String(err)}`);
  }

  bot.on('ready', () => {
    console.log(`[im-qqbot] Bot ready! appId=${config.appId}`);
  });

  // ── 富媒体过期清理 ──
  if (config.media.enabled) {
    startMediaCleanup(ctx, config.media.ttlHours, logger);
  }

  // ── Agent 临时目录（cwd/tmp）：创建 + 过期清理；prompt 里要求模型把中间文件都放这里 ──
  startTmpDir(ctx, resolveTmpDir(config), config.tmpTtlHours ?? 72, logger);

  // ── 视觉工具注册（qqbot_describe_image，复用 dsh llm + attachments） ──
  ensureVisionInputModal(config.vision, logger);
  registerDescribeImageTool(ctx, config.vision, logger);

  // ── 附件发送工具注册（qqbot_send_file） ──
  // 包装 bot：让文件发送也走 msgId 兜底 + 被动回复限额管控。
  // 注意：SDK 文件发送暂不支持 event_id，故 allowEvent=false，跳过 event 候选。
  const mediaSender: MediaSenderLike = {
    sendImage: (target, source, opts) => bot.sendImage(resolveReplyTarget(target, replyLimiter, false), source, opts),
    sendVideo: (target, source, opts) => bot.sendVideo(resolveReplyTarget(target, replyLimiter, false), source, opts),
    sendVoice: (target, source) => bot.sendVoice(resolveReplyTarget(target, replyLimiter, false), source),
    sendFile: (target, source, opts) => bot.sendFile(resolveReplyTarget(target, replyLimiter, false), source, opts),
  };
  // ── 搜图工具（qqbot_fanart_pick）：候选落在 tmp/fanart，发出去的那张才记进 media/fanart 的 seen ──
  const fanartCandidatesDir = join(resolveTmpDir(config), 'fanart');
  const fanartSeen = new FanartSeenStore(join(MEDIA_ROOT, 'fanart'));
  if (config.fanart.enabled) {
    const poolDir = config.fanart.poolDir.trim();
    registerFanartPickTool(ctx, config, {
      get: createHttpGet(config.fanart.proxy),
      seen: fanartSeen,
      poolDir: poolDir === '' ? resolve(PLUGIN_ROOT, 'scripts') : (isAbsolute(poolDir) ? poolDir : resolve(PLUGIN_ROOT, poolDir)),
      candidatesDir: fanartCandidatesDir,
    }, logger);
  }
  registerSendFileTool(ctx, mediaSender, manager, config, logger, (absPath) => {
    if (config.fanart.enabled && markSentCandidate(fanartSeen, fanartCandidatesDir, absPath)) {
      logger.info(`im-qqbot: 搜图候选已发，记为已发: ${absPath}`);
    }
  });

  // ── Bilibili 只读工具（搜索/视频/评论/字幕/扫码登录） ──
  const biliTools = ctx.get('tools') as { register(definition: unknown): unknown } | undefined;
  if (biliTools !== undefined) {
    const biliClient = new BiliClient();
    registerBiliTools(biliTools, {
      client: biliClient,
      logger,
      permission: (agent) => {
        const record = manager.findByAgent(agent as never);
        // 本地 Web/Desktop 会话没有 QQ 记录：视为本机可信，只返回二维码路径
        if (record === undefined) return { allowed: true };
        if (record.scope !== 'c2c') {
          return {
            allowed: false,
            reason: 'B 站登录/字幕只能在私聊里由主人或管理员操作；群聊可以用 bili_search / bili_video / bili_comments',
          };
        }
        if (privilegedOpenids(config).length === 0) {
          return { allowed: false, reason: '请先在插件配置里设置 ownerOpenid 或 adminOpenids，再登录 B 站' };
        }
        if (!isPrivilegedSender(record.peerId, config)) {
          return { allowed: false, reason: '只有 bot 主人或管理员可以登录 B 站/使用登录态字幕' };
        }
        return { allowed: true };
      },
      sendQr: async (agent, qrPath, caption) => {
        const record = manager.findByAgent(agent as never);
        if (record === undefined) return false;
        await mediaSender.sendImage(record.replyTarget, { localPath: qrPath }, { content: caption });
        return true;
      },
    });
  }

  // ── 表情收藏工具注册（qqbot_save_sticker） ──
  if (stickerStore !== undefined) {
    registerSaveStickerTool(ctx, stickerStore, logger);
    registerMatchStickerTool(ctx, stickerStore, logger);
  }

  // ── 共享笔记工具注册（qqbot_notes_search / qqbot_notes_save） ──
  if (notesStore !== undefined) {
    registerNotesTools(ctx, notesStore, manager, logger);
  }

  // ── 跑团工具注册（dnd_*） ──
  if (dndService !== undefined) {
    registerDndTools(ctx, {
      service: dndService,
      manager,
      logger,
      sendImage: async (record, path, caption) => {
        await mediaSender.sendImage(
          withFreshReplyTarget(record.replyTarget),
          { localPath: path },
          caption !== undefined ? { content: caption } : undefined,
        );
      },
      onTurnChange: (record) => dndButtons?.schedule(record),
    });
  }

  // ── 桌宠余额：自定义 deepseek-native 不在 dsh-pet 内置表里，补一个同接口 provider ──
  registerPetNativeBalance(ctx, logger);

  // ── 生命周期 ──
  (ctx as unknown as { effect(fn: () => (() => Promise<void>) | void, name?: string): void })
    .effect(() => {
      logger.info(`Starting bot (appId=${config.appId})`);
      bot.start().catch((err: unknown) => {
        logger.error(`Bot start failed: ${err instanceof Error ? err.message : String(err)}`);
      });

      return async () => {
        logger.info('Shutting down');
        await manager.disposeAll();
        bot.stop();
      };
    }, 'im-qqbot.lifecycle');
}
