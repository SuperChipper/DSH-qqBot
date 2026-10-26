/**
 * 持久化群记忆（借鉴 dsh-pet：把群聊沉淀到磁盘 JSONL，重启后可回灌长期上下文）
 * 路径：~/.dsh/qqbot-memory/<appId>-<groupId>.jsonl
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';

/** 群消息里的图片（只存 QQ 下发的 URL，真正用到时再下载） */
export interface GroupMemoryImage {
  url: string;
  filename?: string;
}

export interface GroupMemoryEntry {
  messageId: string;
  senderId: string;
  senderName?: string;
  content: string;
  timestamp: number;
  /** 图片附件；旧记录没有该字段 */
  images?: GroupMemoryImage[];
}

function sanitize(s: string): string {
  return String(s).replace(/[^a-zA-Z0-9_-]/g, '_');
}

function memoryPath(appId: string, groupId: string): string {
  return resolve(homedir(), '.dsh', 'qqbot-memory', `${sanitize(appId)}-${sanitize(groupId)}.jsonl`);
}

/** 追加一条群消息到持久化记忆（JSONL，写失败静默不阻断消息处理） */
export function appendGroupMessage(appId: string, groupId: string, entry: GroupMemoryEntry): void {
  try {
    const p = memoryPath(appId, groupId);
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, JSON.stringify(entry) + '\n', 'utf8');
  } catch {
    /* ignore */
  }
}

/** 读取全部群记忆（坏行跳过，读失败返回空） */
function readAllGroupMessages(appId: string, groupId: string): GroupMemoryEntry[] {
  try {
    const p = memoryPath(appId, groupId);
    if (!existsSync(p)) return [];
    const entries: GroupMemoryEntry[] = [];
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        const e = JSON.parse(t) as GroupMemoryEntry;
        if (e) entries.push(e);
      } catch {
        /* 跳过坏行 */
      }
    }
    return entries;
  } catch {
    return [];
  }
}

/** 读取最近 limit 条群记忆，排除指定 messageId（当前消息），按时间正序返回 */
export function readRecentGroupMessages(
  appId: string,
  groupId: string,
  limit: number,
  excludeMessageId?: string,
): GroupMemoryEntry[] {
  return readGroupMessagesAfter(appId, groupId, limit, undefined, excludeMessageId);
}

/**
 * 读取 afterMessageId 之后的群记忆（最多 limit 条，按时间正序，排除当前消息）。
 * afterMessageId 缺省或在记忆里找不到时，退回最近 limit 条。
 */
export function readGroupMessagesAfter(
  appId: string,
  groupId: string,
  limit: number,
  afterMessageId: string | undefined,
  excludeMessageId?: string,
): GroupMemoryEntry[] {
  const all = readAllGroupMessages(appId, groupId);
  const cut = afterMessageId === undefined ? -1 : all.findIndex((e) => e.messageId === afterMessageId);
  const since = cut >= 0 ? all.slice(cut + 1) : all;
  return since.filter((e) => e.messageId !== excludeMessageId).slice(-Math.max(0, limit));
}

/**
 * 群历史游标：某个会话上次注入群历史时，已经覆盖到的消息。
 * 绑定 sessionId——换了新会话（/new、重建）时游标失效，重新注入完整的最近 N 条。
 */
export interface GroupHistoryCursor {
  sessionId: string;
  messageId: string;
}

function cursorPath(appId: string, groupId: string): string {
  return resolve(homedir(), '.dsh', 'qqbot-memory', `${sanitize(appId)}-${sanitize(groupId)}.cursor.json`);
}

/** 读取群历史游标（不存在或损坏返回 undefined） */
export function readHistoryCursor(appId: string, groupId: string): GroupHistoryCursor | undefined {
  try {
    const p = cursorPath(appId, groupId);
    if (!existsSync(p)) return undefined;
    const c = JSON.parse(readFileSync(p, 'utf8')) as Partial<GroupHistoryCursor>;
    return typeof c.sessionId === 'string' && typeof c.messageId === 'string'
      ? { sessionId: c.sessionId, messageId: c.messageId }
      : undefined;
  } catch {
    return undefined;
  }
}

/** 写入群历史游标（失败静默：最坏情况是下次多注入几条重复历史） */
export function writeHistoryCursor(appId: string, groupId: string, cursor: GroupHistoryCursor): void {
  try {
    const p = cursorPath(appId, groupId);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(cursor), 'utf8');
  } catch {
    /* ignore */
  }
}
