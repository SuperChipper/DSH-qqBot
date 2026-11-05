import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  chatCompletion,
  describeVideoViaChat,
  setChatKeyResolver,
  transcribeViaChat,
  videoEndpointFromEnv,
} from './chat-gateway.ts';

function stubFetch(content: string | null, status = 200) {
  const mock = vi.fn(async () => new Response(
    JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 2 } }),
    { status, headers: { 'content-type': 'application/json' } },
  ));
  vi.stubGlobal('fetch', mock);
  return mock;
}

afterEach(() => {
  setChatKeyResolver(undefined);
  vi.unstubAllGlobals();
  delete process.env.QQBOT_VIDEO_MODEL;
});

describe('chatCompletion', () => {
  it('带 x-opencode-session、user-agent 和 reasoning_effort=none', async () => {
    setChatKeyResolver(async () => 'sk-x');
    const fetchMock = stubFetch('ok');
    await chatCompletion([{ type: 'text', text: 'hi' }]);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/chat/completions');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-opencode-session']).toBeTruthy();
    expect(headers['user-agent']).toBe('opencode/0.1.0');
    expect(JSON.parse(init.body as string).reasoning_effort).toBe('none');
  });

  it('空正文按错误处理，不静默返回空串', async () => {
    setChatKeyResolver(async () => 'sk-x');
    stubFetch(null);
    await expect(chatCompletion([{ type: 'text', text: 'hi' }])).rejects.toThrow(/空正文/);
  });

  it('缺凭证时报出是哪个 ref', async () => {
    await expect(chatCompletion([{ type: 'text', text: 'hi' }])).rejects.toThrow(/OPENCODE_GO_API_KEY/);
  });
});

describe('describeVideoViaChat', () => {
  it('用 video_url + data URI 传整段视频，模型默认 deepseek-v4.1-flash', async () => {
    setChatKeyResolver(async () => 'sk-x');
    const fetchMock = stubFetch('视频里在吃咖喱');
    const text = await describeVideoViaChat(Buffer.from('fake-mp4'), '讲讲');

    expect(text).toBe('视频里在吃咖喱');
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.model).toBe('deepseek-v4.1-flash');
    expect(body.messages[0].content[0].type).toBe('video_url');
    expect(body.messages[0].content[0].video_url.url).toMatch(/^data:video\/mp4;base64,/);
  });

  it('QQBOT_VIDEO_MODEL 可以换模型', async () => {
    process.env.QQBOT_VIDEO_MODEL = 'some-video-model';
    setChatKeyResolver(async () => 'sk-x');
    const fetchMock = stubFetch('ok');
    await describeVideoViaChat(Buffer.from('v'), '讲讲');
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.model).toBe('some-video-model');
    expect(videoEndpointFromEnv().model).toBe('some-video-model');
  });
});

describe('transcribeViaChat', () => {
  it('超过单次上限直接报错，让调用方去切片', async () => {
    setChatKeyResolver(async () => 'sk-x');
    const fetchMock = stubFetch('x');
    await expect(transcribeViaChat(Buffer.alloc(2048), 'mp3', { maxBytes: 1024 })).rejects.toThrow(/超过单次上限/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('语言提示拼进指令，input_audio 带 format', async () => {
    setChatKeyResolver(async () => 'sk-x');
    const fetchMock = stubFetch('ok');
    await transcribeViaChat(Buffer.from('a'), 'mp3', { prompt: '转写', language: 'ja' });
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.messages[0].content[0].input_audio.format).toBe('mp3');
    expect(body.messages[0].content[1].text).toContain('ja');
  });
});
