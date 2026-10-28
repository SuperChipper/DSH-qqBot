/**
 * SDK MiddlewareState 类型扩展
 *
 * 为 @tencent-connect/qqbot-nodejs 的 MiddlewareState 添加
 * 项目自定义中间件填充的 well-known keys 类型声明。
 *
 * 这些字段由项目中间件填充：
 * - downloadedFiles: attachmentProcessor 中间件 → 下载到本地的当前消息附件
 * - downloadedQuoteFiles: attachmentProcessor 中间件 → 下载到本地的引用消息附件
 * - processedAttachments: attachmentProcessor 中间件 → 语音转写结果
 * - forwardImages: attachmentProcessor 中间件 → 合并转发（聊天记录）里的图片
 */
import '@tencent-connect/qqbot-nodejs';
import type { DownloadedFile } from './transport/attachment.ts';
import type { ForwardImage } from './media/forward-images.ts';
import type { ProcessedAttachment } from './types.ts';

declare module '@tencent-connect/qqbot-nodejs' {
  interface MiddlewareState {
    /** attachmentProcessor 下载到本地的当前消息附件结果 */
    downloadedFiles?: DownloadedFile[];
    /** attachmentProcessor 下载到本地的引用消息附件结果 */
    downloadedQuoteFiles?: DownloadedFile[];
    /** attachmentProcessor 处理后的附件（语音转写文本） */
    processedAttachments?: ProcessedAttachment[];
    /** attachmentProcessor 从合并转发文本里提取并下载的图片 */
    forwardImages?: ForwardImage[];
  }
}
