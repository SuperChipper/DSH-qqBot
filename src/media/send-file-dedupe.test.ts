import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import type { ImQQBotConfig } from '../config.ts';
import type { SessionManager } from '../session/index.ts';
import type { Logger, ReplyTarget } from '../types.ts';
import { registerSendFileTool, resetRecentSends, type MediaSenderLike } from './send-file-tool.ts';

interface Definition {
  name: string;
  output: { render(args: unknown, value: unknown): Array<{ type: string; text?: string }> };
  execute(args: unknown, exec: unknown): Promise<Record<string, unknown>>;
}

function setup() {
  const definitions: Definition[] = [];
  const ctx = {
    get: () => ({ register: (definition: Definition) => definitions.push(definition) }),
  } as unknown as Context;
  const config = {
    cwd: '',
    sendFile: { restrictPaths: false, extraRoots: [] },
  } as unknown as ImQQBotConfig;
  const logger = { info: () => {}, warn: () => {} } as unknown as Logger;

  const sent: string[] = [];
  const bot = {
    sendImage: async (_target: ReplyTarget, source: { localPath?: string }) => {
      sent.push(source.localPath ?? '');
      return { upload: { file_uuid: 'u1' }, message: { id: 'm1' } };
    },
  } as unknown as MediaSenderLike;

  const manager = {
    findByAgent: () => ({ replyTarget: { scope: 'group', targetId: 'g1' } }),
  } as unknown as SessionManager;

  registerSendFileTool(ctx, bot, manager, config, logger);
  const definition = definitions.find((d) => d.name === 'qqbot_send_file')!;
  return { definition, sent };
}

const dir = mkdtempSync(join(tmpdir(), 'qqbot-sendfile-'));
const imagePath = join(dir, 'amiya.jpg');
writeFileSync(imagePath, 'x');

const exec = { agent: { id: 'a1' }, signal: new AbortController().signal };

describe('qqbot_send_file 重复发送', () => {
  beforeEach(() => resetRecentSends());

  it('二十秒内同一张图只发一次，第二次只回说明', async () => {
    const { definition, sent } = setup();

    const first = await definition.execute({ file_path: imagePath, caption: '今日阿米娅' }, exec);
    const second = await definition.execute(
      { file_path: imagePath, caption: '今日阿米娅 · 画师未知 https://example.com/x' },
      exec,
    );

    expect(sent).toHaveLength(1);
    expect(first.deduped).toBeUndefined();
    expect(second.deduped).toBe(true);

    const text = definition.output.render({}, second)[0]!.text!;
    expect(text).toContain('没有重复发送');
    expect(text).toContain('发一条文字');
  });

  it('窗口过期后可以再发（用户明确要求重发）', async () => {
    const { definition, sent } = setup();

    await definition.execute({ file_path: imagePath }, exec);
    resetRecentSends();
    const again = await definition.execute({ file_path: imagePath }, exec);

    expect(sent).toHaveLength(2);
    expect(again.deduped).toBeUndefined();
  });

  it('不同文件互不影响', async () => {
    const { definition, sent } = setup();
    const other = join(dir, 'other.jpg');
    writeFileSync(other, 'y');

    await definition.execute({ file_path: imagePath }, exec);
    await definition.execute({ file_path: other }, exec);

    expect(sent).toHaveLength(2);
  });
});
