/**
 * dsh-im-qqbot 插件内部类型定义
 */

/** 会话作用域 */
export type ChatScope = 'c2c' | 'group';

/** QQ 回复目标 */
export interface ReplyTarget {
  scope: ChatScope;
  targetId: string;
  msgId?: string;
  /** msgId 对应消息的接收时间（ms），用于判断被动回复窗口是否已过 */
  receivedAt?: number;
  /** 互动事件 id（带 INTERACTION_CREATE 前缀），填 event_id 字段，与 msgId 互斥 */
  eventId?: string;
}

/** SDK 原始消息附件（snake_case 字段，来自 QQ 网关 C2C_MESSAGE_CREATE） */
export interface RawAttachment {
  content_type: string;
  filename: string;
  size: number;
  url: string;
  asr_refer_text?: string;
  width?: number;
  height?: number;
  [key: string]: unknown;
}

/** 中间件预处理后的附件（目前只有语音转写结果，由 attachmentProcessor 填充） */
export interface ProcessedAttachment {
  type: 'voice' | 'image' | 'video' | 'file' | 'unknown';
  filename?: string;
  url?: string;
  localPath?: string;
  voiceText?: string;
  /** stt = 在线 ASR 转写，asr = QQ 自带 asr_refer_text */
  voiceSource?: 'stt' | 'asr' | 'fallback';
  /** 转写服务连不上（且没有 QQ 自带识别文本可用） */
  asrOffline?: boolean;
  duration?: number;
  width?: number;
  height?: number;
  size?: number;
}

/** 引用消息附件（quoteRef 中间件解析的 camelCase 视图） */
export interface QuotedAttachment {
  contentType?: string;
  url?: string;
  filename?: string;
  asrText?: string;
}

/** 插件 Logger 接口 */
export interface Logger {
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
  debug(msg: string, ...args: unknown[]): void;
}
