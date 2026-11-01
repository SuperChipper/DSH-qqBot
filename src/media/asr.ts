/**
 * 在线语音识别 — 把 QQ 语音转成文本，供纯文本模型理解。
 *
 * 走 OpenAI 兼容的 POST {baseUrl}/audio/transcriptions（multipart: file + model），
 * SiliconFlow / Groq / OpenAI / 自建 whisper 服务均可直接换用；可再配一个备用接口（如本机 whisper 优先、在线兜底）。
 *
 * 音频来源：优先 QQ 网关给的 voice_wav_url（已是 WAV），否则下载 url 的 SILK 并用 silk-wasm 解码成 WAV。
 */
import { decode, isSilk, isWav } from 'silk-wasm';
import type { AsrConfig } from '../config.ts';
import type { Logger, RawAttachment } from '../types.ts';
import { fetchSafe } from '../transport/attachment.ts';

/** 语音下载上限：QQ 语音最长 60s，10MB 足够 */
const MAX_VOICE_BYTES = 10 * 1024 * 1024;
/** SILK 解码采样率（QQ 语音为 24kHz） */
const SILK_SAMPLE_RATE = 24000;

/** 转写结果 */
export interface VoiceTranscript {
  text: string;
  /** 时长（秒），仅 SILK 解码时可得 */
  duration?: number;
}

/** 给单声道 pcm_s16le 包一层 WAV 头 */
export function pcmToWav(pcm: Uint8Array, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** 把语音字节转成 ASR 接口能吃的音频（SILK → WAV，WAV 原样，其他格式按原文件名上传） */
export async function toUploadableAudio(
  bytes: Buffer,
  filename: string,
): Promise<{ data: Buffer; name: string; duration?: number }> {
  if (isWav(bytes)) return { data: bytes, name: 'voice.wav' };
  if (isSilk(bytes)) {
    const { data, duration } = await decode(bytes, SILK_SAMPLE_RATE);
    return { data: pcmToWav(data, SILK_SAMPLE_RATE), name: 'voice.wav', duration: Math.round(duration / 1000) };
  }
  return { data: bytes, name: filename || 'voice.amr' };
}

/** 转写服务连不上（拒绝连接 / 找不到主机），区别于超时和 HTTP 错误 */
export class AsrOfflineError extends Error {
  constructor(baseUrl: string, cause: unknown) {
    super(`ASR server unreachable: ${baseUrl}`, { cause });
    this.name = 'AsrOfflineError';
  }
}

/** 服务离线时给模型的说明：明确拒绝，不让它自己找别的办法转写 */
export const ASR_OFFLINE_HINT =
  'speech recognition is unavailable: the ASR server is offline. Tell the user, and ask the bot owner '
  + 'to start the whisper server. Do not try to transcribe the audio any other way '
  + '(no ffmpeg/whisper scripts, no other services).';

/** 连接层错误码（undici 把它们挂在 TypeError('fetch failed').cause 上） */
const OFFLINE_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT']);

/** fetch 抛出的错误是否意味着服务连不上 */
export function isConnectionError(err: unknown): boolean {
  if (!(err instanceof TypeError)) return false;
  const cause = (err as { cause?: { code?: unknown; errors?: Array<{ code?: unknown }> } }).cause;
  const codes = [cause?.code, ...(cause?.errors ?? []).map(e => e.code)];
  return codes.some(c => typeof c === 'string' && OFFLINE_CODES.has(c));
}

/** 一个转写接口：主接口或备用接口 */
interface AsrEndpoint {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
}

/** 服务端出错（5xx）：服务在但坏了，和鉴权/参数错误（4xx）区分开，前者值得换备用接口 */
class AsrServerError extends Error {
  constructor(status: number, body: string) {
    super(`HTTP ${status} ${body.slice(0, 200)}`);
    this.name = 'AsrServerError';
  }
}

/** 读取接口密钥（配置为空时退到环境变量） */
function resolveApiKey(endpoint: AsrEndpoint): string {
  return endpoint.apiKey || process.env.QQBOT_ASR_API_KEY || '';
}

/** 调用一个 OpenAI 兼容转写接口；连不上时抛 AsrOfflineError，5xx 抛 AsrServerError */
async function postTranscription(audio: { data: Buffer; name: string }, endpoint: AsrEndpoint): Promise<string> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(audio.data)]), audio.name);
  form.append('model', endpoint.model);

  const apiKey = resolveApiKey(endpoint);
  let resp: Response;
  try {
    resp = await fetch(`${endpoint.baseUrl.replace(/\/+$/, '')}/audio/transcriptions`, {
      method: 'POST',
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
      body: form,
      signal: AbortSignal.timeout(endpoint.timeoutMs),
    });
  } catch (err) {
    throw isConnectionError(err) ? new AsrOfflineError(endpoint.baseUrl, err) : err;
  }
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    if (resp.status >= 500) throw new AsrServerError(resp.status, body);
    throw new Error(`HTTP ${resp.status} ${body.slice(0, 200)}`);
  }
  const json = await resp.json() as { text?: unknown };
  return typeof json.text === 'string' ? json.text.trim() : '';
}

/**
 * 转写：先走主接口，连不上或 5xx 且配了备用接口时改走备用接口。
 * 超时不切换：本机服务处理长音频本来就慢，再把整段音频发去在线服务只会更久。
 * 两边都连不上时抛备用接口的 AsrOfflineError。
 */
export async function requestTranscription(
  audio: { data: Buffer; name: string },
  asr: AsrConfig,
  logger?: Logger,
): Promise<string> {
  try {
    return await postTranscription(audio, asr);
  } catch (err) {
    const fallback = asr.fallback;
    const switchable = err instanceof AsrOfflineError || err instanceof AsrServerError;
    if (!switchable || fallback === undefined || !fallback.enabled) throw err;
    logger?.info(`im-qqbot: ASR 主接口不可用（${err.message}），改用备用接口 ${fallback.baseUrl}`);
    return postTranscription(audio, fallback);
  }
}

/**
 * 转写一条语音附件；服务连不上返回 { offline: true }，其它失败或识别为空返回 undefined。
 */
export async function transcribeVoice(
  att: RawAttachment,
  asr: AsrConfig,
  logger: Logger,
): Promise<VoiceTranscript | { offline: true } | undefined> {
  const wavUrl = typeof att.voice_wav_url === 'string' ? att.voice_wav_url : '';
  const url = wavUrl || att.url;
  if (!url) return undefined;

  try {
    const bytes = await fetchSafe(url, MAX_VOICE_BYTES);
    const audio = await toUploadableAudio(bytes, att.filename);
    const text = await requestTranscription(audio, asr, logger);
    if (!text) return undefined;
    logger.debug(`im-qqbot: voice transcribed (${text.length} chars): ${att.filename}`);
    return { text, duration: audio.duration };
  } catch (err) {
    logger.warn(`im-qqbot: voice transcription failed: ${att.filename} — ${err instanceof Error ? err.message : String(err)}`);
    return err instanceof AsrOfflineError ? { offline: true } : undefined;
  }
}
