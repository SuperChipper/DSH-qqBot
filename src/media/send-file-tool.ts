/**
 * 内置 qqbot_send_file 工具 — 将本地文件发送给 QQ 用户或群。
 *
 *   - 发送目标默认自动定位（exec.agent → SessionManager.findByAgent → replyTarget），
 *     无需模型手动传 openid；显式 target 参数作为覆盖。
 *   - 按扩展名分发到 SDK 的 sendImage / sendVideo / sendVoice / sendFile。
 *   - 路径白名单：默认只允许访问 media 目录 + agent cwd，可开关 + 扩展白名单。
 */
import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { ImQQBotConfig, SendFileConfig } from '../config.ts';
import type { DshAgent, SessionManager } from '../session/index.ts';
import type { Logger, ReplyTarget } from '../types.ts';
import { MEDIA_ROOT } from './media-cleaner.ts';
import { isSensitivePath } from '../shared/file-access.ts';
import { canonical } from '../shared/tool-guard.ts';
import { replyWindowMs } from '../transport/msgid-cache.ts';
import { isVoiceFile, VOICE_REPLY_REMINDER, VOICE_REPLY_TOOL_HINT } from './voice-reply.ts';

/**
 * 群聊被动回复窗口过期后清掉 msgId，降级为主动推送。
 *
 * 会话里保存的 replyTarget 是上一条入站消息的 msg_id；定时任务或长时间空闲后
 * 该 id 早已超出 QQ 的被动回复窗口，直接发送会收到「回复消息msg_id已过期」。
 */
export function withFreshReplyTarget(target: ReplyTarget): ReplyTarget {
  if (target.scope !== 'group' || target.msgId === undefined) return target;
  const age = target.receivedAt === undefined ? 0 : Date.now() - target.receivedAt;
  return age >= replyWindowMs('group') ? { ...target, msgId: undefined } : target;
}

/** 工具名（qqbot 前缀避免与其他通道的同名工具冲突） */
export const SEND_FILE_TOOL_NAME = 'qqbot_send_file';

const DESCRIPTION =
  'Send a local file (image, video, voice, or generic file) to the QQ user or group '
  + 'of the current conversation. Pass the absolute path of a file that already exists on disk. '
  + 'Use this when the user asks you to deliver a generated file (chart, report, exported data, '
  + 'screenshot, etc.) or to send an existing media/file back to them. '
  + 'For an image/video/file, put the entire short companion reply in `caption`: at most two sentences, '
  + 'no line breaks and no lists. Send any longer explanation as a separate text message. Do not repeat '
  + 'the caption as a separate reply; QQ sends it in the same rich-media message. '
  + 'After a captioned send, an empty final reply is fine: end the turn unless you have something new to say. '
  + 'For audio files sent as voice messages: ' + VOICE_REPLY_TOOL_HINT;

/** 发送器最小接口（QQBot 实例满足） */
interface MediaSendResult {
  upload: { file_uuid: string };
  message?: { id?: string };
}

export interface MediaSenderLike {
  sendImage(target: ReplyTarget, source: { localPath?: string }, opts?: { content?: string }): Promise<MediaSendResult>;
  sendVideo(target: ReplyTarget, source: { localPath?: string }, opts?: { content?: string }): Promise<MediaSendResult>;
  sendVoice(target: ReplyTarget, source: { localPath?: string }): Promise<MediaSendResult>;
  sendFile(
    target: ReplyTarget,
    source: { localPath?: string },
    opts?: { fileName?: string; content?: string },
  ): Promise<MediaSendResult>;
}

/** tools 服务最小接口 */
interface ToolsRegistryLike {
  register(definition: unknown): unknown;
}

/** qqbot_send_file 的合法参数 */
interface SendFileArgs {
  file_path: string;
  target?: string;
  caption?: string;
}

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']);
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.avi', '.mkv', '.webm']);

/**
 * 同一目标、同一文件在这个时间窗内再发一次，判为重复。
 *
 * 常见情形：图先发了一版配文，回头发现漏了出处/画师，又想「补上再发一次」——
 * QQ 里就是两张一样的图并排。窗口只取 20 秒：要真的重发（用户明说再来一张），
 * 等一会儿就正常了，不会被永久拦住。
 */
const RECENT_SEND_TTL_MS = 20_000;
const recentSends = new Map<string, number>();

/** 清掉过期记录后判断这次是不是重复（顺带做一次懒惰清理） */
function isRecentDuplicate(key: string, now: number): boolean {
  for (const [k, at] of recentSends) {
    if (now - at > RECENT_SEND_TTL_MS) recentSends.delete(k);
  }
  const at = recentSends.get(key);
  return at !== undefined && now - at <= RECENT_SEND_TTL_MS;
}

/** 清空去重表（测试用） */
export function resetRecentSends(): void {
  recentSends.clear();
}

/** 解析显式 target（"c2c:openid" / "group:openid"），非法返回 undefined */
function parseTarget(input: string): ReplyTarget | undefined {
  const idx = input.indexOf(':');
  if (idx <= 0) return undefined;
  const scope = input.slice(0, idx);
  const targetId = input.slice(idx + 1);
  if (!targetId || (scope !== 'c2c' && scope !== 'group')) return undefined;
  return { scope, targetId };
}

/** 判断 filePath 是否位于 root 目录内（含 root 本身）；两边都解析符号链接，否则目录里的链接能把外面的文件发出去 */
function isWithinRoot(filePath: string, root: string): boolean {
  const rel = relative(canonical(root), canonical(filePath));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** 路径白名单校验：restrictPaths 关闭时放行任意路径，否则限定 media + cwd + extraRoots */
function isPathAllowed(filePath: string, config: SendFileConfig, cwd: string): boolean {
  if (!config.restrictPaths) return true;
  const roots = [MEDIA_ROOT, cwd, ...config.extraRoots];
  return roots.some((root) => isWithinRoot(filePath, root));
}

/** 注册 qqbot_send_file 工具（tools 服务缺失时优雅降级，不阻断插件启动） */
export function registerSendFileTool(
  ctx: Context,
  bot: MediaSenderLike,
  manager: SessionManager,
  config: ImQQBotConfig,
  logger: Logger,
  /** 发送成功后的回调（搜图工具用它把发出去的候选记为已发） */
  onSent?: (absPath: string) => void,
): void {
  const tools = ctx.get('tools') as ToolsRegistryLike | undefined;
  if (!tools?.register) {
    logger.warn('im-qqbot: tools 服务不可用，qqbot_send_file 工具未注册');
    return;
  }

  const cwd = config.cwd || process.cwd();

  const definition = {
    name: SEND_FILE_TOOL_NAME,
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Absolute path to the local file to send (image/video/voice/generic file).',
        },
        target: {
          type: 'string',
          description: 'Optional send target as "c2c:openid" or "group:openid". Omit to send to the current conversation.',
        },
        caption: {
          type: 'string',
          description: 'Optional short reply for an image/video/generic file in the SAME message: at most two sentences, no line breaks, no lists. Put all companion text here; send longer explanations separately, without repeating the caption. Not supported for voice/audio files; omit caption for them.',
        },
      },
      required: ['file_path'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          fileName: { type: 'string' },
          fileSize: { type: 'integer' },
          target: { type: 'string' },
          fileUuid: { type: 'string' },
          messageId: { type: 'string' },
          deduped: { type: 'boolean' },
        },
        required: ['fileName', 'fileSize', 'target', 'fileUuid'],
        additionalProperties: false,
      },
      render: (args: unknown, value: unknown): ContentBlock[] => {
        const v = value as { fileName: string; target: string; deduped?: boolean };
        const caption = (args as { caption?: unknown } | undefined)?.caption;
        if (v.deduped === true) {
          return [{
            type: 'text',
            text: `没有重复发送 ${v.fileName} → ${v.target}：二十秒内已经发过同一张，`
              + 'QQ 里的消息改不了。要补充说明就发一条文字，不要再发同一张图。',
          }];
        }
        if (isVoiceFile(v.fileName)) {
          return [{
            type: 'text',
            text: `已发送语音 ${v.fileName} → ${v.target}。`
              + (typeof caption === 'string' && caption.trim() ? '本次 caption 未发送（语音不支持）。' : '')
              + VOICE_REPLY_REMINDER,
          }];
        }
        // 这里只报事实。曾经拖一句「caption 已随文件发出，不要再复述…」的提醒，
        // 但它会跟着工具结果一起出现在界面上，像是给用户看的旁白；
        // 「别复述」的规则在【发图配文】里，去重也由 caption-echo 在出站时兜底。
        return [{
          type: 'text',
          text: `已发送 ${v.fileName} → ${v.target}`,
        }];
      },
    },
    async execute(args: unknown, exec: { signal: AbortSignal; agent?: unknown }): Promise<Record<string, unknown>> {
      const { file_path, target, caption } = args as SendFileArgs;
      if (typeof file_path !== 'string' || file_path.length === 0) {
        throw new Error('qqbot_send_file: `file_path` must be a non-empty string');
      }
      const captionText = typeof caption === 'string' && caption.trim().length > 0 ? caption.trim() : undefined;

      // 1. 解析发送目标：显式 target > 当前会话（exec.agent → SessionRecord）
      let replyTarget: ReplyTarget | undefined;
      if (target !== undefined && target !== '') {
        replyTarget = parseTarget(target);
        if (replyTarget === undefined) {
          throw new Error(`qqbot_send_file: target 格式错误，需要 c2c:openid 或 group:openid，收到: ${target}`);
        }
      } else if (exec.agent !== undefined) {
        replyTarget = manager.findByAgent(exec.agent as DshAgent)?.replyTarget;
      }
      if (replyTarget === undefined) {
        throw new Error('qqbot_send_file: 无法确定发送目标，请显式传 target 参数');
      }
      replyTarget = withFreshReplyTarget(replyTarget);

      // 2. 校验文件 + 路径白名单
      const absPath = resolve(file_path);
      if (!isPathAllowed(absPath, config.sendFile, cwd)) {
        throw new Error(`qqbot_send_file: file_path 不在允许的目录内: ${absPath}`);
      }
      if (isSensitivePath(absPath, config) || isSensitivePath(canonical(absPath), config)) {
        throw new Error(`qqbot_send_file: file_path 位于敏感目录，禁止访问: ${absPath}`);
      }
      if (!existsSync(absPath)) {
        throw new Error(`qqbot_send_file: 文件不存在: ${absPath}`);
      }
      const info = await stat(absPath);
      if (!info.isFile()) {
        throw new Error(`qqbot_send_file: 路径不是普通文件: ${absPath}`);
      }

      // 3. 按扩展名分类发送
      const fileName = basename(absPath);
      const ext = absPath.slice(absPath.lastIndexOf('.')).toLowerCase();
      const source = { localPath: absPath };
      const targetLabel = `${replyTarget.scope}:${replyTarget.targetId}`;

      // 20 秒内已经发过同一张：不重复发，只回一条说明（QQ 不能撤回重发）
      const dedupeKey = `${targetLabel}|${absPath}`;
      if (isRecentDuplicate(dedupeKey, Date.now())) {
        logger.info(`im-qqbot: qqbot_send_file 跳过 20 秒内的重复发送 ${fileName}`);
        return {
          fileName,
          fileSize: info.size,
          target: targetLabel,
          fileUuid: 'duplicate-skipped',
          deduped: true,
        };
      }

      let result: MediaSendResult;
      if (IMAGE_EXTS.has(ext)) {
        result = await bot.sendImage(replyTarget, source, captionText !== undefined ? { content: captionText } : undefined);
      } else if (VIDEO_EXTS.has(ext)) {
        result = await bot.sendVideo(replyTarget, source, captionText !== undefined ? { content: captionText } : undefined);
      } else if (isVoiceFile(fileName)) {
        if (captionText !== undefined) {
          logger.warn('im-qqbot: qqbot_send_file 语音消息不支持 caption，已忽略');
        }
        result = await bot.sendVoice(replyTarget, source);
      } else {
        result = await bot.sendFile(replyTarget, source, {
          fileName,
          ...(captionText !== undefined ? { content: captionText } : {}),
        });
      }

      logger.info(
        `im-qqbot: qqbot_send_file 发送 ${fileName} (${info.size} bytes) → ${replyTarget.scope}:${replyTarget.targetId}`
        + (captionText !== undefined ? `，caption ${captionText.length} 字` : ''),
      );
      recentSends.set(dedupeKey, Date.now());
      try {
        onSent?.(absPath);
      } catch (err) {
        logger.warn(`im-qqbot: qqbot_send_file 发送后回调失败: ${err instanceof Error ? err.message : String(err)}`);
      }

      return {
        fileName,
        fileSize: info.size,
        target: `${replyTarget.scope}:${replyTarget.targetId}`,
        fileUuid: result.upload.file_uuid,
        ...(result.message?.id !== undefined ? { messageId: result.message.id } : {}),
      };
    },
  };

  tools.register(definition);
  logger.info('im-qqbot: qqbot_send_file 工具已注册');
}
