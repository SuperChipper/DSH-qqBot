import { describe, expect, it, vi } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import type { ImQQBotConfig } from '../config.ts';
import { BrowserSchema } from '../config.ts';
import type { SessionManager } from '../session/index.ts';
import { registerBrowserTool } from './browser-tool.ts';
import { BrowserAccess } from './browser-access.ts';

const run = vi.hoisted(() => vi.fn(async () => ({ text: 'page' })));
const construct = vi.hoisted(() => vi.fn());
vi.mock('./browser-service.ts', () => ({ BrowserService: class {
  constructor(...args: unknown[]) { construct(...args); }
  run = run; dispose = vi.fn();
} }));

function harness(record: unknown, owner = 'owner', enabled = true, allowedGroups: string[] = []) {
  const register = vi.fn();
  const ctx = { get: () => ({ register }), effect: vi.fn() } as unknown as Context;
  const manager = { findByAgent: () => record } as unknown as SessionManager;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  registerBrowserTool(ctx, { ownerOpenid: owner, browser: BrowserSchema({ enabled, allowedGroups }) } as ImQQBotConfig, manager, logger);
  return register;
}

describe('浏览器登录态权限', () => {
  it('批准后立即允许浏览，撤销后立即拒绝，不依赖重载', async () => {
    const record = { scope: 'c2c', peerId: 'owner', senderId: 'owner' };
    const config = { ownerOpenid: 'owner', browser: BrowserSchema({ enabled: true }) } as ImQQBotConfig;
    const manager = { findByAgent: () => record } as unknown as SessionManager;
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const sender = { sendMarkdown: vi.fn(async () => {}) };
    const access = new BrowserAccess(config, manager, sender, logger, () => true);
    const definitions = new Map<string, { execute(args: unknown, exec: { agent?: unknown }): Promise<unknown> }>();
    const ctx = { get: () => ({ register: (tool: { name: string; execute: (args: unknown, exec: { agent?: unknown }) => Promise<unknown> }) => definitions.set(tool.name, tool) }), effect: vi.fn() } as unknown as Context;
    access.register(ctx);
    registerBrowserTool(ctx, config, manager, logger, access);
    const permissions = definitions.get('qqbot_browser_access')!;
    const browsing = definitions.get('qqbot_browser')!;
    await permissions.execute({ action: 'grant', group: 'g1' }, { agent: {} });
    record.scope = 'group'; record.peerId = 'g1'; record.senderId = 'member';
    await expect(browsing.execute({ action: 'read' }, { agent: {} })).resolves.toEqual({ text: 'page' });
    record.scope = 'c2c'; record.peerId = 'owner'; record.senderId = 'owner';
    await permissions.execute({ action: 'revoke', group: 'g1' }, { agent: {} });
    record.scope = 'group'; record.peerId = 'g1'; record.senderId = 'member';
    await expect(browsing.execute({ action: 'read' }, { agent: {} })).rejects.toThrow('白名单');
  });
  it.each([
    undefined, { scope: 'group', peerId: 'owner', senderId: 'owner' },
    { scope: 'c2c', peerId: 'other', senderId: 'other' },
    { scope: 'c2c', peerId: 'owner', senderId: 'other' },
  ])('未知会话/群/非主人均拒绝 %j', async (record) => {
    run.mockClear();
    const tool = harness(record).mock.calls[0]![0];
    await expect(tool.execute({ action: 'read' }, { agent: {} })).rejects.toThrow('主人私聊');
    expect(run).not.toHaveBeenCalled();
  });
  it('仅主人私聊可操作', async () => {
    const tool = harness({ scope: 'c2c', peerId: 'owner', senderId: 'owner' }).mock.calls[0]![0];
    await expect(tool.execute({ action: 'read' }, { agent: {} })).resolves.toEqual({ text: 'page' });
  });
  it('未配置主人或禁用时不注册', () => {
    expect(harness(undefined, '')).not.toHaveBeenCalled();
    expect(harness(undefined, 'owner', false)).not.toHaveBeenCalled();
  });
  it('白名单群可浏览，但白名单不授予其他群或非主人私聊权限', async () => {
    const record = { scope: 'group', peerId: 'g1', senderId: 'member' };
    const tool = harness(record, 'owner', true, ['g1']).mock.calls[0]![0];
    await expect(tool.execute({ action: 'read' }, { agent: {} })).resolves.toEqual({ text: 'page' });
    record.peerId = 'g2';
    await expect(tool.execute({ action: 'read' }, { agent: {} })).rejects.toThrow('白名单');
    record.scope = 'c2c'; record.peerId = 'g1';
    await expect(tool.execute({ action: 'read' }, { agent: {} })).rejects.toThrow('白名单');
  });
  it('每群独立目录和服务，同群复用，主人沿用原目录', async () => {
    construct.mockClear();
    const record = { scope: 'group', peerId: '../../g1', senderId: 'member' };
    const tool = harness(record, 'owner', true, ['../../g1', 'g2']).mock.calls[0]![0];
    const call = () => tool.execute({ action: 'read' }, { agent: {} });
    await call(); await call();
    expect(construct).toHaveBeenCalledTimes(1);
    const first = construct.mock.calls[0]!;
    expect(first[0].userDataDir).toMatch(/[\\/]groups[\\/][a-f0-9]{64}$/);
    expect(first[3]).toBe(true);
    record.peerId = 'g2'; await call();
    expect(construct.mock.calls[1]![0].userDataDir).not.toBe(first[0].userDataDir);
    record.scope = 'c2c'; record.peerId = 'owner'; record.senderId = 'owner'; await call();
    expect(construct.mock.calls[2]![0].userDataDir).toBe('');
    expect(construct.mock.calls[2]![3]).toBe(false);
  });
});
