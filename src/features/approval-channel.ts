/**
 * ApprovalChannel — 把 dsh 的审批 seam（`approval/request` waterfall）桥接到 QQ。
 *
 * 接入方式：监听 `approval/request` waterfall，按 `request.agent.id` 路由到 QQ
 * 会话；非 QQ 会话委托链上其他 answerer（`next()`），多通道（Web/TUI）共存。
 *
 * 每个会话同一时间最多一个 pending 审批（审批是阻塞式的）；outcome 是 dsh
 * 协议的闭合集合，无 allow-always，只提供「允许一次 / 拒绝」两个按钮。
 */
import type { EventOptions } from '@deepseek-ai/cordis';
import type { InteractionEvent } from '@tencent-connect/qqbot-nodejs';
import type { ChatScope, Logger, ReplyTarget } from '../types.ts';
import { decodeButtonData } from './button-utils.ts';
import { buildApprovalKeyboard, buildApprovalText } from './approval-renderer.ts';

// ── 最小契约（对齐 dsh-user-approval，避免硬依赖） ──

export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable';

/** session log 中 tool/call 事件的最小结构（commandOf 回显命令用） */
interface ApprovalSessionEvent {
  type: string;
  data?: { callId?: unknown; arguments?: unknown; [key: string]: unknown };
}

export interface ApprovalRequest {
  agent: {
    id: string;
    /**
     * dsh-agent 的 `Agent.session` 在类型上是必选，但审批请求可能来自跨进程或
     * 投影后的上下文，运行时拿不到 live session（类型契约与运行时的 gap）。此时
     * 只是无法回显命令原文，不应让整个审批失败，故这里标为可选。
     */
    session?: { events?: ApprovalSessionEvent[] };
  };
  toolName: string;
  /** 关联的 tool/call 事件 id，用于从 session log 找回被 gate 的命令 */
  callId?: string;
  /** asker 的人类可读解释 */
  reason?: string;
  signal?: AbortSignal;
}

// ── 依赖接口（结构化，便于单测） ──

export interface ApprovalSessionRecordLike {
  sessionKey: string;
  scope: ChatScope;
  replyTarget: ReplyTarget;
}

export interface ApprovalChannelManagerLike {
  findBySessionId(sessionId: string): ApprovalSessionRecordLike | undefined;
  getSessionRecord(scope: ChatScope, peerId: string): ApprovalSessionRecordLike | undefined;
}

export interface ApprovalChannelSenderLike {
  sendMarkdown(target: ReplyTarget, content: string, opts?: { keyboard?: unknown }): Promise<unknown>;
}

/** approval/request waterfall 的 answerer handler */
export interface ApprovalChannelContext {
  on(
    event: string,
    handler: (...args: unknown[]) => unknown,
    options?: EventOptions,
  ): () => boolean;
}

// ── 每会话 pending 状态 ──

interface PendingApproval {
  record: ApprovalSessionRecordLike;
  request: ApprovalRequest;
  resolve: (outcome: ApprovalOutcome) => void;
  onAbort?: () => void;
}

const COMMAND_CLIP = 500;

/**
 * 从 session log 按 callId 找回被 gate 的命令（审批请求本身不重复携带 arguments）。
 * 对齐 TUI/web 的 `commandOf` 语义。
 */
function commandOf(req: ApprovalRequest): string | undefined {
  if (req.callId === undefined) return undefined;
  // 审批请求可能来自没有 live session 的上下文（例如跨进程/投影后的 Agent），
  // 此时只是拿不到命令原文，不能因此让整个审批失败。
  const events = req.agent.session?.events;
  if (!Array.isArray(events)) return undefined;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (!event || event.type !== 'tool/call') continue;
    const data = event.data;
    if (String(data?.callId) !== String(req.callId)) continue;
    const raw = data?.arguments;
    if (typeof raw !== 'string') return undefined;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed !== null && typeof parsed === 'object' && 'command' in parsed) {
        const command = (parsed as { command?: unknown }).command;
        if (typeof command === 'string') return command;
      }
    } catch {
      // 非 JSON，回退到原始字符串
    }
    return raw.length <= COMMAND_CLIP ? raw : `${raw.slice(0, COMMAND_CLIP)}…`;
  }
  return undefined;
}

export class ApprovalChannel {
  private readonly pending = new Map<string, PendingApproval>();
  private readonly manager: ApprovalChannelManagerLike;
  private readonly sender: ApprovalChannelSenderLike;
  private readonly logger: Logger;
  private readonly isPrivileged: (senderId: string | undefined) => boolean;

  public constructor(
    manager: ApprovalChannelManagerLike,
    sender: ApprovalChannelSenderLike,
    logger: Logger,
    isPrivileged: (senderId: string | undefined) => boolean = () => true,
  ) {
    this.manager = manager;
    this.sender = sender;
    this.logger = logger;
    this.isPrivileged = isPrivileged;
  }

  /**
   * 注册 approval/request waterfall answerer。
   *
   * 不再探测 approval 服务是否已挂载：它是 optional peer，挂载时机可能晚于
   * 本插件的 apply，一次性探测失败会让通道永久失效。监听事件本身不依赖服务
   * 存在——服务就绪后请求自然经过同一条瀑布，未挂载时不会有请求到达。
   *
   * `global` 是必需的：approval/request 按 agent 作用域派发，根作用域注册的
   * 监听器不带 global 会被作用域过滤掉。
   */
  public install(ctx: ApprovalChannelContext): void {
    const self = this;
    ctx.on('approval/request', (req: unknown, next: unknown) => {
      const request = req as ApprovalRequest;
      const nextFn = next as () => Promise<ApprovalOutcome>;
      const record = self.manager.findBySessionId(request.agent.id);
      if (record) return self.park(record, request);
      return nextFn();
    }, { global: true, prepend: true });
    this.logger.info('im-qqbot: QQ approval channel installed');
  }

  /** 会话回收时清理其 pending 审批，避免 Promise 悬挂 */
  public cancelPending(sessionKey: string): void {
    const entry = this.pending.get(sessionKey);
    if (!entry) return;
    this.pending.delete(sessionKey);
    this.removeAbort(entry);
    entry.resolve('cancelled');
  }

  /** 按钮点击决策：解码 button_data，settle pending 审批 */
  public handleInteraction(event: InteractionEvent): boolean {
    const peerId = event.group_openid ?? event.user_openid;
    if (!peerId) return false;
    const scope: ChatScope = event.group_openid ? 'group' : 'c2c';
    const record = this.manager.getSessionRecord(scope, peerId);
    if (!record) {
      // 会话已经不存在（常见于插件重载/会话回收后点旧卡片）：消费事件并 ack 成功，
      // 避免 QQ 侧显示“审批失败”；旧审批已经无法结算。
      this.logger.warn(`im-qqbot: approval click ignored, session not found scope=${scope} peer=${peerId}`);
      return true;
    }

    const data = event.data?.resolved?.button_data;
    if (!data) return false;
    const button = decodeButtonData(data);
    if (!button || button.t !== 'approval') return false;

    const entry = this.pending.get(record.sessionKey);
    if (!entry) {
      // 卡片还在，但 pending 已经因超时/插件重载/会话回收消失：给用户一个明确提示，
      // 而不是让 QQ 显示“审批失败”。
      this.logger.warn(
        `im-qqbot: approval click ignored, no pending key=${record.sessionKey} sender=${event.user_openid ?? 'unknown'}`,
      );
      void this.sender
        .sendMarkdown(record.replyTarget, '这条审批已失效或已被处理了。请让发起人重新发起请求，我再弹一次审批。')
        .catch((err) => {
          this.logger.warn(`im-qqbot: approval stale notice failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      return true;
    }

    // 审批是拒绝/放行工具调用的开关：
    // - c2c：会话本人可以审批自己的操作；
    // - group：只允许主人/管理员，避免任意群成员放行影响群/配置的操作。
    // 未授权点击直接消费但不 settle，审批保持等待，真正的审批人仍可操作。
    const selfApproval = record.scope === 'c2c'
      && event.user_openid !== undefined
      && event.user_openid === record.replyTarget.targetId;
    if (!selfApproval && !this.isPrivileged(event.user_openid)) {
      this.logger.warn(
        `im-qqbot: approval click denied sender=${event.user_openid ?? 'unknown'} key=${record.sessionKey}`,
      );
      void this.sender
        .sendMarkdown(record.replyTarget, '只有 bot 主人或管理员可以审批这条操作。')
        .catch((err) => {
          this.logger.warn(`im-qqbot: approval denied notice failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      return true;
    }

    this.pending.delete(record.sessionKey);
    this.removeAbort(entry);
    entry.resolve(button.d === 'allow' ? 'allowed-once' : 'rejected');
    return true;
  }

  /** 走 QQ 通道：发审批消息 + 挂起 Promise，等待用户决策 */
  private async park(record: ApprovalSessionRecordLike, request: ApprovalRequest): Promise<ApprovalOutcome> {
    const key = record.sessionKey;
    // 会话回收/取消可能在发送前发生：signal 已 abort 则直接失败
    if (request.signal?.aborted) return 'cancelled';

    const command = commandOf(request);
    return new Promise<ApprovalOutcome>((resolve) => {
      // 先登记 pending 再发卡片：用户可能在 sendMarkdown 返回前就点了按钮。
      const entry: PendingApproval = { record, request, resolve };
      this.pending.set(key, entry);

      if (request.signal) {
        const onAbort = (): void => {
          if (this.pending.get(key) !== entry) return;
          this.pending.delete(key);
          resolve('cancelled');
        };
        entry.onAbort = onAbort;
        request.signal.addEventListener('abort', onAbort, { once: true });
      }

      void this.sender
        .sendMarkdown(record.replyTarget, buildApprovalText(request, command), { keyboard: buildApprovalKeyboard() })
        .then(() => {
          this.logger.info(`im-qqbot: approval sent to QQ, waiting for decision key=${key}`);
        })
        .catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.error(`im-qqbot: approval send failed key=${key}: ${msg}`);
          if (this.pending.get(key) === entry) {
            this.pending.delete(key);
            this.removeAbort(entry);
            resolve('unavailable');
          }
        });
    });
  }

  private removeAbort(entry: PendingApproval): void {
    if (entry.onAbort && entry.request.signal) {
      entry.request.signal.removeEventListener('abort', entry.onAbort);
    }
  }
}
