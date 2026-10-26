/**
 * caption 复读去重。
 *
 * 模型用 qqbot_send_file 把正文放进 caption 随图发出后，常在工具返回后再输出一遍同样的话，
 * QQ 里就多出一个复读气泡。出站前用本轮已发出的 caption 过滤 assistant 文本：
 *   - 文本是某条 caption 的复读/子串（含流式过程中的前缀）→ 整段不发；
 *   - 文本包含 caption 原文再加新内容 → 去掉 caption 部分，只发剩下的；
 *   - 剩下的只是一句「图已经发出去了，还附了一句…」式的发送汇报 → 整段不发。
 */

/** 发送汇报的最大长度（归一化后字数）：更长的文本可能有真内容，不按汇报吞掉 */
const NARRATION_MAX_CHARS = 80;

/** 「发出去了 / 已发送 / 附了一句 / 配了张图」等描述发送动作的说法 */
const NARRATION_PATTERN = /发(出去|过去|送|好|了)|已发|附(了|上|带)|配(了|上)|caption|\bsent\b|attached/i;

/** 去掉空白、标点、符号与 emoji 后比较，容忍模型改了标点或多带一个表情 */
function normalizeForEcho(text: string): string {
  return text.replace(/[\s\p{P}\p{S}\p{Extended_Pictographic}‍️]/gu, '');
}

/** 已随文件发出 caption 后，短文本又在汇报「发了什么」，视为多余的旁白 */
function isSendNarration(text: string): boolean {
  return normalizeForEcho(text).length <= NARRATION_MAX_CHARS && NARRATION_PATTERN.test(text);
}

/**
 * 过滤掉对已发 caption 的复读。
 *
 * @param text - 待发送的 assistant 文本（已做伪工具调用清洗）。
 * @param captions - 本轮已随文件成功发出的 caption。
 * @returns 去重后的可见文本；整段都是复读时返回空串。
 */
export function stripCaptionEcho(text: string, captions: readonly string[]): string {
  if (captions.length === 0 || !text.trim()) return text;

  let rest = text;
  for (const caption of captions) {
    if (caption.length > 0 && rest.includes(caption)) rest = rest.split(caption).join('');
  }

  const normalized = normalizeForEcho(rest);
  if (normalized.length === 0) return '';
  if (captions.some((caption) => normalizeForEcho(caption).includes(normalized))) return '';
  if (isSendNarration(rest)) return '';
  return rest === text ? text : rest.trim();
}

/** 从 qqbot_send_file 的原始 arguments JSON 中取出非空 caption */
export function captionFromArgs(args: string): string | undefined {
  try {
    const caption = (JSON.parse(args) as { caption?: unknown }).caption;
    return typeof caption === 'string' && caption.trim().length > 0 ? caption.trim() : undefined;
  } catch {
    return undefined;
  }
}
