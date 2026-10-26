import { describe, expect, it } from 'vitest';
import type { ImQQBotConfig } from '../config.ts';
import { accessPolicyFromConfig, isPrivilegedSender, privilegedOpenids } from './permissions.ts';

function config(overrides: Partial<ImQQBotConfig> = {}): ImQQBotConfig {
  return {
    access: {
      c2cMode: 'open',
      c2cAllow: [],
      groupMode: 'open',
      groupAllow: [],
    },
    adminOpenids: [],
    ...overrides,
  } as unknown as ImQQBotConfig;
}

describe('privilegedOpenids', () => {
  it('合并主人与管理员，去空白并去重', () => {
    const cfg = config({ ownerOpenid: ' owner ', adminOpenids: ['owner', 'admin-1', '  ', 'admin-2'] });
    expect(privilegedOpenids(cfg)).toEqual(['owner', 'admin-1', 'admin-2']);
  });
});

describe('isPrivilegedSender', () => {
  it('主人和管理员允许，其他人拒绝', () => {
    const cfg = config({ ownerOpenid: 'owner', adminOpenids: ['admin'] });
    expect(isPrivilegedSender('owner', cfg)).toBe(true);
    expect(isPrivilegedSender('admin', cfg)).toBe(true);
    expect(isPrivilegedSender('stranger', cfg)).toBe(false);
  });

  it('已配置 owner/admin 但 senderId 缺失时 fail-closed', () => {
    const cfg = config({ ownerOpenid: 'owner' });
    expect(isPrivilegedSender(undefined, cfg)).toBe(false);
    expect(isPrivilegedSender('', cfg)).toBe(false);
  });

  it('未配置 owner/admin 时保持旧部署行为', () => {
    expect(isPrivilegedSender('anyone', config())).toBe(true);
    expect(isPrivilegedSender(undefined, config())).toBe(true);
  });
});

describe('accessPolicyFromConfig', () => {
  it('allowlist 为空时原样传空数组（SDK fail-closed），不能变成通配', () => {
    const policy = accessPolicyFromConfig(config({
      access: { c2cMode: 'allowlist', c2cAllow: [], groupMode: 'allowlist', groupAllow: [] },
    }));
    expect(policy.c2c).toEqual({ mode: 'allowlist', allow: [] });
    expect(policy.group).toEqual({ mode: 'allowlist', allow: [] });
  });

  it('open 模式允许所有，allowlist 模式保留名单', () => {
    const open = accessPolicyFromConfig(config());
    expect(open.c2c?.allow).toEqual(['*']);
    expect(open.group?.allow).toEqual(['*']);

    const allow = accessPolicyFromConfig(config({
      access: {
        c2cMode: 'allowlist',
        c2cAllow: ['user-1'],
        groupMode: 'allowlist',
        groupAllow: ['group-1'],
      },
    }));
    expect(allow.c2c).toEqual({ mode: 'allowlist', allow: ['user-1'] });
    expect(allow.group).toEqual({ mode: 'allowlist', allow: ['group-1'] });
  });
});
