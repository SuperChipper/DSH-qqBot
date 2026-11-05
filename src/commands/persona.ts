/**
 * 人设命令：/persona（别名 /人设）— 调出切换卡片，或按名字直接切换
 *
 * 切换只限主人和管理员，查看不限。
 */
import type { CommandDeps, CategorizedCommand } from './types.ts';
import type { ReplyTarget } from '../types.ts';
import { getScopePeer } from '../shared/index.ts';
import { DEFAULT_PERSONA_ID, DEFAULT_PERSONA_NAME } from '../features/persona-store.ts';
import { canManagePersona } from '../features/persona-switch.ts';

export function personaCommand({ manager, config }: CommandDeps): CategorizedCommand {
  return {
    name: ['persona', '人设'],
    category: 'qqbot',
    description: '查看或切换这个群的人设（用法: /persona [名字]）',
    authorized: (ctx) => {
      // 无参数只是调出卡片（不是管理员就没有按钮）；带名字才是修改
      const raw = (ctx.command?.raw ?? '').trim();
      if (raw === '') return true;
      return canManagePersona(ctx.message.senderId, config) || '⚠️ 只有 bot 主人或管理员可以切换人设。';
    },
    handler: async (cmdCtx) => {
      const { scope, peerId } = getScopePeer(cmdCtx);
      if (scope !== 'group') return '人设只能在群里切换。';
      const personas = manager.personaSwitch;
      if (personas === undefined || manager.personaStore === undefined) return '人设功能没有启用。';

      const arg = (cmdCtx.command?.raw ?? '').trim();
      if (arg === '') {
        const target: ReplyTarget = { scope, targetId: peerId, msgId: cmdCtx.message.messageId, receivedAt: Date.now() };
        await personas.sendCard(target, cmdCtx.message.senderId);
        return { kind: 'noop' as const };
      }
      if (arg === DEFAULT_PERSONA_ID || arg === DEFAULT_PERSONA_NAME) return personas.apply(peerId, DEFAULT_PERSONA_ID);
      const persona = manager.personaStore.find(arg);
      return persona === undefined ? `没有这个人设：${arg}` : personas.apply(peerId, persona.id);
    },
  };
}
