import { describe, it, expect, vi } from 'vitest';
import type { MiddlewareContext } from '@tencent-connect/qqbot-nodejs';
import type { ImQQBotConfig } from '../config.ts';
import type { Logger, RawAttachment } from '../types.ts';

vi.mock('../transport/attachment.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../transport/attachment.ts')>();
  return {
    ...actual,
    downloadMediaAttachments: vi.fn(async (atts: RawAttachment[] | undefined) => (atts ?? []).map((a) => ({
      filename: a.filename,
      contentType: 'image' as const,
      localPath: `/media/${a.filename}`,
    }))),
  };
});

const { attachmentProcessor } = await import('./attachment.ts');

const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const config = {
  media: { enabled: true, maxMB: 10, ttlHours: 24 },
  asr: { enabled: false },
} as unknown as ImQQBotConfig;

const line = (name: string, id: string) =>
  `[附件1] 类型:图片 文件名:${name} 尺寸:1x1 大小:1KB URL:https://multimedia.nt.qq.com.cn/download?fileid=${id}`;

describe('attachmentProcessor 合并转发图片', () => {
  it('从当前消息和引用原文里提取转发图片并下载到 state.forwardImages', async () => {
    const ctx = {
      message: { content: `[群聊的聊天记录]\n=== 消息 1 ===\n[发送者] 甲\n${line('a.jpg', 'A')}`, attachments: [] },
      state: { quote: { text: `[群聊的聊天记录]\n${line('b.jpg', 'B')}` } },
    } as unknown as MiddlewareContext;
    const next = vi.fn(async () => {});

    await attachmentProcessor(config, logger)(ctx, next);

    expect(next).toHaveBeenCalled();
    expect(ctx.state.forwardImages).toEqual([
      { url: 'https://multimedia.nt.qq.com.cn/download?fileid=A', filename: 'a.jpg', localPath: '/media/a.jpg' },
      { url: 'https://multimedia.nt.qq.com.cn/download?fileid=B', filename: 'b.jpg', localPath: '/media/b.jpg' },
    ]);
  });

  it('普通消息不产生 forwardImages', async () => {
    const ctx = { message: { content: '你好', attachments: [] }, state: {} } as unknown as MiddlewareContext;
    await attachmentProcessor(config, logger)(ctx, async () => {});
    expect(ctx.state.forwardImages).toBeUndefined();
  });
});
