/**
 * qqbot_history_search — 查群/私聊的历史聊天记录（JSONL 归档，只读）。
 *
 * 为什么需要它：归档每条消息都写了，但平时只有「被 @ 时回灌最近 historyLimit 条」
 * 这一条读取路径，等于写得多、读得少。这个工具把归档变成可检索的档案：
 * 关键词 + 时间范围 + 发言人，想不起某件事时主动查一次。
 *
 * 只读：不写、不删、不改游标。跨会话查询必须显式给 chat，避免随手翻别人的私聊。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type { Logger } from '../types.ts';
import type { SessionManager } from '../session/session-manager.ts';
import { listMemoryChats, readAllGroupMessages } from './group-memory.ts';

export const HISTORY_SEARCH_TOOL_NAME = 'qqbot_history_search';

const DESCRIPTION =
  'Search archived chat history (every group/private message is written to a JSONL archive). '
  + 'Read-only. Use it when you half-remember something said earlier: a repo name, a promise, a running joke, '
  + 'who said what. Filters: keywords (all must appear), sender name/id substring, date range, chat. '
  + 'Defaults to the current conversation. Cross-chat search needs an explicit `chat` id. '
  + 'Returns matched messages oldest-first with timestamps.';

/** 单条命中里保留的正文字符数，避免一次把整段聊天拉进上下文 */
const SNIPPET_CHARS = 200;
const MAX_LIMIT = 200;

interface ToolsRegistryLike {
  register(definition: unknown): unknown;
}

interface SearchArgs {
  query?: string;
  chat?: string;
  sender?: string;
  since?: string;
  until?: string;
  limit?: number;
}

interface HistoryHit {
  chat: string;
  time: string;
  sender: string;
  text: string;
}

interface SearchOutput {
  chat: string;
  count: number;
  truncated: boolean;
  message: string;
}

/** 'YYYY-MM-DD' / 'YYYY-MM-DD HH:mm' → 毫秒；无时区按本地时间算 */
function parseTime(raw: string, endOfDay: boolean): number | undefined {
  const trimmed = raw.trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?$/.exec(trimmed);
  if (m === null) return undefined;
  const [, y, mo, d, hh, mm] = m;
  const dt = new Date(
    Number(y), Number(mo) - 1, Number(d),
    hh === undefined ? (endOfDay ? 23 : 0) : Number(hh),
    hh === undefined ? (endOfDay ? 59 : 0) : Number(mm),
    hh === undefined && endOfDay ? 59 : 0,
  );
  return Number.isNaN(dt.getTime()) ? undefined : dt.getTime();
}

function renderHits(args: SearchArgs, hits: HistoryHit[], chat: string, truncated: boolean): string {
  const filter = [
    args.query !== undefined ? `关键词「${args.query}」` : '',
    args.sender !== undefined ? `发言人「${args.sender}」` : '',
    args.since !== undefined ? `起 ${args.since}` : '',
    args.until !== undefined ? `止 ${args.until}` : '',
  ].filter(Boolean).join('、');
  const head = hits.length === 0
    ? `没有找到符合条件的聊天记录（${filter || '无条件'}，范围 ${chat}）。`
    : `找到 ${hits.length} 条（${filter || '全量'}，范围 ${chat}）${truncated ? '，已截断到上限' : ''}：`;
  if (hits.length === 0) return head;
  const body = hits.map((h, i) => `${i + 1}. [${h.time}] ${h.sender}：${h.text}`).join('\n');
  return `${head}\n${body}`;
}

/** 归档里的时间字段有两种写法：早期的 `ts`、现在的 `timestamp`，两个都得认 */
interface RawEntry {
  senderId?: string;
  senderName?: string;
  content?: string;
  timestamp?: number | string;
  ts?: number | string;
}

function entryTime(entry: RawEntry): number {
  const raw = entry.timestamp ?? entry.ts;
  return typeof raw === 'number' ? raw : Number(raw);
}

/**
 * 别名（U3）→ openid。归档里存的是原始 openid，模型看到的是 #U3 这种短别名，
 * 不查这张表就没法按别名检索。
 */
function aliasMap(appId: string, chat: string): Map<string, string> {
  const map = new Map<string, string>();
  try {
    const p = resolve(homedir(), '.dsh', 'qqbot-memory', `${appId}-${chat}.aliases.json`);
    if (!existsSync(p)) return map;
    const raw = JSON.parse(readFileSync(p, 'utf8')) as { aliases?: Record<string, string> };
    for (const [alias, openid] of Object.entries(raw.aliases ?? {})) {
      if (typeof openid === 'string' && openid.length > 0) map.set(alias.toUpperCase(), openid);
    }
  } catch {
    /* 别名表坏了就退化成按名字/原始 id 匹配 */
  }
  return map;
}

export function registerHistorySearchTool(
  ctx: Context,
  appId: string,
  manager: SessionManager,
  logger: Logger,
): void {
  const tools = ctx.get('tools') as ToolsRegistryLike | undefined;
  if (!tools?.register) {
    logger.warn('im-qqbot: tools 服务不可用，qqbot_history_search 工具未注册');
    return;
  }

  tools.register({
    name: HISTORY_SEARCH_TOOL_NAME,
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Keywords; every whitespace-separated term must appear in the message (case-insensitive).',
        },
        chat: {
          type: 'string',
          description: 'Chat id to search, or "*" for every archived chat. Omit for the current conversation. Use a group openid only when the user asks about that specific chat.',
        },
        sender: { type: 'string', description: 'Sender name or id substring, e.g. "薯条" or "U3".' },
        since: { type: 'string', description: 'Inclusive start: "YYYY-MM-DD" or "YYYY-MM-DD HH:mm" (local time).' },
        until: { type: 'string', description: 'Inclusive end, same format; a bare date covers the whole day.' },
        limit: { type: 'integer', description: `Max messages to return (1-${MAX_LIMIT}, default 20). Newest matches win.` },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          chat: { type: 'string' },
          count: { type: 'integer' },
          truncated: { type: 'boolean' },
          message: { type: 'string' },
        },
        required: ['chat', 'count', 'truncated', 'message'],
        additionalProperties: false,
      },
      render: (_args: unknown, value: unknown): ContentBlock[] => {
        const v = value as SearchOutput;
        return [{ type: 'text', text: v.message }];
      },
    },
    async execute(args: unknown, exec: { agent?: unknown }): Promise<SearchOutput> {
      const a = (args ?? {}) as SearchArgs;
      const limit = typeof a.limit === 'number' && Number.isFinite(a.limit)
        ? Math.min(MAX_LIMIT, Math.max(1, Math.floor(a.limit)))
        : 20;

      const record = exec.agent !== undefined ? manager.findByAgent(exec.agent as never) : undefined;
      const currentChat = record?.peerId;
      const wanted = a.chat?.trim();
      // "*" = 全部会话，只给定时摘要这类明确要跨群的场景用
      const chats = wanted === '*'
        ? listMemoryChats(appId)
        : wanted !== undefined && wanted.length > 0
          ? [wanted]
          : currentChat !== undefined
            ? [currentChat]
            : listMemoryChats(appId);
      if (chats.length === 0) {
        return { chat: '(无)', count: 0, truncated: false, message: '还没有任何聊天归档。' };
      }

      const terms = (a.query ?? '').toLowerCase().split(/\s+/).filter((t) => t.length > 0);
      const sender = a.sender?.trim().toLowerCase();
      const from = a.since !== undefined ? parseTime(a.since, false) : undefined;
      const to = a.until !== undefined ? parseTime(a.until, true) : undefined;
      if (a.since !== undefined && from === undefined) throw new Error('qqbot_history_search: `since` 要写成 YYYY-MM-DD');
      if (a.until !== undefined && to === undefined) throw new Error('qqbot_history_search: `until` 要写成 YYYY-MM-DD');

      const hits: HistoryHit[] = [];
      let total = 0;
      for (const chat of chats) {
        // sender 写成 U3 / #u3 时先翻成 openid，再按 openid 精确匹配
        const aliases = sender !== undefined ? aliasMap(appId, chat) : undefined;
        const aliasKey = sender !== undefined ? sender.replace(/^#/, '').toUpperCase() : undefined;
        const aliasOpenid = aliasKey !== undefined ? aliases?.get(aliasKey) : undefined;
        for (const entry of readAllGroupMessages(appId, chat) as RawEntry[]) {
          const ts = entryTime(entry);
          if (!Number.isFinite(ts)) continue;
          if (from !== undefined && ts < from) continue;
          if (to !== undefined && ts > to) continue;
          const content = entry.content ?? '';
          if (terms.length > 0) {
            const haystack = content.toLowerCase();
            if (!terms.every((t) => haystack.includes(t))) continue;
          }
          if (sender !== undefined) {
            if (aliasOpenid !== undefined) {
              if ((entry.senderId ?? '').toUpperCase() !== aliasOpenid.toUpperCase()) continue;
            } else {
              const who = `${entry.senderName ?? ''} ${entry.senderId}`.toLowerCase();
              if (!who.includes(sender)) continue;
            }
          }
          total += 1;
          hits.push({
            chat,
            time: new Date(ts).toISOString().replace('T', ' ').slice(0, 16),
            sender: entry.senderName ?? entry.senderId ?? '(未知)',
            text: content.length > SNIPPET_CHARS ? `${content.slice(0, SNIPPET_CHARS)}…` : content,
          });
        }
      }

      const truncated = hits.length > limit;
      const kept = truncated ? hits.slice(-limit) : hits;
      const scope = chats.length === 1 ? chats[0]! : `${chats.length} 个会话`;
      logger.info(`qqbot_history_search: scope=${scope} terms=${terms.join(',')} hits=${total}/${limit}`);
      return {
        chat: scope,
        count: kept.length,
        truncated,
        message: renderHits(a, kept, scope, truncated),
      };
    },
  });

  logger.info('im-qqbot: qqbot_history_search 工具已注册');
}
