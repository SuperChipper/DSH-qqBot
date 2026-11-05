/**
 * 走 chat/completions 的多模态网关：音频转写、整段视频理解都从这里出去。
 *
 * 为什么不用 /audio/transcriptions 或视觉抽帧：
 * - opencode-go 的 mimo 是 chat 形态，没有单独的 ASR 端点；一个 OPENCODE_GO_API_KEY 覆盖全部。
 * - `video_url` + data URI 能直接吃整段 mp4（实测 115s / 3.7MB 原片 → 9.9s 返回、认得准），
 *   比在本地抽 8 帧靠谱，代价是 token：约 274 tokens/秒，10 分钟视频 ≈ 16 万。
 *
 * 两个坑（都踩过）：
 * 1. `reasoning_effort` 必须显式给 `"none"`。默认它会先「逐秒听一遍」再写结论，
 *    把 max_tokens 花在思考上、`content` 回 null。症状看着像 token 不够，调大 max_tokens 没用。
 * 2. opencode-go 网关缺 `x-opencode-session` 直接 400 MissingSessionID。
 */
import type { Logger } from '../types.ts';

export const DEFAULT_CHAT_BASE_URL = 'https://opencode.ai/inference/go/openai/v1';
export const DEFAULT_CHAT_MODEL = 'mimo-v2.6-flash';
export const DEFAULT_CHAT_KEY_REF = 'OPENCODE_GO_API_KEY';

/** 单次请求的音频上限（base64 后约 4/3）。wav 16k 单声道 ≈ 32 KB/s，16MB ≈ 8 分钟 */
export const DEFAULT_CHAT_MAX_BYTES = 16 * 1024 * 1024;

export const DEFAULT_CHAT_PROMPT =
  '逐句转写这段音频里的人声，保留时间轴，标注说话人（SPEAKER_00/01）。只输出转写结果，不要分析过程。';

/** 一个 chat 形态的端点；和插件配置无关，全部来自环境变量 */
export interface ChatEndpoint {
  baseUrl: string;
  model: string;
  keyRef: string;
}

export function chatEndpointFromEnv(): ChatEndpoint {
  return {
    baseUrl: (process.env.QQBOT_TRANSCRIBE_BASE_URL ?? DEFAULT_CHAT_BASE_URL).replace(/\/+$/, ''),
    model: process.env.QQBOT_TRANSCRIBE_MODEL ?? DEFAULT_CHAT_MODEL,
    keyRef: process.env.QQBOT_TRANSCRIBE_KEY_REF ?? DEFAULT_CHAT_KEY_REF,
  };
}

/** 整段视频理解用的模型：和音频转写不是同一个（mimo 没测过 video_url，v4.1-flash 实测可看片） */
export const DEFAULT_VIDEO_MODEL = 'deepseek-v4.1-flash';

/** 视频端点：网关和凭证同 chatEndpointFromEnv，只把模型换掉 */
export function videoEndpointFromEnv(): ChatEndpoint {
  return { ...chatEndpointFromEnv(), model: process.env.QQBOT_VIDEO_MODEL ?? DEFAULT_VIDEO_MODEL };
}

type KeyResolver = (ref: string) => Promise<string | undefined>;
let keyResolver: KeyResolver | undefined;

/**
 * 注入凭证解析器（bootstrap 注册工具时调一次）。
 * asr.ts 是纯模块、拿不到 ctx，所以走这个模块级的口子；没注入时退回同名环境变量。
 */
export function setChatKeyResolver(fn: KeyResolver | undefined): void {
  keyResolver = fn;
}

export async function resolveChatKey(ref: string): Promise<string> {
  if (keyResolver !== undefined) {
    const value = await keyResolver(ref);
    if (value !== undefined && value !== '') return value;
  }
  const fromEnv = process.env[ref];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  throw new Error(`缺少凭证 ${ref}`);
}

export interface ChatCompletionOptions {
  endpoint?: ChatEndpoint;
  timeoutMs?: number;
  maxTokens?: number;
  logger?: Logger;
}

/**
 * 发一次 chat/completions，返回第一条 message.content。
 * 空正文按错误处理：那几乎总是 reasoning 吃光了额度，不能当成「没有内容」静默吞掉。
 */
export async function chatCompletion(content: unknown[], options: ChatCompletionOptions = {}): Promise<string> {
  const endpoint = options.endpoint ?? chatEndpointFromEnv();
  const key = await resolveChatKey(endpoint.keyRef);

  const body = JSON.stringify({
    model: endpoint.model,
    stream: false,
    max_tokens: options.maxTokens ?? 4096,
    // 不关掉思考，它会把额度全花在「逐秒分析」上，正文回 null
    reasoning_effort: 'none',
    messages: [{ role: 'user', content }],
  });

  const response = await fetch(`${endpoint.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      'user-agent': 'opencode/0.1.0',
      // 这个网关缺了它会 400 MissingSessionID
      'x-opencode-session': crypto.randomUUID(),
    },
    body,
    signal: AbortSignal.timeout(options.timeoutMs ?? 300000),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`chat 网关 HTTP ${response.status} ${detail.slice(0, 200)}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string | null } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const text = data.choices?.[0]?.message?.content ?? '';
  if (text.trim() === '') throw new Error('chat 网关返回空正文（多半是思考吃掉了额度，检查 reasoning_effort）');
  options.logger?.debug(
    `im-qqbot: chat ${endpoint.model} in=${data.usage?.prompt_tokens ?? '?'} out=${data.usage?.completion_tokens ?? '?'}`,
  );
  return text.trim();
}

export interface ChatTranscribeOptions extends ChatCompletionOptions {
  /** 转写指令；省略时用 DEFAULT_CHAT_PROMPT */
  prompt?: string;
  /** 语言提示，如 "ja"、"中文" */
  language?: string;
  maxBytes?: number;
}

/** 转写一段音频，返回模型给的正文。音频过大时抛错，由调用方决定切片还是不转 */
export async function transcribeViaChat(
  audio: Buffer,
  format: 'wav' | 'mp3',
  options: ChatTranscribeOptions = {},
): Promise<string> {
  const maxBytes = options.maxBytes ?? DEFAULT_CHAT_MAX_BYTES;
  if (audio.length > maxBytes) {
    throw new Error(
      `音频 ${(audio.length / 1e6).toFixed(1)}MB 超过单次上限 ${(maxBytes / 1e6).toFixed(0)}MB，`
      + '长音频请用 qqbot_transcribe（它带 ffmpeg 切片）',
    );
  }

  const base = options.prompt?.trim() ? options.prompt : DEFAULT_CHAT_PROMPT;
  const instruction = options.language === undefined ? base : `${base}\n（音频语言：${options.language}）`;
  return chatCompletion([
    { type: 'input_audio', input_audio: { data: audio.toString('base64'), format } },
    { type: 'text', text: instruction },
  ], options);
}

/**
 * 把整段视频交给模型看。
 *
 * 只测通过 `video_url` + data URI 这一种：`input_video` 会被网关拒（atlas 还没实现）。
 * 调用方负责先把体积压到上限内。
 */
export async function describeVideoViaChat(
  video: Buffer,
  prompt: string,
  options: ChatCompletionOptions = {},
): Promise<string> {
  return chatCompletion([
    { type: 'video_url', video_url: { url: `data:video/mp4;base64,${video.toString('base64')}` } },
    { type: 'text', text: prompt },
  ], { timeoutMs: 600000, maxTokens: 2048, endpoint: videoEndpointFromEnv(), ...options });
}
