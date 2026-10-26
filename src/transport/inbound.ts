/**
 * 入站处理器 — 经 SDK 中间件链处理后的消息 → dsh Agent followup
 *
 * 内容组装逻辑：
 * - Layer 1: userContent（文本 + 语音转录）
 * - Layer 2: quotePart（引用消息块）
 * - Layer 3: userMessage（带发送者标签）
 * - Layer 4: dynamicCtx（媒体元数据）
 * - Layer 5: agentBody（history + base 拼合）
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { SessionManager } from '../session/index.ts';
import type { ImQQBotConfig } from '../config.ts';
import type { ChatScope, Logger, QuotedAttachment, RawAttachment, ReplyTarget } from '../types.ts';
import {
  classifyContentType,
  isVoiceContentType,
  type DownloadedFile,
  type MediaKind,
} from './attachment.ts';
import { clearGroupHistory } from '../features/history-store.ts';
import { readRecentGroupMessages, type GroupMemoryImage } from '../features/group-memory.ts';
import {
  downloadRecentHistoryImages,
  historyImageTag,
  numberHistoryImages,
  type HistoryImage,
} from '../media/history-images.ts';
import type { MiddlewareContext } from '@tencent-connect/qqbot-nodejs';

// ── 类型定义 ──

interface ProcessedMessage {
  rawEventType: string;
  kind: 'c2c' | 'group';
  senderId: string;
  senderName?: string;
  content: string;
  messageId: string;
  timestamp: string;
  groupOpenid?: string;
  msgType?: number;
  attachments?: RawAttachment[];
  [key: string]: unknown;
}

interface ResolvedQuote {
  text?: string;
  entry?: { senderId?: string; content?: string };
  attachments?: QuotedAttachment[];
}

interface HistoryEntry {
  senderId: string;
  senderName?: string;
  content: string;
  timestamp: number;
  messageId: string;
  /** 群记忆里的图片（SDK historyBuffer 的条目没有） */
  images?: GroupMemoryImage[];
}

interface MentionState {
  wasMentioned?: boolean;
  implicit?: boolean;
}

interface MiddlewareState {
  quote?: ResolvedQuote;
  history?: HistoryEntry[];
  envelope?: string;
  mention?: MentionState;
  processedAttachments?: ProcessedAttachment[];
  downloadedFiles?: DownloadedFile[];
  downloadedQuoteFiles?: DownloadedFile[];
  [key: string]: unknown;
}

interface ProcessedAttachment {
  type: 'voice' | 'image' | 'video' | 'file' | 'unknown';
  filename?: string;
  url?: string;
  localPath?: string;
  voiceText?: string;
  voiceSource?: 'stt' | 'asr' | 'fallback';
  duration?: number;
  width?: number;
  height?: number;
  size?: number;
}

// ── 主处理函数 ──

/**
 * 处理 QQ 入站消息（已经过 SDK 中间件链）
 */
export async function handleInbound(
  ctx: MiddlewareContext,
  manager: SessionManager,
  config: ImQQBotConfig,
  logger: Logger,
): Promise<void> {
  const msg = ctx.message as unknown as ProcessedMessage;
  const mwState = ctx.state as MiddlewareState;
  const { bot } = ctx;

  const scope: ChatScope = msg.kind === 'group' ? 'group' : 'c2c';
  const peerId = scope === 'group' ? (msg.groupOpenid ?? msg.senderId) : msg.senderId;

  const replyTarget: ReplyTarget = {
    scope,
    targetId: peerId,
    msgId: msg.messageId,
  };

  // ── 群历史：被 @/随机触发时读持久化群记忆，并按需下载最近几张历史图片 ──
  const isGroupTrigger = scope === 'group'
    && ((mwState.mention?.wasMentioned ?? false) || (mwState.mention?.implicit ?? false));
  const history: HistoryEntry[] | undefined = isGroupTrigger
    ? readRecentGroupMessages(config.appId, peerId, config.historyLimit, msg.messageId)
    : mwState.history;
  const historyImages = isGroupTrigger ? numberHistoryImages(history ?? []) : [];
  if (historyImages.length > 0) {
    try {
      await downloadRecentHistoryImages(historyImages, config.media, logger);
    } catch (err) {
      logger.warn(`im-qqbot: 历史图片下载失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── 组装 agentBody（下载结果经 mwState.downloadedFiles 提供） ──
  const agentBody = assembleAgentBody(msg, mwState, scope, manager, history, historyImages);

  if (!agentBody) return;

  logger.info(`Processing: scope=${scope} peerId=${peerId} body="${agentBody.slice(0, 200)}"`);

  // ── 获取或创建会话 ──
  let record;
  try {
    record = await manager.getOrCreate(scope, peerId, msg.senderId, replyTarget);
  } catch (err) {
    logger.error(`ERROR creating session: ${err instanceof Error ? err.message : String(err)}`);
    // 兜底回复：会话创建失败时告知用户，避免静默无响应
    try {
      await bot.sendMarkdown(replyTarget, '⚠️ 处理消息时出现异常，请稍后重试。');
    } catch (sendErr) {
      logger.error(`fallback reply failed: ${sendErr instanceof Error ? sendErr.message : String(sendErr)}`);
    }
    return;
  }

  // ── 构建 UserMessage → followup ──
  let text = agentBody;
  let nativeImages = false;
  if (config.vision.native) {
    // 旧会话可能仍是 text-only 路由；按会话实际 requestHeader 判断，不能只看全局 config。
    const header = (record.agent as unknown as {
      session?: { requestHeader?: () => { config?: { provider?: string; model?: string } } };
    }).session?.requestHeader?.()?.config;
    const provider = header?.provider ?? config.provider ?? '';
    const model = header?.model ?? config.model ?? '';
    nativeImages = await manager.supportsImageInput(provider, model);
    if (!nativeImages) {
      text += `\n[图片未原生注入：当前会话模型 ${provider}/${model} 不支持 image 输入；需要看图请调用 qqbot_describe_image。]`;
    }
  }
  const content: ContentBlock[] = [{ type: 'text' as const, text }];

  // 原生读图：主模型路由声明 image 输入时，直接把原图作为 ImageBlock 交给模型，
  // 不再先经过 qqbot_describe_image 的「图片 → 文字描述」链路。
  if (nativeImages) {
    const seen = new Set<string>();
    const hasNativeImage = historyImages.length > 0
      || [...(mwState.downloadedFiles ?? []), ...(mwState.downloadedQuoteFiles ?? [])]
        .some((file) => file.contentType === 'image');
    if (hasNativeImage) {
      content.push({
        type: 'text' as const,
        text: '[图片已原生注入：直接看图，不要先调用 qqbot_describe_image；只有逐字 OCR、图表/表格、长截图或你看不清时才用它补充。]',
      });
    }

    // 历史图片在前，每张前加编号标签，和历史文本里的 [图片#n] 对应
    let historyAttached = 0;
    for (const image of historyImages) {
      if (image.localPath === undefined || seen.has(image.localPath)) continue;
      seen.add(image.localPath);
      const block = await manager.createImageBlock(image.localPath);
      if (block === undefined) continue;
      content.push({ type: 'text', text: `[历史图片#${image.index}]` }, block);
      historyAttached++;
    }

    const images = [
      ...(mwState.downloadedFiles ?? []),
      ...(mwState.downloadedQuoteFiles ?? []),
    ];
    let currentLabeled = false;
    for (const file of images) {
      if (file.contentType !== 'image' || seen.has(file.localPath)) continue;
      seen.add(file.localPath);
      const block = await manager.createImageBlock(file.localPath);
      if (block === undefined) continue;
      if (historyAttached > 0 && !currentLabeled) {
        content.push({ type: 'text', text: '[当前消息的图片]' });
        currentLabeled = true;
      }
      content.push(block);
    }
  }

  const message = createUserMessage({
    content,
    source: { kind: 'user' as const },
  });

  record.agent.followup(message);
  logger.info(`→ followup sent: key=${scope}:${peerId}`);

  // 群消息回复后清空历史缓存（避免下次 @ 时重复组包）
  if (scope === 'group') {
    clearGroupHistory(config.appId, msg.groupOpenid ?? msg.senderId);
  }

  // 阻塞等待本轮 turn 收敛，避免后续消息在 turn 运行期间被 followup 打断
  try {
    await record.agent.whenIdle();
  } catch (err) {
    logger.warn(`whenIdle rejected: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ══════════════════════════════════════════════════════════════
// Body Assembly（5 层组装）
// ══════════════════════════════════════════════════════════════

/**
 * 组装 agentBody — AI 实际看到的完整上下文
 */
function assembleAgentBody(
  msg: ProcessedMessage,
  state: MiddlewareState,
  scope: ChatScope,
  manager: SessionManager,
  history: HistoryEntry[] | undefined,
  historyImages: HistoryImage[],
): string | null {
  const isGroup = scope === 'group';
  const wasMentioned = state.mention?.wasMentioned ?? false;
  const implicit = state.mention?.implicit ?? false;

  const userContent = buildUserContent(msg, state);

  if (isEmptyMessage(userContent, msg.attachments, isGroup, wasMentioned)) return null;

  const quotePart = buildQuotePart(state.quote);
  const userMessage = buildUserMessage(userContent, quotePart, msg.senderId, msg.senderName, isGroup, wasMentioned);

  const dynamicCtx = buildDynamicCtx(msg, state);
  const stickerHints = buildStickerHints(state.downloadedFiles, manager);
  const peerId = isGroup ? (msg.groupOpenid ?? msg.senderId) : msg.senderId;
  const unsent = manager.takeUnsent(scope, peerId);
  const unsentHint = unsent === undefined
    ? ''
    : `[上次未送达]\n上一次发给本会话的消息因平台限制失败，内容如下。现在用户重新说话了，可以把它作为回复补发（太长就发摘要）：\n${unsent}`;
  const migrationHint = manager.takeScheduleMigration(scope, peerId);

  const base = [dynamicCtx, stickerHints, unsentHint, migrationHint, userMessage].filter(Boolean).join('\n');
  const agentBody = buildAgentBody(base, history, isGroup, wasMentioned || implicit, historyImages);

  return agentBody;
}

/**
 * 判断消息是否为空：无文本/语音/附件，且非群聊 @。
 * 群聊被 @ 视为有效触发信号，即使内容为空也保留给 agent。
 */
function buildStickerHints(files: DownloadedFile[] | undefined, manager: SessionManager): string {
  if (files === undefined || files.length === 0) return '';
  const lines: string[] = [];
  for (const file of files) {
    if (file.contentType !== 'image') continue;
    const match = manager.matchSticker(file.localPath);
    if (match === undefined) continue;
    const note = match.note !== undefined ? `；备注：${match.note}` : '';
    lines.push(
      `[本地表情库] 命中「${match.emotion}」→ ${match.file}（${match.bytes} bytes${note}）。`
      + '可直接用这个情绪，或用 qqbot_send_file 发出这张表情。',
    );
  }
  return lines.join('\n');
}

function isEmptyMessage(
  userContent: string,
  attachments: RawAttachment[] | undefined,
  isGroup: boolean,
  wasMentioned: boolean,
): boolean {
  if (userContent) return false;
  if (attachments && attachments.length > 0) return false;
  if (isGroup && wasMentioned) return false;
  return true;
}

/**
 * Layer 1: 用户文本内容 + 语音转录 + 附件类型标签（媒体路径由 buildDynamicCtx 提供）
 */
function buildUserContent(msg: ProcessedMessage, state: MiddlewareState): string {
  const parts: string[] = [];

  const text = (msg.content ?? '').trim();
  if (text) {
    parts.push(text);
  }

  const voiceTexts = extractVoiceTexts(msg.attachments, state.processedAttachments);
  if (voiceTexts.length > 0) {
    for (const vt of voiceTexts) {
      const durationTag = vt.duration ? ` (${vt.duration}s)` : '';
      parts.push(`[Voice message${durationTag}] ${vt.text}`);
    }
  }

  // 附件类型标签（媒体路径由 buildDynamicCtx 提供，这里只提示「带了什么」）
  const attachmentTags = buildAttachmentTags(msg.attachments);
  if (attachmentTags) {
    parts.push(attachmentTags);
  }

  return parts.join('\n');
}

/**
 * Layer 2: 引用消息块
 */
function buildQuotePart(quote?: ResolvedQuote): string {
  if (!quote?.text && !quote?.entry?.content) return '';

  const quoteText = quote.text || quote.entry?.content || 'Original content unavailable';

  return `[Quoted message begins]\n${quoteText}\n[Quoted message ends]\n[Current message]\n`;
}

/**
 * Layer 3: 带发送者标签的用户消息
 */
function buildUserMessage(
  userContent: string,
  quotePart: string,
  senderId: string,
  senderName: string | undefined,
  isGroup: boolean,
  wasMentioned: boolean,
): string {
  if (!isGroup) {
    return `${quotePart}${userContent}`;
  }

  const mentionTag = wasMentioned ? ' (@you)' : '';
  const displayName = senderName ?? shortSenderId(senderId);
  const senderTag = `[${displayName} (${senderId})]`;
  return `${quotePart}${senderTag} ${userContent}${mentionTag}`;
}

/**
 * Layer 4: 媒体元数据上下文（图片/视频/文件本地路径 + 语音 ASR + 引用附件）
 */
function buildDynamicCtx(msg: ProcessedMessage, state: MiddlewareState): string {
  const lines: string[] = [];

  if (msg.attachments && msg.attachments.length > 0) {
    const downloadedByFilename = new Map((state.downloadedFiles ?? []).map(d => [d.filename, d]));
    const voices: RawAttachment[] = [];

    // 一次遍历归类 + 生成媒体行
    for (const att of msg.attachments) {
      const kind = classifyContentType(att.content_type);
      if (kind === 'voice') {
        voices.push(att);
        continue;
      }
      const d = downloadedByFilename.get(att.filename);
      lines.push(`- ${renderMediaLine(kind, att.filename, d?.localPath, att.url, att.size)}`);
    }

    // 语音：有 ASR 文本才带文本，否则只带链接（纯文本模型无法消费音频）
    if (voices.length > 0) {
      const asrTexts = voices.map(a => a.asr_refer_text).filter(Boolean);
      if (asrTexts.length > 0) {
        lines.push(`- ASR: ${asrTexts.join(' | ')}`);
      } else {
        const urls = voices.map(a => a.url).filter(Boolean);
        if (urls.length > 0) lines.push(`- Voice: ${urls.join(', ')}`);
      }
    }
  }

  // 引用消息的附件（独立于当前消息媒体，不受上一步为空影响）
  const quoteAttachments = state.quote?.attachments;
  if (quoteAttachments && quoteAttachments.length > 0) {
    const downloadedQuote = new Map((state.downloadedQuoteFiles ?? []).map(d => [d.filename, d]));
    lines.push('[Reference attachments]');
    for (const qa of quoteAttachments) {
      const kind = classifyContentType(qa.contentType);
      const d = downloadedQuote.get(qa.filename ?? '');
      if (kind === 'voice') {
        if (qa.asrText) lines.push(`  - Voice: ${qa.asrText}`);
        continue;
      }
      lines.push(`  - ${renderMediaLine(kind, qa.filename, d?.localPath, qa.url, undefined)}`);
    }
  }

  return lines.length > 0 ? lines.join('\n') + '\n\n' : '';
}

/**
 * 渲染单个媒体附件（image/video/file）的上下文行内容，不含列表前缀。
 * 当前消息与引用消息共用，保证附件格式统一。语音不在此处理（见 buildDynamicCtx）。
 */
function renderMediaLine(
  kind: Exclude<MediaKind, 'voice'>,
  filename: string | undefined,
  localPath: string | undefined,
  url: string | undefined,
  size: number | undefined,
): string {
  switch (kind) {
    case 'image':
      return localPath
        ? `Image: ${localPath}`
        : `Image: ${url ?? filename ?? 'image'}`;
    case 'video':
      return localPath
        ? `Video: ${localPath}`
        : `Video: ${filename ?? 'video'} (download failed)`;
    case 'file':
      return localPath
        ? `File: ${localPath}`
        : `File: ${filename ?? 'file'} (${formatFileSize(size ?? 0)})`;
  }
}

/**
 * Layer 5: 最终 agentBody 拼合
 */
export function buildAgentBody(
  base: string,
  history: HistoryEntry[] | undefined,
  isGroup: boolean,
  wasMentioned: boolean,
  historyImages: readonly HistoryImage[] = [],
): string {
  if (!isGroup || !wasMentioned || !history || history.length === 0) {
    return base;
  }

  const imagesByMessage = new Map<string, HistoryImage[]>();
  for (const image of historyImages) {
    const list = imagesByMessage.get(image.messageId) ?? [];
    list.push(image);
    imagesByMessage.set(image.messageId, list);
  }

  const historyLines = history.map(h => {
    const name = h.senderName ?? shortSenderId(h.senderId);
    const tags = (imagesByMessage.get(h.messageId) ?? []).map(historyImageTag);
    return `[${name} (${h.senderId})] ${[h.content, ...tags].filter(Boolean).join(' ')}`;
  });

  const imageNote = historyImages.length > 0
    ? ['[图片#n] 是历史消息里的图片。消息末尾附了「[历史图片#n]」的可以直接看；'
      + '其余的用 qqbot_describe_image 传路径/URL 查看（URL 可能已过期）。']
    : [];

  return [
    '[Chat history begins]',
    ...historyLines,
    '',
    '[Chat history ends]',
    ...imageNote,
    '[Current message]',
    base,
  ].join('\n');
}

// ══════════════════════════════════════════════════════════════
// 辅助函数
// ══════════════════════════════════════════════════════════════

interface VoiceText {
  text: string;
  duration?: number;
  source: 'stt' | 'asr' | 'fallback';
}

function extractVoiceTexts(
  attachments?: RawAttachment[],
  processed?: ProcessedAttachment[],
  _logger?: Logger,
): VoiceText[] {
  const results: VoiceText[] = [];

  if (processed) {
    for (const pa of processed) {
      if (pa.type === 'voice' && pa.voiceText) {
        results.push({
          text: pa.voiceText,
          duration: pa.duration,
          source: pa.voiceSource ?? 'stt',
        });
      }
    }
  }

  if (results.length === 0 && attachments) {
    for (const att of attachments) {
      if (isVoiceContentType(att.content_type) && att.asr_refer_text) {
        results.push({
          text: att.asr_refer_text.trim(),
          source: 'asr',
        });
      }
    }
  }

  return results;
}

/**
 * 附件类型标签（Layer 1 用户消息主体里的轻量提示）。
 * 只标注「带了什么类型的附件」，去重；媒体本地路径在 buildDynamicCtx 提供。
 */
function buildAttachmentTags(attachments?: RawAttachment[]): string {
  if (!attachments || attachments.length === 0) return '';

  const labels: Record<string, string> = {
    image: '[图片]',
    video: '[视频]',
    file: '[文件]',
  };

  const seen = new Set<string>();
  const tags: string[] = [];

  for (const att of attachments) {
    const kind = classifyContentType(att.content_type);
    if (kind === 'voice' || seen.has(kind)) continue;
    seen.add(kind);
    const label = labels[kind];
    if (label) tags.push(label);
  }

  return tags.join(' ');
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** 发送者短标识长度（openid 前 N 位，无昵称时兜底） */
const SENDER_SHORT_ID_LEN = 8;

/** 无昵称时用 openid 前 N 位作为匿名标识 */
function shortSenderId(senderId: string): string {
  return senderId.slice(0, SENDER_SHORT_ID_LEN);
}
