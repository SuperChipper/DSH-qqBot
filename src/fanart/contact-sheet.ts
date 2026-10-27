/**
 * 候选对比图：把几张候选缩成同尺寸格子拼成一张，左上角标编号。
 * 模型看一张图就能比较，比逐张 read_image 省 token 也省一轮工具调用。
 *
 * sharp 是可选依赖：装不上时返回 undefined，调用方退化成让模型逐张看。
 */

const CELL_W = 400;
const CELL_H = 520;
const GAP = 8;
const MAX_COLS = 3;

type SharpFactory = (input?: unknown, options?: unknown) => {
  resize(options: unknown): ReturnType<SharpFactory>;
  composite(layers: unknown[]): ReturnType<SharpFactory>;
  jpeg(options: unknown): ReturnType<SharpFactory>;
  toBuffer(): Promise<Buffer>;
  toFile(path: string): Promise<unknown>;
};

let sharpPromise: Promise<SharpFactory | undefined> | undefined;

async function loadSharp(): Promise<SharpFactory | undefined> {
  sharpPromise ??= import('sharp')
    .then((mod) => ((mod as { default?: unknown }).default ?? mod) as SharpFactory)
    .catch(() => undefined);
  return sharpPromise;
}

function labelSvg(n: number): Buffer {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">`
    + `<circle cx="32" cy="32" r="28" fill="#000" fill-opacity="0.7"/>`
    + `<text x="32" y="44" font-size="34" font-family="Arial, sans-serif" font-weight="bold" fill="#fff" text-anchor="middle">${n}</text>`
    + `</svg>`,
  );
}

/** 拼对比图写到 outPath；成功返回 outPath，sharp 不可用或全部图片读不了返回 undefined */
export async function buildContactSheet(imagePaths: readonly string[], outPath: string): Promise<string | undefined> {
  const sharp = await loadSharp();
  if (sharp === undefined || imagePaths.length === 0) return undefined;

  const cols = Math.min(MAX_COLS, imagePaths.length);
  const rows = Math.ceil(imagePaths.length / cols);
  const width = cols * CELL_W + (cols + 1) * GAP;
  const height = rows * CELL_H + (rows + 1) * GAP;

  const layers: unknown[] = [];
  for (let i = 0; i < imagePaths.length; i++) {
    const left = GAP + (i % cols) * (CELL_W + GAP);
    const top = GAP + Math.floor(i / cols) * (CELL_H + GAP);
    try {
      const tile = await sharp(imagePaths[i])
        .resize({ width: CELL_W, height: CELL_H, fit: 'contain', background: '#ffffff' })
        .toBuffer();
      layers.push({ input: tile, left, top });
    } catch {
      continue;
    }
    layers.push({ input: labelSvg(i + 1), left: left + 6, top: top + 6 });
  }
  if (layers.length === 0) return undefined;

  await sharp({ create: { width, height, channels: 3, background: '#e5e5e5' } })
    .composite(layers)
    .jpeg({ quality: 82 })
    .toFile(outPath);
  return outPath;
}
