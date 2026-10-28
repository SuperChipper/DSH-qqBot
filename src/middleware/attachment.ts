/**
 * 富媒体下载中间件 — 在中间件链中下载 image/video/file 附件，并按 asr 配置转写语音
 *
 * 结果写入 ctx.state.downloadedFiles / processedAttachments，供 handleInbound 读取。
 * 下载失败不阻断消息（记录告警后放行），确保附件异常不影响正常文本处理。
 */
import type { MiddlewareContext } from '@tencent-connect/qqbot-nodejs';
import { classifyContentType, downloadMediaAttachments } from '../transport/attachment.ts';
import { transcribeVoice } from '../media/asr.ts';
import { downloadForwardImages, extractForwardImages } from '../media/forward-images.ts';
import type { AsrConfig, ImQQBotConfig } from '../config.ts';
import type { Logger, ProcessedAttachment, QuotedAttachment, RawAttachment } from '../types.ts';

export function attachmentProcessor(config: ImQQBotConfig, logger: Logger) {
  return async (ctx: MiddlewareContext, next: () => Promise<void>): Promise<void> => {
    const msg = ctx.message as { content?: string; attachments?: RawAttachment[] };

    try {
      // 当前消息附件
      const downloaded = await downloadMediaAttachments(msg.attachments, config.media, logger);
      ctx.state.downloadedFiles = downloaded;

      if (config.asr.enabled) {
        ctx.state.processedAttachments = await transcribeVoices(msg.attachments, config.asr, logger);
      }

      // 引用消息附件：转成 RawAttachment 结构复用下载（voice 由 downloadMediaAttachments 自动跳过）
      const quoteAttachments = (ctx.state as { quote?: { attachments?: QuotedAttachment[] } }).quote?.attachments;
      if (quoteAttachments && quoteAttachments.length > 0) {
        const rawQuote = quoteAttachments
          .filter(a => a.url)
          .map((a): RawAttachment => ({
            content_type: a.contentType ?? '',
            filename: a.filename ?? '',
            size: 0,
            url: a.url as string,
          }));
        const downloadedQuote = await downloadMediaAttachments(rawQuote, config.media, logger);
        ctx.state.downloadedQuoteFiles = downloadedQuote;
      }

      // 合并转发（聊天记录）里的图片只以 URL 文本出现在 content / 引用原文里，单独提取下载
      const quote = (ctx.state as { quote?: { text?: string; entry?: { content?: string } } }).quote;
      const forwardImages = extractForwardImages(msg.content, quote?.text || quote?.entry?.content);
      if (forwardImages.length > 0) {
        await downloadForwardImages(forwardImages, config.media, logger);
        ctx.state.forwardImages = forwardImages;
      }
    } catch (err) {
      logger.warn(`im-qqbot: attachment download failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    await next();
  };
}

/**
 * 转写当前消息的语音附件：preferQQ 时 QQ 自带 asr_refer_text 直接采用，否则调用在线 ASR。
 * 转写失败的语音不入结果，由 handleInbound 回退为 asr_refer_text 或语音链接。
 */
export async function transcribeVoices(
  attachments: RawAttachment[] | undefined,
  asr: AsrConfig,
  logger: Logger,
  transcribe: typeof transcribeVoice = transcribeVoice,
): Promise<ProcessedAttachment[]> {
  const results: ProcessedAttachment[] = [];
  for (const att of attachments ?? []) {
    if (classifyContentType(att.content_type) !== 'voice') continue;
    const qqText = att.asr_refer_text?.trim();
    if (qqText && asr.preferQQ) {
      results.push({ type: 'voice', filename: att.filename, url: att.url, voiceText: qqText, voiceSource: 'asr' });
      continue;
    }
    const transcript = await transcribe(att, asr, logger);
    if (transcript) {
      results.push({
        type: 'voice',
        filename: att.filename,
        url: att.url,
        voiceText: transcript.text,
        voiceSource: 'stt',
        duration: transcript.duration,
      });
    } else if (qqText) {
      results.push({ type: 'voice', filename: att.filename, url: att.url, voiceText: qqText, voiceSource: 'asr' });
    }
  }
  return results;
}
