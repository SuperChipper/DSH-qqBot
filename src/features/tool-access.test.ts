import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import type { InteractionEvent } from '@tencent-connect/qqbot-nodejs';
import type { ImQQBotConfig } from '../config.ts';
import type { SessionManager } from '../session/index.ts';
import type { Logger } from '../types.ts';
import { ToolAccess, ToolAccessStore } from './tool-access.ts';

const OWNER = 'OWNER';
const GROUP = 'GROUP_A';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
const config = {
  ownerOpenid: OWNER,
  toolAccess: { enabled: true, fullAccessGroups: [], fullAccessUsers: [], readRoots: [] },
} as unknown as ImQQBotConfig;

interface Registered {
  execute(args: unknown, exec: { agent?: unknown }): Promise<{ message: string }>;
}

function setup() {
  const path = join(mkdtempSync(join(tmpdir(), 'access-')), 'tool-access.json');
  const store = new ToolAccessStore(path);
  const groupAgent = { followup: vi.fn() };
  const ownerAgent = { followup: vi.fn() };
  const records = new Map<object, unknown>([
    [groupAgent, { scope: 'group', peerId: GROUP, replyTarget: { type: 'group', id: GROUP }, agent: groupAgent }],
    [ownerAgent, { scope: 'c2c', peerId: OWNER, replyTarget: { type: 'c2c', id: OWNER }, agent: ownerAgent }],
  ]);
  const manager = { findByAgent: (agent: object) => records.get(agent) } as unknown as SessionManager;
  const sender = { sendMarkdown: vi.fn().mockResolvedValue(undefined) };
  const access = new ToolAccess(config, store, manager, sender, logger);
  let tool: Registered | undefined;
  access.register({ get: () => ({ register: (def: Registered) => { tool = def; } }) } as never);
  return { access, store, path, sender, tool: tool!, groupAgent, ownerAgent };
}

function click(data: string, clicker: string): InteractionEvent {
  return { group_member_openid: clicker, data: { resolved: { button_data: data } } } as unknown as InteractionEvent;
}

describe('qqbot_tool_access', () => {
  it('群里只发确认按钮，主人点同意才生效并持久化', async () => {
    const { access, store, path, sender, tool, groupAgent } = setup();
    const result = await tool.execute({ action: 'grant' }, { agent: groupAgent });
    expect(result.message).toMatch(/等主人/);
    expect(access.isFullAccess({ scope: 'group', peerId: GROUP })).toBe(false);

    const keyboard = sender.sendMarkdown.mock.calls[0]![2].keyboard;
    const allow = keyboard.content.rows[0].buttons[0].action.data as string;

    expect(access.handleInteraction(click(allow, 'SOMEONE'))).toBe(4); // 别人点：denied
    expect(access.isFullAccess({ scope: 'group', peerId: GROUP })).toBe(false);

    expect(access.handleInteraction(click(allow, OWNER))).toBe(0);
    expect(access.isFullAccess({ scope: 'group', peerId: GROUP })).toBe(true);
    expect(JSON.parse(readFileSync(path, 'utf8')).groups).toEqual([GROUP]);
    expect(groupAgent.followup).toHaveBeenCalled();
    expect(new ToolAccessStore(path).groups).toEqual([GROUP]);

    // 同一个按钮不能再点第二次
    expect(access.handleInteraction(click(allow, OWNER))).toBe(3);
    expect(store.groups).toEqual([GROUP]);
  });

  it('主人点拒绝不改白名单', async () => {
    const { access, sender, tool, groupAgent } = setup();
    await tool.execute({ action: 'grant' }, { agent: groupAgent });
    const deny = sender.sendMarkdown.mock.calls[0]![2].keyboard.content.rows[0].buttons[1].action.data as string;
    expect(access.handleInteraction(click(deny, OWNER))).toBe(0);
    expect(access.isFullAccess({ scope: 'group', peerId: GROUP })).toBe(false);
  });

  it('群里不能申请别的群', async () => {
    const { sender, tool, groupAgent } = setup();
    const result = await tool.execute({ action: 'grant', group: 'OTHER' }, { agent: groupAgent });
    expect(result.message).toMatch(/只能申请把本群/);
    expect(sender.sendMarkdown).not.toHaveBeenCalled();
  });

  it('主人私聊直接生效，可以指定群；status 列出白名单', async () => {
    const { access, sender, tool, ownerAgent } = setup();
    await tool.execute({ action: 'grant', group: GROUP }, { agent: ownerAgent });
    expect(sender.sendMarkdown).not.toHaveBeenCalled();
    expect(access.isFullAccess({ scope: 'group', peerId: GROUP })).toBe(true);
    expect((await tool.execute({ action: 'status' }, { agent: ownerAgent })).message).toContain(GROUP);

    await tool.execute({ action: 'revoke', group: GROUP }, { agent: ownerAgent });
    expect(access.isFullAccess({ scope: 'group', peerId: GROUP })).toBe(false);
  });

  it('群里 status 只说本群，不列别的群', async () => {
    const { tool, ownerAgent, groupAgent } = setup();
    await tool.execute({ action: 'grant', group: 'OTHER_GROUP' }, { agent: ownerAgent });
    const message = (await tool.execute({ action: 'status' }, { agent: groupAgent })).message;
    expect(message).toBe('本会话不在终端白名单里。');
  });
});
