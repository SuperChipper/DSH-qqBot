/**
 * Bilibili 只读工具：搜索 / 视频信息 / 评论 / 字幕 / 扫码登录。
 *
 * 刻意不注册发评论、投币、收藏、私信、投稿等写操作：
 * 肥鱼只负责“看”，要发内容由用户自己决定。
 */
import { createRequire } from 'node:module';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import { PLUGIN_ROOT } from '../shared/index.ts';
import { BiliClient } from './client.ts';

const require = createRequire(import.meta.url);
const QRCode = require('qrcode') as {
  toFile(path: string, text: string, options?: Record<string, unknown>): Promise<void>;
};

interface ToolsRegistryLike {
  register(definition: unknown): unknown;
}

interface ToolLogger {
  info(message: string): void;
  warn(message: string): void;
}

export interface BiliToolDeps {
  client?: BiliClient;
  logger: ToolLogger;
  /** 把登录二维码发到当前 QQ 会话；返回 false/抛错时退化为返回本地路径 */
  sendQr?: (agent: unknown, qrPath: string, caption: string) => Promise<boolean>;
  /** 登录/使用登录态字幕的权限门；未提供时不做额外限制（本地 Web 场景） */
  permission?: (agent: unknown) => { allowed: boolean; reason?: string };
}

interface ToolRegistration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  output: {
    schema: Record<string, unknown>;
    render: (args: unknown, value: unknown) => ContentBlock[];
  };
  execute(args: unknown, exec: { signal: AbortSignal; agent?: unknown }): Promise<Record<string, unknown> | string>;
}

const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args: unknown, value: unknown): ContentBlock[] => [{ type: 'text', text: String(value) }],
};

const BVID_PATTERN = /BV[0-9A-Za-z]{10}/;

function bvidOf(value: string): string {
  const match = BVID_PATTERN.exec(value);
  return match?.[0] ?? value.trim();
}

function count(value: number): string {
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(1)}亿`;
  if (value >= 10_000) return `${(value / 10_000).toFixed(1)}万`;
  return String(value);
}

function dateOf(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—';
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

function loginHint(): string {
  return '还没有 B 站登录凭证。先调用 bili_login 生成二维码，用手机 B 站扫码（确认时选「记住我 / 长期」），扫完再调用 bili_login_check。';
}

export function registerBiliTools(tools: ToolsRegistryLike, deps: BiliToolDeps): void {
  const client = deps.client ?? new BiliClient();

  const ensurePermission = (agent: unknown): void => {
    if (deps.permission === undefined) return;
    const result = deps.permission(agent);
    if (!result.allowed) throw new Error(result.reason ?? '没有权限执行这个 B 站操作');
  };

  const search: ToolRegistration = {
    name: 'bili_search',
    description:
      'Search Bilibili public videos by keyword and return titles, BVIDs, authors, play counts and dates. '
      + 'Read-only; does not log in, post, like or comment.',
    parameters: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: 'Search keywords, e.g. "DeepSeek Harness" or "大肥鱼".' },
        limit: { type: 'number', description: 'Number of results, 1-20. Default 10.' },
        order: {
          type: 'string',
          enum: ['totalrank', 'click', 'pubdate'],
          description: 'Sort order: relevance (totalrank), most played (click), newest (pubdate).',
        },
      },
      required: ['keyword'],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      const { keyword, limit, order } = args as { keyword?: string; limit?: number; order?: 'totalrank' | 'click' | 'pubdate' };
      if (typeof keyword !== 'string' || keyword.trim().length === 0) {
        throw new Error('bili_search: keyword 不能为空');
      }
      const items = await client.search(keyword.trim(), limit ?? 10, order ?? 'totalrank');
      if (items.length === 0) return `B站搜索「${keyword}」没有结果。`;
      const lines = [`B站搜索「${keyword}」：`, ''];
      items.forEach((item, index) => {
        lines.push(`${index + 1}. [${item.title}](https://www.bilibili.com/video/${item.bvid})`);
        lines.push(`   UP主：${item.author}；播放：${count(item.play)}；发布：${dateOf(item.pubdate)}；时长：${item.duration || '—'}`);
      });
      lines.push('', '以上为公开搜索结果；需要看某个视频的字幕/评论，把 BVID 发我。');
      return lines.join('\n');
    },
  };

  const video: ToolRegistration = {
    name: 'bili_video',
    description: 'Get public metadata for one Bilibili video (title, author, stats, description, pages). Read-only.',
    parameters: {
      type: 'object',
      properties: {
        bvid: { type: 'string', description: 'BVID or a Bilibili video URL, e.g. BV1qbn16kEFh.' },
      },
      required: ['bvid'],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      const { bvid } = args as { bvid?: string };
      if (typeof bvid !== 'string' || bvid.trim().length === 0) throw new Error('bili_video: bvid 不能为空');
      const info = await client.video(bvidOf(bvid));
      return [
        `# ${info.title}`,
        '',
        `- 链接：https://www.bilibili.com/video/${info.bvid}`,
        `- UP主：${info.author}（UID ${info.authorUid}）`,
        `- 发布：${dateOf(info.pubdate)}；时长：${Math.floor(info.duration / 60)}:${String(info.duration % 60).padStart(2, '0')}`,
        `- 播放：${count(info.stats.view)}；点赞：${count(info.stats.like)}；评论：${count(info.stats.reply)}；收藏：${count(info.stats.favorite)}；投币：${count(info.stats.coin)}`,
        info.description.trim() ? `- 简介：${truncate(info.description.replace(/\s+/g, ' ').trim(), 500)}` : '',
        info.pages.length > 1 ? `- 分P：${info.pages.length} 个（${info.pages.slice(0, 5).map((page) => `P${page.page} ${page.part}`).join('；')}${info.pages.length > 5 ? '…' : ''}）` : '',
      ].filter(Boolean).join('\n');
    },
  };

  const comments: ToolRegistration = {
    name: 'bili_comments',
    description: 'Get the top public comments of a Bilibili video. Read-only; never posts or replies.',
    parameters: {
      type: 'object',
      properties: {
        bvid: { type: 'string', description: 'BVID or a Bilibili video URL.' },
        limit: { type: 'number', description: 'Number of comments, 1-30. Default 10.' },
      },
      required: ['bvid'],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      const { bvid, limit } = args as { bvid?: string; limit?: number };
      if (typeof bvid !== 'string' || bvid.trim().length === 0) throw new Error('bili_comments: bvid 不能为空');
      const items = await client.comments(bvidOf(bvid), limit ?? 10);
      if (items.length === 0) return '这个视频暂时没有公开评论。';
      const lines = ['评论（按热度）：', ''];
      items.forEach((item, index) => {
        lines.push(`${index + 1}. @${item.author}（赞 ${count(item.like)}）：${truncate(item.message.replace(/\s+/g, ' '), 300)}`);
        if (item.replyCount > 0) lines.push(`   楼中楼 ${item.replyCount} 条`);
      });
      return lines.join('\n');
    },
  };

  const subtitle: ToolRegistration = {
    name: 'bili_subtitle',
    description:
      'Get a Bilibili video subtitle as plain text (usually requires a one-time Bilibili login). '
      + 'Read-only; if not logged in, call bili_login first.',
    parameters: {
      type: 'object',
      properties: {
        bvid: { type: 'string', description: 'BVID or a Bilibili video URL.' },
      },
      required: ['bvid'],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const { bvid } = args as { bvid?: string };
      if (typeof bvid !== 'string' || bvid.trim().length === 0) throw new Error('bili_subtitle: bvid 不能为空');
      if (client.hasCredential()) ensurePermission(exec.agent);
      try {
        const result = await client.subtitle(bvidOf(bvid));
        if (result === undefined) return '这个视频没有可用字幕（可能未上传字幕，或该字幕需要登录后才有权限）。';
        return [
          `字幕（${result.lan || '未知语言'}，${result.lines} 行${result.truncated ? '，已截断' : ''}）：`,
          '',
          result.text,
        ].join('\n');
      } catch (err) {
        if (!client.hasCredential()) return `${loginHint()}\n\n（${err instanceof Error ? err.message : String(err)}）`;
        throw err;
      }
    },
  };

  const qrSessions = new Map<string, { path: string; createdAt: number }>();

  const login: ToolRegistration = {
    name: 'bili_login',
    description:
      'Generate a one-time Bilibili login QR code and send it to the current QQ conversation. '
      + 'Use only when the user asks to log in; never post the QR or cookies publicly. After the user scans, call bili_login_check.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: TEXT_OUTPUT,
    async execute(_args, exec) {
      ensurePermission(exec.agent);
      const start = await client.loginStart();
      const dir = join(PLUGIN_ROOT, 'media');
      mkdirSync(dir, { recursive: true });
      const qrPath = join(dir, `bili-login-${start.qrcodeKey.slice(0, 8)}.png`);
      await QRCode.toFile(qrPath, start.url, { width: 360, margin: 1, errorCorrectionLevel: 'M' });
      qrSessions.set(start.qrcodeKey, { path: qrPath, createdAt: Date.now() });

      let sent = false;
      if (deps.sendQr !== undefined && exec.agent !== undefined) {
        try {
          sent = await deps.sendQr(exec.agent, qrPath, '用手机 B 站扫码登录（确认时选「记住我 / 长期」），扫完说一声');
        } catch (err) {
          deps.logger.warn(`im-qqbot: 发送 B 站登录二维码失败: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      return [
        sent ? '登录二维码已发到当前会话。' : `登录二维码已生成：${qrPath}（可调用 qqbot_send_file 发送）。`,
        '用手机 B 站扫码，确认时选「记住我 / 长期」。',
        `扫完把这句话发我，或调用 bili_login_check（qrcodeKey=${start.qrcodeKey}）。`,
        `二维码约 ${start.expiresInSeconds} 秒内有效。`,
      ].join('\n');
    },
  };

  const loginCheck: ToolRegistration = {
    name: 'bili_login_check',
    description:
      'Check a Bilibili QR login session started by bili_login. Saves the credential locally on success; '
      + 'returns waiting/scanned/expired/success.',
    parameters: {
      type: 'object',
      properties: {
        qrcodeKey: { type: 'string', description: 'The qrcodeKey returned by bili_login.' },
      },
      required: ['qrcodeKey'],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const { qrcodeKey } = args as { qrcodeKey?: string };
      if (typeof qrcodeKey !== 'string' || qrcodeKey.length === 0) throw new Error('bili_login_check: qrcodeKey 不能为空');
      ensurePermission(exec.agent);
      const status = await client.loginPoll(qrcodeKey);
      if (status.state === 'success') {
        const session = qrSessions.get(qrcodeKey);
        if (session !== undefined) {
          try { rmSync(session.path, { force: true }); } catch { /* 忽略清理失败 */ }
          qrSessions.delete(qrcodeKey);
        }
        deps.logger.info('im-qqbot: B 站扫码登录成功，凭证已保存到本机');
        return status.message;
      }
      if (status.state === 'expired') {
        const session = qrSessions.get(qrcodeKey);
        if (session !== undefined) {
          try { rmSync(session.path, { force: true }); } catch { /* 忽略 */ }
          qrSessions.delete(qrcodeKey);
        }
      }
      return status.message;
    },
  };

  for (const tool of [search, video, comments, subtitle, login, loginCheck]) {
    tools.register(tool);
  }
  deps.logger.info('im-qqbot: B 站只读工具已注册（搜索/视频/评论/字幕/扫码登录）');
}
