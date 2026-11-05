/**
 * 人设切换卡片：/persona 发一张带按钮的消息，主人和管理员点一下切换当前群的人设。
 *
 * 按钮对所有人可点（QQ 的按钮权限管不到 openid 名单），是否放行看回调里点击者的 openid，
 * 模型改不了，也不提供切换人设的工具：否则群友能把 bot 说动，或者往 system prompt 里塞东西。
 */
import type { InlineKeyboard, InteractionEvent } from '@tencent-connect/qqbot-nodejs';
import type { ImQQBotConfig } from '../config.ts';
import { privilegedOpenids } from '../shared/permissions.ts';
import type { Logger, ReplyTarget } from '../types.ts';
import { BUTTONS_PER_ROW, buttonLabel, decodeButtonData, encodeButtonData } from './button-utils.ts';
import { DEFAULT_PERSONA_ID, DEFAULT_PERSONA_NAME, type PersonaStore } from './persona-store.ts';

/** acknowledgeInteraction 返回码（与 dnd/turn-buttons 的 ACK 一致） */
const ACK = { ok: 0, failed: 1, duplicate: 3, denied: 4 } as const;

/** QQ 键盘最多 5 行：4 行人设，留 1 行翻页 */
const PAGE_SIZE = 4 * BUTTONS_PER_ROW;

export type SwitchPersonaOutcome = 'ok' | 'same' | 'dnd' | 'busy';

export interface PersonaSwitchManager {
  switchPersona(groupId: string, personaId: string): SwitchPersonaOutcome;
}

export interface PersonaSender {
  sendMarkdown(target: ReplyTarget, content: string, opts?: { keyboard?: InlineKeyboard }): Promise<unknown>;
}

type ButtonDef = InlineKeyboard['content']['rows'][number]['buttons'][number];

interface PersonaOption {
  id: string;
  name: string;
}

/**
 * 能不能管人设。没配主人和管理员时也拒绝：isPrivilegedSender 那种放行所有人的旧行为，
 * 在这里等于任何群友都能改 system prompt。
 */
export function canManagePersona(senderId: string | undefined, config: ImQQBotConfig): boolean {
  return senderId !== undefined && privilegedOpenids(config).includes(senderId);
}

function button(id: string, label: string, style: number, data: string): ButtonDef {
  return {
    id,
    render_data: { label, visited_label: label, style },
    action: { type: 1, permission: { type: 2 }, data, unsupport_tips: '请升级 QQ 后再点' } as ButtonDef['action'],
  };
}

export function buildPersonaKeyboard(options: readonly PersonaOption[], currentId: string, page: number): InlineKeyboard {
  const pages = Math.max(1, Math.ceil(options.length / PAGE_SIZE));
  const shown = Math.min(Math.max(0, page), pages - 1);
  const rows: InlineKeyboard['content']['rows'] = [];
  const items = options.slice(shown * PAGE_SIZE, (shown + 1) * PAGE_SIZE);
  for (let i = 0; i < items.length; i += BUTTONS_PER_ROW) {
    rows.push({
      buttons: items.slice(i, i + BUTTONS_PER_ROW).map((item) => {
        const current = item.id === currentId;
        return button(
          `persona-${item.id}`,
          current ? `${buttonLabel(item.name).slice(0, 8)} ✓` : buttonLabel(item.name),
          current ? 1 : 0,
          encodeButtonData({ t: 'persona', a: 'use', p: item.id }),
        );
      }),
    });
  }
  const nav: ButtonDef[] = [];
  if (shown > 0) nav.push(button('persona-prev', '上一页', 0, encodeButtonData({ t: 'persona', a: 'page', n: shown - 1 })));
  if (shown < pages - 1) nav.push(button('persona-next', '下一页', 0, encodeButtonData({ t: 'persona', a: 'page', n: shown + 1 })));
  if (nav.length > 0) rows.push({ buttons: nav });
  return { content: { rows } };
}

export class PersonaSwitch {
  public constructor(
    private readonly manager: PersonaSwitchManager,
    private readonly store: PersonaStore,
    private readonly sender: PersonaSender,
    private readonly config: ImQQBotConfig,
    private readonly logger: Logger,
  ) {}

  /** 默认人设排最前，它没有文件 */
  private options(): PersonaOption[] {
    return [{ id: DEFAULT_PERSONA_ID, name: DEFAULT_PERSONA_NAME }, ...this.store.list()];
  }

  private nameOf(personaId: string): string {
    return this.options().find((option) => option.id === personaId)?.name ?? personaId;
  }

  /** 发卡片：能管的人看到按钮，其他人只看到当前人设 */
  public async sendCard(target: ReplyTarget, senderId: string | undefined, page = 0): Promise<void> {
    const currentId = this.store.currentId(target.targetId);
    const text = `当前人设：${this.nameOf(currentId)}`;
    if (!canManagePersona(senderId, this.config)) {
      await this.sender.sendMarkdown(target, text);
      return;
    }
    await this.sender.sendMarkdown(target, `${text}\n点按钮切换，只影响这个群。`, {
      keyboard: buildPersonaKeyboard(this.options(), currentId, page),
    });
  }

  /** 切换并返回给人看的结果；按钮和 /persona <名字> 共用 */
  public apply(groupId: string, personaId: string): string {
    const name = this.nameOf(personaId);
    const outcome = this.manager.switchPersona(groupId, personaId);
    if (outcome === 'ok') this.logger.info(`im-qqbot: 人设切换 group=${groupId} persona=${personaId}`);
    switch (outcome) {
      case 'ok': return `已切换到「${name}」。`;
      case 'same': return `现在就是「${name}」。`;
      case 'dnd': return '正在跑团，结团后再切换人设。';
      case 'busy': return '我正在回复，等这轮说完再切换。';
    }
  }

  public handleInteraction(event: InteractionEvent): number {
    const raw = event.data?.resolved?.button_data;
    const data = raw === undefined ? undefined : decodeButtonData(raw);
    if (data?.t !== 'persona') return ACK.duplicate;
    const groupId = event.group_openid;
    if (groupId === undefined) return ACK.failed;
    const clicker = event.group_member_openid ?? event.user_openid;
    if (!canManagePersona(clicker, this.config)) return ACK.denied;

    const target: ReplyTarget = { scope: 'group', targetId: groupId, eventId: event.id };
    const report = (err: unknown): void => {
      this.logger.warn(`im-qqbot: 人设消息发送失败: ${err instanceof Error ? err.message : String(err)}`);
    };
    if (data.a === 'page') {
      this.sendCard(target, clicker, data.n ?? 0).catch(report);
      return ACK.ok;
    }
    // 旧卡片上的人设可能已经删了
    const known = data.p !== undefined && this.options().some((option) => option.id === data.p);
    const text = known ? this.apply(groupId, data.p!) : '这个人设已经不在了，重新发一次 /persona。';
    this.sender.sendMarkdown(target, text).catch(report);
    return ACK.ok;
  }
}
