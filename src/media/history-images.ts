/**
 * 群历史图片 — 给历史消息里的图片编号，并按需下载最近几张。
 *
 * 未 @bot 的群消息不经过附件下载，群记忆里只存了 QQ 下发的图片 URL。
 * bot 被触发、回灌群历史时，才把最近 MAX_HISTORY_IMAGES 张下载到 media 目录，
 * 以便原生注入或交给 qqbot_describe_image / qqbot_match_sticker。
 * URL → 本地路径做进程内缓存，同一张图在连续几次 @ 里只下载一次。
 */
import { existsSync } from 'node:fs';
import type { MediaConfig } from '../config.ts';
import type { GroupMemoryImage } from '../features/group-memory.ts';
import type { Logger, RawAttachment } from '../types.ts';
import { downloadMediaAttachments, type DownloadedFile } from '../transport/attachment.ts';

/** 每次触发最多下载/注入的历史图片张数（越新越优先） */
export const MAX_HISTORY_IMAGES = 4;

/** URL → 本地路径缓存上限（超出按插入顺序淘汰） */
const CACHE_LIMIT = 200;

const downloadedByUrl = new Map<string, string>();

/** 编号后的历史图片；localPath 仅在下载成功后存在 */
export interface HistoryImage {
  /** 在本次历史里的序号（从 1 开始，按时间正序） */
  index: number;
  messageId: string;
  url: string;
  filename?: string;
  localPath?: string;
}

type Downloader = (attachments: RawAttachment[], media: MediaConfig, logger: Logger) => Promise<DownloadedFile[]>;

/** 按时间正序给历史里的图片编号 */
export function numberHistoryImages(
  history: ReadonlyArray<{ messageId: string; images?: readonly GroupMemoryImage[] }>,
): HistoryImage[] {
  const result: HistoryImage[] = [];
  for (const entry of history) {
    for (const image of entry.images ?? []) {
      result.push({
        index: result.length + 1,
        messageId: entry.messageId,
        url: image.url,
        ...(image.filename !== undefined ? { filename: image.filename } : {}),
      });
    }
  }
  return result;
}

/**
 * 下载最近 limit 张历史图片，成功的写回 localPath（失败只记日志，保留 URL 兜底）。
 */
export async function downloadRecentHistoryImages(
  images: HistoryImage[],
  media: MediaConfig,
  logger: Logger,
  limit: number = MAX_HISTORY_IMAGES,
  downloader: Downloader = downloadMediaAttachments,
): Promise<void> {
  if (!media.enabled || limit <= 0) return;

  for (const image of images.slice(-limit)) {
    const cached = downloadedByUrl.get(image.url);
    if (cached !== undefined && existsSync(cached)) {
      image.localPath = cached;
      continue;
    }

    const [file] = await downloader(
      [{ content_type: 'image', filename: image.filename || `history_${image.index}.jpg`, size: 0, url: image.url }],
      media,
      logger,
    );
    if (file === undefined) continue;

    image.localPath = file.localPath;
    downloadedByUrl.delete(image.url);
    downloadedByUrl.set(image.url, file.localPath);
    if (downloadedByUrl.size > CACHE_LIMIT) {
      const oldest = downloadedByUrl.keys().next().value;
      if (oldest !== undefined) downloadedByUrl.delete(oldest);
    }
  }
}

/** 历史文本里的图片标记：有本地文件给路径，否则给 URL（可能已过期） */
export function historyImageTag(image: HistoryImage): string {
  return `[图片#${image.index}: ${image.localPath ?? image.url}]`;
}
