/**
 * 群成员短别名：每个群一张 `U1/U2/… ↔ openid` 表，按第一次出现的顺序分配，落盘后重启不变。
 *
 * 给模型看的标签只用别名：完整 openid 是 32 位随机串，一个就占 20 多个 token，群历史里每行重复一遍，
 * 模型还比对不准——「按 openid 认人」实际做不到。凡是要真实 openid 的工具参数（跑团的 declared_by、player_id），
 * 由代码用这张表换回去，模型永远不需要写 openid。
 * 路径：~/.dsh/qqbot-memory/<appId>-<groupId>.aliases.json（和群记忆放一起）
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';

const ALIAS_PATTERN = /^#?\s*u(\d+)$/i;

interface GroupTable {
  /** 别名 → openid */
  byAlias: Map<string, string>;
  /** openid → 别名 */
  byOpenid: Map<string, string>;
}

function sanitize(s: string): string {
  return String(s).replace(/[^a-zA-Z0-9_-]/g, '_');
}

/** 是不是别名的写法（U3 / #U3 / u3），是的话返回规范形式 U3 */
export function normalizeAlias(value: string): string | undefined {
  const match = ALIAS_PATTERN.exec(value.trim());
  return match === null ? undefined : `U${Number(match[1])}`;
}

export class SenderAliasStore {
  private readonly tables = new Map<string, GroupTable>();

  constructor(private readonly dir: string = resolve(homedir(), '.dsh', 'qqbot-memory')) {}

  private path(appId: string, groupId: string): string {
    return resolve(this.dir, `${sanitize(appId)}-${sanitize(groupId)}.aliases.json`);
  }

  private table(appId: string, groupId: string): GroupTable {
    const key = `${appId}\u0000${groupId}`;
    let table = this.tables.get(key);
    if (table !== undefined) return table;
    table = { byAlias: new Map(), byOpenid: new Map() };
    try {
      const p = this.path(appId, groupId);
      if (existsSync(p)) {
        const raw = JSON.parse(readFileSync(p, 'utf8')) as { aliases?: Record<string, unknown> };
        for (const [alias, openid] of Object.entries(raw.aliases ?? {})) {
          const normalized = normalizeAlias(alias);
          if (normalized === undefined || typeof openid !== 'string' || openid === '') continue;
          table.byAlias.set(normalized, openid);
          table.byOpenid.set(openid, normalized);
        }
      }
    } catch {
      /* 表坏了就从空表开始：别名会重新分配，但不影响收发消息 */
    }
    this.tables.set(key, table);
    return table;
  }

  private save(appId: string, groupId: string, table: GroupTable): void {
    try {
      const p = this.path(appId, groupId);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, JSON.stringify({ aliases: Object.fromEntries(table.byAlias) }, null, 2), 'utf8');
    } catch {
      /* 写失败时内存里的表照常用，本进程内别名仍然稳定 */
    }
  }

  /** openid 在这个群里的别名；第一次见到时分配下一个编号并落盘 */
  aliasFor(appId: string, groupId: string, openid: string): string {
    const table = this.table(appId, groupId);
    const existing = table.byOpenid.get(openid);
    if (existing !== undefined) return existing;
    let n = table.byAlias.size + 1;
    while (table.byAlias.has(`U${n}`)) n++;
    const alias = `U${n}`;
    table.byAlias.set(alias, openid);
    table.byOpenid.set(openid, alias);
    this.save(appId, groupId, table);
    return alias;
  }

  /** 只查不分配：没见过的 openid 返回 undefined */
  peekAlias(appId: string, groupId: string, openid: string): string | undefined {
    return this.table(appId, groupId).byOpenid.get(openid);
  }

  /**
   * 把模型写的成员标识换回 openid：接受 U3 / #U3；也接受这个群里已知的 openid 原样（旧会话的历史里还是 openid）。
   * 未知别名或陌生字符串返回 undefined，由调用方报错，不能原样当 openid 用。
   */
  resolve(appId: string, groupId: string, value: string): string | undefined {
    const table = this.table(appId, groupId);
    const alias = normalizeAlias(value);
    if (alias !== undefined) return table.byAlias.get(alias);
    const trimmed = value.trim();
    return table.byOpenid.has(trimmed) ? trimmed : undefined;
  }
}

/**
 * 按会话换算成员标识（给跑团工具用）。只有群会话有别名；私聊里模型看不到标签，参数原样当 openid。
 */
export function memberIdsFor(store: SenderAliasStore, appId: string) {
  return {
    toOpenid(record: { scope: string; peerId: string }, value: string): string | undefined {
      return record.scope === 'group' ? store.resolve(appId, record.peerId, value) : value.trim();
    },
    display(record: { scope: string; peerId: string }, openid: string): string | undefined {
      return record.scope === 'group' ? store.aliasFor(appId, record.peerId, openid) : undefined;
    },
  };
}

let shared: SenderAliasStore | undefined;

/** 进程内共享的别名表（入站组装、排队合并、跑团工具共用同一份缓存） */
export function getSenderAliases(): SenderAliasStore {
  shared ??= new SenderAliasStore();
  return shared;
}
