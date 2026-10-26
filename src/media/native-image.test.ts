import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadNativeImageBlock, sniffImageMediaType, type AttachmentStoreLike } from './native-image.ts';

const dirs: string[] = [];
function tempPng(bytes: number[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'native-image-'));
  dirs.push(dir);
  const path = join(dir, 'test.png');
  writeFileSync(path, Buffer.from(bytes));
  return path;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0];

describe('native image', () => {
  it('按 magic bytes 识别 PNG/JPEG/GIF/WebP', () => {
    expect(sniffImageMediaType(Uint8Array.from(PNG))).toBe('image/png');
    expect(sniffImageMediaType(Uint8Array.from([0xff, 0xd8, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe('image/jpeg');
    expect(sniffImageMediaType(Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe('image/gif');
    expect(sniffImageMediaType(Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]))).toBe('image/webp');
    expect(sniffImageMediaType(Uint8Array.from([1, 2, 3, 4]))).toBeUndefined();
  });

  it('保存为 attachment 并返回 ImageBlock', async () => {
    const ref = { attachmentId: 'sha256:abc', mediaType: 'image/png', bytes: 12, width: 1, height: 1 };
    const saveImage = vi.fn(async () => ref);
    const attachments: AttachmentStoreLike = { saveImage };
    const path = tempPng(PNG);

    const block = await loadNativeImageBlock(attachments, path, 1024);
    expect(block).toEqual({ type: 'image', attachment: ref });
    expect(saveImage).toHaveBeenCalledWith(expect.objectContaining({ mediaType: 'image/png', name: 'test.png' }));
  });

  it('超大/格式不支持/文件不存在时返回 undefined', async () => {
    const attachments: AttachmentStoreLike = { saveImage: vi.fn(async () => { throw new Error('should not save'); }) };
    expect(await loadNativeImageBlock(attachments, tempPng(PNG), 4)).toBeUndefined();
    expect(await loadNativeImageBlock(attachments, tempPng([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]), 1024)).toBeUndefined();
    expect(await loadNativeImageBlock(attachments, join(tmpdir(), 'no-such-native-image.png'), 1024)).toBeUndefined();
    expect(attachments.saveImage).not.toHaveBeenCalled();
  });
});
