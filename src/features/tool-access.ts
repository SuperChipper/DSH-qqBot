/**
 * 终端白名单的自然语言入口 — qqbot_tool_access 工具 + 主人确认按钮。
 *
 * 白名单 = 配置里的 toolAccess.fullAccessGroups/Users + 运行时授予（~/.dsh-qqbot/tool-access.json）。
 *
 * 谁能改：
 *   - 主人私聊（以及本机会话）：模型调用工具即生效 —— 这个会话里只有主人；
 *   - 群里：模型只能「申请」把本群加入/移出，bot 发一条带按钮的确认，
 *     只有主人本人点「同意」才生效。点击者 openid 由 QQ 回调给出，模型和群友都伪造不了。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm';
import type { InlineKeyboard, InteractionEvent } from '@tencent-connect/qqbot-nodejs';
import type { ImQQBotConfig } from '../config.ts';
import type { DshAgent, SessionManager } from '../session/index.ts';
import type { Logger, ReplyTarget } from '../types.ts';
import { hasFullToolAccess, type ToolAccessGrants, type ToolGuardSession } from '../shared/tool-guard.ts';
import { decodeButtonData, encodeButtonData } from './button-utils.ts';

export const TOOL_ACCESS_TOOL_NAME = 'qqbot_tool_access';

/** 确认按钮有效期 */
const PENDING_TTL_MS = 10 * 60 * 1000;

/** acknowledgeInteraction 返回码（与 dnd/turn-buttons 的 ACK 一致） */
const ACK = { ok: 0, failed: 1, duplicate: 3, denied: 4 } as const;

type Kind = 'group' | 'user';
type Op = 'grant' | 'revoke';

interface GrantsFile {
  groups: string[];
  users: string[];
}

/** 运行时授予的白名单，持久化到 JSON */
export class ToolAccessStore implements ToolAccessGrants {
  private data: GrantsFile = { groups: [], users: [] };
  private readonly path: string;

  public constructor(path = resolve(homedir(), '.dsh-qqbot', 'tool-access.json')) {
    this.path = path;
    try {
      if (existsSync(path)) {
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<GrantsFile>;
        this.data = {
          groups: Array.isArray(parsed.groups) ? parsed.groups.filter((s) => typeof s === 'string') : [],
          users: Array.isArray(parsed.users) ? parsed.users.filter((s) => typeof s === 'string') : [],
        };
      }
    } catch {
      // 文件坏了就当空白名单（fail-closed）
    }
  }

  public get groups(): readonly string[] {
    return this.data.groups;
  }

  public get users(): readonly string[] {
    return this.data.users;
  }

  /** 加入/移出；返回是否有变化 */
  public apply(op: Op, kind: Kind, id: string): boolean {
    const list = kind === 'group' ? this.data.groups : this.data.users;
    const has = list.includes(id);
    if (op === 'grant' ? has : !has) return false;
    if (op === 'grant') list.push(id);
    else list.splice(list.indexOf(id), 1);
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.data, null, 2), 'utf8');
    return true;
  }
}

export interface ToolAccessButtonSender {
  sendMarkdown(target: ReplyTarget, content: string, opts?: { keyboard?: InlineKeyboard }): Promise<unknown>;
}

interface Pending {
  op: Op;
  kind: Kind;
  id: string;
  target: ReplyTarget;
  agent: DshAgent;
  expiresAt: number;
}

interface ToolsRegistryLike {
  register(definition: unknown): unknown;
}

interface AccessArgs {
  action: 'status' | 'grant' | 'revoke';
  group?: string;
  user?: string;
}

const DESCRIPTION =
  'Manage the terminal whitelist: chats on it may use pwsh/bash/terminal, subagents and read/write any path; '
  + 'other chats only get file tools inside the bot\'s media/sticker/tmp dirs. Only the bot owner may change it. '
  + 'action="status" shows whether this chat is whitelisted (in the owner\'s private chat: the full list). '
  + 'action="grant"/"revoke" adds/removes a chat: in a group it can only target this group and posts a confirm '
  + 'button that takes effect only when the owner clicks it — tell the user to wait for the owner, never claim '
  + 'it is done. In the owner\'s private chat it applies at once; pass `group` (group openid) or `user` (openid). '
  + 'Call it only when the owner asks; never on behalf of someone else.';

function label(kind: Kind, id: string): string {
  return kind === 'group' ? `群 ${id.slice(0, 8)}` : `用户 ${id.slice(0, 8)}`;
}

function confirmKeyboard(pendingId: string): InlineKeyboard {
  const button = (id: string, text: string, style: number, d: 'allow' | 'deny'): InlineKeyboard['content']['rows'][number]['buttons'][number] => ({
    id,
    render_data: { label: text, visited_label: text, style },
    action: {
      type: 1,
      permission: { type: 2 },
      data: encodeButtonData({ t: 'access', p: pendingId, d }),
      unsupport_tips: '请升级 QQ 后再点',
    } as InlineKeyboard['content']['rows'][number]['buttons'][number]['action'],
  });
  return { content: { rows: [{ buttons: [button('access-allow', '同意', 1, 'allow'), button('access-deny', '拒绝', 0, 'deny')] }] } };
}

/** 白名单服务：合并配置与运行时授予，提供工具注册和按钮处理 */
export class ToolAccess {
  private readonly pending = new Map<string, Pending>();

  public constructor(
    private readonly config: ImQQBotConfig,
    public readonly store: ToolAccessStore,
    private readonly manager: SessionManager,
    private readonly sender: ToolAccessButtonSender,
    private readonly logger: Logger,
  ) {}

  public isFullAccess(session: ToolGuardSession): boolean {
    return hasFullToolAccess(session, this.config, this.store);
  }

  private isOwnerChat(session: ToolGuardSession | undefined): boolean {
    if (session === undefined) return true; // 本机会话 = 主人自己
    const owner = this.config.ownerOpenid?.trim();
    return session.scope === 'c2c' && owner !== undefined && owner !== '' && session.peerId === owner;
  }

  private change(op: Op, kind: Kind, id: string): string {
    const changed = this.store.apply(op, kind, id);
    this.logger.info(`im-qqbot: 终端白名单 ${op} ${kind}=${id} changed=${changed}`);
    if (!changed) return `${label(kind, id)} ${op === 'grant' ? '已经在' : '本来就不在'}终端白名单里。`;
    return `已把${label(kind, id)}${op === 'grant' ? '加入' : '移出'}终端白名单，下一次工具调用起生效。`;
  }

  public register(ctx: Context): void {
    const tools = ctx.get('tools') as ToolsRegistryLike | undefined;
    if (!tools?.register) {
      this.logger.warn('im-qqbot: tools 服务不可用，qqbot_tool_access 未注册');
      return;
    }
    tools.register({
      name: TOOL_ACCESS_TOOL_NAME,
      description: DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['status', 'grant', 'revoke'] },
          group: { type: 'string', description: 'Group openid (owner private chat only; in a group, omit = this group).' },
          user: { type: 'string', description: 'User openid for private-chat access (owner private chat only).' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'], additionalProperties: false },
        render: (_args: unknown, value: unknown): ContentBlock[] => [{ type: 'text', text: (value as { message: string }).message }],
      },
      execute: async (args: unknown, exec: { agent?: unknown }): Promise<{ message: string }> => ({
        message: await this.execute(args as AccessArgs, exec.agent as DshAgent | undefined),
      }),
    });
    this.logger.info('im-qqbot: qqbot_tool_access 已注册');
  }

  private async execute(args: AccessArgs, agent: DshAgent | undefined): Promise<string> {
    const record = agent !== undefined ? this.manager.findByAgent(agent) : undefined;
    const session = record === undefined ? undefined : { scope: record.scope, peerId: record.peerId };
    const ownerChat = this.isOwnerChat(session);

    if (args.action === 'status') {
      if (ownerChat) {
        const groups = [...new Set([...(this.config.toolAccess?.fullAccessGroups ?? []), ...this.store.groups])];
        const users = [...new Set([...(this.config.toolAccess?.fullAccessUsers ?? []), ...this.store.users])];
        return `终端白名单：群 ${groups.length > 0 ? groups.join('、') : '（无）'}；私聊用户 ${users.length > 0 ? users.join('、') : '（无，主人私聊始终可用）'}。`
          + '（配置文件里的条目只能改配置移除。）';
      }
      return session !== undefined && this.isFullAccess(session) ? '本会话在终端白名单里。' : '本会话不在终端白名单里。';
    }

    const op: Op = args.action;
    if (ownerChat) {
      const group = args.group?.trim();
      const user = args.user?.trim();
      if (group) return this.change(op, 'group', group);
      if (user) return this.change(op, 'user', user);
      throw new Error('qqbot_tool_access: 主人私聊里需要给 `group` 或 `user`');
    }

    if (record === undefined || session === undefined) throw new Error('qqbot_tool_access: 找不到当前会话');
    if (session.scope !== 'group' || (args.group !== undefined && args.group.trim() !== session.peerId) || args.user !== undefined) {
      return '这里只能申请把本群加入/移出终端白名单；改别的群或私聊，请主人在私聊里说。';
    }
    const owner = this.config.ownerOpenid?.trim();
    if (owner === undefined || owner === '') return '还没设置 bot 主人（ownerOpenid），没法确认，白名单不能在聊天里修改。';

    this.prune();
    const pendingId = randomUUID().slice(0, 8);
    this.pending.set(pendingId, {
      op, kind: 'group', id: session.peerId, target: record.replyTarget, agent: record.agent, expiresAt: Date.now() + PENDING_TTL_MS,
    });
    const what = op === 'grant'
      ? '把**本群**加入终端白名单（bot 可在本群使用命令行、读写本机任意文件）'
      : '把**本群**移出终端白名单';
    await this.sender.sendMarkdown(record.replyTarget, `🔐 申请${what}。\n只有 bot 主人点「同意」才生效，10 分钟内有效。`, {
      keyboard: confirmKeyboard(pendingId),
    });
    return '已发出确认按钮，等主人点「同意」才生效。告诉用户等主人确认，不要说已经开通。';
  }

  private prune(now = Date.now()): void {
    for (const [id, p] of this.pending) if (p.expiresAt < now) this.pending.delete(id);
  }

  /** 处理确认按钮；不是白名单按钮时返回 undefined */
  public handleInteraction(event: InteractionEvent): number | undefined {
    const raw = event.data?.resolved?.button_data;
    const button = raw === undefined ? undefined : decodeButtonData(raw);
    if (button?.t !== 'access') return undefined;
    this.prune();
    const pending = this.pending.get(button.p);
    if (pending === undefined) return ACK.duplicate;

    const clicker = event.group_member_openid ?? event.user_openid;
    const owner = this.config.ownerOpenid?.trim();
    if (owner === undefined || owner === '' || clicker !== owner) return ACK.denied;
    this.pending.delete(button.p);

    const text = button.d === 'allow'
      ? `✅ 主人已同意：${this.change(pending.op, pending.kind, pending.id)}`
      : '❌ 主人拒绝了这次终端白名单申请。';
    void this.sender.sendMarkdown(pending.target, text)
      .catch((err: unknown) => this.logger.warn(`im-qqbot: 白名单确认回执发送失败: ${err instanceof Error ? err.message : String(err)}`));
    try {
      pending.agent.followup(createSystemNote(`[系统 · 按钮] ${text}`));
    } catch {
      // 会话已经换掉（/new 等）：回执已发到群里，不用再通知模型
    }
    return ACK.ok;
  }
}

function createSystemNote(text: string): Parameters<DshAgent['followup']>[0] {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' as const } });
}
