import { describe, expect, it } from 'vitest';
import { buildGifSheetNote, isGifBytes, sheetFilter, sheetLayout } from './gif-sheet.ts';
import { withSniffedExtension } from '../transport/attachment.ts';

const gifBytes = (...head: number[]) => Uint8Array.from([...head, ...new Array(20).fill(0)]);

describe('isGifBytes', () => {
  it('recognizes GIF87a / GIF89a by header, not by name', () => {
    expect(isGifBytes(Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBe(true);
    expect(isGifBytes(Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]))).toBe(true);
  });

  it('rejects jpeg/png and short buffers', () => {
    expect(isGifBytes(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe(false);
    expect(isGifBytes(Uint8Array.from([0x47, 0x49]))).toBe(false);
  });
});

describe('sheetLayout', () => {
  it('uses two columns up to four frames and three above', () => {
    expect(sheetLayout(2)).toEqual({ cols: 2, rows: 1, count: 2 });
    expect(sheetLayout(4)).toEqual({ cols: 2, rows: 2, count: 4 });
    expect(sheetLayout(9)).toEqual({ cols: 3, rows: 3, count: 9 });
  });

  it('caps the sheet at nine frames', () => {
    expect(sheetLayout(200).count).toBe(9);
  });
});

describe('sheetFilter', () => {
  it('picks an even sampling step so the grid fills up', () => {
    const filter = sheetFilter(36);
    expect(filter).toContain('mod(n\\,4)');
    expect(filter).toContain('tile=3x3');
  });

  it('never samples less often than every frame', () => {
    expect(sheetFilter(3)).toContain('mod(n\\,1)');
  });
});

describe('buildGifSheetNote', () => {
  it('states frame count and reading order', () => {
    const note = buildGifSheetNote({ path: 'x.png', frames: 9 });
    expect(note).toContain('9 帧');
    expect(note).toContain('3x3');
    expect(note).toContain('从左到右');
  });
});

describe('withSniffedExtension', () => {
  it('renames a gif that QQ shipped as .jpg', () => {
    expect(withSniffedExtension('F3F4636CE9.jpg', gifBytes(0x47, 0x49, 0x46, 0x38))).toBe('F3F4636CE9.gif');
  });

  it('keeps a correct extension and treats jpeg as jpg', () => {
    expect(withSniffedExtension('a.png', gifBytes(0x89, 0x50, 0x4e, 0x47))).toBe('a.png');
    expect(withSniffedExtension('a.jpeg', gifBytes(0xff, 0xd8, 0xff, 0xe0))).toBe('a.jpeg');
  });

  it('leaves unknown bytes alone', () => {
    expect(withSniffedExtension('report.bin', gifBytes(1, 2, 3, 4))).toBe('report.bin');
  });
});
