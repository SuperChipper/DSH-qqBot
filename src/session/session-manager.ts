/**
 * SessionManager — 管理 QQ peer → dsh Agent 的映射和生命周期
 *
 * sessionKey 格式: `qqbot:${appId}:${kind}:${peerId}`
 *   - c2c:   peerId = senderId (用户 openid)
 *   - group: peerId = groupOpenid
 *
 * SessionId 由 sessionKey 确定性派生（SHA-256），
 * 保证同一个用户/群的消息始终路由到同一个会话，
 * 重启后可根据 key 恢复 session。
 *
 * 支持 agent-presets 系统：通过 setup hook 在 create/resume 时
 * 挂载 preset（工具集、prompt sections 等），实现场景化配置。
 */
import { createHash, randomUUID } from 'node:crypto';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { Context } from '@deepseek-ai/cordis';
import type { ImageBlock } from '@deepseek-ai/dsh-llm';
import type { ChatScope, Logger, ReplyTarget } from '../types.ts';
import type { ImQQBotConfig } from '../config.ts';
import { loadNativeImageBlock, type AttachmentStoreLike } from '../media/native-image.ts';
import { ModelResolver } from '../model/model-resolver.ts';
import type { ModelRoute, ModelEntry } from '../model/types.ts';
import { IdleEvictor } from './idle-evictor.ts';
import { resolveSessionCwd } from '../shared/file-access.ts';
import type { StickerStore, StickerMatchResult } from '../media/sticker-store.ts';
import { formatNotesHint, type NotesStore } from '../notes/notes-store.ts';
import { formatScheduleMigrationHint, readScheduleMigrations, scheduleStorageHome, type ScheduleMigrationTask } from './schedule-migration.ts';
import type { QuestionChannel } from '../features/question-channel.ts';
import type { ApprovalChannel } from '../features/approval-channel.ts';
import type {
  SessionEventLike,
  DshAgent,
  DshAgentHandle,
  SessionsService,
  DshAgentRegistry,
  AgentPresetsLike,
  PresetComposition,
  PresetEntry,
  PresetSwitchOutcome,
  SessionRecord,
  SessionStatus,
  TokenUsageStats,
  CompactionServiceLike,
  CompactOutcome,
} from './types.ts';

/** ManualCompactionError 各 code 的友好提示 */
const COMPACTION_ERROR_HINTS: Record<string, string> = {
  busy: '压缩服务忙，请稍后重试',
  cancelled: '压缩已取消',
  changed: '历史在压缩过程中发生变化，请重试',
  commit: '压缩提交失败',
  persistence: '压缩完成但保存失败',
};

/** system-prompt section 最小结构（name/order/text） */
interface PromptSection {
  name: string;
  order: number;
  text: string;
}

/** system-prompt/assemble waterfall 的 context 最小结构 */
interface AssembleContext {
  agent?: DshAgent;
}

/** system-prompt/assemble 的组装产物最小结构 */
interface AssembledPrompt {
  sections?: PromptSection[];
  [key: string]: unknown;
}

export class SessionManager {
  private sessions = new Map<string, SessionRecord>();
  /** 发送失败（常见于群主动消息无权限）的文本，等下一次用户消息时补发 */
  private unsent = new Map<string, string[]>();
  /** /new 或 fork 后的旧 sessionId → 当前会话 key，用于旧定时任务/旧审批卡片继续路由 */
  private retiredSessionIds = new Map<string, string>();
  /** /new 后待新会话重建的定时任务（旧会话 key → 任务） */
  private pendingScheduleMigrations = new Map<string, ScheduleMigrationTask[]>();
  private readonly evictor: IdleEvictor;
  private readonly modelResolver: ModelResolver;
  private readonly ctx: Context;
  private readonly agents: DshAgentRegistry;
  private readonly config: ImQQBotConfig;
  private readonly logger: Logger;
  /** 由 bootstrap 注入的问答通道（ask_user_question → QQ），会话回收时清理其待答问题 */
  public questionChannel?: QuestionChannel;
  /** 由 bootstrap 注入的审批通道（approval/request → QQ），会话回收时清理其待批审批 */
  public approvalChannel?: ApprovalChannel;
  /** 由 bootstrap 注入的表情收藏存储（动态 prompt 清单） */
  public stickerStore?: StickerStore;
  /** 由 bootstrap 注入的共享笔记库（工具 + 自动召回） */
  public notesStore?: NotesStore;

  constructor(
    ctx: Context,
    agents: DshAgentRegistry,
    config: ImQQBotConfig,
    logger: Logger,
  ) {
    this.ctx = ctx;
    this.agents = agents;
    this.config = config;
    this.logger = logger;
    this.modelResolver = new ModelResolver(ctx, config, logger);

    this.evictor = new IdleEvictor(
      this.sessions,
      config.sessionIdleTimeout,
      (key, record) => {
        this.logger.info(`evicting idle session: key=${key}`);
        this.sessions.delete(key);
        record.agent.cancel({ kind: 'user' });
        void record.handle.dispose().catch(() => {});
        // 回收会话时统一清理其待答问题/待批审批，避免 pending 悬挂泄漏
        this.questionChannel?.cancelPending(key);
        this.approvalChannel?.cancelPending(key);
      },
    );

    this.registerScopePromptInjection();
  }

  /**
   * 通过 system-prompt/assemble waterfall 注入群聊/私聊额外 system prompt。
   *
   * 该事件在每次 turn 构建 request 时触发；此处按会话 scope（群聊/私聊）
   * 追加对应的额外 prompt section。会话尚未建立（首次 assemble）或未配置
   * 额外 prompt 时原样返回，不做改动。
   */
  private registerScopePromptInjection(): void {
    const assemble = async (
      _assembly: unknown,
      context: AssembleContext,
      next: () => Promise<AssembledPrompt>,
    ): Promise<AssembledPrompt> => {
      const assembled = await next();
      if (!context.agent) return assembled;

      const record = this.findByAgent(context.agent);
      if (!record) return assembled;

      const sections = [...(assembled.sections ?? [])];
      const prompt = record.scope === 'group' ? this.config.groupPrompt : this.config.directPrompt;
      if (prompt) {
        sections.push({ name: 'qqbot:scope-prompt', order: 90, text: prompt });
      }

      // 水群：模型看到一整屏历史时容易挨个点评，真人只会接触发自己的那一句。
      if (record.scope === 'group') {
        sections.push({
          name: 'qqbot:group-focus',
          order: 91,
          text: [
            '【水群】',
            '你被 @ 或随机冒泡时，只接 [Current message] 那一句：先弄懂这句话本身在说什么、冲谁说的，再回它。',
            '[Chat history] 是你刚好扫到的聊天记录，只用来理解语境（这句话在接谁、在聊什么）；别把前面的消息、图片挨个点评一遍，也别总结群聊。',
            '只有当前这句明确提到前面的内容（「上面那张图」「刚才说的」、引用了某条消息）时，才回到前文去看。',
            '一句话能回完就一句话；不知道对方指什么就直接问，别自己脑补一大段。',
          ].join('\n'),
        });
      }

      // 动态表情清单：新收藏的表情在当前会话的下一回合即可见，不需要改人设配置。
      if (this.stickerStore !== undefined) {
        try {
          sections.push(...this.stickerStore.promptSections());
        } catch (err) {
          this.logger.warn(`im-qqbot: 注入表情清单失败: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      if (this.notesStore !== undefined) {
        sections.push({
          name: 'qqbot:shared-notes',
          order: 92,
          text: [
            '【共享笔记】',
            '你有一个所有群和私聊共享的笔记库，是你的长期记忆。消息前出现「[共享笔记 · 可能相关]」时，是按这条消息自动检索到的片段，相关就自然地用上，不相关就忽略，别生硬复述。',
            '想不起来但可能记过的东西，用 qqbot_notes_search 查；看完/学到/群里沉淀下来值得长期记住的，用 qqbot_notes_save 记下（提炼后再记，别记隐私和闲聊）。',
            '记笔记是你自己的事，不用每次都告诉用户「我记下了」。',
          ].join('\n'),
        });
      }

      // 媒体 caption：QQ 支持图片/视频/文件与文字同一条发出。
      // 这条优先于人设里的「先文字后图片」，避免用户看到两个气泡。
      sections.push({
        name: 'qqbot:media-caption',
        order: 93,
        text: [
          '【发图配文】',
          '用 qqbot_send_file 发图片/视频/文件并配文字时，把整段回复放进 caption，调用后不要再单独回复同一段文字；caption 会和媒体同一条消息发出。',
          '没有媒体要发时正常文字回复。这条优先于人设里的「先文字后图片」。',
        ].join('\n'),
      });

      sections.push({
        name: 'qqbot:image-routing',
        order: 94,
        text: [
          '【图片路由】',
          '用户发图时：',
          '1. 如果上下文里已有「[本地表情库]」命中提示，直接用它的情绪/文件，不要重复猜。',
          '2. 用户问“这是谁 / 出自哪 / 什么动漫”时，调用 skill 加载 anime-recognition，再按它的流程识别。',
          '3. 用户问“什么梗 / 表情包 / 怎么回”时，调用 skill 加载 meme-recognition。',
          '4. 用户只是随手发图、没提问时，按人设自然反应，不必强行识别。',
          '不要只凭肉眼断言角色或梗；需要外部检索时走对应 skill。',
        ].join('\n'),
      });

      if (sections.length === (assembled.sections?.length ?? 0)) return assembled;
      return { ...assembled, sections };
    };

    (this.ctx as unknown as {
      on(event: 'system-prompt/assemble', handler: typeof assemble): void;
    }).on('system-prompt/assemble', assemble);
  }

  /**
   * 动态获取 sessions 服务（fork 能力，可选）
   */
  private getSessionsService(): SessionsService | undefined {
    try {
      return this.ctx.get('sessions') as SessionsService | undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * 动态获取 agentPresets 服务（可选，未注入时返回 undefined）
   */
  private getPresetsService(): AgentPresetsLike | undefined {
    try {
      return this.ctx.get('agentPresets') as AgentPresetsLike | undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * 从 session 持久化 header 读 session 当初的 preset（started 锁定语义）。
   * 读不到（服务缺失 / session 不存在 / 未记录 agentPreset）返回 undefined。
   */
  private async resolvePersistedPreset(sessionId: string): Promise<string | undefined> {
    let persistence: { load(id: string): Promise<{ meta?: { agentPreset?: string } }> } | undefined;
    try {
      persistence = this.ctx.get('sessionPersistence') as typeof persistence | undefined;
    } catch {
      return undefined;
    }
    if (!persistence) return undefined;
    try {
      const { meta } = await persistence.load(sessionId);
      return meta?.agentPreset;
    } catch {
      return undefined;
    }
  }

  // ── 模型相关（委托给 ModelResolver） ──

  getEffectiveModel(scope: ChatScope, peerId: string): ModelRoute | undefined {
    return this.modelResolver.getEffectiveRoute(this.sessionKey(scope, peerId));
  }

  /**
   * 获取指定 peer 的生效 preset（per-peer 覆盖 > config.preset）
   */
  getEffectivePreset(scope: ChatScope, peerId: string): string | undefined {
    return this.getEffectivePresetByKey(this.sessionKey(scope, peerId));
  }

  /** 按 sessionKey 解析生效 preset */
  private getEffectivePresetByKey(key: string): string | undefined {
    return this.modelResolver.getPreset(key) ?? this.config.preset;
  }

  /**
   * 列出所有可用 preset（/preset 命令用）
   */
  async listPresets(): Promise<PresetEntry[]> {
    const presets = this.getPresetsService();
    if (!presets) return [];
    try {
      const list = await presets.list();
      return list.map((p) => ({ id: p.id, name: p.name, description: p.description }));
    } catch (err) {
      this.logger.warn(`list presets failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  /**
   * 切换模型（fork + 重建会话，保留历史）
   */
  async setModelOverride(scope: ChatScope, peerId: string, route: ModelRoute): Promise<void> {
    const key = this.sessionKey(scope, peerId);

    this.modelResolver.setOverride(key, route);

    const record = this.sessions.get(key);
    if (!record) {
      this.logger.info(`model pref saved (no active session): key=${key} → ${route.provider}/${route.model}`);
      return;
    }

    await this.rebuildSession(record, { route });
    this.logger.info(`model switched via fork: key=${key} → ${route.provider}/${route.model}`);
  }

  /**
   * 切换指定 peer 的 agent preset（per-peer 覆盖）
   *
   * 已开始的会话保持锁定（blank-session contract）：只持久化为新会话默认，
   * 不 fork/rebuild 当前会话，避免历史工具调用与新 preset 工具集冲突。
   */
  async setPresetOverride(scope: ChatScope, peerId: string, presetId: string): Promise<PresetSwitchOutcome> {
    const key = this.sessionKey(scope, peerId);

    // 1. 校验 preset 存在 + 可加载（broken 拒绝）
    const presets = this.getPresetsService();
    if (!presets) return { ok: false, reason: 'unavailable' };
    let resolved: { id: string; broken?: string };
    try {
      resolved = await presets.resolve(presetId);
    } catch (err) {
      return { ok: false, reason: 'unknown-preset', message: err instanceof Error ? err.message : String(err) };
    }
    if (resolved.broken !== undefined) {
      return { ok: false, reason: 'broken', message: resolved.broken };
    }

    // 2. 持久化 per-peer 覆盖（新会话生效）
    this.modelResolver.setPreset(key, presetId);

    const hasActive = this.sessions.has(key);
    this.logger.info(
      `preset pref saved: key=${key} → ${presetId}${hasActive ? ' (active session locked, next session applies)' : ''}`,
    );
    return { ok: true, presetId };
  }

  /**
   * 清除 per-peer preset 覆盖，回到 config.preset / 默认（新会话生效）
   */
  async clearPresetOverride(scope: ChatScope, peerId: string): Promise<PresetSwitchOutcome> {
    const key = this.sessionKey(scope, peerId);
    this.modelResolver.clearPreset(key);
    this.logger.info(`preset pref cleared: key=${key} (next session applies)`);
    return { ok: true };
  }

  /**
   * fork + 重建会话（保留历史，换 model）
   *
   * options.route 缺省时沿用当前生效值。preset 沿用当前生效 preset（getEffectivePresetByKey）。
   * fork 不可用或失败时降级为 dispose（下次消息重建）。
   */
  private async rebuildSession(
    record: SessionRecord,
    options: { route?: ModelRoute },
  ): Promise<void> {
    const key = record.sessionKey;

    const sessionsService = this.getSessionsService();
    if (!sessionsService) {
      this.logger.warn(`fork unavailable, fallback to dispose: key=${key}`);
      this.sessions.delete(key);
      record.agent.cancel({ kind: 'user' });
      await record.handle.dispose().catch(() => {});
      return;
    }

    let seed: readonly unknown[];
    try {
      seed = sessionsService.fork(record.agent.session).events;
    } catch (err) {
      this.logger.warn(`fork failed, fallback to dispose: key=${key} err=${err instanceof Error ? err.message : String(err)}`);
      this.sessions.delete(key);
      record.agent.cancel({ kind: 'user' });
      await record.handle.dispose().catch(() => {});
      return;
    }

    const childId = SessionId(randomUUID());
    const effectiveRoute = options.route ?? this.modelResolver.getEffectiveRoute(key);
    const composed = await this.composePreset(this.getEffectivePresetByKey(key));
    const created = await this.agents.create({
      sessionId: childId,
      seed,
      meta: {
        cwd: resolveSessionCwd(record.scope, record.senderId, this.config),
        parentSession: record.sessionId,
        seedLength: seed.length,
        ...(composed.agentPreset ? { agentPreset: composed.agentPreset } : {}),
      },
      ...(effectiveRoute ? { agentOptions: effectiveRoute } : {}),
      ...(composed.setup ? { setup: composed.setup } : {}),
    });

    this.modelResolver.setSessionId(key, childId);
    this.captureScheduleMigrations(key, record.sessionId);
    this.retiredSessionIds.set(record.sessionId, key);

    const oldHandle = record.handle;
    record.sessionId = childId;
    record.agent = created.agent;
    record.handle = created;
    record.agentPreset = composed.agentPreset;
    record.lastActivity = Date.now();

    void oldHandle.dispose().catch(() => {});
    this.logger.info(`session rebuilt via fork: key=${key} preset=${composed.agentPreset ?? 'none'} sessionId=${childId}`);
  }

  clearModelOverride(scope: ChatScope, peerId: string): void {
    const key = this.sessionKey(scope, peerId);
    this.modelResolver.clearOverride(key);
    this.modelResolver.clearSessionId(key);
  }

  async listAvailableModels(): Promise<ModelEntry[]> {
    return this.modelResolver.listModels();
  }

  listProviders(): string[] {
    return this.modelResolver.listProviders();
  }

  // ── 会话状态 / 统计 ──

  getSessionRecord(scope: ChatScope, peerId: string): SessionRecord | undefined {
    return this.sessions.get(this.sessionKey(scope, peerId));
  }

  /** 入站图片本地表情库精确匹配（失败/未启用时返回 undefined，不阻塞消息） */
  matchSticker(path: string): StickerMatchResult | undefined {
    try {
      return this.stickerStore?.match(path);
    } catch {
      return undefined;
    }
  }

  /** 按当前消息检索共享笔记，返回要注入的提示块（未启用/无相关结果/出错时返回空串） */
  notesHint(query: string): string {
    const notes = this.config.notes;
    if (this.notesStore === undefined || !notes?.autoInject || query.trim().length === 0) return '';
    try {
      return formatNotesHint(this.notesStore.search(query, notes.injectTopK * 2), {
        topK: notes.injectTopK,
        maxChars: notes.injectMaxChars,
        minCoverage: notes.injectMinCoverage,
      });
    } catch (err) {
      this.logger.warn(`im-qqbot: 笔记检索失败: ${err instanceof Error ? err.message : String(err)}`);
      return '';
    }
  }

  /** 原生读图：把本地图片提交为 attachment，返回可直接放进 user message 的 ImageBlock */
  async createImageBlock(path: string): Promise<ImageBlock | undefined> {
    if (!this.config.vision.native) return undefined;
    const attachments = this.ctx.get('attachments') as AttachmentStoreLike | undefined;
    if (attachments === undefined) {
      this.logger.warn('im-qqbot: vision.native 已开启，但 attachments 服务不可用，回退到图片路径');
      return undefined;
    }
    try {
      return await loadNativeImageBlock(attachments, path, this.config.vision.maxBytes);
    } catch (err) {
      this.logger.warn(`im-qqbot: 原生图片附件创建失败，回退到图片路径: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  /** 当前 provider/model 是否声明 image 输入（旧会话切模型前不能硬塞 ImageBlock） */
  async supportsImageInput(provider: string, model: string): Promise<boolean> {
    const llm = this.ctx.get('llm') as {
      resolveModelInfo(provider: string, model: string): Promise<{ inputModalities?: readonly string[] }>;
    } | undefined;
    if (llm === undefined) return false;
    try {
      const info = await llm.resolveModelInfo(provider, model);
      return info.inputModalities?.includes('image') ?? false;
    } catch {
      return false;
    }
  }

  /** 记录一条因平台限制未送达的文本，等下一次用户消息时提示模型补发 */
  addUnsent(sessionKey: string, text: string): void {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    const list = this.unsent.get(sessionKey) ?? [];
    list.push(trimmed.slice(0, 8000));
    while (list.length > 3) list.shift();
    this.unsent.set(sessionKey, list);
  }

  /** 取出并清空该会话的未送达文本 */
  takeUnsent(scope: ChatScope, peerId: string): string | undefined {
    const key = this.sessionKey(scope, peerId);
    const list = this.unsent.get(key);
    if (list === undefined || list.length === 0) return undefined;
    this.unsent.delete(key);
    return list.join('\n\n---\n\n').slice(0, 8000);
  }

  /** /new 时捕获旧会话的 active 定时任务，等新会话第一条消息注入重建指令 */
  private captureScheduleMigrations(sessionKey: string, oldSessionId: string): void {
    try {
      const tasks = readScheduleMigrations(scheduleStorageHome(), oldSessionId);
      if (tasks.length > 0) this.pendingScheduleMigrations.set(sessionKey, tasks);
      else this.pendingScheduleMigrations.delete(sessionKey);
    } catch {
      // 调度存储不可读时不阻塞 /new；用户仍可手动重建
    }
  }

  /** 取走并格式化待迁移任务（只给新会话的第一条消息一次） */
  takeScheduleMigration(scope: ChatScope, peerId: string): string | undefined {
    const key = this.sessionKey(scope, peerId);
    const tasks = this.pendingScheduleMigrations.get(key);
    if (tasks === undefined) return undefined;
    this.pendingScheduleMigrations.delete(key);
    return formatScheduleMigrationHint(tasks);
  }

  getStatus(scope: ChatScope, peerId: string): SessionStatus {
    const record = this.getSessionRecord(scope, peerId);
    const route = this.getEffectiveModel(scope, peerId);

    return {
      active: !!record,
      sessionId: record?.sessionId,
      provider: route?.provider,
      model: route?.model,
      preset: record?.agentPreset,
      lastActivity: record?.lastActivity,
      messageCount: this.countMessages(record),
    };
  }

  getTokenUsage(scope: ChatScope, peerId: string): TokenUsageStats {
    const record = this.getSessionRecord(scope, peerId);
    const stats: TokenUsageStats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

    const events = record?.agent.session.events;
    if (!events) return stats;

    for (const event of events) {
      if (event.type !== 'assistant/message' || !event.usage) continue;
      stats.input += event.usage.input ?? 0;
      stats.output += event.usage.output ?? 0;
      stats.cacheRead += event.usage.cacheRead ?? 0;
      stats.cacheWrite += event.usage.cacheWrite ?? 0;
    }

    return stats;
  }

  exportMarkdown(scope: ChatScope, peerId: string): string {
    const record = this.getSessionRecord(scope, peerId);
    if (!record) return '';

    const events = record.agent.session.events;
    if (!events || events.length === 0) return '';

    const lines: string[] = [`# QQ 会话导出\n`, `> session: ${record.sessionId}\n`];

    for (const event of events) {
      if (event.type === 'user/message') {
        const text = extractMessageText(event.message);
        if (text) lines.push(`## 用户\n\n${text}\n`);
      } else if (event.type === 'assistant/message') {
        const text = extractMessageText(event.message);
        if (text) lines.push(`## 助手\n\n${text}\n`);
      }
    }

    return lines.join('\n');
  }

  private countMessages(record: SessionRecord | undefined): number {
    const events = record?.agent.session.events;
    if (!events) return 0;

    let count = 0;
    for (const event of events) {
      if (event.type === 'user/message' || event.type === 'assistant/message') {
        count += 1;
      }
    }
    return count;
  }

  // ── Session 生命周期管理 ──

  private sessionKey(scope: ChatScope, peerId: string): string {
    return `qqbot:${this.config.appId}:${scope}:${peerId}`;
  }

  private deriveSessionId(sessionKey: string): string {
    const hash = createHash('sha256').update(sessionKey).digest('hex');
    return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
  }

  private currentSessionId(sessionKey: string): string {
    return this.modelResolver.getSessionId(sessionKey) ?? this.deriveSessionId(sessionKey);
  }

  /** 该 peer 当前（或下一次 getOrCreate 将使用）的 sessionId */
  sessionIdFor(scope: ChatScope, peerId: string): string {
    const record = this.sessions.get(this.sessionKey(scope, peerId));
    return record?.sessionId ?? this.currentSessionId(this.sessionKey(scope, peerId));
  }

  private async composePreset(presetId?: string): Promise<PresetComposition> {
    const presets = this.getPresetsService();
    if (!presets) return {};

    try {
      const resolved = await presets.resolve(presetId);
      const resolvedId = resolved.id;
      return {
        agentPreset: resolvedId,
        setup: async (agentCtx: Context) => {
          await presets.mount(agentCtx, resolvedId);
        },
      };
    } catch (err) {
      this.logger.warn(
        `im-qqbot: preset ${presetId ?? '(default)'} unavailable: ${err instanceof Error ? err.message : String(err)} — using host composition`,
      );
      return {};
    }
  }

  /** 获取或恢复或创建会话（get → resume → create） */
  async getOrCreate(
    scope: ChatScope,
    peerId: string,
    senderId: string,
    replyTarget: ReplyTarget,
  ): Promise<SessionRecord> {
    const key = this.sessionKey(scope, peerId);
    const existing = this.sessions.get(key);

    if (existing) {
      existing.replyTarget = replyTarget;
      existing.lastActivity = Date.now();
      return existing;
    }

    const route = this.modelResolver.getEffectiveRoute(key);
    const sessionId = SessionId(this.currentSessionId(key));
    this.logger.info(`getOrCreate: key=${key} route=${route ? `${route.provider}/${route.model}` : 'host-default'} sessionId=${sessionId}`);

    let agent: DshAgent;
    let handle: DshAgentHandle | undefined;
    let agentPreset: string | undefined;

    const live = this.agents.get(sessionId);
    if (live) {
      agent = live;
      this.logger.info(`reusing live agent: key=${key}`);
    } else {
      // preset 只解析一次：resume/create 共用同一组合，避免重复 resolve/mount 目录。
      // 优先 session 当初的 preset（started 锁定语义），无则用当前 effective preset。
      const presetId = (await this.resolvePersistedPreset(sessionId)) ?? this.getEffectivePresetByKey(key);
      const composed = await this.composePreset(presetId);
      agentPreset = composed.agentPreset;
      try {
        const resumeRoute = this.modelResolver.getResumeRoute(key);
        const resumed = await this.agents.resume({
          resumeSessionId: sessionId,
          ...(resumeRoute ? { agentOptions: resumeRoute } : {}),
          ...(composed.setup ? { setup: composed.setup } : {}),
        });
        agent = resumed.agent;
        handle = resumed;
        this.logger.info(`resumed session: key=${key} preset=${agentPreset ?? 'none'} route=${resumeRoute ? `${resumeRoute.provider}/${resumeRoute.model}` : 'session-own'}`);
      } catch {
        const created = await this.agents.create({
          sessionId,
          meta: {
            cwd: resolveSessionCwd(scope, senderId, this.config),
            ...(agentPreset ? { agentPreset } : {}),
          },
          ...(route ? { agentOptions: route } : {}),
          ...(composed.setup ? { setup: composed.setup } : {}),
        });
        agent = created.agent;
        handle = created;
        this.logger.info(`created new session: key=${key} preset=${agentPreset ?? 'none'}`);
      }
    }

    const record: SessionRecord = {
      sessionKey: key,
      sessionId,
      agent,
      handle: handle ?? { agent, dispose: async () => {} },
      replyTarget,
      scope,
      peerId,
      senderId,
      lastActivity: Date.now(),
      agentPreset,
    };

    this.sessions.set(key, record);
    return record;
  }

  findBySessionId(sessionId: string): SessionRecord | undefined {
    for (const record of this.sessions.values()) {
      if (record.sessionId === sessionId) return record;
    }
    const currentKey = this.retiredSessionIds.get(sessionId);
    return currentKey === undefined ? undefined : this.sessions.get(currentKey);
  }

  findByAgent(agent: DshAgent): SessionRecord | undefined {
    for (const record of this.sessions.values()) {
      if (record.agent === agent) return record;
    }
    return undefined;
  }

  async remove(scope: ChatScope, peerId: string): Promise<void> {
    const key = this.sessionKey(scope, peerId);
    const record = this.sessions.get(key);
    const oldSessionId = record?.sessionId ?? this.modelResolver.getSessionId(key);
    if (oldSessionId !== undefined) {
      this.captureScheduleMigrations(key, oldSessionId);
      this.retiredSessionIds.set(oldSessionId, key);
      while (this.retiredSessionIds.size > 100) {
        const first = this.retiredSessionIds.keys().next().value;
        if (first === undefined) break;
        this.retiredSessionIds.delete(first);
      }
    }
    this.modelResolver.setSessionId(key, randomUUID());

    if (!record) return;
    this.sessions.delete(key);
    record.agent.cancel({ kind: 'user' });
    await record.handle.dispose().catch(() => {});
    this.logger.info(`session removed: key=${key}`);
  }

  /**
   * 原地压缩当前会话历史（保留 sessionId，用摘要替换旧历史）。
   *
   * 需通过 agentPresets.serviceFor(agent, 'compaction') 解析；未挂载时优雅降级。
   * 这是「压缩上下文」的语义，区别于 remove() 的「换新会话」。
   */
  async compact(scope: ChatScope, peerId: string): Promise<CompactOutcome> {
    const key = this.sessionKey(scope, peerId);
    const record = this.sessions.get(key);
    if (!record) return { ok: false, reason: 'no-session' };
    if (record.agent.status !== 'idle') return { ok: false, reason: 'busy' };

    let compaction: CompactionServiceLike | undefined;
    try {
      const presets = this.getPresetsService();
      compaction = (presets?.serviceFor(record.agent, 'compaction') ?? this.ctx.get('compaction')) as CompactionServiceLike | undefined;
    } catch {
      compaction = undefined;
    }
    if (!compaction) return { ok: false, reason: 'unavailable' };

    const route = this.modelResolver.getEffectiveRoute(key);
    const agentCtx = {
      session: record.agent.session,
      options: { provider: route?.provider, model: route?.model },
      runMaintenance: record.agent.runMaintenance.bind(record.agent),
    };

    try {
      const result = await compaction.compactNow(agentCtx, new AbortController().signal);
      if (result === null) return { ok: true, shadowed: 0, tokens: 0 };
      return { ok: true, shadowed: result.shadowedSeqs.length, tokens: result.shadowedTokenCount };
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      // summary = 摘要没有更小 = 历史不足以压缩，属正常结果而非失败
      if (code === 'summary') {
        return { ok: true, shadowed: 0, tokens: 0 };
      }
      // 其他 ManualCompactionError 预期失败，给友好文案（debug 记录，不 warn 刷屏）
      if (code !== undefined && code in COMPACTION_ERROR_HINTS) {
        this.logger.debug(`compact declined: key=${key} code=${code}`);
        return { ok: false, reason: 'failed', message: COMPACTION_ERROR_HINTS[code] };
      }
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`compact failed: key=${key} err=${message}`);
      return { ok: false, reason: 'failed', message };
    }
  }

  /**
   * 轮次结束后按上下文大小自动压缩（后台执行，不阻塞下一条消息）。
   *
   * dsh 默认阈值按模型窗口算（deepseek-flash 约 678k token），群聊会话几乎碰不到；
   * 这里只对 QQ 会话、按 autoCompactTokens 主动压缩。压缩期间进来的消息由 agent 排队，压完再跑。
   * 正忙、正在压缩或还不知道上下文大小时跳过，下一轮再判断。
   */
  maybeAutoCompact(record: SessionRecord): void {
    const threshold = this.config.autoCompactTokens ?? 0;
    if (threshold <= 0 || record.compacting) return;
    if (record.contextTokens === undefined || record.contextTokens < threshold) return;
    if (record.agent.status !== 'idle') return;

    const before = record.contextTokens;
    record.compacting = true;
    void this.compact(record.scope, record.peerId)
      .then((outcome) => {
        if (outcome.ok) {
          record.contextTokens = undefined; // 下一次请求后重新测量
          this.logger.info(
            `im-qqbot: 自动压缩 key=${record.sessionKey} 上下文≈${before} tokens → 摘要替换 ${outcome.shadowed ?? 0} 条（约 ${outcome.tokens ?? 0} tokens）`,
          );
        } else {
          this.logger.warn(`im-qqbot: 自动压缩跳过 key=${record.sessionKey} reason=${outcome.reason}${outcome.message ? ` ${outcome.message}` : ''}`);
        }
      })
      .catch((err: unknown) => {
        this.logger.warn(`im-qqbot: 自动压缩失败 key=${record.sessionKey}: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        record.compacting = false;
      });
  }

  async disposeAll(): Promise<void> {
    this.evictor.dispose();
    const records = [...this.sessions.values()];
    this.sessions.clear();
    for (const record of records) {
      record.agent.cancel({ kind: 'user' });
    }
    await Promise.allSettled(records.map((r) => r.handle.dispose()));
    this.logger.info(`all sessions disposed (count=${records.length})`);
  }

  get size(): number {
    return this.sessions.size;
  }
}

/** 从消息对象中提取纯文本（用于导出/统计） */
function extractMessageText(
  message: SessionEventLike['message'],
): string {
  const blocks = message?.content;
  if (!blocks || !Array.isArray(blocks)) return '';

  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === 'text' && block.text) {
      parts.push(block.text);
    }
  }
  return parts.join('\n').trim();
}
