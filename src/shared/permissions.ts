/**
 * 权限判定 — 配置管理员与访问策略。
 *
 * 约定：
 * - `ownerOpenid` 是 bot 主人，永远拥有配置权限；
 * - `adminOpenids` 是额外的配置管理员；
 * - 两者都为空时保持旧部署行为（不额外限制），因此建议至少设置 ownerOpenid。
 */
import type { AccessPolicy } from '@tencent-connect/qqbot-nodejs';
import type { ImQQBotConfig } from '../config.ts';

/** 去重后的主人 + 管理员 openid 列表（忽略空值） */
export function privilegedOpenids(config: ImQQBotConfig): string[] {
  const ids = [config.ownerOpenid, ...(config.adminOpenids ?? [])]
    .filter((id): id is string => typeof id === 'string' && id.trim() !== '')
    .map((id) => id.trim());
  return [...new Set(ids)];
}

/**
 * 当前发送者是否有权执行配置变更/审批操作。
 *
 * - 未配置 owner/admin：返回 true（兼容旧部署；启动时会打 warn）；
 * - 已配置但 senderId 缺失：返回 false（fail-closed）。
 */
export function isPrivilegedSender(senderId: string | undefined, config: ImQQBotConfig): boolean {
  const ids = privilegedOpenids(config);
  if (ids.length === 0) return true;
  if (senderId === undefined || senderId.length === 0) return false;
  return ids.includes(senderId);
}

/**
 * 把插件配置映射为 SDK 的访问策略。
 *
 * 关键：allowlist 模式下必须原样传 allow 列表。空列表在 SDK 里是
 * fail-closed（拒绝所有人），不能再 fallback 成 `['*']`，否则「只允许
 * 白名单」会变成「允许所有人」。
 */
export function accessPolicyFromConfig(config: ImQQBotConfig): AccessPolicy {
  return {
    c2c: {
      mode: config.access.c2cMode,
      allow: config.access.c2cMode === 'allowlist' ? config.access.c2cAllow : ['*'],
    },
    group: {
      mode: config.access.groupMode,
      allow: config.access.groupMode === 'allowlist' ? config.access.groupAllow : ['*'],
    },
  };
}
