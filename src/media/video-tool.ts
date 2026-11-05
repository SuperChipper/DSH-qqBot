/**
 * 内置 qqbot_describe_video 视频理解工具（路线：抽帧宫格 + 视觉模型 + 音轨 ASR）。
 *
 *   1. ffprobe 取时长 / 是否有音轨
 *   2. ffmpeg 在前 maxSeconds 秒内均匀抽 N 帧，tile 拼成一张宫格 JPEG → 一次视觉调用
 *   3. 有音轨且 asr 已启用：抽 16k 单声道 WAV → `requestTranscription`
 *      （默认 chat 协议走订阅网关，见 asr.ts / chat-gateway.ts）
 *   4. 合成「画面 + 语音」文本返回给主模型
 *
 * 临时文件放系统 tmp 目录，调用结束即删。ffmpeg 不可用时工具不注册。
 */
import { execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { promisify } from 'node:util';
import type { Context } from '@deepseek-ai/cordis';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { AsrConfig, VideoConfig, VisionConfig } from '../config.ts';
import type { Logger } from '../types.ts';
import { ASR_OFFLINE_HINT, AsrOfflineError, requestTranscription } from './asr.ts';
import { describeVideoViaChat, videoEndpointFromEnv } from './chat-gateway.ts';
import { callVision, type AttachmentStoreLike, type LlmRuntimeLike } from './vision-tool.ts';

const execFileAsync = promisify(execFile);

/** tools 服务最小接口 */
interface ToolsRegistryLike {
  register(definition: unknown): unknown;
}

/** qqbot_describe_video 的合法参数 */
interface DescribeVideoArgs {
  video: string;
  prompt?: string;
}

export const DESCRIBE_VIDEO_TOOL_NAME = 'qqbot_describe_video';

const DESCRIPTION =
  'Understand one video and return a text summary of what is seen and said. The video is a local '
  + 'absolute path (downloaded by the QQ bot). Frames are sampled evenly and read by a vision model; '
  + 'the audio track is transcribed when speech recognition is configured. Use this when the user '
  + 'sends or references a video. Pass a precise `prompt` when the user asks something specific '
  + '(e.g. "what game is this", "read the on-screen text"). The result is raw material for your own '
  + 'reply: answer what the user actually wanted (a reaction, a summary, or a specific answer) instead '
  + 'of relaying the description.';

const DEFAULT_PROMPT = 'Describe what happens in the video: scenes, people, actions and any on-screen text.';

/** 整段直传上限：base64 后约 ×4/3，网关请求体一般 25MB 封顶 */
const DIRECT_MAX_BYTES = 15 * 1024 * 1024;
/** 压缩后的目标高度：1080p 长片靠它把体积压下来 */
const COMPRESS_HEIGHT = 480;
/** 音轨只转前这么多秒（48kbps mp3 下 40 分钟约 14MB，仍在单次请求上限内） */
const AUDIO_MAX_SECONDS = 2400;

/** 每帧缩放宽度（宫格最多 4 列 → 1920px 宽） */
const FRAME_WIDTH = 480;
/** 宫格最多列数 */
const MAX_COLUMNS = 4;
/** ffmpeg 单次调用超时 */
const FFMPEG_TIMEOUT_MS = 120_000;

/** ffmpeg / ffprobe 可执行文件 */
export interface FfmpegBins {
  ffmpeg: string;
  ffprobe: string;
}

/** 解析 ffmpeg 路径：配置为空用 PATH；配置了则 ffprobe 取同目录 */
export function resolveFfmpegBins(ffmpegPath: string): FfmpegBins {
  if (!ffmpegPath) return { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' };
  const ext = extname(ffmpegPath);
  return { ffmpeg: ffmpegPath, ffprobe: join(dirname(ffmpegPath), `ffprobe${ext}`) };
}

/** 抽帧计划 */
export interface FramePlan {
  /** 实际分析时长（秒） */
  span: number;
  count: number;
  cols: number;
  rows: number;
  /** 每帧大致时间点（秒） */
  times: number[];
}

/** 按时长规划抽帧：约每 2 秒一帧，最多 maxFrames，只看前 maxSeconds 秒 */
export function planFrames(duration: number, maxFrames: number, maxSeconds: number): FramePlan {
  const span = Math.max(0.1, Math.min(duration, maxSeconds));
  const count = Math.max(1, Math.min(maxFrames, Math.ceil(span / 2)));
  const cols = Math.min(MAX_COLUMNS, count);
  const rows = Math.ceil(count / cols);
  const times = Array.from({ length: count }, (_, k) => Math.round((k * span / count) * 10) / 10);
  return { span, count, cols, rows, times };
}

/** winget 装的 ffmpeg 常常不在 PATH 里（Gyan.FFmpeg 只解压到 Packages 目录，不建 Links）：按固定布局找 */
export function findWingetFfmpeg(localAppData: string | undefined = process.env.LOCALAPPDATA): string | undefined {
  if (!localAppData) return undefined;
  const winget = join(localAppData, 'Microsoft', 'WinGet');
  const link = join(winget, 'Links', 'ffmpeg.exe');
  if (existsSync(link)) return link;
  const packages = join(winget, 'Packages');
  const found: string[] = [];
  for (const pkg of safeReaddir(packages).filter(name => /ffmpeg/i.test(name))) {
    for (const build of safeReaddir(join(packages, pkg))) {
      const exe = join(packages, pkg, build, 'bin', 'ffmpeg.exe');
      if (existsSync(exe)) found.push(exe);
    }
  }
  // 版本目录名带版本号，排序后取最后一个，多半是最新装的
  return found.sort().at(-1);
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** 找一个能跑的 ffmpeg：配置了只认配置；没配先试 PATH，再试 winget 安装目录 */
export async function locateFfmpeg(ffmpegPath: string): Promise<FfmpegBins | undefined> {
  const candidates = ffmpegPath ? [ffmpegPath] : ['', findWingetFfmpeg()].filter((p): p is string => p !== undefined);
  for (const candidate of candidates) {
    const bins = resolveFfmpegBins(candidate);
    try {
      await execFileAsync(bins.ffmpeg, ['-version'], { timeout: 10_000 });
      await execFileAsync(bins.ffprobe, ['-version'], { timeout: 10_000 });
      return bins;
    } catch {
      // 试下一个
    }
  }
  return undefined;
}

/** ffprobe：时长与是否有音轨 */
export async function probeVideo(bins: FfmpegBins, path: string): Promise<{ duration: number; hasAudio: boolean }> {
  const { stdout } = await execFileAsync(
    bins.ffprobe,
    ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', path],
    { timeout: FFMPEG_TIMEOUT_MS },
  );
  const json = JSON.parse(stdout) as { format?: { duration?: string }; streams?: Array<{ codec_type?: string }> };
  const duration = Number(json.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('qqbot_describe_video: cannot read video duration');
  const hasAudio = (json.streams ?? []).some(s => s.codec_type === 'audio');
  return { duration, hasAudio };
}

/** 均匀抽帧并拼成一张宫格 JPEG */
async function extractFrameGrid(bins: FfmpegBins, path: string, plan: FramePlan, out: string): Promise<void> {
  const filter = `fps=${plan.count}/${plan.span},scale=${FRAME_WIDTH}:-2,tile=${plan.cols}x${plan.rows}`;
  await execFileAsync(
    bins.ffmpeg,
    ['-v', 'error', '-y', '-t', String(plan.span), '-i', path, '-vf', filter, '-frames:v', '1', '-q:v', '3', out],
    { timeout: FFMPEG_TIMEOUT_MS },
  );
}

/** 抽音轨为 16k 单声道 mp3（48kbps；比 wav 小 5 倍，长片也塞得进单次请求） */
async function extractAudioMp3(bins: FfmpegBins, path: string, out: string): Promise<void> {
  await execFileAsync(
    bins.ffmpeg,
    ['-v', 'error', '-y', '-i', path, '-vn', '-ac', '1', '-ar', '16000',
      '-b:a', '48k', '-t', String(AUDIO_MAX_SECONDS), '-f', 'mp3', out],
    { timeout: FFMPEG_TIMEOUT_MS },
  );
}

/** 压成适合整段直传的 mp4：最长边 480p / crf 30 / 64k aac */
async function compressVideo(bins: FfmpegBins, path: string, out: string): Promise<void> {
  await execFileAsync(
    bins.ffmpeg,
    ['-v', 'error', '-y', '-i', path,
      '-vf', `scale=-2:min(${COMPRESS_HEIGHT}\\,ih)`,
      '-c:v', 'libx264', '-crf', '30', '-preset', 'veryfast',
      '-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart',
      out],
    { timeout: 600_000 },
  );
}

/** 给视觉模型的说明：宫格布局 + 每帧时间点 */
export function buildFramePrompt(plan: FramePlan, duration: number, prompt: string): string {
  const times = plan.times.map(t => `${t}s`).join(', ');
  return `This image is a ${plan.cols}x${plan.rows} grid of ${plan.count} frames sampled evenly from a `
    + `${Math.round(duration * 10) / 10}s video, in chronological order left-to-right, top-to-bottom `
    + `(at about ${times}). Treat them as one continuous video, not separate pictures.\n\n${prompt}`;
}

/** 合成返回给主模型的文本 */
export function composeVideoText(visual: string, transcript: string | undefined, note: string | undefined): string {
  const parts = [`[Visual] ${visual}`];
  if (transcript) parts.push(`[Speech] ${transcript}`);
  else if (note) parts.push(`[Speech] (${note})`);
  return parts.join('\n');
}

/** 注册 qqbot_describe_video（vision 未配置 / ffmpeg 不可用时跳过，不阻断启动） */
export async function registerDescribeVideoTool(
  ctx: Context,
  video: VideoConfig,
  vision: VisionConfig,
  asr: AsrConfig,
  logger: Logger,
): Promise<void> {
  if (!video.enabled) return;
  if (!vision.enabled || !vision.provider || !vision.model) {
    logger.debug('im-qqbot: vision 未配置，qqbot_describe_video 工具未注册');
    return;
  }

  const tools = ctx.get('tools') as ToolsRegistryLike | undefined;
  const llm = ctx.get('llm') as LlmRuntimeLike | undefined;
  const attachments = ctx.get('attachments') as AttachmentStoreLike | undefined;
  if (!tools?.register || !llm?.stream || !attachments?.saveImage) {
    logger.warn('im-qqbot: tools/llm/attachments 服务不可用，qqbot_describe_video 工具未注册');
    return;
  }

  const bins = resolveFfmpegBins(video.ffmpegPath);
  try {
    await execFileAsync(bins.ffmpeg, ['-version'], { timeout: 10_000 });
    await execFileAsync(bins.ffprobe, ['-version'], { timeout: 10_000 });
  } catch {
    logger.warn(`im-qqbot: 找不到 ffmpeg/ffprobe（${bins.ffmpeg}），qqbot_describe_video 工具未注册`);
    return;
  }

  const definition = {
    name: DESCRIBE_VIDEO_TOOL_NAME,
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        video: {
          type: 'string',
          description: 'Absolute path to a local video file.',
        },
        prompt: {
          type: 'string',
          description: 'Your precise instruction for the vision model about this video.',
        },
      },
      required: ['video'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          model: { type: 'string' },
          video: { type: 'string' },
          duration: { type: 'number' },
          frames: { type: 'integer' },
          mode: { type: 'string', enum: ['video', 'frames'] },
          transcribed: { type: 'boolean' },
        },
        required: ['text', 'model', 'video', 'duration', 'frames', 'transcribed'],
        additionalProperties: false,
      },
      render: (_args: unknown, value: unknown): ContentBlock[] => [
        { type: 'text', text: (value as { text: string }).text },
      ],
    },
    async execute(args: unknown, exec: { signal: AbortSignal }): Promise<Record<string, unknown>> {
      const { video: path, prompt } = args as DescribeVideoArgs;
      if (typeof path !== 'string' || path.length === 0) {
        throw new Error('qqbot_describe_video: `video` must be a non-empty string');
      }
      const info = await stat(path).catch(() => null);
      if (!info?.isFile()) throw new Error(`qqbot_describe_video: video file not found: ${path}`);

      const { duration, hasAudio } = await probeVideo(bins, path);
      const plan = planFrames(duration, video.maxFrames, video.maxSeconds);
      const asked = prompt ?? DEFAULT_PROMPT;
      const work = await mkdtemp(join(tmpdir(), 'qqbot-video-'));
      try {
        // 音轨：整段（不再只取抽帧覆盖的前 N 秒），与画面并行；失败只记一条说明
        const transcriptTask = (async (): Promise<{ text?: string; note?: string }> => {
          if (!hasAudio) return { note: 'no audio track' };
          if (!asr.enabled) return { note: 'speech recognition disabled' };
          try {
            const mp3Path = join(work, 'audio.mp3');
            await extractAudioMp3(bins, path, mp3Path);
            const text = await requestTranscription({ data: await readFile(mp3Path), name: 'audio.mp3' }, asr, logger);
            return text ? { text } : { note: 'no speech detected' };
          } catch (err) {
            logger.warn(`im-qqbot: video audio transcription failed: ${err instanceof Error ? err.message : String(err)}`);
            return { note: err instanceof AsrOfflineError ? ASR_OFFLINE_HINT : 'transcription failed' };
          }
        })();

        // 画面：整段直传优先（模型自己看全片），太大先压一版，压完还超才退回抽帧宫格
        let visual = '';
        let mode: 'video' | 'frames' = 'frames';
        let frames = plan.count;
        let visualModel = vision.model;

        let whole: string | undefined = info.size <= DIRECT_MAX_BYTES ? path : undefined;
        if (whole === undefined) {
          const compressed = join(work, 'compressed.mp4');
          try {
            await compressVideo(bins, path, compressed);
            const compressedSize = (await stat(compressed)).size;
            if (compressedSize <= DIRECT_MAX_BYTES) {
              whole = compressed;
            } else {
              logger.info(`im-qqbot: 压缩后仍 ${(compressedSize / 1e6).toFixed(1)}MB，改用抽帧`);
            }
          } catch (err) {
            logger.warn(`im-qqbot: 视频压缩失败，改用抽帧：${err instanceof Error ? err.message : String(err)}`);
          }
        }

        if (whole !== undefined) {
          try {
            visual = await describeVideoViaChat(
              await readFile(whole),
              `${Math.round(duration * 10) / 10}s video. ${asked}`,
              { logger },
            );
            mode = 'video';
            frames = 0;
            visualModel = videoEndpointFromEnv().model;
          } catch (err) {
            logger.warn(`im-qqbot: 整段视频理解失败，退回抽帧：${err instanceof Error ? err.message : String(err)}`);
            whole = undefined;
          }
        }

        if (whole === undefined) {
          const gridPath = join(work, 'frames.jpg');
          await extractFrameGrid(bins, path, plan, gridPath);
          const grid = new Uint8Array(await readFile(gridPath));
          if (grid.length > vision.maxBytes) throw new Error(`qqbot_describe_video: frame grid too large (${grid.length} bytes)`);
          const ref = await attachments.saveImage({ data: grid, mediaType: 'image/jpeg', name: `${basename(path)}.frames.jpg` });
          visual = await callVision(llm, vision, buildFramePrompt(plan, duration, asked), ref, exec.signal);
        }

        const transcript = await transcriptTask;
        return {
          text: composeVideoText(visual, transcript.text, transcript.note),
          model: visualModel,
          video: path,
          duration,
          frames,
          mode,
          transcribed: Boolean(transcript.text),
        };
      } finally {
        await rm(work, { recursive: true, force: true });
      }
    },
  };

  tools.register(definition);
  logger.info(`im-qqbot: qqbot_describe_video 工具已注册 (ffmpeg=${bins.ffmpeg} frames≤${video.maxFrames})`);
}
