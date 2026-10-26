/**
 * 兜底解析模型误写成文本的工具调用。
 *
 * 模型偶尔会把 `qqbot_save_sticker` 写成：
 *   <qqbot_save_sticker>
 *   <image>...</image>
 *   <emotion>...</emotion>
 *   </qqbot_save_sticker>
 * 这不是工具调用，会被当普通文字发出去。这里负责：
 *   - 从出站文本中剥离完整/未完成的标签块，避免用户看到 XML；
 *   - 解析成可执行的收藏参数，供调用方补执行。
 */

export interface PseudoStickerCall {
  image: string;
  emotion: string;
  note?: string;
  file?: string;
}

export interface PseudoStickerExtraction {
  /** 去掉伪调用块后的可见文本 */
  visible: string;
  /** 解析出的收藏调用（可能为空） */
  calls: PseudoStickerCall[];
}

const OPEN_TAG = '<qqbot_save_sticker';
const COMPLETE_BLOCK = /<qqbot_save_sticker([^>]*)>([\s\S]*?)<\/qqbot_save_sticker>/gi;

function readBodyTag(body: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i').exec(body);
  const value = match?.[1]?.trim();
  return value !== undefined && value.length > 0 ? value : undefined;
}

function readAttr(attrs: string, name: string): string | undefined {
  const match = new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(attrs);
  const value = match?.[1]?.trim();
  return value !== undefined && value.length > 0 ? value : undefined;
}

function parseCall(attrs: string, body: string): PseudoStickerCall | undefined {
  const image = readBodyTag(body, 'image') ?? readAttr(attrs, 'image');
  const emotion = readBodyTag(body, 'emotion') ?? readAttr(attrs, 'emotion');
  if (image === undefined || emotion === undefined) return undefined;
  const note = readBodyTag(body, 'note') ?? readAttr(attrs, 'note');
  const file = readBodyTag(body, 'file') ?? readAttr(attrs, 'file');
  return {
    image,
    emotion,
    ...(note !== undefined ? { note } : {}),
    ...(file !== undefined ? { file } : {}),
  };
}

/** 去掉末尾处于「可能正在流式输出开标签」的半截前缀 */
function stripTrailingPartialOpen(text: string, openTag: string): string {
  const lower = text.toLowerCase();
  for (let length = Math.min(openTag.length, lower.length); length >= 8; length -= 1) {
    if (lower.endsWith(openTag.slice(0, length))) {
      return text.slice(0, text.length - length);
    }
  }
  return text;
}

/** 剥离指定工具的伪调用块（完整/未闭合/流式半截），不执行 */
function stripPseudoBlock(text: string, tag: string): string {
  const openTag = `<${tag}`;
  let visible = text.replace(new RegExp(`<${tag}[^>]*>[\\s\\S]*?</${tag}>`, 'gi'), '');
  const lastOpen = visible.toLowerCase().lastIndexOf(openTag);
  if (lastOpen >= 0) visible = visible.slice(0, lastOpen);
  visible = stripTrailingPartialOpen(visible, openTag);
  return visible.replace(/\n{3,}/g, '\n\n').trimEnd();
}

/**
 * 解析并剥离伪调用。
 *
 * 流式场景下会被反复调用：完整块移除、未闭合块从开标签到结尾移除、
 * 末尾半截开标签也先扣住，保证用户看不到 XML 碎片。
 */
export function extractPseudoStickerCalls(text: string): PseudoStickerExtraction {
  const calls: PseudoStickerCall[] = [];
  let visible = text.replace(COMPLETE_BLOCK, (_whole, attrs: string, body: string) => {
    const call = parseCall(attrs, body);
    if (call !== undefined) calls.push(call);
    return '';
  });

  // 未闭合块（流式中途）：从最后一个开标签一直扣到结尾
  const lastOpen = visible.toLowerCase().lastIndexOf(OPEN_TAG);
  if (lastOpen >= 0) {
    visible = visible.slice(0, lastOpen);
  }

  visible = stripTrailingPartialOpen(visible, OPEN_TAG);
  // 移除块后可能留下多余空行，但不破坏正常段落
  visible = visible.replace(/\n{3,}/g, '\n\n').trimEnd();
  return { visible, calls };
}

/** 只取可见文本，不执行调用（流式 update 用） */
export function sanitizePseudoStickerText(text: string): string {
  return extractPseudoStickerCalls(text).visible;
}

/** 剥离 qqbot_send_file 的伪调用文本（图片/文件可能已由真实工具发出，不重复执行） */
export function stripPseudoSendFileText(text: string): string {
  return stripPseudoBlock(text, 'qqbot_send_file');
}

/** 统一清洗：贴纸伪调用剥离 + send_file 伪调用剥离 */
export function sanitizePseudoToolText(text: string): string {
  return stripPseudoSendFileText(sanitizePseudoStickerText(text));
}
