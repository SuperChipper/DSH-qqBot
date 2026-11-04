import { describe, expect, it } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import type { ImQQBotConfig } from '../config.ts';
import type { SessionManager } from '../session/index.ts';
import type { Logger } from '../types.ts';
import { registerSendFileTool, type MediaSenderLike } from './send-file-tool.ts';
import { registerSpeakTool } from './speak-tool.ts';
import { captionFromArgs } from '../transport/caption-echo.ts';

interface Definition {
  name: string;
  parameters?: { properties?: Record<string, { enum?: string[] }> };
  output: { render(args: unknown, value: unknown): Array<{ type: string; text?: string }> };
}

function tools() {
  const definitions: Definition[] = [];
  const ctx = { get: () => ({ register: (definition: Definition) => definitions.push(definition) }) } as unknown as Context;
  const config = { cwd: '', speak: { voice: 'test' } } as unknown as ImQQBotConfig;
  const logger = { info: () => {}, warn: () => {} } as unknown as Logger;
  const bot = {} as MediaSenderLike;
  const manager = {} as SessionManager;
  registerSendFileTool(ctx, bot, manager, config, logger);
  registerSpeakTool(ctx, bot, manager, config, logger);
  return new Map(definitions.map((definition) => [definition.name, definition]));
}

describe('voice reply delivery guidance', () => {
  it('speak 成功后允许文字补充，说明系统会独立排队发送', () => {
    const definition = tools().get('qqbot_speak')!;
    const text = definition.output.render({}, { voice: 'test', chars: 5, target: 'group:p' })[0]!.text!;
    expect(text).toContain('已发送语音');
    expect(text).toContain('需要补充说明时继续正常输出文字');
    expect(text).toContain('独立消息排队发送');
    expect(text).not.toContain('直接结束本轮');
    expect(text).not.toContain('需要文字补充就另外打字');
  });

  it('speak 暴露 lang 参数，外语句子能指定日文/英文音素', () => {
    const definition = tools().get('qqbot_speak')!;
    const lang = definition.parameters?.properties?.lang;
    expect(lang?.enum).toEqual(['zh', 'ja', 'en']);
  });

  it.each(['song.mp3', 'VOICE.WAV', 'clip.silk'])('send_file 发语音 %s 不把被忽略的 caption 报成已送达', (fileName) => {
    const definition = tools().get('qqbot_send_file')!;
    const args = { file_path: 'C:/tmp/' + fileName, caption: '歌曲说明' };
    const text = definition.output.render(args, { fileName, target: 'group:p' })[0]!.text!;
    expect(text).toContain('本次 caption 未发送');
    expect(text).toContain('需要补充说明时继续正常输出文字');
    expect(text).not.toContain('caption 已随文件发出');
    expect(captionFromArgs(JSON.stringify(args))).toBeUndefined();
  });

  it('图片 caption 只报发送事实，不拖复读提醒的小尾巴', () => {
    const definition = tools().get('qqbot_send_file')!;
    const args = { file_path: 'C:/tmp/image.png', caption: '这张给你' };
    const text = definition.output.render(args, { fileName: 'image.png', target: 'group:p' })[0]!.text!;
    expect(text).toContain('已发送 image.png');
    expect(text).not.toContain('caption 已随文件发出');
    expect(text).not.toContain('不输出文字');
    expect(text).not.toContain('语音发送成功后');
    expect(captionFromArgs(JSON.stringify(args))).toBe('这张给你');
  });
});
