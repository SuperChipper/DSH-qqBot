/**
 * 合并转发（聊天记录）里的图片 — 从转发文本里提取图片 URL，下载到 media，并在上下文里替换成编号标记。
 *
 * QQ 开放平台不会把转发里的图片放进 attachments：整段聊天记录被展开成纯文本塞进 content
 * （引用转发时在 msg_elements[0].content），每张图是一行
 *   [附件1] 类型:图片 文件名:XXX.jpg 尺寸:240x240 大小:30.6KB URL:https://multimedia.nt.qq.com.cn/download?...
 * 不额外调 API 就能拿到 URL，但原样留在文本里模型只看到一串链接（rkey 过期后也打不开）。
 * 这里把这些 URL 提取出来走和历史图片同一套下载/缓存，再把那一行改写成 [图片#n: 本地路径]。
 */
import type { MediaConfig } from '../config.ts';
import type { Logger } from '../types.ts';
import { downloadRecentHistoryImages, type HistoryImage } from './history-images.ts';

/** 每条消息最多下载的转发图片张数（按出现顺序，靠前优先；其余保留 URL） */
export const MAX_FORWARD_IMAGES = 8;

/** 转发文本里的一张图片；localPath 仅在下载成功后存在 */
export interface ForwardImage {
  url: string;
  filename?: string;
  localPath?: string;
}

/** 编号后的转发图片（index 和上下文里的 [图片#n] 对应） */
export interface TaggedForwardImage extends ForwardImage {
  index: number;
}

/** 转发文本里的图片附件行：前缀 [附件n]、中间的 文件名/尺寸/大小、行尾 URL */
const FORWARD_IMAGE_LINE = /^([ \t]*\[附件\d+\][ \t]*)类型:图片(.*?)URL:(https?:\/\/\S+)(?=[ \t\r]*$)/gm;

/** 按出现顺序提取转发文本里的图片（按 URL 去重） */
export function extractForwardImages(...texts: Array<string | undefined>): ForwardImage[] {
  const byUrl = new Map<string, ForwardImage>();
  for (const text of texts) {
    if (!text) continue;
    for (const match of text.matchAll(FORWARD_IMAGE_LINE)) {
      const url = match[3]!;
      if (byUrl.has(url)) continue;
      const filename = /文件名:(\S+)/.exec(match[2] ?? '')?.[1];
      byUrl.set(url, { url, ...(filename !== undefined ? { filename } : {}) });
    }
  }
  return [...byUrl.values()];
}

/**
 * 下载前 limit 张转发图片，成功的写回 localPath（复用历史图片的下载与 URL 缓存，失败只记日志）。
 */
export async function downloadForwardImages(
  images: ForwardImage[],
  media: MediaConfig,
  logger: Logger,
  limit: number = MAX_FORWARD_IMAGES,
  downloader?: Parameters<typeof downloadRecentHistoryImages>[4],
): Promise<void> {
  const targets: HistoryImage[] = images.slice(0, Math.max(0, limit)).map((image, i) => ({
    index: i + 1,
    messageId: 'forward',
    url: image.url,
    filename: image.filename || `forward_${i + 1}.jpg`,
  }));
  if (targets.length === 0) return;
  await downloadRecentHistoryImages(targets, media, logger, targets.length, downloader);
  targets.forEach((target, i) => {
    if (target.localPath !== undefined) images[i]!.localPath = target.localPath;
  });
}

/**
 * 转发图片编号器：同一 URL 共用一个编号，编号从 startIndex + 1 起（接在历史图片后面，避免撞号）。
 * rewrite 把文本里的图片附件行改写成 `[附件k] [图片#n: 本地路径] 尺寸:WxH`，没下载成功的给 URL。
 */
export function createForwardTagger(images: readonly ForwardImage[] | undefined, startIndex: number) {
  const byUrl = new Map((images ?? []).map((image) => [image.url, image]));
  const tagged: TaggedForwardImage[] = [];
  const indexByUrl = new Map<string, number>();

  const rewrite = (text: string): string => {
    if (byUrl.size === 0 || !text) return text;
    return text.replace(FORWARD_IMAGE_LINE, (line, prefix: string, middle: string, url: string) => {
      const image = byUrl.get(url);
      if (image === undefined) return line;
      let index = indexByUrl.get(url);
      if (index === undefined) {
        index = startIndex + tagged.length + 1;
        indexByUrl.set(url, index);
        tagged.push({ ...image, index });
      }
      const size = /尺寸:(\S+)/.exec(middle)?.[1];
      return `${prefix}[图片#${index}: ${image.localPath ?? url}]${size !== undefined ? ` 尺寸:${size}` : ''}`;
    });
  };

  return { rewrite, tagged };
}
