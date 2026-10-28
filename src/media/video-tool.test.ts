import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import type { StreamChunk } from '@deepseek-ai/dsh-llm';
import {
  buildFramePrompt,
  composeVideoText,
  planFrames,
  registerDescribeVideoTool,
  resolveFfmpegBins,
} from './video-tool.ts';
import type { AsrConfig, VideoConfig, VisionConfig } from '../config.ts';

describe('planFrames', () => {
  it('takes about one frame per 2s, capped by maxFrames and maxSeconds', () => {
    expect(planFrames(5, 8, 300)).toMatchObject({ count: 3, cols: 3, rows: 1, times: [0, 1.7, 3.3] });
    expect(planFrames(60, 8, 300)).toMatchObject({ span: 60, count: 8, cols: 4, rows: 2 });
    expect(planFrames(1000, 8, 300).span).toBe(300);
    expect(planFrames(0.5, 8, 300)).toMatchObject({ count: 1, cols: 1, rows: 1 });
  });
});

describe('resolveFfmpegBins', () => {
  it('uses PATH by default and a sibling ffprobe for a configured path', () => {
    expect(resolveFfmpegBins('')).toEqual({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' });
    expect(resolveFfmpegBins(join('C:', 'ff', 'ffmpeg.exe')).ffprobe).toBe(join('C:', 'ff', 'ffprobe.exe'));
  });
});

describe('prompt and output text', () => {
  it('describes the grid layout and frame times', () => {
    const text = buildFramePrompt(planFrames(8, 4, 300), 8.04, 'what game?');
    expect(text).toContain('4x1 grid of 4 frames');
    expect(text).toContain('8s video');
    expect(text).toContain('0s, 2s, 4s, 6s');
    expect(text.endsWith('what game?')).toBe(true);
  });

  it('includes speech when present, else the reason', () => {
    expect(composeVideoText('a cat', 'meow', undefined)).toBe('[Visual] a cat\n[Speech] meow');
    expect(composeVideoText('a cat', undefined, 'no audio track')).toBe('[Visual] a cat\n[Speech] (no audio track)');
  });
});

function hasFfmpeg(): boolean {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe.runIf(hasFfmpeg())('qqbot_describe_video with real ffmpeg', () => {
  let dir: string;
  let clip: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'video-tool-test-'));
    clip = join(dir, 'clip.mp4');
    execFileSync('ffmpeg', [
      '-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc=duration=6:size=320x240:rate=10',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
      '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', clip,
    ]);
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  afterEach(() => vi.unstubAllGlobals());

  const vision: VisionConfig = {
    enabled: true, native: false, provider: 'p', model: 'vl', defaultPrompt: '',
    maxBytes: 10 * 1024 * 1024, maxTokens: 256, timeoutMs: 1000,
  };
  const video: VideoConfig = { enabled: true, ffmpegPath: '', maxFrames: 8, maxSeconds: 300 };
  const asr: AsrConfig = {
    enabled: true, baseUrl: 'https://asr.example.com/v1', apiKey: 'k',
    model: 'm', preferQQ: true, timeoutMs: 1000,
  };
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  async function register() {
    let tool: { execute(args: unknown, exec: { signal: AbortSignal }): Promise<Record<string, unknown>> } | undefined;
    const saved: Array<{ data: Uint8Array; mediaType: string }> = [];
    const prompts: string[] = [];
    const services: Record<string, unknown> = {
      tools: { register: (d: typeof tool) => { tool = d; } },
      attachments: {
        saveImage: async (input: { data: Uint8Array; mediaType: string }) => {
          saved.push(input);
          return { id: 'img1', mediaType: input.mediaType };
        },
      },
      llm: {
        async *stream(options: { messages: Array<{ content: Array<{ type: string; text?: string }> }> }) {
          prompts.push(options.messages[0].content.find(b => b.type === 'text')?.text ?? '');
          const chunks: StreamChunk[] = [
            { type: 'block-start', index: 0, blockType: 'text' },
            { type: 'text-delta', index: 0, text: 'a color test pattern' },
            { type: 'block-end', index: 0, block: { type: 'text', text: 'a color test pattern' } },
            { type: 'finish', reason: { kind: 'stop' } },
          ];
          yield* chunks;
        },
      },
    };
    const ctx = { get: (name: string) => services[name] } as unknown as Context;
    await registerDescribeVideoTool(ctx, video, vision, asr, logger);
    return { tool, saved, prompts };
  }

  it('sends a frame grid to the vision model and the audio track to ASR', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ text: 'beep' })));
    vi.stubGlobal('fetch', fetchMock);
    const { tool, saved, prompts } = await register();
    expect(tool).toBeDefined();

    const out = await tool!.execute({ video: clip }, { signal: new AbortController().signal });
    expect(out).toMatchObject({ frames: 3, transcribed: true });
    expect(out.duration as number).toBeCloseTo(6, 0);
    expect(saved[0].mediaType).toBe('image/jpeg');
    expect(saved[0].data.subarray(0, 3)).toEqual(new Uint8Array([0xff, 0xd8, 0xff]));
    expect(prompts[0]).toContain('3x1 grid of 3 frames');
    const form = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as FormData;
    expect((form.get('file') as Blob).size).toBeGreaterThan(6 * 16000 * 2 * 0.9);
  });

  it('rejects a missing file', async () => {
    const { tool } = await register();
    await expect(tool!.execute({ video: join(dir, 'nope.mp4') }, { signal: new AbortController().signal }))
      .rejects.toThrow('video file not found');
  });
});
