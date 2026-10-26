import { describe, expect, it } from 'vitest';
import type { ImQQBotConfig } from '../config.ts';
import { modelCommand } from './model.ts';
import { presetCommand } from './preset.ts';

const config = {
  ownerOpenid: 'owner',
  adminOpenids: ['admin'],
} as unknown as ImQQBotConfig;

function ctx(senderId: string, raw: string) {
  return {
    command: { name: 'x', args: raw ? raw.split(/\s+/) : [], raw },
    message: { senderId },
  } as never;
}

describe('config command authorization', () => {
  it('/model 无参数可查看，修改仅 owner/admin', () => {
    const cmd = modelCommand({ manager: {} as never, config });
    expect(cmd.authorized?.(ctx('stranger', ''))).toBe(true);
    expect(cmd.authorized?.(ctx('stranger', 'deepseek-official/deepseek-flash'))).toMatch(/只有/);
    expect(cmd.authorized?.(ctx('admin', 'deepseek-official/deepseek-flash'))).toBe(true);
    expect(cmd.authorized?.(ctx('owner', 'deepseek-official/deepseek-flash'))).toBe(true);
  });

  it('/preset 无参数可查看，切换/重置仅 owner/admin', () => {
    const cmd = presetCommand({ manager: {} as never, config });
    expect(cmd.authorized?.(ctx('stranger', ''))).toBe(true);
    expect(cmd.authorized?.(ctx('stranger', 'reset'))).toMatch(/只有/);
    expect(cmd.authorized?.(ctx('admin', 'standard'))).toBe(true);
    expect(cmd.authorized?.(ctx('owner', 'standard'))).toBe(true);
  });
});
