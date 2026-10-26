/**
 * 原生图片输入辅助：把本地图片交给 dsh attachments 服务，生成 ImageBlock。
 *
 * 只有主模型路由声明了 image 输入时才应调用；否则请求会在适配器处失败。
 * 图片字节进入 attachments（content-addressed），session log 只存引用。
 */
import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import type { ImageBlock } from '@deepseek-ai/dsh-llm';

type ImageAttachmentRef = ImageBlock['attachment'];
export type NativeImageMediaType = ImageAttachmentRef['mediaType'];

export interface AttachmentStoreLike {
  saveImage(input: { data: Uint8Array; mediaType: NativeImageMediaType; name?: string }): Promise<ImageAttachmentRef>;
}

/** 图片 magic bytes 嗅探 → 标准 MIME（不信扩展名） */
export function sniffImageMediaType(bytes: Uint8Array): NativeImageMediaType | undefined {
  if (bytes.length < 12) return undefined;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'image/gif';
  if (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) return 'image/webp';
  return undefined;
}

/**
 * 读取本地图片并提交为 attachment，返回可直接放进 user message 的 ImageBlock。
 * 失败（文件缺失/超大/格式不支持/附件服务不可用）返回 undefined，由调用方回退到文本/视觉工具。
 */
export async function loadNativeImageBlock(
  attachments: AttachmentStoreLike,
  path: string,
  maxBytes: number,
): Promise<ImageBlock | undefined> {
  const info = await stat(path).catch(() => undefined);
  if (info === undefined || !info.isFile()) return undefined;
  if (info.size <= 0 || info.size > maxBytes) return undefined;

  const data = new Uint8Array(await readFile(path));
  const mediaType = sniffImageMediaType(data);
  if (mediaType === undefined) return undefined;
  const ref = await attachments.saveImage({ data, mediaType, name: basename(path) });
  return { type: 'image', attachment: ref };
}
