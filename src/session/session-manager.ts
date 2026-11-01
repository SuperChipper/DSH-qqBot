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
import { chatKeyOf, formatNotesHint, type NotesStore } from '../notes/notes-store.ts';
import type { ToolAccess } from '../features/tool-access.ts';
import type { DndService } from '../dnd/dnd-service.ts';
import type { DndTurnButtons } from '../dnd/turn-buttons.ts';
import { resolveTmpDir } from '../media/tmp-dir.ts';
import { isVoiceFile, VOICE_REPLY_REMINDER } from '../media/voice-reply.ts';
import { join } from 'node:path';
import {
  formatScheduleMigrationHint,
  readScheduleMigrations,
  retireMigratedSchedules,
  scheduleStorageHome,
  type ScheduleMigrationTask,
  type ScheduleServiceLike,
} from './schedule-migration.ts';
import type { QuestionChannel } from '../features/question-channel.ts';
import type { ApprovalChannel } from '../features/approval-channel.ts';
import { GROUP_MESSAGE_FORMAT_PROMPT } from '../features/message-format.ts';
import { compactThreshold, decideAutoCompact, deferCeiling, lastTurnUsedTools } from '../features/compact-policy.ts';
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

/** ctx.llm 查模型窗口的最小接口 */
interface ModelInfoLlm {
  resolveModelInfo?(provider: string, model: string): Promise<{ context?: { contextWindow?: number } } | undefined>;
}

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

const RECENT_SENDERS_MAX = 12;

function noteSender(record: SessionRecord, senderId: string): void {
  const list = record.recentSenders ?? [];
  list.push({ id: senderId, at: Date.now() });
  if (list.length > RECENT_SENDERS_MAX) list.splice(0, list.length - RECENT_SENDERS_MAX);
  record.recentSenders = list;
}

/** windowMs 内给这个会话发过消息的人 */
export function recentSenderIds(record: SessionRecord, windowMs: number, now = Date.now()): string[] {
  return [...new Set((record.recentSenders ?? []).filter((s) => now - s.at <= windowMs).map((s) => s.id))];
}

export class SessionManager {
  private sessions = new Map<string, SessionRecord>();
  /** 发送失败（常见于群主动消息无权限）的文本，等下一次用户消息时补发 */
  private unsent = new Map<string, string[]>();
  /** /new 或 fork 后的旧 sessionId → 当前会话 key，用于旧定时任务/旧审批卡片继续路由 */
  private retiredSessionIds = new Map<string, string>();
  /** /new 后待新会话重建的定时任务（会话 key → 各旧 session 的任务批次） */
  private pendingScheduleMigrations = new Map<string, Array<{ oldSessionId: string; tasks: ScheduleMigrationTask[] }>>();
  /** provider/model → 上下文窗口（自动压缩阈值用；undefined = 查过但宿主没给） */
  private readonly contextWindows = new Map<string, number | undefined>();
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
  /** 由 bootstrap 注入的工具权限（终端白名单） */
  public toolAccess?: ToolAccess;
  /** 由 bootstrap 注入的跑团服务（/dnd 命令 + DM prompt 注入） */
  public dndService?: DndService;
  /** 由 bootstrap 注入的跑团按钮（/dnd start 发签到）；按钮关闭时为空 */
  public dndButtons?: DndTurnButtons;
  /** 由 bootstrap 探测到的 ffmpeg 绝对路径（配置的或 winget 目录里找到的；走 PATH 时为空），提示模型直接用 */
  public ffmpegPath?: string;

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
    this.registerVoiceReplyDelivery();
  }

  /** 语音后的文字继续生成，出站层改用独立静态消息，投递队列负责发送间隔。 */
  private registerVoiceReplyDelivery(): void {
    interface Execution {
      name: string;
      arguments: unknown;
      agent?: unknown;
      signal: AbortSignal;
    }
    interface Result {
      isError?: boolean;
      error?: unknown;
    }
    const handler = async (exec: Execution, next: () => Promise<Result>): Promise<Result> => {
      const record = exec.agent === undefined ? undefined : this.findByAgent(exec.agent as DshAgent);
      const args = exec.arguments as { file_path?: unknown; target?: unknown } | null;
      const voice = exec.name === 'qqbot_speak'
        || (exec.name === 'qqbot_send_file' && typeof args?.file_path === 'string' && isVoiceFile(args.file_path));
      const currentTarget = record === undefined ? undefined : `${record.replyTarget.scope}:${record.replyTarget.targetId}`;
      const sameChat = args?.target === undefined || args.target === '' || args.target === currentTarget;
      const result = await next();
      if (record === undefined || !voice || !sameChat || exec.signal.aborted || result.isError || result.error !== undefined) return result;
      record.voiceReplySentAt = Date.now();
      this.logger.info(`im-qqbot: 语音已送达，后续文字单独投递 key=${record.sessionKey}`);
      return result;
    };
    (this.ctx as unknown as {
      on(event: 'tools/execute', listener: typeof handler): void;
    }).on('tools/execute', handler);
    this.logger.info('im-qqbot: 语音后文字独立发送已启用（保留模型续写）');
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
        // 不解释标签的话，模型按昵称认人：重名、没昵称（只剩 openid 前缀）或多人合并时就会认错发言人
        sections.push({ name: 'qqbot:message-format', order: 91, text: GROUP_MESSAGE_FORMAT_PROMPT });
        sections.push({
          name: 'qqbot:group-focus',
          order: 91,
          text: [
            '【水群】',
            '你被 @ 或随机冒泡时，落点是 [Current message]：先弄懂这句在说什么、冲谁说的。',
            '[Chat history] 是你扫到的背景，用来判断语境（在接谁的话、在聊什么）。可以顺着一两句往下接，但不用逐条回应，也别把整段群聊总结一遍。',
            '当前这句明确指向前面（「上面那张图」「刚才说的」、引用了某条消息）时，就回去看。',
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

      if (this.toolAccess !== undefined && !this.toolAccess.isFullAccess({ scope: record.scope, peerId: record.peerId })) {
        sections.push({
          name: 'qqbot:tool-access',
          order: 91,
          text: [
            '【工具权限】',
            '本会话不在终端白名单里：没有 pwsh/bash/终端，不能派生子 agent；文件工具只能用在 bot 的媒体、表情和临时目录。被拦就直接告诉用户做不到，别换工具绕，也别说出本机路径。',
            '只有 bot 主人能把本群加入白名单：主人明确要求时调用 qqbot_tool_access(action="grant")，它会发确认按钮，主人点了才生效。',
          ].join('\n'),
        });
      }

      if (this.notesStore !== undefined) {
        sections.push({
          name: 'qqbot:shared-notes',
          order: 92,
          text: [
            '【共享笔记】',
            '你有一个所有群和私聊共享的笔记库，是你的长期记忆。消息前出现「[共享笔记 · 可能相关]」时，是按这条消息自动检索到的片段，相关就自然地用上，不相关就忽略，别生硬复述。',
            '想不起来但可能记过的东西，用 qqbot_notes_search 查；看完/学到/群里沉淀下来值得长期记住的，用 qqbot_notes_save 记下（提炼后再记，别记隐私和闲聊）。',
            '只属于当前群的东西（跑团的玩家偏好、DM 约定，这个群成员自己的事）用 qqbot_notes_save(scope="chat") 记，别的群看不到；共享笔记里提到的人和事不一定发生在这个群，别把别的群的跑团进度、角色当成这个群的。',
            '跑团进度、物品、任务线头和待办用 dnd_progress 写进团档，不写笔记；进度以 dnd_* 工具查到的为准。DC、怪物数值、DM 笔记、没揭示的东西任何时候都不写进笔记。',
            '记笔记是你自己的事，不用每次都告诉用户「我记下了」。',
            '另外有一本《人类观察日记》，所有群和私聊共用：遇到人类的回复和你预测的不一样，就往里追加一条，用 qqbot_notes_save(file="人类观察日记.md")，格式固定「预测 / 实际 / 差在哪」，编号取文末最后一个 +1。只记判断失误，不记流水账。',
          ].join('\n'),
        });
      }

      // 跑团：开团的会话每回合注入 DM 守则 + 精简团况（不注入整份 campaign JSON）
      if (this.dndService !== undefined) {
        try {
          const dndSections = this.dndService.promptSections(record.sessionKey);
          sections.push(...dndSections);
          // 开团时本群笔记不走自动注入（见 notesHint），这里只列个目录，玩的时候要用的约定让模型自己去查
          const titles = dndSections.length > 0 ? this.notesStore?.chatNoteTitles(chatKeyOf(record.scope, record.peerId)) ?? [] : [];
          if (titles.length > 0) {
            sections.push({
              name: 'qqbot:dnd-chat-notes',
              order: 98,
              text: `本群笔记（开团期间不自动注入，需要时用 qqbot_notes_search 查，进度以【团况】为准）：${titles.join('；')}`,
            });
          }
        } catch (err) {
          this.logger.warn(`im-qqbot: 注入团况失败: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // 临时文件集中放 tmp/：不提示的话模型会把脚本、截图、抽帧直接写在工作目录根下
      const tmpDir = resolveTmpDir(this.config);
      const ttl = this.config.tmpTtlHours ?? 72;
      sections.push({
        name: 'qqbot:tmp-dir',
        order: 95,
        text: [
          '【临时文件】',
          `临时文件一律写到 ${tmpDir} 下（一次性脚本、截图、抽帧、下载的素材、pip/npm 依赖、转写音频等），按任务建子目录，例如 ${join(tmpDir, 'asr-video')}。不要写在工作目录 ${this.config.cwd || process.cwd()} 的根下。`,
          '定时任务每次运行用的脚本和下载的图片也是临时文件，同样写进临时目录，不要每次在别处另存一份新脚本；只有需要跨次保留的状态（已发记录、游标、日志）才写到固定的状态文件里（json/log/txt/md）。',
          ttl > 0
            ? `${tmpDir} 里 ${ttl} 小时没动过的东西会被自动清理；要长期保留的成果（用户要的文件、笔记）放到用户指定的位置，或用 qqbot_notes_save 记进笔记。`
            : '要长期保留的成果（用户要的文件、笔记）放到用户指定的位置，或用 qqbot_notes_save 记进笔记。',
          ...(this.ffmpegPath !== undefined
            ? [`本机有 ffmpeg/ffprobe：${this.ffmpegPath}（同目录还有 ffprobe），终端里直接用这个路径，不用再找或重装。`]
            : []),
        ].join('\n'),
      });

      // 配文只放短回应；完整解释另发，避免动态提示把人设的两句上限覆盖掉。
      sections.push({
        name: 'qqbot:media-caption',
        order: 93,
        text: [
          '【发图配文】',
          '用 qqbot_send_file 发图片/视频/文件并配文字时，整段配文放进 caption，但不超过两句、不换行、不放列表；要讲道理另发一条纯文字。caption 会和媒体同一条消息发出，不要再单独复述这段配文。',
          '没有媒体要发时正常文字回复。语音不支持 caption，按下面的语音发送规则处理。',
          '【语音单独发送】',
          '通过 qqbot_speak 或 qqbot_send_file 发送语音时：' + VOICE_REPLY_REMINDER,
        ].join('\n'),
      });

      sections.push({
        name: 'qqbot:image-routing',
        order: 94,
        text: [
          '【图片路由】',
          '用户发图时：',
          '1. 用户发图且有情绪可对时，优先用库存里那张回应；只在情绪明确、且库里有对得上的图时发。已有「[本地表情库]」命中提示时，用它判断情绪，不必重复识别；命中不代表必须配图。',
          '2. 用户问“这是谁 / 出自哪 / 什么动漫”时，先查本地表情库与梗库；查不到就如实说认不出，不要硬认。',
          '3. 用户问“什么梗 / 表情包 / 怎么回”时，调用 skill 加载 meme-recognition。',
          '4. 用户只是分享内容时，以文字为主，不必配图，也不必强行识别。纯信息性回复不发表情包，别连着两轮各挂一张。',
          '不要只凭肉眼断言角色或梗；需要外部检索时走对应 skill。',
        ].join('\n'),
      });

      // 视频意图：不提示的话模型拿到字幕/转写就整段复述，群友只是分享时也会收到一份「解读报告」
      sections.push({
        name: 'qqbot:video-intent',
        order: 94,
        text: [
          '【视频：先分清是要解读还是要评论】',
          '有人发视频、B 站卡片/链接，或让你看某个视频时，先判断他要哪种回应，再决定看多少、说多少：',
          '1. 评论（默认）：只是分享、只 @ 你、「看看」「你觉得呢」「好笑吗」。像群友一样给出你自己的反应：最戳你的一个点、一句吐槽，或联想到群里的事，一到三句。不复述剧情，不报 UP 主/播放量/时长，不搬评论区，不翻译全文。',
          '2. 解读：明确说「讲了啥」「总结」「解读」「翻译」「转写」「细说」。按要点讲清楚，结论放前面，不逐句复述。',
          '3. 具体问题：问什么答什么，视频内容只当依据；一条消息里有几问，就按顺序逐个答完。',
          '4. 问能力：「你能看视频吗」「能转写吗」，先回答能不能；能看就顺手看了，按第 1 条给反应，别借机把内容整段讲一遍。',
          '5. 让你自己挑、「喜欢就细品」：说你挑了哪条、喜欢哪儿、为什么，用你自己的口味说话，别交调研报告，也别把字幕整理成文件当作回答。',
          '拿不准就按「评论」处理，说短一点，对方想听细节会追问。字幕、转写、抽帧描述都是你看片的素材，不是要原样转述的稿子。',
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

  /** 按当前消息检索笔记（共享 + 本会话私有），返回要注入的提示块（未启用/无相关结果/出错时返回空串） */
  async notesHint(query: string, scope: ChatScope, peerId: string): Promise<string> {
    const notes = this.config.notes;
    if (this.notesStore === undefined || !notes?.autoInject || query.trim().length === 0) return '';
    try {
      // 开着团时本群的跑团笔记（旧进度、旧待办）会和每回合注入的实时团况打架，只召回共享笔记
      const campaignRunning = this.dndService?.active(this.sessionKey(scope, peerId)) !== undefined;
      const hits = await this.notesStore.searchHybrid(query, notes.injectTopK * 2, chatKeyOf(scope, peerId), { sharedOnly: campaignRunning });
      return formatNotesHint(hits, {
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
      if (tasks.length === 0) return;
      // 连续 /new 时保留之前还没交出去的批次，每批记住自己的旧 sessionId
      const pending = this.pendingScheduleMigrations.get(sessionKey) ?? [];
      pending.push({ oldSessionId, tasks });
      this.pendingScheduleMigrations.set(sessionKey, pending);
    } catch {
      // 调度存储不可读时不阻塞 /new；用户仍可手动重建
    }
  }

  /**
   * 取走并格式化待迁移任务（只给新会话的第一条消息一次）。
   * 同时删除旧会话里的这些任务：DSH 按原 sessionId 投递，不删会和新会话重建的任务重复触发。
   */
  takeScheduleMigration(scope: ChatScope, peerId: string): string | undefined {
    const key = this.sessionKey(scope, peerId);
    const pending = this.pendingScheduleMigrations.get(key);
    if (pending === undefined) return undefined;
    this.pendingScheduleMigrations.delete(key);
    const schedule = this.getScheduleService();
    if (schedule === undefined) {
      this.logger.warn(`schedule service unavailable; old session tasks not retired: key=${key}`);
    } else {
      for (const { oldSessionId, tasks } of pending) {
        void retireMigratedSchedules(schedule, oldSessionId, tasks)
          .then((count) => this.logger.info(`retired ${count} migrated schedule task(s): key=${key} oldSessionId=${oldSessionId}`))
          .catch((err: unknown) => this.logger.warn(`retire migrated schedules failed: key=${key} oldSessionId=${oldSessionId} err=${err instanceof Error ? err.message : String(err)}`));
      }
    }
    return formatScheduleMigrationHint(pending.flatMap((batch) => batch.tasks));
  }

  private getScheduleService(): ScheduleServiceLike | undefined {
    try {
      return this.ctx.get('schedule') as ScheduleServiceLike | undefined;
    } catch {
      return undefined;
    }
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

  sessionKey(scope: ChatScope, peerId: string): string {
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

  /** 记一个发过消息的人（合并消息里除触发者以外的发送者） */
  noteSender(record: SessionRecord, senderId: string): void {
    noteSender(record, senderId);
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
      noteSender(existing, senderId);
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
    noteSender(record, senderId);

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
   * 这里对 QQ 会话主动压缩，阈值与推迟规则见 features/compact-policy。压缩期间进来的消息由
   * agent 排队，压完再跑。正忙、正在压缩或还不知道上下文大小时跳过，下一轮再判断。
   */
  maybeAutoCompact(record: SessionRecord): void {
    if ((this.config.autoCompactTokens ?? 0) <= 0 || record.compacting) return;
    if (record.contextTokens === undefined || record.agent.status !== 'idle') return;

    // 先占住标记：查窗口是异步的，期间不能再触发一次
    record.compacting = true;
    void this.autoCompact(record)
      .catch((err: unknown) => {
        this.logger.warn(`im-qqbot: 自动压缩失败 key=${record.sessionKey}: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        record.compacting = false;
      });
  }

  private async autoCompact(record: SessionRecord): Promise<void> {
    const before = record.contextTokens;
    const contextWindow = await this.contextWindowOf(record);
    const threshold = compactThreshold(record.scope, contextWindow, {
      autoCompactTokens: this.config.autoCompactTokens ?? 0,
      autoCompactPrivateRatio: this.config.autoCompactPrivateRatio ?? 0,
      autoCompactDeferOnTools: this.config.autoCompactDeferOnTools ?? false,
    });
    const usedTools = lastTurnUsedTools(record.agent.session.events);
    const decision = decideAutoCompact({
      contextTokens: before,
      threshold,
      contextWindow,
      lastTurnUsedTools: usedTools,
      deferOnTools: this.config.autoCompactDeferOnTools ?? false,
    });
    if (decision === 'defer') {
      this.logger.info(
        `im-qqbot: 自动压缩推迟 key=${record.sessionKey} 上下文≈${before} tokens ≥ 阈值 ${threshold}，上一轮还在调工具，等收尾轮或到 ${deferCeiling(threshold, contextWindow)} 再压`,
      );
      return;
    }
    if (decision !== 'compact') return;
    // 查窗口期间可能已经开始了下一轮
    if (record.agent.status !== 'idle') return;

    const outcome = await this.compact(record.scope, record.peerId);
    if (outcome.ok) {
      record.contextTokens = undefined; // 下一次请求后重新测量
      this.logger.info(
        `im-qqbot: 自动压缩 key=${record.sessionKey} 上下文≈${before} tokens（阈值 ${threshold}）→ 摘要替换 ${outcome.shadowed ?? 0} 条（约 ${outcome.tokens ?? 0} tokens）`,
      );
    } else {
      this.logger.warn(`im-qqbot: 自动压缩跳过 key=${record.sessionKey} reason=${outcome.reason}${outcome.message ? ` ${outcome.message}` : ''}`);
    }
  }

  /** 按会话实际路由的模型查上下文窗口（按 provider/model 缓存）；查不到返回 undefined，私聊退回固定阈值 */
  private async contextWindowOf(record: SessionRecord): Promise<number | undefined> {
    const header = record.agent.session.requestHeader?.()?.config;
    const route = header?.provider && header.model
      ? { provider: header.provider, model: header.model }
      : this.modelResolver.getEffectiveRoute(record.sessionKey);
    if (!route?.provider || !route.model) return undefined;
    const key = `${route.provider}/${route.model}`;
    if (this.contextWindows.has(key)) return this.contextWindows.get(key);

    let window: number | undefined;
    try {
      const llm = this.ctx.get('llm') as ModelInfoLlm | undefined;
      const info = await llm?.resolveModelInfo?.(route.provider, route.model);
      window = info?.context?.contextWindow;
    } catch (err) {
      this.logger.debug(`contextWindowOf ${key} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    // 查不到也缓存，免得每轮都查；换模型会换 key
    this.contextWindows.set(key, window);
    return window;
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
