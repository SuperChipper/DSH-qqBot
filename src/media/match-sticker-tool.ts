/**
 * qqbot_match_sticker — 在 bot 自己的表情库里按 SHA-256 查找完全相同的图片。
 *
 * 只读：不上传、不复制、不改索引。命中时返回情绪/备注/文件，
 * 模型可以据此判断要不要用 qqbot_send_file 发出去，或直接引用情绪。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { Logger } from '../types.ts';
import { StickerStore } from './sticker-store.ts';

export const MATCH_STICKER_TOOL_NAME = 'qqbot_match_sticker';

const DESCRIPTION =
  'Match a user-sent image against the bot\'s own sticker/meme collection by SHA-256. '
  + 'Read-only: does not upload, copy or modify the index. Returns matched emotion, note, file and byte size, '
  + 'or matched=false. Images in the current message are already matched on arrival (a "[本地表情库] 命中" line '
  + 'means a hit, no line means a miss), so call this only for images outside the current message, such as '
  + 'quoted/earlier or downloaded images. If matched, you may send the sticker with qqbot_send_file or use its emotion.';

interface ToolsRegistryLike {
  register(definition: unknown): unknown;
}

interface MatchStickerArgs {
  image: string;
}

interface MatchStickerOutput {
  matched: boolean;
  file?: string;
  emotion?: string;
  note?: string;
  bytes?: number;
  total?: number;
  message: string;
}

export function registerMatchStickerTool(
  ctx: Context,
  store: StickerStore,
  logger: Logger,
): void {
  const tools = ctx.get('tools') as ToolsRegistryLike | undefined;
  if (!tools?.register) {
    logger.warn('im-qqbot: tools 服务不可用，qqbot_match_sticker 工具未注册');
    return;
  }

  const definition = {
    name: MATCH_STICKER_TOOL_NAME,
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        image: {
          type: 'string',
          description: 'Absolute path to the user-sent image (the - Image: line), e.g. C:/.../media/xxx.jpg.',
        },
      },
      required: ['image'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          matched: { type: 'boolean' },
          file: { type: 'string' },
          emotion: { type: 'string' },
          note: { type: 'string' },
          bytes: { type: 'integer' },
          total: { type: 'integer' },
          message: { type: 'string' },
        },
        required: ['matched', 'message'],
        additionalProperties: false,
      },
      render: (_args: unknown, value: unknown): ContentBlock[] => {
        const result = value as MatchStickerOutput;
        return [{ type: 'text', text: result.message }];
      },
    },
    async execute(args: unknown): Promise<MatchStickerOutput> {
      const { image } = args as MatchStickerArgs;
      if (typeof image !== 'string' || image.trim().length === 0) {
        throw new Error('qqbot_match_sticker: `image` 必须是图片绝对路径');
      }
      const match = store.match(image.trim());
      if (match === undefined) {
        return {
          matched: false,
          message: '表情库里没有完全相同的图片。先自己看图读出文字和模板（看不到原图或文字太小时再用 qqbot_describe_image），再用 web_search 查梗。',
        };
      }
      const note = match.note !== undefined ? `；备注：${match.note}` : '';
      return {
        matched: true,
        file: match.file,
        emotion: match.emotion,
        ...(match.note !== undefined ? { note: match.note } : {}),
        bytes: match.bytes,
        total: match.total,
        message: `表情库命中「${match.emotion}」→ ${match.file}（${match.bytes} bytes，共 ${match.total} 条${note}）。可用 qqbot_send_file 发出，或直接用这个情绪回应。`,
      };
    },
  };

  tools.register(definition);
  logger.info('im-qqbot: qqbot_match_sticker 工具已注册');
}
