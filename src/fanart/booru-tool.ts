/**
 * qqbot_booru_fetch — 按 tag 抽一张 booru 图，下载校验后交给 qqbot_send_file。
 *
 * 存在意义：定时推送类任务（角色新图、同人图日报）以前每轮都在 prompt 里写死
 * 「用 node 写个 dl-xxx.cjs 下载」，一轮一个一次性脚本，state/ 里堆了几十个。
 * 搜索、下载、Cloudflare/代理绕行、已发去重这些固化成工具之后，任务 prompt 只剩
 * 「调工具 → 发图」两句。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ContentBlock, ImageBlock } from '@deepseek-ai/dsh-llm';
import type { ImQQBotConfig } from '../config.ts';
import { loadNativeImageBlock, type AttachmentStoreLike } from '../media/native-image.ts';
import type { Logger } from '../types.ts';
import { fetchBooruImage, sanitizeTags, type BooruFetchMode, type BooruFetchResult } from './booru-post.ts';
import type { HttpGet } from './http.ts';
import type { FanartSeenStore } from './seen.ts';

export const BOORU_FETCH_TOOL_NAME = 'qqbot_booru_fetch';

/** 图进上下文的大小上限（超了就不附，模型只拿路径） */
const ATTACH_MAX_BYTES = 5 * 1024 * 1024;
const MIN_EDGE_DEFAULT = 800;

const DESCRIPTION =
  'Search safebooru by tag and download ONE image to disk, ready to send with qqbot_send_file. '
  + 'Use this for recurring character fan-art posts ("new picture of X") instead of writing per-run download '
  + 'scripts: it already handles the search, the CDN/proxy quirks, the file-type and size checks, and skips ids '
  + 'that were already sent (the send-file hook marks the image as seen, so nothing needs bookkeeping). '
  + 'mode="latest" takes the newest unseen post (polling for new art); mode="random" takes a random unseen one '
  + '(daily drip). Returns the local path plus tags/source. If it returns ok=false, send nothing and stay silent.';

interface ToolsRegistryLike {
  register(definition: unknown): unknown;
}

interface FetchArgs {
  tags?: string;
  mode?: string;
  min_edge?: number;
}

export interface BooruFetchToolDeps {
  get: HttpGet;
  seen: FanartSeenStore;
  candidatesDir: string;
}

export function renderBooruFetchText(result: BooruFetchResult, imageAttached: boolean): string {
  if (!result.ok) return `没取到可发的图：${result.reason}。这一轮不要发任何消息。`;
  const lines = [
    `取到 post ${result.id}（${result.width}x${result.height}，${Math.round(result.bytes / 1024)}KB）`,
    `path: ${result.path}`,
    `出处: ${result.pageUrl}`,
  ];
  if (result.sourceUrl !== undefined) lines.push(`原帖: ${result.sourceUrl}`);
  if (result.author !== undefined) lines.push(`画师: ${result.author}`);
  if (result.tags.length > 0) lines.push(`tags: ${result.tags.slice(0, 24).join(' ')}`);
  lines.push(imageAttached ? '图见下方，直接拿 path 调 qqbot_send_file，caption 一两句中文。' : '拿 path 调 qqbot_send_file，caption 一两句中文。');
  return lines.join('\n');
}

export function registerBooruFetchTool(
  ctx: Context,
  config: ImQQBotConfig,
  deps: BooruFetchToolDeps,
  logger: Logger,
): void {
  const tools = ctx.get('tools') as ToolsRegistryLike | undefined;
  if (!tools?.register) {
    logger.warn('im-qqbot: tools 服务不可用，qqbot_booru_fetch 工具未注册');
    return;
  }
  const attachments = ctx.get('attachments') as AttachmentStoreLike | undefined;

  tools.register({
    name: BOORU_FETCH_TOOL_NAME,
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        tags: {
          type: 'string',
          description: 'safebooru/danbooru tag query, e.g. "shinosawa_hiro rating:general -ai-generated". '
            + 'Unknown tags return nothing, so keep it to real tags.',
        },
        mode: {
          type: 'string',
          enum: ['latest', 'random'],
          description: '"latest" = newest unseen post (default for polling new art), "random" = random unseen post (default).',
        },
        min_edge: {
          type: 'integer',
          description: `Reject images whose shorter side is below this many pixels (default ${MIN_EDGE_DEFAULT}).`,
        },
      },
      required: ['tags'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args: unknown, value: unknown): ContentBlock[] => {
        const v = value as BooruFetchResult & { image?: ImageBlock };
        const blocks: ContentBlock[] = [{ type: 'text', text: renderBooruFetchText(v, v.image !== undefined) }];
        if (v.image !== undefined) blocks.push(v.image);
        return blocks;
      },
    },
    async execute(args: unknown): Promise<Record<string, unknown>> {
      const { tags: rawTags, mode: rawMode, min_edge: rawMinEdge } = (args ?? {}) as FetchArgs;
      const tags = sanitizeTags(rawTags);
      if (tags === undefined) {
        return { ok: false, reason: 'tags 为空或过长' } satisfies Record<string, unknown>;
      }
      const mode: BooruFetchMode = rawMode === 'latest' ? 'latest' : 'random';
      const minEdge = typeof rawMinEdge === 'number' && Number.isFinite(rawMinEdge)
        ? Math.min(2000, Math.max(400, Math.floor(rawMinEdge)))
        : MIN_EDGE_DEFAULT;
      const started = Date.now();

      const result = await fetchBooruImage({ tags, mode }, {
        get: deps.get,
        candidatesDir: deps.candidatesDir,
        seen: deps.seen.load('booru'),
        minEdge,
      });

      let image: ImageBlock | undefined;
      if (result.ok && config.vision.native && attachments?.saveImage) {
        image = await loadNativeImageBlock(attachments, result.path, ATTACH_MAX_BYTES).catch(() => undefined);
      }
      logger.info(
        `im-qqbot: qqbot_booru_fetch ${mode} ${tags} → ${result.ok ? result.id : result.reason}（${Date.now() - started}ms）`,
      );
      return { ...result, ...(image === undefined ? {} : { image }) } as unknown as Record<string, unknown>;
    },
  });
  logger.info(`im-qqbot: ${BOORU_FETCH_TOOL_NAME} 工具已注册`);
}
