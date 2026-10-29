import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import type { ImQQBotConfig } from '../config.ts';
import { createToolGuard, hasFullToolAccess, type ToolGuardSession } from './tool-guard.ts';

const OWNER = 'OWNER';
const GROUP = 'GROUP_A';
const WHITE_GROUP = 'GROUP_W';

function makeConfig(over: Partial<ImQQBotConfig['toolAccess']> = {}, sensitivePaths: string[] = []): ImQQBotConfig {
  return {
    ownerOpenid: OWNER,
    fileAccess: { ownerOnly: true, extraAllow: [], sensitivePaths },
    toolAccess: { enabled: true, fullAccessGroups: [WHITE_GROUP], fullAccessUsers: [], readRoots: [], ...over },
  } as unknown as ImQQBotConfig;
}

function setup(config = makeConfig()) {
  const cwd = mkdtempSync(join(tmpdir(), 'guard-'));
  const media = join(cwd, 'media');
  mkdirSync(media);
  const campaigns = join(cwd, 'dnd', 'campaigns');
  mkdirSync(campaigns, { recursive: true });
  writeFileSync(join(media, 'a.png'), 'x');
  writeFileSync(join(cwd, '.env'), 'SECRET=1');
  const agents = new Map<object, ToolGuardSession>();
  const agentFor = (session: ToolGuardSession): object => {
    const agent = {};
    agents.set(agent, session);
    return agent;
  };
  const guard = createToolGuard({
    config,
    isFullAccess: (s) => hasFullToolAccess(s, config),
    findSession: (agent) => agents.get(agent as object),
    roots: [media],
    noWriteRoots: [campaigns],
    cwd,
  });
  return { guard, cwd, media, campaigns, agentFor };
}

describe('hasFullToolAccess', () => {
  const config = makeConfig();
  it('主人私聊和白名单群有完整权限，其它没有', () => {
    expect(hasFullToolAccess({ scope: 'c2c', peerId: OWNER }, config)).toBe(true);
    expect(hasFullToolAccess({ scope: 'group', peerId: WHITE_GROUP }, config)).toBe(true);
    expect(hasFullToolAccess({ scope: 'group', peerId: GROUP }, config)).toBe(false);
    expect(hasFullToolAccess({ scope: 'c2c', peerId: 'someone' }, config)).toBe(false);
    // 群 openid 恰好等于主人 openid 也不算主人私聊
    expect(hasFullToolAccess({ scope: 'group', peerId: OWNER }, config)).toBe(false);
  });

  it('运行时授予的白名单生效；关闭限制时全部放行', () => {
    expect(hasFullToolAccess({ scope: 'group', peerId: GROUP }, config, { groups: [GROUP], users: [] })).toBe(true);
    expect(hasFullToolAccess({ scope: 'group', peerId: GROUP }, makeConfig({ enabled: false }))).toBe(true);
  });
});

describe('createToolGuard', () => {
  it('本机会话（不在 QQ 会话表里）不受影响', () => {
    const { guard } = setup();
    expect(guard({ name: 'pwsh', arguments: { command: 'type .env' }, agent: {} })).toBeUndefined();
  });

  it('非白名单群：终端和子 agent 一律拒绝', () => {
    const { guard, agentFor } = setup();
    const agent = agentFor({ scope: 'group', peerId: GROUP });
    expect(guard({ name: 'pwsh', arguments: { command: 'dir' }, agent })).toMatch(/终端权限/);
    expect(guard({ name: 'terminal_open', arguments: {}, agent })).toMatch(/终端权限/);
    expect(guard({ name: 'subagent', arguments: {}, agent })).toMatch(/子 agent/);
  });

  it('非白名单群：文件工具只能碰允许的目录', () => {
    const { guard, agentFor, cwd, media } = setup();
    const agent = agentFor({ scope: 'group', peerId: GROUP });
    expect(guard({ name: 'read', arguments: { file_path: join(media, 'a.png') }, agent })).toBeUndefined();
    expect(guard({ name: 'read', arguments: { file_path: join(cwd, '.env') }, agent })).toMatch(/不在允许范围/);
    expect(guard({ name: 'read', arguments: { file_path: 'media/../.env' }, agent })).toMatch(/不在允许范围/);
    expect(guard({ name: 'write', arguments: { file_path: join(cwd, 'x.txt'), content: '' }, agent })).toMatch(/不在允许范围/);
    expect(guard({ name: 'qqbot_send_file', arguments: { file_path: join(cwd, '.env') }, agent })).toMatch(/不在允许范围/);
  });

  it('非白名单群：grep/glob 必须给 path，通配不能跳出', () => {
    const { guard, agentFor, media } = setup();
    const agent = agentFor({ scope: 'group', peerId: GROUP });
    expect(guard({ name: 'grep', arguments: { pattern: 'SECRET' }, agent })).toMatch(/必须用 path/);
    expect(guard({ name: 'grep', arguments: { pattern: '/SECRET/', path: media }, agent })).toBeUndefined();
    expect(guard({ name: 'glob', arguments: { pattern: '../**/*.env', path: media }, agent })).toMatch(/不在允许范围/);
    expect(guard({ name: 'glob', arguments: { pattern: 'C:/Users/**', path: media }, agent })).toMatch(/不在允许范围/);
    expect(guard({ name: 'glob', arguments: { pattern: '**/*.png', path: media }, agent })).toBeUndefined();
  });

  it('白名单群和主人私聊放行任意路径和终端，但敏感路径对所有 QQ 会话都拦', () => {
    const base = setup();
    const config = makeConfig({}, [join(base.cwd, '.env')]);
    const { guard, agentFor, cwd } = setup(config);
    const owner = agentFor({ scope: 'c2c', peerId: OWNER });
    const white = agentFor({ scope: 'group', peerId: WHITE_GROUP });
    expect(guard({ name: 'pwsh', arguments: { command: 'dir' }, agent: white })).toBeUndefined();
    expect(guard({ name: 'read', arguments: { file_path: join(cwd, 'notes.md') }, agent: owner })).toBeUndefined();

    const sensitive = setup(makeConfig({}, ['.env']));
    const ownerAgent = sensitive.agentFor({ scope: 'c2c', peerId: OWNER });
    expect(sensitive.guard({ name: 'read', arguments: { file_path: join(sensitive.cwd, '.env') }, agent: ownerAgent })).toMatch(/敏感路径/);
  });

  it('跑团存档目录：白名单会话也不能用 write/edit 改，读照常', () => {
    const { guard, agentFor, campaigns } = setup();
    const white = agentFor({ scope: 'group', peerId: WHITE_GROUP });
    const save = join(campaigns, 'qqbot_group_x.json');
    expect(guard({ name: 'edit', arguments: { file_path: save, old_string: 'a', new_string: 'b' }, agent: white })).toMatch(/dnd_\* 工具/);
    expect(guard({ name: 'write', arguments: { file_path: save, content: '{}' }, agent: white })).toMatch(/dnd_\* 工具/);
    expect(guard({ name: 'read', arguments: { file_path: save }, agent: white })).toBeUndefined();
    // 本机会话不受影响
    expect(guard({ name: 'edit', arguments: { file_path: save, old_string: 'a', new_string: 'b' }, agent: {} })).toBeUndefined();
  });
});
