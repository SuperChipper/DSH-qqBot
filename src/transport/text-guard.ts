/**
 * 出站文本的最小体检。
 *
 * 模型发完图/表情后想「就此打住」，但又不肯真的输出空串，常补一个 `.` 或 `…` 当占位，
 * QQ 里就多出一个光秃秃的标点气泡。emoji 属于符号不算标点，单独的 emoji 仍照发。
 */
export function isBlankReply(text: string): boolean {
  return /^[\s\p{P}]*$/u.test(text);
}
