import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import yaml from 'js-yaml';
import type { Context } from '@deepseek-ai/cordis';
import type { InteractionEvent, InlineKeyboard } from '@tencent-connect/qqbot-nodejs';
import { BrowserSchema, type ImQQBotConfig } from '../config.ts';
import type { SessionManager } from '../session/index.ts';
import { updateProfileConfig } from '../setup/persist.ts';
import { BrowserAccess } from './browser-access.ts';
import { decodeButtonData } from '../features/button-utils.ts';
import type { ReplyTarget } from '../types.ts';

interface Tool { execute(args: unknown, exec: { agent?: unknown }): Promise<{ message: string }> }
const directories: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function setup(allowedGroups: string[] = []) {
  const config = { ownerOpenid: 'owner', browser: BrowserSchema({ enabled: true, allowedGroups }) } as ImQQBotConfig;
  const group = { followup: vi.fn() }, owner = {}, other = {};
  const records = new Map<unknown, unknown>([
    [group, { scope: 'group', peerId: 'g1', senderId: 'member', agent: group, replyTarget: { scope: 'group', targetId: 'g1' } }],
    [owner, { scope: 'c2c', peerId: 'owner', senderId: 'owner' }],
    [other, { scope: 'c2c', peerId: 'other', senderId: 'other' }],
  ]);
  const manager = { findByAgent: (a: unknown) => records.get(a) } as unknown as SessionManager;
  const sender = { sendMarkdown: vi.fn(async (_target: ReplyTarget, _content: string, _opts?: { keyboard?: InlineKeyboard }) => {}) };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const persist = vi.fn((_groups: string[]) => true);
  const access = new BrowserAccess(config, manager, sender, logger, persist);
  let tool!: Tool;
  let dispose!: () => void;
  const ctx = { get: () => ({ register: (t: Tool) => { tool = t; } }),
    effect: (fn: () => () => void) => { dispose = fn(); } } as unknown as Context;
  access.register(ctx);
  const invoke = (action: string, agent: unknown = group, target?: string) => tool.execute({ action, ...(target ? { group: target } : {}) }, { agent });
  const button = (decision: 'allow' | 'deny' = 'allow') => {
    const options = sender.sendMarkdown.mock.calls[0]?.[2];
    return options!.keyboard!.content.rows[0]!.buttons[decision === 'allow' ? 0 : 1]!.action.data!;
  };
  const click = (raw: string, user = 'owner', target = 'g1') => access.handleInteraction({
    scene: 'group', group_openid: target, group_member_openid: user,
    data: { resolved: { button_data: raw } },
  } as InteractionEvent);
  return { config, access, sender, persist, invoke, button, click, group, owner, other, dispose, tool, records, logger };
}

describe('qqbot_browser_access', () => {
  it('群里只申请，只有主人原群点击才授权，审批回执与后续通知到原群', async () => {
    const s = setup();
    expect((await s.invoke('grant')).message).toContain('当前权限尚未修改');
    expect(s.access.isAllowedGroup('g1')).toBe(false);
    expect(s.persist).not.toHaveBeenCalled();
    const data = s.button();
    expect(decodeButtonData(data)).toMatchObject({ t: 'browser-access', d: 'allow' });
    expect(s.click(data, 'member')).toBe(4);
    expect(s.click(data, 'owner', 'g2')).toBe(4);
    expect(s.access.handleInteraction({ scene: 'c2c', user_openid: 'owner',
      data: { resolved: { button_data: data } } } as InteractionEvent)).toBe(4);
    expect(s.persist).not.toHaveBeenCalled();
    expect(s.click(data)).toBe(0);
    expect(s.persist).toHaveBeenCalledExactlyOnceWith(['g1']);
    expect(s.config.browser?.allowedGroups).toEqual(['g1']);
    expect(s.access.isAllowedGroup('g1')).toBe(true);
    expect(s.group.followup).toHaveBeenCalledOnce();
    expect(s.sender.sendMarkdown.mock.calls[1]?.[0]).toMatchObject({ scope: 'group', targetId: 'g1' });
    expect(s.click(data)).toBe(3);
  });

  it('拒绝和过期均不授权；过期可重新申请', async () => {
    const s = setup();
    await s.invoke('grant');
    expect(s.click(s.button('deny'))).toBe(0);
    expect(s.access.isAllowedGroup('g1')).toBe(false);
    await s.invoke('grant');
    const options = s.sender.sendMarkdown.mock.calls.at(-1)?.[2];
    const raw = options!.keyboard!.content.rows[0]!.buttons[0]!.action.data!;
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 10 * 60 * 1000 + 1);
    expect(s.click(raw)).toBe(3);
    expect(s.persist).not.toHaveBeenCalled();
    await s.invoke('grant');
    expect(s.sender.sendMarkdown).toHaveBeenCalledTimes(4);
  });

  it('重复申请不重复发消息，不需要改权限时不发按钮', async () => {
    const s = setup();
    await s.invoke('grant');
    expect((await s.invoke('grant')).message).toContain('已有相同申请');
    expect(s.sender.sendMarkdown).toHaveBeenCalledOnce();
    s.click(s.button());
    expect((await s.invoke('grant')).message).toContain('已在');
    expect(s.sender.sendMarkdown).toHaveBeenCalledTimes(2);
  });

  it('发消息失败后可重试，不留下无法点击的待审批条目', async () => {
    const s = setup();
    s.sender.sendMarkdown.mockRejectedValueOnce(new Error('offline'));
    await expect(s.invoke('grant')).rejects.toThrow('offline');
    await expect(s.invoke('grant')).resolves.toHaveProperty('message');
    expect(s.sender.sendMarkdown).toHaveBeenCalledTimes(2);
  });

  it('主人私聊直接加入、查询、撤销配置中的群，其他群仍保留', async () => {
    const s = setup(['configured']);
    await s.invoke('grant', s.owner, 'g1');
    expect(s.sender.sendMarkdown).not.toHaveBeenCalled();
    expect((await s.invoke('status', s.owner)).message).toContain('configured、g1');
    await s.invoke('revoke', s.owner, 'configured');
    expect(s.config.browser?.allowedGroups).toEqual(['g1']);
    expect((await s.invoke('status')).message).toBe('本群已在浏览白名单里。');
  });

  it('群撤销也需审批，批准后立即拒绝该群权限', async () => {
    const s = setup(['g1']);
    await s.invoke('revoke');
    expect(s.access.isAllowedGroup('g1')).toBe(true);
    s.click(s.button());
    expect(s.access.isAllowedGroup('g1')).toBe(false);
  });

  it('未知 agent、非主人私聊不能修改，群不能申请其他群', async () => {
    const s = setup(['secret-group']);
    await expect(s.invoke('grant', {})).rejects.toThrow('找不到');
    await expect(s.invoke('grant', s.other, 'g1')).rejects.toThrow('仅主人');
    expect((await s.invoke('grant', s.group, 'g2')).message).toContain('只能申请把本群');
    await expect(s.invoke('grant', s.owner)).rejects.toThrow('目标群');
    expect((await s.invoke('status')).message).not.toContain('secret-group');
    expect(s.persist).not.toHaveBeenCalled();
    expect(s.sender.sendMarkdown).not.toHaveBeenCalled();
  });

  it.each([null, { action: 'invalid' }, { action: 'grant', group: 123 }, { action: 'grant', group: '' }])('非法参数不产生申请 %j', async (args) => {
    const s = setup();
    await expect(s.tool.execute(args, { agent: s.group })).rejects.toThrow();
    expect(s.sender.sendMarkdown).not.toHaveBeenCalled();
    expect(s.persist).not.toHaveBeenCalled();
  });

  it('保存失败不授予权限，并报告审批失败', async () => {
    const s = setup();
    s.persist.mockReturnValue(false);
    await s.invoke('grant');
    expect(s.click(s.button())).toBe(1);
    expect(s.access.isAllowedGroup('g1')).toBe(false);
    expect(s.sender.sendMarkdown.mock.calls[1]?.[1]).toContain('权限未修改');
    await expect(s.invoke('grant', s.owner, 'g1')).rejects.toThrow('保存失败');
  });

  it('销毁清除待审批，旧按钮和旧工具不能授权', async () => {
    const s = setup();
    await s.invoke('grant'); const data = s.button(); s.dispose();
    expect(s.click(data)).toBe(3);
    await expect(s.invoke('grant')).rejects.toThrow('已关闭');
    expect(s.persist).not.toHaveBeenCalled();
  });

  it('沿用 profile 持久化，设置页可读同一 allowedGroups，保留其他顶层配置', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'browser-access-')); directories.push(dir);
    const path = join(dir, 'cordis.patch.yml');
    writeFileSync(path, yaml.dump([{ id: 'im-qqbot', config: { appSecret: 'test-secret', historyLimit: 7 } }]));
    const s = setup();
    s.persist.mockImplementation((groups) => updateProfileConfig({ browser: { ...s.config.browser, allowedGroups: groups } }, dir, s.logger));
    await s.invoke('grant', s.owner, 'g1');
    const stored = yaml.load(readFileSync(path, 'utf8')) as Array<{ config: Record<string, unknown> }>;
    expect(stored[0]!.config).toMatchObject({ appSecret: 'test-secret', historyLimit: 7, browser: { allowedGroups: ['g1'] } });
    expect(Object.keys(stored[0]!.config).sort()).toEqual(['appSecret', 'browser', 'historyLimit']);
  });
});
