/**
 * 跑团回合按钮：轮到 PC 时，在 DM 这一轮回复发完之后补一条「轮到 X」+ 按钮。
 *
 * 「结束回合」由谁点，看的是 QQ 回调里点击者的 openid，模型改不了：只有这个 PC 的玩家
 * 本人点才推进先攻；推进后给会话补一条系统消息，让 DM 接着结算怪物回合。
 * 「查看状态」由工具层直接回一份玩家视角的团况，不经过模型、也不会泄露怪物数值。
 * 攻击/施法/其他是指令按钮：只把半句话填进点击者自己的输入框，行动仍由本人发出。
 */
import type { InlineKeyboard, InteractionEvent } from '@tencent-connect/qqbot-nodejs';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { SessionManager, SessionRecord } from '../session/index.ts';
import type { Logger, ReplyTarget } from '../types.ts';
import { decodeButtonData, encodeButtonData } from '../features/button-utils.ts';
import { type Campaign, findCharacter, nextTurn, playerStatus } from './campaign.ts';
import type { DndService } from './dnd-service.ts';
import { turnPrompt } from './dnd-tools.ts';

/** acknowledgeInteraction 的返回码：QQ 客户端据此弹提示 */
export const ACK = { ok: 0, failed: 1, duplicate: 3, denied: 4 } as const;

/** 等 DM 的回复真正发出去再补按钮，避免按钮消息跑到叙事前面 */
const FLUSH_DELAY_MS = 1500;

export interface TurnButtonSender {
  sendMarkdown(target: ReplyTarget, content: string, opts?: { keyboard?: InlineKeyboard }): Promise<unknown>;
}

type ButtonDef = InlineKeyboard['content']['rows'][number]['buttons'][number];

function callbackButton(id: string, label: string, style: number, data: string): ButtonDef {
  return {
    id,
    render_data: { label, visited_label: label, style },
    action: { type: 1, permission: { type: 2 }, data, unsupport_tips: '请升级 QQ 后再点' } as ButtonDef['action'],
  };
}

/** 指令按钮：点了把 data 填进点击者的输入框（自动带 @bot），不直接发送 */
function commandButton(id: string, label: string, data: string): ButtonDef {
  return {
    id,
    render_data: { label, visited_label: label, style: 0 },
    action: { type: 2, permission: { type: 2 }, data, enter: false, unsupport_tips: '请升级 QQ 后再点' } as ButtonDef['action'],
  };
}

export function buildTurnKeyboard(name: string, round: number): InlineKeyboard {
  return {
    content: {
      rows: [
        {
          buttons: [
            callbackButton('dnd-end', '结束回合', 1, encodeButtonData({ t: 'dnd', a: 'end', n: name, r: round })),
            callbackButton('dnd-status', '查看状态', 0, encodeButtonData({ t: 'dnd', a: 'status' })),
          ],
        },
        {
          buttons: [
            commandButton('dnd-attack', '攻击', `${name} 攻击 `),
            commandButton('dnd-cast', '施法', `${name} 施放 `),
            commandButton('dnd-other', '其他行动', `${name} `),
            commandButton('dnd-wiki', '查询', '/dnd 查 '),
          ],
        },
      ],
    },
  };
}

/** 当前回合的 PC（活着、有意识）；不是 PC 回合时返回 undefined */
function currentPc(c: Campaign): { name: string; player?: string; round: number; turn: number } | undefined {
  const state = c.initiative;
  const entry = state?.order[state.turn];
  if (state === undefined || entry === undefined) return undefined;
  const ch = findCharacter(c, entry.name);
  if (ch === undefined || ch.kind !== 'pc' || ch.hp === 0 || ch.conditions.includes('死亡')) return undefined;
  return { name: ch.name, ...(ch.player !== undefined ? { player: ch.player } : {}), round: state.round, turn: state.turn };
}

export class DndTurnButtons {
  private readonly scheduled = new Set<string>();
  /** 每个会话最后一次发按钮的回合，同一回合不重复发 */
  private readonly lastSent = new Map<string, string>();
  private disabled = false;

  public constructor(
    private readonly service: DndService,
    private readonly manager: SessionManager,
    private readonly sender: TurnButtonSender,
    private readonly logger: Logger,
  ) {}

  /** 先攻指针变了：等这一轮回复结束后，如果轮到 PC 就发按钮 */
  public schedule(record: SessionRecord): void {
    if (this.disabled || record.scope !== 'group' || this.scheduled.has(record.sessionKey)) return;
    this.scheduled.add(record.sessionKey);
    void record.agent.whenIdle()
      .catch(() => {})
      .then(() => new Promise((resolve) => setTimeout(resolve, FLUSH_DELAY_MS)))
      .then(() => this.flush(record))
      .catch((err: unknown) => this.logger.warn(`im-qqbot: 跑团按钮发送失败: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => this.scheduled.delete(record.sessionKey));
  }

  private async flush(record: SessionRecord): Promise<void> {
    const found = this.service.active(record.sessionKey);
    if (found === undefined) return;
    const pc = currentPc(found.campaign);
    if (pc === undefined) return;
    const mark = `${pc.round}:${pc.turn}:${pc.name}`;
    if (this.lastSent.get(record.sessionKey) === mark) return;
    this.lastSent.set(record.sessionKey, mark);
    const text = `▶ 第 ${pc.round} 轮 · 轮到 **${pc.name}**${pc.player !== undefined ? `〈${pc.player}〉` : ''}\n`
      + '宣告动作请 @我；动作、附赠动作、移动都用完了点「结束回合」（只有你本人点才算）。';
    try {
      await this.sender.sendMarkdown(record.replyTarget, text, { keyboard: buildTurnKeyboard(pc.name, pc.round) });
    } catch (err) {
      // 多半是机器人没开通消息按钮权限：关掉按钮，DM 照常用文字推进
      this.disabled = true;
      this.logger.warn(`im-qqbot: 跑团按钮发送失败，本次运行不再发按钮: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 处理按钮点击；不是跑团按钮时返回 undefined，交给其他通道 */
  public handleInteraction(event: InteractionEvent): number | undefined {
    const raw = event.data?.resolved?.button_data;
    const button = raw === undefined ? undefined : decodeButtonData(raw);
    if (button?.t !== 'dnd') return undefined;
    const groupId = event.group_openid;
    if (groupId === undefined) return ACK.failed;
    const key = this.manager.sessionKey('group', groupId);
    const record = this.manager.getSessionRecord('group', groupId);
    const found = this.service.active(key);
    if (found === undefined) return ACK.duplicate;

    if (button.a === 'status') {
      if (record !== undefined) {
        void this.sender.sendMarkdown(record.replyTarget, `🎲 ${found.dungeon.name}\n${playerStatus(found.campaign, found.dungeon)}`)
          .catch((err: unknown) => this.logger.warn(`im-qqbot: 跑团状态发送失败: ${err instanceof Error ? err.message : String(err)}`));
      }
      return ACK.ok;
    }

    // 结束回合：必须还是按钮上的那个回合，且由该 PC 的玩家本人点
    const pc = currentPc(found.campaign);
    if (pc === undefined || pc.name !== button.n || pc.round !== button.r) return ACK.duplicate;
    const ch = findCharacter(found.campaign, pc.name);
    const clicker = event.group_member_openid ?? event.user_openid;
    if (ch?.playerId !== undefined && ch.playerId !== clicker) return ACK.denied;

    const next = this.service.store.update(key, (c) => {
      const { round, current, newRound } = nextTurn(c);
      return { round, newRound, prompt: turnPrompt(findCharacter(c, current.name), current.name) };
    }, `按钮 结束回合 ${pc.name}`);
    this.logger.info(`im-qqbot: 跑团按钮结束回合 key=${key} ${pc.name} by=${clicker ?? '?'}`);

    if (record !== undefined) {
      const text = `[系统 · 按钮] ${pc.name}${pc.player !== undefined ? `〈${pc.player}〉` : ''} 点了「结束回合」，`
        + `先攻已由工具推进（不要再为 ${pc.name} 调用 dnd_initiative next）。`
        + `${next.newRound ? `进入第 ${next.round} 轮。` : ''}${next.prompt}`;
      record.agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' as const } }));
      this.schedule(record);
    }
    return ACK.ok;
  }
}
