import { describe, expect, it, vi } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import type { Logger } from '../types.ts';
import { registerSaveStickerTool } from './save-sticker-tool.ts';
import type { StickerStore } from './sticker-store.ts';

const logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;

function setup() {
  let definition: { parameters: { required: string[] }; execute(args: unknown): Promise<unknown> } | undefined;
  const save = vi.fn(() => ({ saved: true }));
  const ctx = { get: () => ({ register: (d: typeof definition) => { definition = d; } }) } as unknown as Context;
  registerSaveStickerTool(ctx, { save } as unknown as StickerStore, logger);
  return { definition: definition!, save };
}

describe('qqbot_save_sticker', () => {
  it('look 必填，没写清图里是什么就不收藏', async () => {
    const { definition, save } = setup();
    expect(definition.parameters.required).toContain('look');
    for (const look of [undefined, '', '   ']) {
      await expect(definition.execute({ image: 'a.png', emotion: '开心', look })).rejects.toThrow(/look/);
    }
    expect(save).not.toHaveBeenCalled();
  });

  it('look 传给存储', async () => {
    const { definition, save } = setup();
    await definition.execute({ image: 'a.png', emotion: '开心', look: '蓝鲸娘握拳笑' });
    expect(save).toHaveBeenCalledWith({ source: 'a.png', emotion: '开心', look: '蓝鲸娘握拳笑' });
  });
});
