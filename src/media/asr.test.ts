import { afterEach, describe, expect, it, vi } from 'vitest';
import { encode } from 'silk-wasm';
import { pcmToWav, requestTranscription, toUploadableAudio } from './asr.ts';
import { transcribeVoices } from '../middleware/attachment.ts';
import type { AsrConfig } from '../config.ts';
import type { RawAttachment } from '../types.ts';

const asr: AsrConfig = {
  enabled: true,
  baseUrl: 'https://asr.example.com/v1/',
  apiKey: 'test-key',
  model: 'FunAudioLLM/SenseVoiceSmall',
  preferQQ: true,
  timeoutMs: 5000,
};

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function voice(extra: Partial<RawAttachment> = {}): RawAttachment {
  return { content_type: 'voice', filename: 'a.amr', size: 100, url: 'https://x/a.amr', ...extra };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('toUploadableAudio', () => {
  it('decodes SILK to a WAV with duration', async () => {
    const pcm = new Uint8Array(24000 * 2); // 1s of silence at 24kHz
    const silk = await encode(pcmToWav(pcm, 24000), 0);
    const out = await toUploadableAudio(Buffer.from(silk.data), 'a.amr');
    expect(out.name).toBe('voice.wav');
    expect(out.data.subarray(0, 4).toString()).toBe('RIFF');
    expect(out.duration).toBe(1);
  });

  it('passes WAV through and keeps unknown formats as-is', async () => {
    const wav = pcmToWav(new Uint8Array(4), 16000);
    expect((await toUploadableAudio(wav, 'x')).data).toBe(wav);
    const mp3 = Buffer.from('ID3....');
    expect(await toUploadableAudio(mp3, 'a.mp3')).toEqual({ data: mp3, name: 'a.mp3' });
  });
});

describe('requestTranscription', () => {
  it('posts multipart to {baseUrl}/audio/transcriptions with bearer key', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ text: ' 你好 ' })));
    vi.stubGlobal('fetch', fetchMock);
    const text = await requestTranscription({ data: Buffer.from('RIFF'), name: 'voice.wav' }, asr);
    expect(text).toBe('你好');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://asr.example.com/v1/audio/transcriptions');
    expect(init.headers).toEqual({ Authorization: 'Bearer test-key' });
    expect((init.body as FormData).get('model')).toBe(asr.model);
  });

  it('throws on HTTP errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad key', { status: 401 })));
    await expect(requestTranscription({ data: Buffer.from(''), name: 'v.wav' }, asr)).rejects.toThrow('HTTP 401');
  });
});

describe('transcribeVoices', () => {
  it('prefers QQ asr_refer_text and only calls ASR when missing', async () => {
    const transcribe = vi.fn(async () => ({ text: '在线结果', duration: 3 }));
    const out = await transcribeVoices(
      [voice({ asr_refer_text: 'QQ结果' }), voice({ filename: 'b.amr' }), { ...voice(), content_type: 'image/png' }],
      asr,
      logger,
      transcribe,
    );
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(out.map(p => [p.voiceText, p.voiceSource])).toEqual([['QQ结果', 'asr'], ['在线结果', 'stt']]);
  });

  it('falls back to QQ text when online ASR fails and preferQQ is off', async () => {
    const transcribe = vi.fn(async () => undefined);
    const out = await transcribeVoices([voice({ asr_refer_text: 'QQ结果' })], { ...asr, preferQQ: false }, logger, transcribe);
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(out).toEqual([expect.objectContaining({ voiceText: 'QQ结果', voiceSource: 'asr' })]);
  });
});
