/**
 * 富媒体下载目录（仓库内 media/）。过期清理由 cleanup.ts 的 media 规则负责：
 * 文件写入后不再变更，按文件 mtime 判断是否超过 media.ttlHours，并受 media.maxTotalMB 总量上限约束。
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 富媒体下载根目录（仓库内 media/，attachment.ts 复用） */
export const MEDIA_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'media');
