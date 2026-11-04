/**
 * 内置 qqbot_speak 工具 — 让 bot 用自己的声音说一句话。
 *
 * 为什么放在插件里而不是让模型自己跑命令：受限沙箱里联网要人审批，
 * 每开一次口就弹一次确认太出戏；宿主进程内的插件不受文件沙箱约束，
 * 合成一次 mp3 再走 sendVoice 就跟发图一样直接。
 *
 * QQ 语音不支持 caption，后续文字由出站队列留出间隔后独立发送。
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import type { Context } from '@deepseek-ai/cordis';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { ImQQBotConfig, SpeakConfig } from '../config.ts';
import type { DshAgent, SessionManager } from '../session/index.ts';
import type { Logger, ReplyTarget } from '../types.ts';
import { resolveTmpDir } from './tmp-dir.ts';
import { withFreshReplyTarget } from './send-file-tool.ts';
import { VOICE_REPLY_REMINDER, VOICE_REPLY_TOOL_HINT } from './voice-reply.ts';

const execFileAsync = promisify(execFile);

/** 工具名（qqbot 前缀避免与其他通道的同名工具冲突） */
export const SPEAK_TOOL_NAME = 'qqbot_speak';

const DESCRIPTION =
  'Speak one short line out loud as a QQ voice message, using the configured TTS voice. '
  + 'Use it sparingly for a quick aside, a joke, or when the user would rather listen than read. '
  + 'Do NOT use it for code, commands, links, error messages, long explanations, or anything the user may need to copy. '
  + 'For a non-Chinese line, set `lang` (ja/en) so the local voice reads it in that language instead of Chinese phonemes. '
  + VOICE_REPLY_TOOL_HINT;

/** 常用音色（只是提示，允许传任意 edge-tts 音色名） */
const VOICE_HINTS = [
  'zh-CN-XiaoyiNeural（少女音，默认）',
  'zh-CN-XiaoxiaoNeural（通用女声）',
  'zh-CN-XiaomoNeural（偏温柔）',
  'zh-CN-XiaoshuangNeural（更幼）',
  'zh-CN-YunxiNeural（男声）',
].join('、');

interface VoiceSenderLike {
  sendVoice(target: ReplyTarget, source: { localPath?: string }): Promise<{ upload: { file_uuid: string }; message?: { id?: string } }>;
}

interface ToolsRegistryLike {
  register(definition: unknown): unknown;
}

interface SpeakArgs {
  text: string;
  voice?: string;
  rate?: string;
  target?: string;
  lang?: string;
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

/**
 * 把回复文本洗成适合朗读的样子。
 *
 * 代码块整段丢掉（念出来是噪音），链接换成「链接」两个字，
 * markdown 符号和多余换行也一并抹平——这些在耳朵里全是杂音。
 */
export function toSpeechText(raw: string): string {
  let text = raw;
  text = text.replace(/```[\s\S]*?```/g, ' ');
  text = text.replace(/`([^`]*)`/g, '$1');
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  text = text.replace(/https?:\/\/\S+/g, '链接');
  text = text.replace(/[*_~#>|]+/g, ' ');
  text = text.replace(/[ \t]*\n+[ \t]*/g, '，');
  text = text.replace(/[ \t]{2,}/g, ' ');
  return text.trim();
}

/** edge-tts 的候选调用方式：配置优先，否则按 edge-tts → python -m → py -m 依次试探 */
function resolveAttempts(config: SpeakConfig): { bin: string; prefix: string[] }[] {
  const configured = (config.command ?? '').trim();
  if (configured !== '') return [{ bin: configured, prefix: [] }];
  return [
    { bin: 'edge-tts', prefix: [] },
    { bin: 'python', prefix: ['-m', 'edge_tts'] },
    { bin: 'py', prefix: ['-m', 'edge_tts'] },
  ];
}

/** 合成一次 mp3；返回生成的文件路径 */
async function synthesize(
  config: SpeakConfig,
  text: string,
  voice: string,
  rate: string,
  outPath: string,
  logger: Logger,
): Promise<void> {
  const attempts = resolveAttempts(config);
  const errors: string[] = [];

  for (const attempt of attempts) {
    const args = [
      ...attempt.prefix,
      '--voice', voice,
      ...(rate.trim() !== '' ? ['--rate', rate.trim()] : []),
      '--text', text,
      '--write-media', outPath,
    ];
    try {
      await execFileAsync(attempt.bin, args, {
        timeout: 60_000,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
      });
      if (!existsSync(outPath)) throw new Error('合成结束但没有产出文件');
      return;
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { stderr?: string };
      const reason = e.code === 'ENOENT'
        ? '命令不存在'
        : (e.stderr?.trim() || e.message || String(err));
      errors.push(`${attempt.bin}: ${reason}`);
      logger.warn(`im-qqbot: qqbot_speak 尝试 ${attempt.bin} 失败: ${reason}`);
    }
  }

  throw new Error(
    'qqbot_speak: 语音合成失败，没找到可用的 edge-tts。'
    + `已尝试 -> ${errors.join(' | ')}。`
    + '可用 config.speak.command 指定可执行文件，或先 pip install edge-tts。',
  );
}

/**
 * 走本地 GPT-SoVITS 服务（推荐路径）。
 *
 * 服务那边常驻着模型，返回 32k 的 wav；QQ 语音要 mp3，所以这里顺手用 ffmpeg 转一道。
 * 任何一步失败都抛出去，由调用方退回 edge-tts——宁可声音换人，也不要没声音。
 */
async function synthesizeLocal(
  config: SpeakConfig,
  text: string,
  outPath: string,
  lang?: string,
): Promise<void> {
  const base = config.gsvUrl.trim().replace(/\/+$/, '');
  const res = await fetch(`${base}/tts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // lang 决定服务用哪套音素；不传时服务默认按中文处理
    body: JSON.stringify(lang === undefined ? { text, speed: config.gsvSpeed } : { text, speed: config.gsvSpeed, lang }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) {
    throw new Error(`本地语音服务返回 ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const audio = Buffer.from(await res.arrayBuffer());
  if (audio.length < 1024) throw new Error('本地语音服务返回的音频过小');
  const wavPath = outPath.replace(/\.mp3$/, '.wav');
  await writeFile(wavPath, audio);
  try {
    await execFileAsync(
      'ffmpeg',
      ['-hide_banner', '-loglevel', 'error', '-y', '-i', wavPath, '-codec:a', 'libmp3lame', '-q:a', '4', outPath],
      { timeout: 120_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
    );
  } finally {
    await rm(wavPath, { force: true });
  }
  if (!existsSync(outPath)) throw new Error('转 mp3 没有产出文件');
}

/** 注册 qqbot_speak 工具（tools 服务缺失时优雅降级，不阻断插件启动） */
export function registerSpeakTool(
  ctx: Context,
  bot: VoiceSenderLike,
  manager: SessionManager,
  config: ImQQBotConfig,
  logger: Logger,
): void {
  const tools = ctx.get('tools') as ToolsRegistryLike | undefined;
  if (!tools?.register) {
    logger.warn('im-qqbot: tools 服务不可用，qqbot_speak 工具未注册');
    return;
  }

  const speak = config.speak;
  const outDir = join(resolveTmpDir(config), 'voice');

  const definition = {
    name: SPEAK_TOOL_NAME,
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: `Exactly what to say out loud (plain text; markdown and code blocks are stripped). Keep it under ${speak.maxChars} characters.`,
        },
        voice: {
          type: 'string',
          description: `Optional edge-tts voice name (ignored when a local voice service is configured). Defaults to config.speak.voice. Common ones: ${VOICE_HINTS}`,
        },
        rate: {
          type: 'string',
          description: 'Optional speech-rate delta such as "+10%" or "-5%". Defaults to config.speak.rate.',
        },
        lang: {
          type: 'string',
          enum: ['zh', 'ja', 'en'],
          description: 'Language tag for the local voice service (default zh). Pass ja for Japanese lines: '
            + 'without it the model reads kana/kanji with Chinese phonemes. Ignored when falling back to edge-tts.',
        },
        target: {
          type: 'string',
          description: 'Optional send target as "c2c:openid" or "group:openid". Omit to speak into the current conversation.',
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          voice: { type: 'string' },
          backend: { type: 'string' },
          chars: { type: 'integer' },
          fileSize: { type: 'integer' },
          target: { type: 'string' },
          fileUuid: { type: 'string' },
          messageId: { type: 'string' },
        },
        required: ['voice', 'chars', 'fileSize', 'target', 'fileUuid'],
        additionalProperties: false,
      },
      render: (_args: unknown, value: unknown): ContentBlock[] => {
        const v = value as { voice: string; backend?: string; chars: number; target: string };
        const engine = v.backend === 'local' ? '本地嗓子' : 'edge-tts';
        return [{
          type: 'text',
          text: `已发送语音（${v.chars} 字，${engine}${v.backend === 'local' ? '' : `，${v.voice}`}）→ ${v.target}。`
            + VOICE_REPLY_REMINDER,
        }];
      },
    },
    async execute(args: unknown, exec: { signal: AbortSignal; agent?: unknown }): Promise<Record<string, unknown>> {
      const { text, voice, rate, target, lang } = args as SpeakArgs;
      if (typeof text !== 'string' || text.trim().length === 0) {
        throw new Error('qqbot_speak: `text` 不能为空');
      }

      const spoken = toSpeechText(text);
      if (spoken.length === 0) {
        throw new Error('qqbot_speak: 洗掉代码块和链接后没有可朗读的内容');
      }
      if (spoken.length > speak.maxChars) {
        throw new Error(
          `qqbot_speak: 文本 ${spoken.length} 字超过上限 ${speak.maxChars} 字（QQ 语音最长约 60 秒），请精简后再念`,
        );
      }

      // 1. 解析发送目标：显式 target > 当前会话
      let replyTarget: ReplyTarget | undefined;
      if (target !== undefined && target !== '') {
        replyTarget = parseTarget(target);
        if (replyTarget === undefined) {
          throw new Error(`qqbot_speak: target 格式错误，需要 c2c:openid 或 group:openid，收到: ${target}`);
        }
      } else if (exec.agent !== undefined) {
        replyTarget = manager.findByAgent(exec.agent as DshAgent)?.replyTarget;
      }
      if (replyTarget === undefined) {
        throw new Error('qqbot_speak: 无法确定发送目标，请显式传 target 参数');
      }
      replyTarget = withFreshReplyTarget(replyTarget);

      // 2. 合成：配了本地服务就先用它，挂了再退回 edge-tts
      const useVoice = (typeof voice === 'string' && voice.trim() !== '') ? voice.trim() : speak.voice;
      const useRate = typeof rate === 'string' ? rate : speak.rate;
      await mkdir(outDir, { recursive: true });
      const outPath = join(outDir, `say-${randomUUID()}.mp3`);
      let backend = 'edge-tts';
      let voiceLabel = useVoice;
      if (speak.gsvUrl.trim() !== '') {
        try {
          await synthesizeLocal(speak, spoken, outPath, typeof lang === 'string' ? lang : undefined);
          backend = 'local';
          voiceLabel = '本地嗓子';
        } catch (err) {
          logger.warn(`im-qqbot: qqbot_speak 本地语音服务不可用，退回 edge-tts: ${(err as Error).message}`);
        }
      }
      if (backend !== 'local') await synthesize(speak, spoken, useVoice, useRate, outPath, logger);
      const info = await stat(outPath);

      // 3. 发送
      const result = await bot.sendVoice(replyTarget, { localPath: outPath });
      logger.info(
        `im-qqbot: qqbot_speak 合成并发送 ${spoken.length} 字（${voiceLabel}/${backend}`
        + `${typeof lang === 'string' ? `/${lang}` : ''}，${info.size} bytes）`
        + ` → ${replyTarget.scope}:${replyTarget.targetId}`,
      );

      return {
        voice: voiceLabel,
        backend,
        chars: spoken.length,
        fileSize: info.size,
        target: `${replyTarget.scope}:${replyTarget.targetId}`,
        fileUuid: result.upload.file_uuid,
        ...(result.message?.id !== undefined ? { messageId: result.message.id } : {}),
      };
    },
  };

  tools.register(definition);
  logger.info(`im-qqbot: qqbot_speak 工具已注册（音色 ${speak.voice}）`);
}
