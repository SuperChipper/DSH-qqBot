/**
 * 跑团回合按钮：轮到 PC 时，在 DM 这一轮回复发完之后补一条「轮到 X」+ 按钮。
 *
 * 「结束回合」由谁点，看的是 QQ 回调里点击者的 openid，模型改不了：只有这个 PC 的玩家
 * 本人点才推进先攻；推进后给会话补一条系统消息，让 DM 接着结算怪物回合。
 * 「查看状态」由工具层直接回一份玩家视角的团况，不经过模型、也不会泄露怪物数值。
 * 攻击/施法/其他是指令按钮：只把半句话填进点击者自己的输入框，行动仍由本人发出。
 * /dnd start 的回复本身带签到按钮：「签到」按点击者 openid 记，群里发一行小提醒，人齐自动开场，见 check-in.ts。
 */
import type { InlineKeyboard, InteractionEvent } from '@tencent-connect/qqbot-nodejs';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { SessionManager, SessionRecord } from '../session/index.ts';
import type { Logger, ReplyTarget } from '../types.ts';
import { BUTTONS_PER_ROW, buttonLabel, decodeButtonData, encodeButtonData } from '../features/button-utils.ts';
import { type Campaign, type PendingAttack, findCharacter, nextTurn, playerStatus } from './campaign.ts';
import { REACTION_WINDOW_MS, waitingOn } from './pending-attack.ts';
import { type CheckIn, arrivalNotice, checkInHint, createCheckIn, isComplete, kickoffMessage, markArrived, rosterOf, rosterText } from './check-in.ts';
import type { DndService } from './dnd-service.ts';
import { combatTurnPrompt } from './dnd-tools.ts';

/** acknowledgeInteraction 的返回码：QQ 客户端据此弹提示 */
export const ACK = { ok: 0, failed: 1, duplicate: 3, denied: 4 } as const;

/** 等 DM 的回复真正发出去再补按钮，避免按钮消息跑到叙事前面 */
const FLUSH_DELAY_MS = 1500;
/** 「名单」按钮的冷却：这段时间内重复点不再发，免得几个人一起点刷屏 */
const ROSTER_COOLDOWN_MS = 30_000;
/** QQ 内联键盘最多几行：超了整条消息会发不出去 */
const MAX_KEYBOARD_ROWS = 5;
/** 签到提醒攒几秒再发：开团时几个人前后脚点签到，合成一条 */
const ARRIVAL_BATCH_MS = 4000;

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
            commandButton('dnd-wiki', '查询', '/dnd search '),
          ],
        },
      ],
    },
  };
}

/** 按钮上只放名字前半截：「刻德温 Kodwin」→「刻德温」，label 才不会被截成省略号 */
function shortName(name: string): string {
  const first = name.trim().split(/\s+/)[0] ?? name;
  return first.length > 0 ? first : name;
}

/**
 * 反应窗口：每个可用的反应一个按钮，再加一个「不用」。权限不靠 QQ 的 specify_user_ids，
 * 和「结束回合」一样在回调里比对点击者 openid：别人的按钮点了会被拒，提示也更明确。
 */
export function buildReactionKeyboard(p: PendingAttack): InlineKeyboard {
  const options = p.reactors.map((r, i) => callbackButton(`dnd-react-${i}`, buttonLabel(`${shortName(r.character)}·${r.reaction}`), 1, encodeButtonData({ t: 'dnd', a: 'react', r: p.seq, i })));
  // 挤在一行里名字会被截断 → 默认竖着排；QQ 键盘最多 5 行，选项太多才退回两列，宁可挤也别整条发不出去
  const perRow = options.length + 1 > MAX_KEYBOARD_ROWS ? BUTTONS_PER_ROW : 1;
  const rows: InlineKeyboard['content']['rows'] = [];
  for (let i = 0; i < options.length; i += perRow) rows.push({ buttons: options.slice(i, i + perRow) });
  rows.push({ buttons: [callbackButton('dnd-pass', '不用', 0, encodeButtonData({ t: 'dnd', a: 'pass', r: p.seq }))] });
  return { content: { rows } };
}

export function buildCheckInKeyboard(): InlineKeyboard {
  return {
    content: {
      rows: [{
        buttons: [
          callbackButton('dnd-in', '签到', 1, encodeButtonData({ t: 'dnd', a: 'in' })),
          callbackButton('dnd-go', '开始', 0, encodeButtonData({ t: 'dnd', a: 'go' })),
          callbackButton('dnd-roster', '名单', 0, encodeButtonData({ t: 'dnd', a: 'roster' })),
        ],
      }],
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
  /** 还没发出去的签到提醒（会话 key → 这一批刚签到的 openid） */
  private readonly pendingArrivals = new Map<string, { openids: string[]; timer: ReturnType<typeof setTimeout> }>();
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
    // 待结算期间回合按钮点了也推进不了，落账后会再排一次
    if (found.campaign.initiative?.pending !== undefined) return;
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

  /**
   * 有一笔待结算：回复发完后发反应按钮，再开始计时。计时不看按钮能不能发：
   * 按钮关着时玩家照样打字回应，时间到了也要提醒 DM 落账，否则这笔会一直挂着。
   */
  public scheduleReaction(record: SessionRecord): void {
    void record.agent.whenIdle()
      .catch(() => {})
      .then(() => new Promise((resolve) => setTimeout(resolve, FLUSH_DELAY_MS)))
      .then(() => this.openReactionWindow(record))
      .catch((err: unknown) => this.logger.warn(`im-qqbot: 反应窗口失败: ${err instanceof Error ? err.message : String(err)}`));
  }

  private async openReactionWindow(record: SessionRecord): Promise<void> {
    const p = this.service.active(record.sessionKey)?.campaign.initiative?.pending;
    if (p === undefined) return;
    if (!this.disabled && record.scope === 'group' && p.reactors.length > 0) {
      const text = `⚡ ${p.attacker} 打 ${p.target}，还没结算。要用反应的点下面，只有本人点才算，也可以直接打字说。`
        + `约 ${Math.round(REACTION_WINDOW_MS / 1000)} 秒没回算不用。`;
      try {
        await this.sender.sendMarkdown(record.replyTarget, text, { keyboard: buildReactionKeyboard(p) });
      } catch (err) {
        this.disabled = true;
        this.logger.warn(`im-qqbot: 反应按钮发送失败，本次运行不再发按钮: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const timer = setTimeout(() => this.reactionTimeout(record, p.seq), REACTION_WINDOW_MS);
    timer.unref?.();
  }

  private reactionTimeout(record: SessionRecord, seq: number): void {
    const p = this.service.active(record.sessionKey)?.campaign.initiative?.pending;
    if (p === undefined || p.seq !== seq) return;
    const waiting = waitingOn(p);
    if (waiting.length === 0) return;
    this.notifyDm(record, `[系统 · 反应窗口] 时间到，${waiting.join('、')} 没回，算不用。用 dnd_apply target=${p.target} settle=true 落账，再接着结算。`);
  }

  private notifyDm(record: SessionRecord, text: string): void {
    record.agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' as const } }));
  }

  /** 反应按钮：点击者必须是那个角色的玩家。「不用」只算他自己，全员答复才叫醒 DM，免得每人点一下都触发一轮回复 */
  private reactionClick(event: InteractionEvent, key: string, record: SessionRecord | undefined, button: { a: string; r?: number; i?: number }): number {
    const p = this.service.active(key)?.campaign.initiative?.pending;
    if (p === undefined || p.seq !== button.r) return ACK.duplicate;
    const clicker = event.group_member_openid ?? event.user_openid;
    const ownsReactor = (name: string): boolean => {
      const ch = this.service.active(key)?.campaign.characters.find((x) => x.name === name);
      return ch !== undefined && (ch.playerId === undefined || ch.playerId === clicker);
    };
    const answered = new Set([...p.declined, ...p.used.map((u) => u.by), ...p.claimed.map((o) => o.character)]);

    if (button.a === 'pass') {
      const mine = [...new Set(p.reactors.map((r) => r.character))].filter(ownsReactor);
      if (mine.length === 0) return ACK.denied;
      const fresh = mine.filter((name) => !answered.has(name));
      if (fresh.length === 0) return ACK.duplicate;
      const left = this.service.store.update(key, (c) => {
        const pending = c.initiative?.pending;
        if (pending === undefined) return undefined;
        for (const name of fresh) if (!pending.declined.includes(name)) pending.declined.push(name);
        return waitingOn(pending);
      }, `按钮 不用反应 ${fresh.join('、')}`);
      if (record !== undefined && left !== undefined && left.length === 0) {
        this.notifyDm(record, `[系统 · 按钮] 反应都答复了，${fresh.join('、')} 不用。用 dnd_apply target=${p.target} settle=true 落账，再接着结算。`);
      }
      return ACK.ok;
    }

    const option = button.i === undefined ? undefined : p.reactors[button.i];
    if (option === undefined) return ACK.failed;
    if (!ownsReactor(option.character)) return ACK.denied;
    if (answered.has(option.character)) return ACK.duplicate;
    this.service.store.update(key, (c) => {
      c.initiative?.pending?.claimed.push({ character: option.character, reaction: option.reaction });
    }, `按钮 反应 ${option.character}·${option.reaction}`);
    this.logger.info(`im-qqbot: 跑团反应按钮 key=${key} ${option.character}·${option.reaction} by=${clicker ?? '?'}`);
    if (record !== undefined) {
      this.notifyDm(record, `[系统 · 按钮] ${option.character} 的玩家本人点了用「${option.reaction}」。这是对「${p.attacker}→${p.target}」那笔的反应，不是新的回合行动：`
        + `用 dnd_apply target=${p.target} reaction={by:"${option.character}", name:"${option.reaction}", ...} 改数值，不用 declared_by。`);
    }
    return ACK.ok;
  }

  /**
   * 开团消息即签到表：intro（开团文字）+ 名单 + 签到/开始/名单按钮，合成一条发出。
   * reset=false 时沿用已有的签到表（/dnd checkin 只是把按钮再发一次）。
   * 按钮关着或发送失败返回 false，调用方退回纯文字回复。
   */
  public async openCheckIn(key: string, target: ReplyTarget, intro: string, reset: boolean): Promise<boolean> {
    if (this.disabled || target.scope !== 'group') return false;
    const found = this.service.active(key);
    if (found === undefined) return false;
    const existed = this.service.checkIns.get(key);
    const checkIn = reset || existed === undefined ? createCheckIn() : existed;
    this.service.checkIns.set(key, checkIn);
    const roster = rosterOf(checkIn, found.campaign);
    const text = [intro, rosterText(roster), checkIn.started ? '已经开场了，晚到的点「签到」就行。' : checkInHint(roster)]
      .filter((s) => s.length > 0).join('\n\n');
    try {
      await this.sender.sendMarkdown(target, text, { keyboard: buildCheckInKeyboard() });
      return true;
    } catch (err) {
      // 多半是机器人没开通消息按钮权限：关掉按钮，开团回复退回纯文字
      if (existed === undefined) this.service.checkIns.delete(key); else this.service.checkIns.set(key, existed);
      this.disabled = true;
      this.logger.warn(`im-qqbot: 跑团签到发送失败，本次运行不再发按钮: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /** bot 重启后点旧消息上的按钮：签到表丢了，重新开一张接着用 */
  private checkInOf(key: string): CheckIn {
    let checkIn = this.service.checkIns.get(key);
    if (checkIn === undefined) {
      checkIn = createCheckIn();
      this.service.checkIns.set(key, checkIn);
    }
    return checkIn;
  }

  /**
   * 开场：把出勤交给 DM，让它直接开讲。群里不另发「人齐了」，开场白本身就是信号。
   * 没有会话（bot 刚重启、群里还没人说过话）时开不了，留着下次点。
   */
  private kickoff(checkIn: CheckIn, record: SessionRecord | undefined, campaign: Campaign, reason: 'complete' | 'manual'): boolean {
    if (checkIn.started || record === undefined) return false;
    checkIn.started = true;
    // 开场叙述会说谁到了，攒着的签到提醒不用再发
    this.cancelArrivals(record.sessionKey);
    const text = kickoffMessage(rosterOf(checkIn, campaign), campaign.begun === true, reason);
    record.agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' as const } }));
    return true;
  }

  /** 签到：给点击者回执，群里攒一行小提醒；签完人齐了就自动开场（不再发提醒） */
  private checkIn(event: InteractionEvent, key: string, record: SessionRecord | undefined, campaign: Campaign): number {
    const clicker = event.group_member_openid ?? event.user_openid;
    if (clicker === undefined) return ACK.failed;
    const checkIn = this.checkInOf(key);
    if (!markArrived(checkIn, clicker)) return ACK.duplicate;
    this.logger.info(`im-qqbot: 跑团签到 key=${key} by=${clicker}`);
    if (isComplete(rosterOf(checkIn, campaign)) && this.kickoff(checkIn, record, campaign, 'complete')) {
      this.logger.info(`im-qqbot: 跑团人齐自动开场 key=${key}`);
    } else if (record !== undefined) {
      this.queueArrival(record, clicker);
    }
    return ACK.ok;
  }

  private queueArrival(record: SessionRecord, openid: string): void {
    const key = record.sessionKey;
    const pending = this.pendingArrivals.get(key);
    if (pending !== undefined) {
      pending.openids.push(openid);
      return;
    }
    const timer = setTimeout(() => this.flushArrivals(record), ARRIVAL_BATCH_MS);
    this.pendingArrivals.set(key, { openids: [openid], timer });
  }

  private cancelArrivals(key: string): void {
    const pending = this.pendingArrivals.get(key);
    if (pending === undefined) return;
    clearTimeout(pending.timer);
    this.pendingArrivals.delete(key);
  }

  private flushArrivals(record: SessionRecord): void {
    const key = record.sessionKey;
    const pending = this.pendingArrivals.get(key);
    this.pendingArrivals.delete(key);
    const found = this.service.active(key);
    const checkIn = this.service.checkIns.get(key);
    // 这几秒里结团了、或者已经开场（开场白会说谁到了）就不发
    if (pending === undefined || found === undefined || checkIn === undefined || checkIn.started) return;
    void this.sender.sendMarkdown(record.replyTarget, arrivalNotice(pending.openids, rosterOf(checkIn, found.campaign)))
      .catch((err: unknown) => this.logger.warn(`im-qqbot: 跑团签到提醒发送失败: ${err instanceof Error ? err.message : String(err)}`));
  }

  /** 「开始」：不等没到的人。点的人顺带算签到 */
  private start(event: InteractionEvent, key: string, record: SessionRecord | undefined, campaign: Campaign): number {
    const checkIn = this.checkInOf(key);
    const clicker = event.group_member_openid ?? event.user_openid;
    if (clicker !== undefined) markArrived(checkIn, clicker);
    if (checkIn.started) return ACK.duplicate;
    if (!this.kickoff(checkIn, record, campaign, 'manual')) return ACK.failed;
    this.logger.info(`im-qqbot: 跑团手动开场 key=${key} by=${clicker ?? '?'}`);
    return ACK.ok;
  }

  /** 「名单」：唯一会在群里发名单的地方，带冷却 */
  private roster(key: string, record: SessionRecord | undefined, campaign: Campaign, now = Date.now()): number {
    const checkIn = this.checkInOf(key);
    if (record === undefined) return ACK.failed;
    if (checkIn.rosterPostedAt !== undefined && now - checkIn.rosterPostedAt < ROSTER_COOLDOWN_MS) return ACK.duplicate;
    checkIn.rosterPostedAt = now;
    void this.sender.sendMarkdown(record.replyTarget, rosterText(rosterOf(checkIn, campaign)))
      .catch((err: unknown) => this.logger.warn(`im-qqbot: 跑团名单发送失败: ${err instanceof Error ? err.message : String(err)}`));
    return ACK.ok;
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

    if (button.a === 'in') return this.checkIn(event, key, record, found.campaign);
    if (button.a === 'go') return this.start(event, key, record, found.campaign);
    if (button.a === 'roster') return this.roster(key, record, found.campaign);
    if (button.a === 'react' || button.a === 'pass') return this.reactionClick(event, key, record, button);

    if (button.a === 'status') {
      if (record !== undefined) {
        void this.sender.sendMarkdown(record.replyTarget, `🎲 ${found.adventure.name}\n${playerStatus(found.campaign, found.adventure)}`)
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
    // 还有一笔没落账：现在推进就把窗口吃掉了
    if (found.campaign.initiative?.pending !== undefined) return ACK.failed;

    const next = this.service.store.update(key, (c) => {
      const { round, current, newRound } = nextTurn(c);
      return { round, newRound, prompt: combatTurnPrompt(c, current.name) };
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
