/**
 * qqbot_fanart_pick — 一次抽几张百合同人图候选，拼成带编号的对比图交给模型挑。
 *
 * 模型看对比图挑一张，再用 qqbot_send_file 发出；发送成功后由 send-file 的回调
 * 把那张记为已发（markSentCandidate），没选中的候选下次还能抽到。
 */
import { join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { ContentBlock, ImageBlock } from '@deepseek-ai/dsh-llm';
import type { ImQQBotConfig } from '../config.ts';
import { loadNativeImageBlock, type AttachmentStoreLike } from '../media/native-image.ts';
import type { Logger } from '../types.ts';
import type { HttpGet } from './http.ts';
import { loadPool, pickFanart, type PickedCandidate, type PickResult, type PickSourceMode } from './pick.ts';
import type { FanartSeenStore } from './seen.ts';
import type { BooruPoolEntry, PixivPoolEntry } from './types.ts';

export const FANART_PICK_TOOL_NAME = 'qqbot_fanart_pick';

const MAX_COUNT = 6;
const DEFAULT_COUNT = 3;
/** 对比图进上下文的大小上限 */
const SHEET_MAX_BYTES = 5 * 1024 * 1024;

const DESCRIPTION =
  'Fetch several yuri fan-art candidates at once (pixiv + safebooru, all-ages, both characters of the couple '
  + 'tag-matched, popularity-weighted, one image per artist) and return them with a numbered contact sheet. '
  + 'Look at the sheet, pick the best-drawn image whose characters really match the couple, then send ONLY that '
  + `one with qqbot_send_file (put the source link in the caption). Only the image you send is marked as posted; `
  + 'the rest can be drawn again later. If none is good enough, call this tool once more instead of sending a weak one.';

interface ToolsRegistryLike {
  register(definition: unknown): unknown;
}

interface PickArgs {
  count?: number;
  cp?: string;
  source?: string;
  cp_only?: boolean;
}

export interface FanartToolDeps {
  get: HttpGet;
  seen: FanartSeenStore;
  /** pixiv-tags.json / fanart-tags.json 所在目录 */
  poolDir: string;
  candidatesDir: string;
}

function describeCandidate(c: PickedCandidate): string {
  const parts = [
    `#${c.index}`,
    c.source,
    c.cp ? `「${c.cp}」` : '随机百合',
    c.author ? `画师 ${c.author}` : undefined,
    c.bookmarks !== undefined ? `收藏 ${c.bookmarks}` : '收藏未知',
    `${c.width}x${c.height}`,
  ].filter(Boolean);
  return `${parts.join(' · ')}\n   path: ${c.path}\n   出处: ${c.pageUrl}`;
}

export function renderPickText(v: PickResult, sheetAttached: boolean): string {
  if (v.candidates.length === 0) {
    return `这次没抽到可用的候选。${v.failures.length ? `\n原因：${v.failures.join('；')}` : ''}`;
  }
  const lines = [`抽到 ${v.candidates.length} 张候选：`, ...v.candidates.map(describeCandidate)];
  if (v.sheetPath) {
    lines.push(sheetAttached
      ? `对比图（编号对应上面）已附在下面：${v.sheetPath}`
      : `对比图（编号对应上面）：${v.sheetPath}，先看这张再挑。`);
  }
  lines.push('挑一张用 qqbot_send_file 发（caption 带出处链接）；只有发出去的那张会记为已发。');
  if (v.failures.length) lines.push(`部分查询失败：${v.failures.join('；')}`);
  return lines.join('\n');
}

export function registerFanartPickTool(
  ctx: Context,
  config: ImQQBotConfig,
  deps: FanartToolDeps,
  logger: Logger,
): void {
  const tools = ctx.get('tools') as ToolsRegistryLike | undefined;
  if (!tools?.register) {
    logger.warn('im-qqbot: tools 服务不可用，qqbot_fanart_pick 工具未注册');
    return;
  }
  const attachments = ctx.get('attachments') as AttachmentStoreLike | undefined;

  tools.register({
    name: FANART_PICK_TOOL_NAME,
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        count: { type: 'integer', description: `How many candidates to fetch (1-${MAX_COUNT}, default ${DEFAULT_COUNT}).` },
        cp: { type: 'string', description: 'Optional couple name from the pool (e.g. "芙星"); omit to mix several couples.' },
        source: { type: 'string', enum: ['mix', 'pixiv', 'booru'], description: 'Which site to search (default mix).' },
        cp_only: { type: 'boolean', description: 'Booru: only search the couple pool, skip random yuri (default false).' },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args: unknown, value: unknown): ContentBlock[] => {
        const v = value as PickResult & { sheetImage?: ImageBlock };
        const blocks: ContentBlock[] = [{ type: 'text', text: renderPickText(v, v.sheetImage !== undefined) }];
        if (v.sheetImage !== undefined) blocks.push(v.sheetImage);
        return blocks;
      },
    },
    async execute(args: unknown): Promise<Record<string, unknown>> {
      const { count, cp, source, cp_only } = (args ?? {}) as PickArgs;
      const n = typeof count === 'number' && Number.isFinite(count)
        ? Math.min(MAX_COUNT, Math.max(1, Math.floor(count)))
        : DEFAULT_COUNT;
      const mode: PickSourceMode = source === 'pixiv' || source === 'booru' ? source : 'mix';
      const started = Date.now();

      const result = await pickFanart(
        { count: n, ...(typeof cp === 'string' && cp.trim() ? { cp: cp.trim() } : {}), source: mode, cpOnly: cp_only === true },
        {
          get: deps.get,
          seen: deps.seen,
          pixivPool: loadPool<PixivPoolEntry>(join(deps.poolDir, 'pixiv-tags.json'), (e) => !!e.name && !!e.words),
          booruPool: loadPool<BooruPoolEntry>(join(deps.poolDir, 'fanart-tags.json'), (e) => !!e.name && !!e.tags),
          candidatesDir: deps.candidatesDir,
        },
      );

      let sheetImage: ImageBlock | undefined;
      if (config.vision.native && attachments?.saveImage && result.sheetPath) {
        sheetImage = await loadNativeImageBlock(attachments, result.sheetPath, SHEET_MAX_BYTES).catch(() => undefined);
      }
      logger.info(
        `im-qqbot: qqbot_fanart_pick ${result.candidates.length}/${n} 张，用时 ${Date.now() - started}ms`
        + (result.failures.length ? `，失败: ${result.failures.join('；')}` : ''),
      );
      return { ...result, ...(sheetImage !== undefined ? { sheetImage } : {}) } as unknown as Record<string, unknown>;
    },
  });
  logger.info('im-qqbot: qqbot_fanart_pick 工具已注册');
}
