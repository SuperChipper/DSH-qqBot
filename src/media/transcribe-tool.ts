/**
 * qqbot_transcribe — 把音频/视频里的人声转成带时间轴的文字。
 *
 * 为什么不用本机 whisper：那套服务在 Windows 上常挂（2026-11-05 实测 127.0.0.1:8080 拒连），
 * 而 OpenCode 订阅里的 mimo-v2.6-flash 直接吃音频、自带说话人分离和时间轴。
 *
 * 端点 / 模型 / 凭证解析都在 `chat-gateway.ts`（asr 和视频理解共用同一套），
 * 这里只管「本地切片 + 拼时间轴」：长音频按 10 分钟切，转完再合并。
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Context } from '@deepseek-ai/cordis';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import { chatEndpointFromEnv, setChatKeyResolver, transcribeViaChat } from './chat-gateway.ts';
import type { Logger } from '../types.ts';

const run = promisify(execFile);

export const TRANSCRIBE_TOOL_NAME = 'qqbot_transcribe';

const DESCRIPTION =
  'Transcribe speech from a local audio or video file into timestamped text (speaker-labelled). '
  + 'Use it when you must know what was SAID: voice notes, video dialogue, meeting clips. '
  + 'It runs ffmpeg locally to extract audio, then a multimodal model that accepts audio input. '
  + 'Returns segments like "12.50-18.20 | SPEAKER_01: ...". Read-only, no uploads beyond the model call.';

/** 单次请求的音频上限；mp3 48kbps 下约 20 分钟，超了就切片 */
const MAX_CHUNK_BYTES = 8 * 1024 * 1024;
const CHUNK_SECONDS = 600;
const MAX_FILE_BYTES = 500 * 1024 * 1024;

interface ToolsRegistryLike {
  register(definition: unknown): unknown;
}

interface CredentialsLike {
  resolve(ref: string): Promise<{ value: string } | undefined>;
}

interface TranscribeArgs {
  file: string;
  prompt?: string;
  language?: string;
}

interface TranscribeOutput {
  text: string;
  segments: number;
  chunks: number;
  model: string;
  message: string;
}

async function ffmpeg(args: string[], ffmpegPath: string): Promise<void> {
  await run(ffmpegPath, args, { maxBuffer: 8 * 1024 * 1024, windowsHide: true });
}

async function probeDuration(file: string, ffprobePath: string): Promise<number> {
  try {
    const { stdout } = await run(ffprobePath, [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file,
    ], { windowsHide: true });
    const n = Number.parseFloat(stdout.trim());
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

export function registerTranscribeTool(ctx: Context, logger: Logger): void {
  const tools = ctx.get('tools') as ToolsRegistryLike | undefined;
  if (!tools?.register) {
    logger.warn('im-qqbot: tools 服务不可用，qqbot_transcribe 工具未注册');
    return;
  }

  const endpoint = chatEndpointFromEnv();
  const { model } = endpoint;
  const ffmpegPath = process.env.QQBOT_FFMPEG ?? 'ffmpeg';
  const ffprobePath = process.env.QQBOT_FFPROBE ?? 'ffprobe';

  // asr.ts 是纯模块、拿不到 ctx，凭证解析从这里注入一次，语音消息和视频音轨共用
  const credentials = ctx.get('credentials') as CredentialsLike | undefined;
  setChatKeyResolver(async (ref) => (await credentials?.resolve(ref))?.value);


  tools.register({
    name: TRANSCRIBE_TOOL_NAME,
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Absolute path to a local audio or video file.' },
        prompt: { type: 'string', description: 'Optional instruction, e.g. "只转写中文，不要翻译".' },
        language: { type: 'string', description: 'Optional language hint, e.g. "ja" or "中文".' },
      },
      required: ['file'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          segments: { type: 'integer' },
          chunks: { type: 'integer' },
          model: { type: 'string' },
          message: { type: 'string' },
        },
        required: ['text', 'segments', 'chunks', 'model', 'message'],
        additionalProperties: false,
      },
      render: (_args: unknown, value: unknown): ContentBlock[] => {
        const v = value as TranscribeOutput;
        return [{ type: 'text', text: v.message }];
      },
    },
    async execute(args: unknown): Promise<TranscribeOutput> {
      const { file, prompt, language } = (args ?? {}) as TranscribeArgs;
      if (typeof file !== 'string' || file.trim() === '') throw new Error('qqbot_transcribe: `file` 不能为空');
      const path = file.trim();
      if (!existsSync(path)) throw new Error(`qqbot_transcribe: 文件不存在 ${path}`);
      const size = statSync(path).size;
      if (size > MAX_FILE_BYTES) throw new Error(`qqbot_transcribe: 文件过大 ${(size / 1e6).toFixed(0)}MB`);

      const work = mkdtempSync(join(tmpdir(), 'transcribe-'));
      const instruction = prompt?.trim();
      try {
        const duration = await probeDuration(path, ffprobePath);
        const parts: string[] = [];
        let chunks = 0;
        for (let start = 0; ; start += CHUNK_SECONDS) {
          const out = join(work, `chunk${chunks}.mp3`);
          // 48kbps 单声道：10 分钟约 3.6MB，稳在 8MB 上限内
          await ffmpeg([
            '-y', '-loglevel', 'error', '-ss', String(start), '-t', String(CHUNK_SECONDS),
            '-i', path, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '48k', out,
          ], ffmpegPath);
          if (!existsSync(out) || statSync(out).size < 1024) break;
          if (statSync(out).size > MAX_CHUNK_BYTES) throw new Error('qqbot_transcribe: 音频块超过上限');
          const text = await transcribeViaChat(readFileSync(out), 'mp3', { prompt: instruction, language, endpoint, logger });
          parts.push(duration > CHUNK_SECONDS ? `【${Math.floor(start / 60)}分${start % 60}秒起】\n${text}` : text);
          chunks += 1;
          if (duration <= (start + CHUNK_SECONDS) || duration === 0) break;
        }
        if (parts.length === 0) throw new Error('qqbot_transcribe: 没抽出音轨（可能是无声视频）');
        const text = parts.join('\n\n');
        const segments = text.split('\n').filter((line) => /\d+\.\d+\s*-\s*\d+\.\d+/.test(line)).length;
        logger.info(`im-qqbot: qqbot_transcribe ${path} → ${chunks} 块 / ${text.length} 字`);
        return { text, segments, chunks, model, message: text };
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    },
  });

  logger.info(`im-qqbot: qqbot_transcribe 工具已注册 (${model})`);
}
