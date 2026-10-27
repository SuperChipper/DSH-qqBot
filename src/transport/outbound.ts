/**
 * 出站处理器 — dsh session/event → QQ 消息发送
 *
 * 采用路由器模式：OutboundRouter 持有会话级状态（文本缓冲、工具调用记录），
 * 事件解析归一化在 events.ts，路由按事件类型分发到私有方法。
 */
import type { SessionManager, SessionRecord } from '../session/index.ts';
import type { ImQQBotConfig } from '../config.ts';
import type { Logger } from '../types.ts';
import type { StickerStore } from '../media/sticker-store.ts';
import { extractPseudoStickerCalls, sanitizePseudoToolText } from '../media/pseudo-sticker-call.ts';
import { SEND_FILE_TOOL_NAME } from '../media/send-file-tool.ts';
import { captionFromArgs, stripCaptionEcho } from './caption-echo.ts';
import { chunkMarkdownText } from './chunker.ts';
import { OutboundBuffer, type QQBotSender } from './outbound-buffer.ts';
import { formatToolResult, type ToolsRegistryLike, type ToolResultData } from './tool-presenter.ts';
import {
  parseEvent,
  extractTurnError,
  contextTokensOf,
  type ChunkEvent,
  type MessageEvent,
  type ToolCallEvent,
  type ToolResultEvent,
  type TurnEndEvent,
  type RawSessionEvent,
  type StreamDelta,
} from './events.ts';

export type { QQBotSender } from './outbound-buffer.ts';
export type { ToolsRegistryLike } from './tool-presenter.ts';
export { parseStreamFrame } from './events.ts';

/** 出站处理器签名（注册到 ctx.on('session/event')） */
export type OutboundHandler = (session: SessionLike, event: RawSessionEvent) => void;

/** 出站事件入口集合：durable 事件 + 实时流式帧 */
export interface OutboundHandlers {
  /** durable session 事件入口（注册到 ctx.on('session/event')） */
  routeSessionEvent(session: SessionLike, event: RawSessionEvent): void;
  /**
   * 实时流式帧入口（注册到 ctx.on('agent/assistant-stream', ..., { global: true })）。
   */
  routeStreamFrame(agentId: string, delta: StreamDelta): void;
}

/** dsh Session 简化类型 */
export interface SessionLike {
  header: { id: string };
}

/** 工具调用记录（tool/call 建立，tool/result 消费） */
interface ToolCallRecord {
  name: string;
  args: string;
}

/** 不展示给用户的轮次错误码（底层传输/网络错误，对用户无意义，且常被重试兜住） */
const SILENT_TURN_ERROR_CODES = new Set(['STREAM_CLOSED']);

/**
 * 出站路由器：持有会话级状态，按事件类型分发到处理器
 */
class OutboundRouter {
  private readonly buffers = new Map<string, OutboundBuffer>();
  private readonly toolCalls = new Map<string, ToolCallRecord>();
  /** 每会话当前流式 attemptId：LLM 重试会发布新 attempt，用于 reset 与迟到帧过滤 */
  private readonly streamAttempts = new Map<string, string>();
  /** 每会话本轮已随 qqbot_send_file 发出的 caption（用于过滤复读），turn/end 清空 */
  private readonly captions = new Map<string, string[]>();
  private readonly manager: SessionManager;
  private readonly bot: QQBotSender;
  private readonly config: ImQQBotConfig;
  private readonly logger: Logger;
  private readonly toolsRegistry: ToolsRegistryLike | undefined;
  private readonly stickerStore: StickerStore | undefined;

  public constructor(
    manager: SessionManager,
    bot: QQBotSender,
    config: ImQQBotConfig,
    logger: Logger,
    toolsRegistry: ToolsRegistryLike | undefined,
    stickerStore?: StickerStore,
  ) {
    this.manager = manager;
    this.bot = bot;
    this.config = config;
    this.logger = logger;
    this.toolsRegistry = toolsRegistry;
    this.stickerStore = stickerStore;
  }

  /** 事件分发入口 */
  public route(session: SessionLike, raw: RawSessionEvent): void {
    const event = parseEvent(raw);
    if (event === undefined) return;

    const record = this.manager.findBySessionId(session.header.id);
    if (record === undefined) return;

    switch (event.type) {
      case 'assistant/chunk':
        this.onChunk(session.header.id, record, event);
        break;
      case 'assistant/message':
        this.onMessage(session.header.id, record, event);
        break;
      case 'tool/call':
        this.onToolCall(event);
        break;
      case 'tool/result':
        this.onToolResult(session.header.id, record, event);
        break;
      case 'turn/end':
        this.onTurnEnd(session.header.id, record, event);
        break;
    }
  }

  /** durable assistant/chunk 事件的流式增量（历史格式兼容保留，当前宿主不再生产该事件） */
  private onChunk(sessionId: string, record: SessionRecord, event: ChunkEvent): void {
    this.appendChunk(sessionId, record, event.text);
  }

  /**
   * 实时流式帧入口（瞬态 agent/assistant-stream 事件）。
   *
   * attempt 语义：start 帧即新内容起点，无条件重置 buffer——清空旧 attempt 的
   * 累积文本但保留流式会话（QQ 流式 update 是全量替换，用户看到同一条消息被
   * 新内容重写）。不用 attemptId 对比判断"新 attempt"：agent replacement 后
   * attempt 计数重启、attemptId 可能与旧 agent 重叠（官方按 frame revision 的
   * gap 检测处理同一问题）。迟到帧（attemptId 不匹配）仍直接丢弃，防止旧
   * attempt 的尾巴混进新内容。
   */
  public routeStreamFrame(agentId: string, delta: StreamDelta): void {
    if (delta.kind === 'attempt-start') {
      this.streamAttempts.set(agentId, delta.attemptId);
      this.buffers.get(agentId)?.reset();
      return;
    }

    // text-delta：首帧未见 start 时自愈记录，迟到帧丢弃
    const current = this.streamAttempts.get(agentId);
    if (current === undefined) {
      this.streamAttempts.set(agentId, delta.attemptId);
    } else if (current !== delta.attemptId) {
      return;
    }

    const record = this.manager.findBySessionId(agentId);
    if (record === undefined) return;
    this.appendChunk(agentId, record, delta.text);
  }

  /** 获取或创建会话 buffer 并追加增量 */
  private appendChunk(sessionId: string, record: SessionRecord, text: string): void {
    let buffer = this.buffers.get(sessionId);
    if (buffer === undefined) {
      // 持有本轮 caption 列表的引用：flush 可能晚于 turn/end 清理才执行
      const captions = this.captionsOf(sessionId);
      buffer = new OutboundBuffer(
        record,
        this.bot,
        this.config.textChunkLimit,
        this.logger,
        this.shouldStream(record),
        (raw) => this.salvage(raw, captions),
        (raw) => stripCaptionEcho(sanitizePseudoToolText(raw), captions),
        (raw) => this.markUnsent(record, raw),
      );
      this.buffers.set(sessionId, buffer);
    }
    buffer.append(text);
  }

  /** 是否启用流式：配置开启 + c2c + 有 msgId（群聊不支持流式） */
  private shouldStream(record: SessionRecord): boolean {
    return this.config.streaming
      && record.replyTarget.scope === 'c2c'
      && !!record.replyTarget.msgId;
  }

  /** 完整 assistant 消息：有流式 buffer 则 flush，否则直接发送文本块 */
  private onMessage(sessionId: string, record: SessionRecord, event: MessageEvent): void {
    // 记下当前上下文大小，供 turn 结束后判断是否自动压缩（旧 sessionId 的迟到事件不算）
    if (event.usage !== undefined && record.sessionId === sessionId) {
      record.contextTokens = contextTokensOf(event.usage);
    }

    const buffer = this.buffers.get(sessionId);
    if (buffer !== undefined && buffer.text.trim()) {
      void buffer.flush();
      this.buffers.delete(sessionId);
      return;
    }

    const textParts: string[] = [];
    for (const block of event.content) {
      if (block.type === 'text' && block.text) textParts.push(block.text);
    }
    const fullText = textParts.join('\n');
    if (!fullText.trim()) return;

    void this.send(record, fullText, 'sendMarkdown', this.captionsOf(sessionId));
    this.buffers.delete(sessionId);
  }

  /** 取本轮 caption 列表（不存在则创建；同一轮内始终是同一个数组） */
  private captionsOf(sessionId: string): string[] {
    let list = this.captions.get(sessionId);
    if (list === undefined) {
      list = [];
      this.captions.set(sessionId, list);
    }
    return list;
  }

  /** 工具调用：仅记录，不发送（避免刷屏，等待结果） */
  private onToolCall(event: ToolCallEvent): void {
    this.toolCalls.set(event.callId, { name: event.name, args: event.arguments });
  }

  /** 工具结果：错误始终发送，成功结果按开关 */
  private onToolResult(sessionId: string, record: SessionRecord, event: ToolResultEvent): void {
    const call = this.toolCalls.get(event.callId);
    this.toolCalls.delete(event.callId);
    if (call === undefined) return;

    // caption 已随文件送达：记下来，过滤模型随后对它的复读
    if (event.error === undefined && call.name === SEND_FILE_TOOL_NAME) {
      const caption = captionFromArgs(call.args);
      if (caption !== undefined) this.captionsOf(sessionId).push(caption);
    }

    if (event.error === undefined && !this.config.showToolResults) return;
    // 群聊不刷工具报错：模型通常会自己换路子（如 web_fetch 被拦后改用 web_search），
    // 报错原文对群友只是噪音；私聊照常展示便于主人排查，开了 showToolResults 时群聊也展示。
    if (event.error !== undefined && record.replyTarget.scope === 'group' && !this.config.showToolResults) {
      this.logger.info(`im-qqbot: 群聊工具报错未展示 tool=${call.name} code=${event.error.code}`);
      return;
    }

    const text = formatToolResult(
      call.name,
      call.args,
      event.raw as unknown as ToolResultData,
      this.toolsRegistry,
      record.agent,
    );
    if (!text) return;

    void this.send(record, text, 'sendToolResult');
  }

  /** 轮次结束：清理 buffer 与 attempt 跟踪状态，异常结束时告知用户 */
  private onTurnEnd(sessionId: string, record: SessionRecord, event: TurnEndEvent): void {
    const buffer = this.buffers.get(sessionId);
    if (buffer !== undefined) {
      if (buffer.text.trim()) {
        void buffer.flush();
      } else {
        buffer.cancel();
      }
      this.buffers.delete(sessionId);
    }
    this.streamAttempts.delete(sessionId);
    this.captions.delete(sessionId);

    const failure = extractTurnError(event.reason);
    if (failure !== undefined && !SILENT_TURN_ERROR_CODES.has(failure.code)) {
      void this.send(record, `⚠️ 本轮异常结束\n\`${failure.code}\`: ${failure.message}`, 'sendTurnEndError');
    }

    this.logger.debug(`im-qqbot: turn/end sessionId=${sessionId}`);
  }

  /**
   * 兜底：剥离模型误写的 <qqbot_save_sticker> / <qqbot_send_file> 文本块，并补执行收藏；
   * 再去掉对本轮已发 caption 的复读。
   */
  private salvage(text: string, captions: readonly string[] = []): string {
    const { calls } = extractPseudoStickerCalls(text);
    const visible = stripCaptionEcho(sanitizePseudoToolText(text), captions);
    for (const call of calls) {
      if (this.stickerStore === undefined) {
        this.logger.warn('im-qqbot: 收到伪 qqbot_save_sticker 文本，但表情收藏未启用，已忽略');
        continue;
      }
      try {
        const result = this.stickerStore.save({
          source: call.image,
          emotion: call.emotion,
          ...(call.note !== undefined ? { note: call.note } : {}),
          ...(call.file !== undefined ? { file: call.file } : {}),
        });
        this.logger.info(
          result.saved
            ? `im-qqbot: 从文本伪调用补存表情 ${result.file}（情绪「${result.emotion}」）`
            : `im-qqbot: 文本伪调用命中重复表情 ${result.file}`,
        );
      } catch (err) {
        this.logger.warn(
          `im-qqbot: 文本伪调用补存表情失败: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return visible;
  }

  /** 统一发送：切分 + 逐 chunk 发送 + 错误记录 */
  private async send(record: SessionRecord, text: string, tag: string, captions: readonly string[] = []): Promise<void> {
    const visible = this.salvage(text, captions);
    if (!visible.trim()) return;
    const chunks = chunkMarkdownText(visible, this.config.textChunkLimit);
    let failed = false;
    for (const chunk of chunks) {
      try {
        await this.bot.sendMarkdown(record.replyTarget, chunk);
      } catch (err) {
        failed = true;
        this.logger.error(`im-qqbot: ${tag} failed: ${err instanceof Error ? err.message : String(err)}`);
        break;
      }
    }
    if (failed) this.markUnsent(record, text);
  }

  /** 群主动消息无权限/被动窗口过期时，内容不能丢：等用户下次说话时注入提示补发 */
  private markUnsent(record: SessionRecord, text: string): void {
    this.manager.addUnsent(record.sessionKey, text);
    this.logger.warn(`im-qqbot: 消息未送达，已挂起到下一次用户消息 session=${record.sessionKey}`);
  }
}

/**
 * 创建出站事件处理器
 *
 * 返回 durable 事件与实时流式帧两个入口，分别注册到
 * ctx.on('session/event') 与 ctx.on('agent/assistant-stream', ..., { global: true })。
 * toolsRegistry 用于工具结果的结构化展示。
 */
export function createOutboundHandler(
  manager: SessionManager,
  bot: QQBotSender,
  config: ImQQBotConfig,
  logger: Logger,
  toolsRegistry?: ToolsRegistryLike,
  stickerStore?: StickerStore,
): OutboundHandlers {
  const router = new OutboundRouter(manager, bot, config, logger, toolsRegistry, stickerStore);
  return {
    routeSessionEvent: (session, event) => router.route(session, event),
    routeStreamFrame: (agentId, delta) => router.routeStreamFrame(agentId, delta),
  };
}
