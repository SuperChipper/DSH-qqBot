/**
 * 持久化群记忆（借鉴 dsh-pet：把群聊沉淀到磁盘 JSONL，重启后可回灌长期上下文）
 * 路径：~/.dsh/qqbot-memory/<appId>-<groupId>.jsonl
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
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

/** 读取最近 limit 条群记忆，排除指定 messageId（当前消息），按时间正序返回 */
export function readRecentGroupMessages(
  appId: string,
  groupId: string,
  limit: number,
  excludeMessageId?: string,
): GroupMemoryEntry[] {
  try {
    const p = memoryPath(appId, groupId);
    if (!existsSync(p)) return [];
    const entries: GroupMemoryEntry[] = [];
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        const e = JSON.parse(t) as GroupMemoryEntry;
        if (e && e.messageId !== excludeMessageId) entries.push(e);
      } catch {
        /* 跳过坏行 */
      }
    }
    return entries.slice(-Math.max(0, limit));
  } catch {
    return [];
  }
}
