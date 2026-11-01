const VOICE_EXTS = new Set(['.mp3', '.wav', '.ogg', '.aac', '.silk', '.amr']);

export function isVoiceFile(fileName: string): boolean {
  return VOICE_EXTS.has(fileName.slice(fileName.lastIndexOf('.')).toLowerCase());
}

// 文字是否需要补充由模型正常判断；发送层负责拆开消息，而不是让模型闭嘴。
export const VOICE_REPLY_REMINDER = '语音已单独发送。需要补充说明时继续正常输出文字，系统会把后续文字作为独立消息排队发送，并在语音后留出间隔；不必等用户再说话，也不必重复发送语音里的文字。语音不支持 caption，未发送的配文可改为文字补充。';

export const VOICE_REPLY_TOOL_HINT = 'Voice is sent as a standalone message. Continue with any useful companion text normally: the delivery layer queues it as a separate message with a gap after the voice. You do not need to wait for another user message. Voice has no caption; an ignored caption may be supplied as text, but do not repeat the spoken text unnecessarily.';
