/**
 * 在线语音识别 — 把 QQ 语音转成文本，供纯文本模型理解。
 *
 * 走 OpenAI 兼容的 POST {baseUrl}/audio/transcriptions（multipart: file + model），
 * SiliconFlow / Groq / OpenAI / 自建 whisper 服务均可直接换用。
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

/** 读取接口密钥（配置为空时退到环境变量） */
function resolveApiKey(asr: AsrConfig): string {
  return asr.apiKey || process.env.QQBOT_ASR_API_KEY || '';
}

/** 调用 OpenAI 兼容转写接口 */
export async function requestTranscription(
  audio: { data: Buffer; name: string },
  asr: AsrConfig,
): Promise<string> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(audio.data)]), audio.name);
  form.append('model', asr.model);

  const apiKey = resolveApiKey(asr);
  const resp = await fetch(`${asr.baseUrl.replace(/\/+$/, '')}/audio/transcriptions`, {
    method: 'POST',
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
    body: form,
    signal: AbortSignal.timeout(asr.timeoutMs),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`HTTP ${resp.status} ${body.slice(0, 200)}`);
  }
  const json = await resp.json() as { text?: unknown };
  return typeof json.text === 'string' ? json.text.trim() : '';
}

/**
 * 转写一条语音附件；失败或识别为空返回 undefined（由调用方回退为语音链接）。
 */
export async function transcribeVoice(
  att: RawAttachment,
  asr: AsrConfig,
  logger: Logger,
): Promise<VoiceTranscript | undefined> {
  const wavUrl = typeof att.voice_wav_url === 'string' ? att.voice_wav_url : '';
  const url = wavUrl || att.url;
  if (!url) return undefined;

  try {
    const bytes = await fetchSafe(url, MAX_VOICE_BYTES);
    const audio = await toUploadableAudio(bytes, att.filename);
    const text = await requestTranscription(audio, asr);
    if (!text) return undefined;
    logger.debug(`im-qqbot: voice transcribed (${text.length} chars): ${att.filename}`);
    return { text, duration: audio.duration };
  } catch (err) {
    logger.warn(`im-qqbot: voice transcription failed: ${att.filename} — ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}
