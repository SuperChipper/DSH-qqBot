/**
 * 内置 qqbot_save_sticker 工具 — 由 bot 自己决定是否收藏一张表情。
 *
 * 工具只负责把「bot 的决定」落盘：校验来源/大小 → 内容哈希去重 →
 * 复制到表情包目录 → 更新 index.json。动态 prompt 清单由
 * StickerStore.promptSections() 在每回合组装时读取，不需要改人设配置。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { Logger } from '../types.ts';
import { StickerStore, type SaveStickerResult } from './sticker-store.ts';

/** 工具名 */
export const SAVE_STICKER_TOOL_NAME = 'qqbot_save_sticker';

const DESCRIPTION =
  'Save a user-sent image into your own sticker collection when it genuinely captures a mood you would reuse. '
  + 'Call this only for images that make you feel something and that you would actually send later; do not save '
  + 'every image, ordinary screenshots, or long text screenshots. The tool deduplicates by SHA-256, copies the '
  + 'image into the sticker directory, updates stickers/index.json, and the new entry appears in your sticker '
  + 'catalog from the next turn. After saving you can send it right away with qqbot_send_file. '
  + 'Invoke this as a structured tool call; never write <qqbot_save_sticker> tags or XML in your reply text. '
  + 'If you also want to reply in the same step, call the tool first with empty text and write the reply after the result.';

/** tools 服务最小接口 */
interface ToolsRegistryLike {
  register(definition: unknown): unknown;
}

interface SaveStickerArgs {
  image: string;
  emotion: string;
  note?: string;
  file?: string;
}

export function registerSaveStickerTool(
  ctx: Context,
  store: StickerStore,
  logger: Logger,
): void {
  const tools = ctx.get('tools') as ToolsRegistryLike | undefined;
  if (!tools?.register) {
    logger.warn('im-qqbot: tools 服务不可用，qqbot_save_sticker 工具未注册');
    return;
  }

  const definition = {
    name: SAVE_STICKER_TOOL_NAME,
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        image: {
          type: 'string',
          description: "Absolute local path of the image; copy it from the user message's `- Image:` line.",
        },
        emotion: {
          type: 'string',
          description: 'Your own mood/reaction at this moment as a short label (e.g. 破防, 被萌到, 无语, 骄傲). Describe what you feel, not the image content.',
        },
        note: {
          type: 'string',
          description: 'Optional one-sentence reason why this sticker is worth keeping.',
        },
        file: {
          type: 'string',
          description: 'Optional preferred file name (e.g. fish_破防.png). Omit to derive it from emotion.',
        },
      },
      required: ['image', 'emotion'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          saved: { type: 'boolean' },
          duplicate: { type: 'boolean' },
          file: { type: 'string' },
          emotion: { type: 'string' },
          bytes: { type: 'integer' },
          total: { type: 'integer' },
          message: { type: 'string' },
        },
        required: ['saved', 'duplicate', 'file', 'emotion', 'bytes', 'total', 'message'],
        additionalProperties: false,
      },
      render: (_args: unknown, value: unknown): ContentBlock[] => {
        const result = value as SaveStickerResult;
        return [{ type: 'text', text: result.message }];
      },
    },
    async execute(args: unknown): Promise<SaveStickerResult> {
      const { image, emotion, note, file } = args as SaveStickerArgs;
      if (typeof image !== 'string' || image.trim().length === 0) {
        throw new Error('qqbot_save_sticker: `image` 必须是图片绝对路径');
      }
      if (typeof emotion !== 'string' || emotion.trim().length === 0) {
        throw new Error('qqbot_save_sticker: `emotion` 必须是你此刻的情绪标签');
      }
      return store.save({
        source: image,
        emotion,
        ...(typeof note === 'string' ? { note } : {}),
        ...(typeof file === 'string' ? { file } : {}),
      });
    },
  };

  tools.register(definition);
  logger.info('im-qqbot: qqbot_save_sticker 工具已注册');
}
