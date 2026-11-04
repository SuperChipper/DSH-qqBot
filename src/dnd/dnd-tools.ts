/**
 * dnd_* 跑团工具：骰子、检定、伤害/治疗/状态、角色卡、先攻、移动、地图、剧情、模组查询、结团、SRD 查询。
 *
 * 工具结果只给模型看（showToolResults 对 dnd_* 永远不展示），DM 机密留在这里，
 * 由模型决定哪些说给玩家。团按会话 key 区分：每个群一份。
 */
import { join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { DshAgent, SessionManager, SessionRecord } from '../session/index.ts';
import { recentSenderIds } from '../session/session-manager.ts';
import type { Logger } from '../types.ts';
import { ATTITUDES, type Adventure, type Attitude, QUEST_STATUSES, type QuestStatus, findNpc, findQuest, roomGraph } from './adventure.ts';
import { type Advantage, type Roller, rollD20, rollExpression } from './dice.ts';
import {
  type Campaign,
  type Character,
  type CharacterInput,
  type CharacterKind,
  type HpChange,
  addSummary,
  SUMMARY_MAX_CHARS,
  UNDEAD_FORTITUDE,
  applyDamage,
  assertCanAct,
  assertCanEndTurn,
  attackModifier,
  changeCondition,
  changeInventory,
  checkModifier,
  deathSave,
  endInitiative,
  explored,
  findCharacter,
  findWeapon,
  gotoTurn,
  grantTempHp,
  heal,
  inInitiative,
  isRangedWeapon,
  isTwoHandedWeapon,
  fightRooms,
  joinInitiative,
  leaveInitiative,
  outsideRooms,
  moveParty,
  nextTurn,
  partyPositions,
  pushLog,
  recordDeathFailures,
  removeCharacter,
  resourceTag,
  requireCharacter,
  requireInitiative,
  rest,
  restoreResource,
  roomOf,
  setResource,
  spawnEncounter,
  spawnMonsters,
  startInitiative,
  summarize,
  upsertCharacter,
  useResource,
  usesGreatWeaponFighting,
  weaponAttackModifier,
  type Weapon,
  weaponDamage,
} from './campaign.ts';
import {
  CHRONICLE_KINDS,
  type ChronicleKind,
  addEntry,
  closeEntry,
  formatEntry,
  markChronicle,
  openEntries,
  recentEntries,
  recordChanges,
  searchEntries,
  seedChronicle,
} from './chronicle.ts';
import type { DndService } from './dnd-service.ts';
import { findRoom, resolveRoom } from './dungeon.ts';
import { renderMapPng } from './map-render.ts';
import {
  type NpcState,
  afterChange,
  beginAdventure,
  fireTrigger,
  leadsCard,
  learnLead,
  npcAlive,
  npcBrief,
  npcCard,
  npcCharacterInput,
  npcRoom,
  npcsIn,
  pendingTriggers,
  questCard,
  revealFact,
  roomBrief,
  roomCard,
  setChapter,
  setFlag,
  setQuestStatus,
  shopLine,
  siteCard,
  updateNpc,
} from './story.ts';
import { ABILITIES, ABILITY_NAMES, type Ability, type Skill, SKILLS, parseAbility, parseSkill, skillLabel } from './rules.ts';
import { applyProgressPatch, isEmptyPatch, parseProgressPatch } from './progress-patch.ts';
import { type SrdEntry, type SrdKind, candidatesText, resolveSrdQuery, zhTable } from './srd-lookup.ts';
import { DEFENSE_NAMES, type SaveTarget, parseDefense, parseSaveTargets, resolveSaveEffect, saveDamage } from './save-effect.ts';

export const DND_TOOL_PREFIX = 'dnd_';

interface ToolsRegistryLike {
  register(definition: unknown): unknown;
}

export interface DndToolDeps {
  service: DndService;
  manager: SessionManager;
  logger: Logger;
  /** 把地图发到当前会话 */
  sendImage(record: SessionRecord, path: string, caption?: string): Promise<void>;
  /** 先攻指针变了（start/next/goto）：轮到 PC 时由按钮模块在回复发完后发「结束回合」按钮 */
  onTurnChange?(record: SessionRecord): void;
  /** 群成员短别名（#U3）和 openid 互换；不传时 declared_by / player_id 按原样当 openid */
  members?: MemberIds;
}

/** 模型只看得到群内短别名，要真实 openid 的参数由这里换回去 */
export interface MemberIds {
  /** U3 / #U3（或本群已知的 openid）→ openid；查不到返回 undefined */
  toOpenid(record: SessionRecord, value: string): string | undefined;
  /** openid → 给模型看的别名（如 U3）；没见过的人返回 undefined */
  display(record: SessionRecord, openid: string): string | undefined;
}

type Exec = { agent?: unknown; label?: string };

/** declared_by 要和这段时间内真正发过消息的人对得上（覆盖一轮里插进来的消息） */
const SENDER_WINDOW_MS = 10 * 60 * 1000;

const TEXT_OUTPUT = {
  schema: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
    additionalProperties: false,
  },
  render: (_args: unknown, value: unknown): ContentBlock[] => [{ type: 'text', text: (value as { text: string }).text }],
};

const SECRET_NOTE = '（DM 机密：不要把 DC/AC 说给玩家）';

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function int(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : undefined;
}

function strList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).map((v) => v.trim());
}

function advantageOf(value: unknown): Advantage {
  return value === 'advantage' || value === 'disadvantage' ? value : 'none';
}

function hpLine(change: HpChange): string {
  const temp = change.tempHp > 0 ? `（临时 HP ${change.tempHp}）` : '';
  const absorbed = change.absorbed > 0 ? `，临时 HP 吸收 ${change.absorbed}` : '';
  const events = change.events.length > 0 ? `，${change.events.join('、')}` : '';
  const wound = change.wound !== undefined ? `（对玩家只说「${change.wound}」，不报数字）` : '';
  return `${change.name} HP ${change.before}→${change.after}/${change.maxHp}${temp}${absorbed}${events}${wound}`;
}

/** 重击：骰子数量翻倍，常数不变 */
export function critExpression(expression: string): string {
  return expression.replace(/(\d*)d(\d+)/gi, (_m, n: string, sides: string) => `${(n === '' ? 1 : Number(n)) * 2}d${sides}`);
}

/** 表达式里一共有几颗骰子（常数不算） */
export function diceCount(expression: string): number {
  let n = 0;
  for (const m of expression.matchAll(/(\d*)d\d+/gi)) n += m[1] === '' ? 1 : Number(m[1]);
  return n;
}

/**
 * 巨武器战斗：只对前 weaponDice 颗骰（武器本身的伤害骰，表达式里排在最前）掷出 1、2 时重投一次，
 * 必须用新点数。偷袭、神恩之类附加骰不重投。明细里只显示最终点数，重投记在 rerolls 里另报。
 */
export function greatWeaponRoller(roller: Roller, weaponDice: number): { roller: Roller; rerolls: string[] } {
  const rerolls: string[] = [];
  let i = 0;
  return {
    rerolls,
    roller: (sides) => {
      const first = roller(sides);
      if (i++ >= weaponDice || first > 2) return first;
      const second = roller(sides);
      rerolls.push(`${first}→${second}`);
      return second;
    },
  };
}

function weaponTags(w: Weapon): string {
  const tags = [
    w.magic ? `+${w.magic} 魔法` : '',
    w.proficient === false ? '不熟练' : '',
    isRangedWeapon(w) ? '远程' : '',
    isTwoHandedWeapon(w) ? '双手持' : '',
  ].filter(Boolean);
  return tags.length > 0 ? `［${tags.join('，')}］` : '';
}

/** who：把角色卡上绑定的 openid 换成给模型看的成员编号 */
function sheet(ch: Character, who: (openid: string) => string = (id) => id): string {
  const abilities = ABILITIES.map((a) => `${ABILITY_NAMES[a]}${ch.abilities[a]}`).join(' ');
  const lines = [
    `${ch.name}${ch.player ? `〈${ch.player}${ch.playerId ? ` ${who(ch.playerId)}` : ''}〉` : ''}｜${ch.kind === 'pc' ? 'PC' : (ch.kind === 'npc' ? 'NPC' : '怪物')}${ch.className ? ` ${ch.className}` : ''} ${ch.level} 级`,
    `HP ${ch.hp}/${ch.maxHp}${ch.tempHp > 0 ? ` +${ch.tempHp}` : ''}  AC ${ch.ac}`,
    abilities,
  ];
  if (ch.skills.length > 0) lines.push(`熟练技能：${ch.skills.map(skillLabel).join('、')}`);
  if ((ch.expertise?.length ?? 0) > 0) lines.push(`专精：${ch.expertise!.map(skillLabel).join('、')}`);
  if (ch.saves.length > 0) lines.push(`熟练豁免：${ch.saves.map((a) => ABILITY_NAMES[a]).join('、')}`);
  if (ch.attackBonus !== undefined || ch.damage !== undefined) lines.push(`攻击 +${attackModifier(ch)} 伤害 ${ch.damage ?? '?'}`);
  for (const w of ch.weapons ?? []) {
    const hit = weaponAttackModifier(ch, w);
    lines.push(`武器 ${w.name}${weaponTags(w)}：命中 ${hit >= 0 ? '+' : ''}${hit}，伤害 ${weaponDamage(ch, w)}${w.notes ? `（${w.notes}）` : ''}`);
  }
  if (ch.conditions.length > 0) lines.push(`状态：${ch.conditions.join('、')}`);
  if (ch.deathSaves !== undefined) lines.push(`死亡豁免：成功 ${ch.deathSaves.successes}/3 失败 ${ch.deathSaves.failures}/3`);
  const resources = Object.entries(ch.resources ?? {}).map(([k, r]) => `${k} ${r.current}/${r.max}（${{ short: '短休回满', long: '长休回满', none: '不回复' }[r.reset]}）`);
  if (ch.hitDie !== undefined) resources.push(`生命骰 ${ch.hitDie} ${ch.level - (ch.hitDiceUsed ?? 0)}/${ch.level}`);
  if (resources.length > 0) lines.push(`资源：${resources.join('、')}`);
  if ((ch.inventory?.length ?? 0) > 0 || ch.gp !== undefined) lines.push(`物品：${ch.inventory?.join('、') || '无'}${ch.gp !== undefined ? `；${ch.gp} gp` : ''}`);
  if (ch.traits !== undefined && ch.traits.length > 0) lines.push(`特性：${ch.traits.join('、')}`);
  if (ch.room !== undefined) lines.push(`位置：${ch.room}`);
  if (ch.srd) lines.push(`SRD：${ch.srd}`);
  if (ch.notes) lines.push(`备注：${ch.notes}`);
  return lines.join('\n');
}

/** dnd_character show brief=true：一行状态，够回答「我还剩多少血/法术位」 */
export function characterBrief(c: Campaign, ch: Character): string {
  const room = roomOf(c, ch);
  return `${ch.name} HP ${ch.hp}/${ch.maxHp}${ch.tempHp > 0 ? `+${ch.tempHp}` : ''} AC ${ch.ac}`
    + `${ch.conditions.length > 0 ? ` [${ch.conditions.join(',')}]` : ''}${resourceTag(ch)}${room !== undefined ? ` @${room}` : ''}`;
}

function parseSkills(values: string[] | undefined): Skill[] | undefined {
  if (values === undefined) return undefined;
  return values.map((v) => {
    const skill = parseSkill(v);
    if (skill === undefined) throw new Error(`未知技能: ${v}。可用：${Object.values(SKILLS).map((s) => s.name).join('、')}`);
    return skill;
  });
}

function parseWeapons(value: unknown): Weapon[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((raw) => {
    const w = raw as Record<string, unknown>;
    const name = str(w.name);
    const damage = str(w.damage);
    if (name === undefined || damage === undefined) throw new Error('武器需要 name 和 damage');
    rollExpression(damage); // 只为校验表达式
    const weapon: Weapon = { name, damage };
    if (w.ability === 'str' || w.ability === 'dex') weapon.ability = w.ability;
    const notes = str(w.notes);
    if (notes !== undefined) weapon.notes = notes;
    const magic = int(w.magic);
    if (magic !== undefined && magic !== 0) weapon.magic = Math.max(-3, Math.min(3, magic));
    if (w.proficient === false) weapon.proficient = false;
    if (typeof w.ranged === 'boolean') weapon.ranged = w.ranged;
    if (typeof w.two_handed === 'boolean') weapon.twoHanded = w.two_handed;
    return weapon;
  });
}

function parseAbilities(values: string[] | undefined): Ability[] | undefined {
  if (values === undefined) return undefined;
  return values.map((v) => {
    const ability = parseAbility(v);
    if (ability === undefined) throw new Error(`未知属性: ${v}`);
    return ability;
  });
}

export function registerDndTools(ctx: Context, deps: DndToolDeps): void {
  const tools = ctx.get('tools') as ToolsRegistryLike | undefined;
  if (!tools?.register) {
    deps.logger.warn('im-qqbot: tools 服务不可用，跑团工具未注册');
    return;
  }
  const { service, manager } = deps;

  const recordOf = (exec: Exec): SessionRecord => {
    const record = exec.agent !== undefined ? manager.findByAgent(exec.agent as DshAgent) : undefined;
    if (record === undefined) throw new Error('跑团工具只能在 QQ 会话里用');
    return record;
  };

  /**
   * 读写当前会话的团；fn 抛错时不落盘。
   * 每次改动后统一跑一遍 afterChange（任务达成、里程碑…），有提示就接在文字结果后面。
   */
  const mutate = <T>(exec: Exec, fn: (c: Campaign, adventure: Adventure) => T): T => {
    const key = recordOf(exec).sessionKey;
    const { adventure } = service.require(key);
    return service.store.update(key, (c) => {
      seedChronicle(c, adventure);
      const before = markChronicle(c);
      const result = fn(c, adventure);
      const story = afterChange(c, adventure);
      for (const line of story) pushLog(c, line);
      recordChanges(before, c, adventure);
      return (story.length > 0 && typeof result === 'string' ? `${result}\n【剧情】${story.join('；')}` : result) as T;
    }, exec.label);
  };

  const sendersOf = (exec: Exec): string[] => recentSenderIds(recordOf(exec), SENDER_WINDOW_MS);

  /** 模型写的成员编号（U3）→ openid；未知编号直接报错，不能原样当 openid 存进角色卡或拿去校验 */
  const memberId = (exec: Exec, value: unknown, param: string): string | undefined => {
    const raw = str(value);
    if (raw === undefined || deps.members === undefined) return raw;
    const openid = deps.members.toOpenid(recordOf(exec), raw);
    if (openid === undefined) {
      throw new Error(`不认识的成员编号「${raw}」：${param} 填那位玩家消息标签里的编号，例如「[阿乙 #U3]」就填 U3。`);
    }
    return openid;
  };
  const whoOf = (exec: Exec) => (openid: string): string => {
    const alias = deps.members?.display(recordOf(exec), openid);
    return alias === undefined ? openid : `#${alias}`;
  };

  /**
   * dnd_check type=save 的伤害/多目标结算。spendFrom：花资源的人（施法者，或没有 targets 时掷豁免的人）；
   * 来源不是角色（陷阱）时不扣资源。
   */
  const saveEffectText = (c: Campaign, args: Record<string, unknown>, targets: SaveTarget[], source: string | undefined, hasSheet: boolean): string => {
    const ability = parseAbility(String(args.ability ?? ''));
    if (ability === undefined) throw new Error(`dnd_check: 豁免要给 ability（如 敏捷），收到 ${String(args.ability ?? '')}`);
    const spendKey = str(args.spend);
    const spender = source ?? targets[0]!.name;
    if (spendKey !== undefined && !hasSheet) throw new Error(`「${spender}」不是角色卡上的人，不能 spend`);
    const spent = spendKey === undefined ? undefined : useResource(c, spender, spendKey);
    const dc = int(args.dc);
    const damage = str(args.damage);
    const result = resolveSaveEffect(c, {
      targets, ability, dc, damage, damageType: str(args.damage_type), onSave: args.on_save === 'none' ? 'none' : 'half',
      advantage: advantageOf(args.advantage), bonus: int(args.bonus), bonusDice: str(args.bonus_dice), roller: service.roller,
    });
    const label = `${ABILITY_NAMES[ability]}豁免`;
    const head = [
      source !== undefined ? `${source} 的效果：` : '',
      `${label}${dc !== undefined ? ` DC ${dc}` : ''}`,
      result.damageRoll !== undefined
        ? `，伤害 ${result.damageRoll.detail}${str(args.damage_type) ? ` ${str(args.damage_type)}` : ''}（成功${args.on_save === 'none' ? '无伤' : '减半'}）`
        : '',
    ].join('');
    const lines = [head];
    for (const o of result.outcomes) {
      if (o.skipped !== undefined) {
        lines.push(`- ${o.name}：${o.skipped}，跳过`);
        continue;
      }
      const verdict = o.saved === undefined ? '' : ` → ${o.saved ? '成功' : '失败'}`;
      const nat = o.natural === 20 ? '（天然 20）' : (o.natural === 1 ? '（天然 1）' : '');
      const dmg = o.damage === undefined
        ? ''
        : `，${o.defense !== undefined ? `${DEFENSE_NAMES[o.defense]} ` : ''}受 ${o.damage}${o.change !== undefined ? `；${hpLine(o.change)}` : ''}`;
      lines.push(`- ${o.name} ${o.detail}${verdict}${nat}${dmg}`);
    }
    if (spent !== undefined) lines.push(`用掉「${spent.key}」，剩 ${spent.resource.current}/${spent.resource.max}`);
    lines.push(args.secret === true ? '（暗骰：点数和 DC 都不要告诉玩家）' : SECRET_NOTE);
    return lines.join('\n');
  };

  const register = (
    name: string,
    description: string,
    properties: Record<string, unknown>,
    required: string[],
    run: (args: Record<string, unknown>, exec: Exec) => Promise<string> | string,
  ): void => {
    tools.register({
      name,
      description,
      parameters: { type: 'object', properties, required, additionalProperties: false },
      output: TEXT_OUTPUT,
      async execute(args: unknown, exec: Exec): Promise<{ text: string }> {
        const input = (args ?? {}) as Record<string, unknown>;
        // 快照标签：undo 列表里让模型认得出是哪一步
        const brief = Object.entries(input)
          .filter(([k]) => !['declared_by', 'reaction', 'dm_override'].includes(k))
          .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
          .join(' ')
          .slice(0, 120);
        return { text: await run(input, { ...exec, label: `${name} ${brief}` }) };
      },
    });
  };

  register(
    'dnd_roll',
    'Roll dice for the D&D game (damage, random tables, anything not covered by dnd_check). Never invent dice '
    + 'results yourself: always call this. Supports NdM, NdMkhX/klX, constants joined by + or -, e.g. "2d6+3", "4d6kh3".',
    {
      expression: { type: 'string', description: 'Dice expression, e.g. "1d8+2".' },
      reason: { type: 'string', description: 'What the roll is for, e.g. "长剑伤害".' },
      secret: { type: 'boolean', description: 'DM-only roll: do not tell players the number.' },
    },
    ['expression'],
    (args) => {
      const expression = str(args.expression);
      if (expression === undefined) throw new Error('dnd_roll: expression 不能为空');
      const result = rollExpression(expression, service.roller);
      const reason = str(args.reason);
      return `${reason ? `${reason}：` : ''}${result.detail}${args.secret === true ? '（暗骰：不要告诉玩家点数）' : ''}`;
    },
  );

  register(
    'dnd_check',
    'Resolve a d20 roll for a character: skill check, ability check, saving throw, attack, or death save. '
    + 'The DC (or the target\'s AC) stays hidden from players. For attacks with a known damage expression the hit '
    + 'damage is rolled (crits double the dice) and applied to the target automatically. '
    + 'Save effects (fireball, breath weapon, sacred flame, a trap on several PCs): ONE call with type=save, '
    + '`character` = the caster/source, `targets` = everyone who saves, plus dc, ability, damage; the tool rolls '
    + 'damage once, rolls each save, halves on success (on_save), applies resistance/immunity and HP. Never loop '
    + 'one call per target or pre-roll the damage.',
    {
      character: { type: 'string', description: 'Who rolls (character name or the player\'s nickname).' },
      type: { type: 'string', enum: ['skill', 'ability', 'save', 'attack', 'death'] },
      skill: { type: 'string', description: 'For type=skill, e.g. "察觉" or "stealth".' },
      ability: {
        type: 'string',
        description: 'For ability/save, e.g. "敏捷". For attack: override the attack ability; spell attacks MUST pass the '
          + 'casting ability (wis cleric/druid/ranger, int wizard, cha bard/paladin/sorcerer/warlock).',
      },
      dc: { type: 'integer', description: 'Difficulty class for skill/ability/save. Secret.' },
      target: { type: 'string', description: 'For type=attack: the character being attacked.' },
      targets: {
        type: 'array',
        description: 'For type=save: creatures that make the save (then `character` is the caster or source, e.g. '
          + 'a trap name). Only `name` is required per item. Use it even for one target.',
        // 只用对象形式：不确定宿主/模型端是否支持 anyOf；运行时仍兼容纯字符串
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            advantage: { type: 'string', enum: ['none', 'advantage', 'disadvantage'] },
            bonus: { type: 'integer' },
            defense: { type: 'string', enum: ['resistant', 'immune', 'vulnerable'], description: 'Against this damage type.' },
          },
          required: ['name'],
          additionalProperties: false,
        },
      },
      on_save: { type: 'string', enum: ['half', 'none'], description: 'For type=save with damage: what a successful save takes (default half).' },
      defense: {
        type: 'string',
        enum: ['resistant', 'immune', 'vulnerable'],
        description: 'The attack target (or the lone saver when there are no `targets`) resists / is immune / vulnerable to this damage type.',
      },
      weapon: { type: 'string', description: 'For type=attack: weapon name from the attacker\'s sheet; damage and ability come from it.' },
      damage: {
        type: 'string',
        description: 'For type=attack: damage expression for spells/special attacks, or extra dice such as sneak attack "1d6". '
          + 'With `weapon` it is ADDED to the weapon damage. For type=save: the effect\'s full damage, rolled once for all targets.',
      },
      damage_type: { type: 'string', description: 'For attack/save damage: damage type, e.g. 光耀/穿刺/火焰 (radiant beats Undead Fortitude).' },
      advantage: { type: 'string', enum: ['none', 'advantage', 'disadvantage'] },
      bonus: {
        type: 'integer',
        description: 'Extra situational flat modifier (e.g. cover). Magic weapons, fighting styles and expertise on the '
          + 'sheet are applied automatically; never add them here.',
      },
      bonus_dice: {
        type: 'string',
        description: 'Extra dice added to THIS d20 roll, rolled by the tool: guidance/bless "1d4", bardic inspiration "1d6". '
          + 'Never pre-roll these with dnd_roll.',
      },
      spend: {
        type: 'string',
        description: 'Resource the roller spends on this roll, e.g. "1环法术位" for guiding bolt, "诗人激励" (spent by '
          + 'the character it is on). Fails if none left. Only when the player said they use it.',
      },
      secret: { type: 'boolean', description: 'Hidden check (passive perception, insight): do not reveal the roll.' },
      declared_by: {
        type: 'string',
        description: 'Member id of the player whose message declared this action: the #U number in their tag "[昵称 #U3]" (pass "U3"). '
          + 'Required for a PC acting on their own; omit for monsters/NPCs.',
      },
      reaction: {
        type: 'boolean',
        description: 'A roll you (the DM) call for outside the actor\'s own declaration: contested checks, '
          + 'opportunity attacks, reactions. Skips the turn-order and player checks.',
      },
      dm_override: {
        type: 'boolean',
        description: 'Roll for a PC whose player has not spoken because another player explicitly delegated it '
          + '(e.g. "让 Kriv 去谈"): skips the "only the owner may declare" check but still respects turn order. '
          + 'Requires declared_by (who delegated) and must be explained in the reply.',
      },
    },
    ['character', 'type'],
    (args, exec) => mutate(exec, (c) => {
      const type = String(args.type);
      if (args.dm_override === true && str(args.declared_by) === undefined) {
        throw new Error('dnd_check: dm_override 还要给 declared_by（提出委托的玩家编号，如 U4），并在回复里写明是谁委托的');
      }
      const actOptions = () => ({
        declaredBy: memberId(exec, args.declared_by, 'declared_by'),
        reaction: args.reaction === true,
        dmOverride: args.dm_override === true,
        recentSenders: sendersOf(exec),
      });
      const targets = type === 'save' ? parseSaveTargets(args.targets) : undefined;
      if (targets !== undefined && targets.length > 0) {
        // character 是施法者/来源：是角色卡上的人就按主动行动校验并从他身上扣资源；陷阱之类的来源不校验
        const source = findCharacter(c, String(args.character ?? ''));
        if (source !== undefined) {
          if (args.reaction === true && c.initiative !== undefined) c.initiative.rebrief = true;
          assertCanAct(c, source, actOptions());
        }
        return saveEffectText(c, args, targets, source?.name ?? str(args.character) ?? '效果', source !== undefined);
      }
      const ch = requireCharacter(c, String(args.character ?? ''));
      const adv = advantageOf(args.advantage);
      const secret = args.secret === true;
      if (type === 'save' && str(args.damage) !== undefined) {
        // 没有 targets 但带了伤害：掷豁免的人自己挨这一下（踩中陷阱），走同一套减半/抗性结算
        const defense = parseDefense(args.defense);
        return saveEffectText(c, args, [{ name: ch.name, ...(defense !== undefined ? { defense } : {}) }], undefined, true);
      }
      // 豁免和死亡豁免是被动发生的，不需要宣告；攻击和检定是主动行动
      if (type !== 'save' && type !== 'death') {
        // 打断回合顺序的反应/借机攻击之后，下一个 PC 回合重新给完整的停手提示
        if (args.reaction === true && c.initiative !== undefined) c.initiative.rebrief = true;
        assertCanAct(c, ch, actOptions());
      }
      const spendKey = str(args.spend);
      const spent = spendKey === undefined ? undefined : useResource(c, ch.name, spendKey);
      const spentNote = spent === undefined ? '' : `\n用掉「${spent.key}」，剩 ${spent.resource.current}/${spent.resource.max}`;
      const bonusDice = str(args.bonus_dice);
      const extraRoll = bonusDice === undefined ? undefined : rollExpression(bonusDice, service.roller);
      const bonus = (int(args.bonus) ?? 0) + (extraRoll?.total ?? 0);
      const extraNote = extraRoll === undefined ? '' : `（含额外骰 ${extraRoll.detail}）`;

      if (type === 'death') {
        const r = deathSave(c, ch.name, service.roller);
        return `${r.name} 死亡豁免 ${r.detail}：${{ success: '成功', failure: '失败', stable: '三次成功，伤势稳定', dead: '死亡', revived: '天然 20，恢复 1 HP 醒来' }[r.outcome]}（成功 ${r.successes}/3，失败 ${r.failures}/3）`;
      }

      if (type === 'attack') {
        const targetName = str(args.target);
        if (targetName === undefined) throw new Error('dnd_check: 攻击需要 target');
        const target = requireCharacter(c, targetName);
        const weaponName = str(args.weapon);
        const weapon = weaponName === undefined ? undefined : findWeapon(ch, weaponName);
        const override = str(args.ability);
        const ability = override !== undefined ? parseAbility(override) : (weapon === undefined ? undefined : weapon.ability ?? 'str');
        const modifier = weapon !== undefined ? weaponAttackModifier(ch, weapon, ability) : attackModifier(ch, ability);
        const roll = rollD20(modifier + bonus, adv, service.roller);
        const crit = roll.natural === 20;
        const hit = crit || (roll.natural !== 1 && roll.total >= target.ac);
        const lines = [`${ch.name}${weapon !== undefined ? `（${weapon.name}）` : ''} 攻击 ${target.name}：${roll.detail}${extraNote} vs AC ${target.ac} → ${crit ? '重击！' : (hit ? '命中' : (roll.natural === 1 ? '天然 1，失手' : '未命中'))}${spentNote}`];
        if (hit) {
          const extra = str(args.damage);
          const expression = weapon !== undefined
            ? `${weaponDamage(ch, weapon)}${extra !== undefined ? `+${extra}` : ''}`
            : extra ?? ch.damage;
          if (expression === undefined) {
            lines.push('没有伤害表达式：传 weapon（角色卡上的武器），或用 dnd_roll 掷伤害（重击时骰子翻倍）再 dnd_apply 扣血。');
          } else {
            const gwf = usesGreatWeaponFighting(ch, weapon)
              ? greatWeaponRoller(service.roller, diceCount(crit ? critExpression(weapon!.damage) : weapon!.damage))
              : undefined;
            const dmg = rollExpression(crit ? critExpression(expression) : expression, gwf?.roller ?? service.roller);
            const rerolled = gwf !== undefined && gwf.rerolls.length > 0 ? `（巨武器战斗重投：${gwf.rerolls.join('、')}）` : '';
            const defense = parseDefense(args.defense);
            const amount = saveDamage(dmg.total, false, 'half', defense);
            lines.push(`伤害 ${dmg.detail}${rerolled}${defense !== undefined ? `，${DEFENSE_NAMES[defense]} → ${amount}` : ''}`);
            const change = applyDamage(c, target.name, amount, { crit, damageType: str(args.damage_type), roller: service.roller });
            // 倒地的 PC 被重击：死亡豁免记两次失败（applyDamage 已记一次）
            if (crit && change.before === 0 && target.kind === 'pc' && !target.conditions.includes('死亡')) {
              change.events.push(...recordDeathFailures(c, target.name, 1));
            }
            lines.push(hpLine(change));
          }
        }
        lines.push(SECRET_NOTE);
        return lines.join('\n');
      }

      let ability: Ability | undefined;
      let skill: Skill | undefined;
      if (type === 'skill') {
        skill = parseSkill(String(args.skill ?? ''));
        if (skill === undefined) throw new Error(`dnd_check: 未知技能 ${String(args.skill ?? '')}。可用：${Object.values(SKILLS).map((s) => s.name).join('、')}`);
        ability = SKILLS[skill].ability;
      } else if (type === 'ability' || type === 'save') {
        ability = parseAbility(String(args.ability ?? ''));
        if (ability === undefined) throw new Error(`dnd_check: 未知属性 ${String(args.ability ?? '')}`);
      } else {
        throw new Error(`dnd_check: 未知类型 ${type}`);
      }
      const kind = type as 'skill' | 'ability' | 'save';
      const roll = rollD20(checkModifier(ch, kind, ability, skill) + bonus, adv, service.roller);
      const label = skill !== undefined ? `${skillLabel(skill)}检定` : `${ABILITY_NAMES[ability]}${kind === 'save' ? '豁免' : '检定'}`;
      const dc = int(args.dc);
      const verdict = dc === undefined
        ? ''
        : ` vs DC ${dc} → ${roll.total >= dc ? '成功' : '失败'}${roll.natural === 20 ? '（天然 20）' : (roll.natural === 1 ? '（天然 1）' : '')}`;
      return `${ch.name} ${label}：${roll.detail}${extraNote}${verdict}${spentNote}\n${secret ?'（暗骰：点数和 DC 都不要告诉玩家，只描述角色察觉到/没察觉到什么）' : SECRET_NOTE}`;
    }),
  );

  register(
    'dnd_apply',
    'Change a character\'s state: damage, healing, temporary HP, conditions. This is the only way HP or conditions '
    + 'change; roll the amount with dnd_roll first.',
    {
      target: { type: 'string' },
      damage: { type: 'integer' },
      damage_type: { type: 'string', description: 'e.g. 光耀/心灵/钝击. Radiant damage beats Undead Fortitude.' },
      crit: { type: 'boolean', description: 'The damage came from a critical hit.' },
      heal: { type: 'integer' },
      temp_hp: { type: 'integer' },
      add_conditions: { type: 'array', items: { type: 'string' }, description: 'e.g. ["中毒", "倒地"]' },
      remove_conditions: { type: 'array', items: { type: 'string' } },
    },
    ['target'],
    (args, exec) => mutate(exec, (c) => {
      const ch = requireCharacter(c, String(args.target ?? ''));
      const lines: string[] = [];
      const damage = int(args.damage);
      const healing = int(args.heal);
      const temp = int(args.temp_hp);
      if (damage !== undefined && damage > 0) {
        lines.push(hpLine(applyDamage(c, ch.name, damage, { crit: args.crit === true, damageType: str(args.damage_type), roller: service.roller })));
      }
      if (healing !== undefined && healing > 0) lines.push(hpLine(heal(c, ch.name, healing)));
      if (temp !== undefined && temp > 0) lines.push(hpLine(grantTempHp(c, ch.name, temp)));
      for (const cond of strList(args.add_conditions) ?? []) changeCondition(c, ch.name, cond, true);
      for (const cond of strList(args.remove_conditions) ?? []) changeCondition(c, ch.name, cond, false);
      if (lines.length === 0) lines.push(`${ch.name} HP ${ch.hp}/${ch.maxHp}`);
      lines.push(`状态：${ch.conditions.join('、') || '无'}`);
      return lines.join('\n');
    }),
  );

  register(
    'dnd_character',
    'Create, update, show, list or remove character sheets (PCs, NPCs, extra monsters). Ability scores default to 10. '
    + 'Bind a PC to the player\'s group nickname with `player` so they can only act for their own character. '
    + 'Improvised monsters: pass `srd` (e.g. "goblin") to take real stats from the SRD and `count` for several '
    + '(named 地精1, 地精2…); they are placed in the party\'s current room unless `room` is given.',
    {
      action: { type: 'string', enum: ['create', 'update', 'show', 'list', 'remove'] },
      name: { type: 'string' },
      srd: { type: 'string', description: 'For create: SRD monster index; fills AC/HP/abilities/attack from dnd5eapi.' },
      count: { type: 'integer', description: 'For create: how many copies (numbered names).' },
      room: {
        type: 'string',
        description: 'Room id the character is in (monsters; PCs that split off). Moving a monster in combat to a room '
          + 'outside the fight (fleeing, running for help) also takes it out of the initiative order.',
      },
      hit_die: { type: 'string', description: 'PCs: hit die, e.g. d10 (fighter/paladin/ranger), d8 (cleric/rogue/bard).' },
      traits: {
        type: 'array',
        items: { type: 'string' },
        description: 'Auto-handled traits (replaces the list): "不死坚韧"; fighting styles "巨武器战斗" (rerolls 1-2 on '
          + 'two-handed weapon dice) and "箭术" (+2 to hit with ranged weapons). With these set, never add them by hand.',
      },
      expertise: { type: 'array', items: { type: 'string' }, description: 'Skills with expertise (double proficiency), e.g. ["巧手","隐匿"].' },
      add_items: { type: 'array', items: { type: 'string' }, description: 'Items picked up.' },
      remove_items: { type: 'array', items: { type: 'string' }, description: 'Items used up or handed over.' },
      gp_change: { type: 'integer', description: 'Gold gained (+) or spent (-).' },
      kind: { type: 'string', enum: ['pc', 'npc', 'monster'] },
      player: { type: 'string', description: 'Player nickname in the group (PCs).' },
      player_id: { type: 'string', description: 'Player member id from their tag "[昵称 #U3]" (pass "U3") (PCs). Binds the PC so only this player can act for it.' },
      class_name: { type: 'string', description: 'e.g. 战士 / 法师 / 游荡者' },
      level: { type: 'integer' },
      str: { type: 'integer' }, dex: { type: 'integer' }, con: { type: 'integer' },
      int: { type: 'integer' }, wis: { type: 'integer' }, cha: { type: 'integer' },
      skills: { type: 'array', items: { type: 'string' }, description: 'Proficient skills, e.g. ["察觉","隐匿"].' },
      saves: { type: 'array', items: { type: 'string' }, description: 'Proficient saves, e.g. ["力量","体质"].' },
      max_hp: { type: 'integer' },
      ac: { type: 'integer' },
      attack_bonus: { type: 'integer', description: 'Monsters/NPCs; PCs use ability + proficiency.' },
      damage: { type: 'string', description: 'Monsters/NPCs: default attack damage, e.g. "1d8+3".' },
      weapons: {
        type: 'array',
        description: 'PC weapons (replaces the list). damage is the weapon die only: 巨斧 1d12, 长剑 1d8, 刺剑 1d8 (dex), 短弓 1d6 (dex).',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            damage: { type: 'string' },
            ability: { type: 'string', enum: ['str', 'dex'] },
            notes: { type: 'string', description: 'damage type, properties, range' },
            magic: { type: 'integer', description: '+N magic weapon: added to hit AND damage automatically.' },
            proficient: { type: 'boolean', description: 'false when the wielder lacks proficiency (no proficiency bonus to hit).' },
            ranged: { type: 'boolean', description: 'Ranged weapon (Archery applies). Default: name contains 弓/弩.' },
            two_handed: { type: 'boolean', description: 'Wielded two-handed (Great Weapon Fighting applies). Default: notes contain 双手.' },
          },
          required: ['name', 'damage'],
          additionalProperties: false,
        },
      },
      notes: { type: 'string' },
      brief: { type: 'boolean', description: 'For show: one line (HP, AC, conditions, resources, room) instead of the full sheet.' },
    },
    ['action'],
    async (args, exec) => {
      const action = String(args.action);
      if (action === 'list' || action === 'show') {
        const { campaign } = service.require(recordOf(exec).sessionKey);
        if (action === 'list') {
          return campaign.characters.length === 0
            ? '还没有角色。'
            : campaign.characters.map((ch) => `${ch.name}${ch.player ? `〈${ch.player}〉` : ''} ${ch.kind} HP ${ch.hp}/${ch.maxHp}${roomOf(campaign, ch) ? ` @${roomOf(campaign, ch)}` : ''}`).join('\n');
        }
        const target = requireCharacter(campaign, String(args.name ?? ''));
        return args.brief === true ? characterBrief(campaign, target) : sheet(target, whoOf(exec));
      }
      // SRD 数据先取回来（网络请求不能放进同步的 mutate 里）
      const srdIndex = action === 'create' ? str(args.srd) : undefined;
      const srdBase = srdIndex === undefined ? undefined : srdMonsterInput(await requireSrd('monsters', srdIndex));
      return mutate(exec, (c) => {
        const name = str(args.name);
        if (name === undefined) throw new Error('dnd_character: name 不能为空');
        if (action === 'remove') return `已移除 ${removeCharacter(c, name).name}`;
        if (action === 'update' && findCharacter(c, name) === undefined) throw new Error(`找不到角色「${name}」，要新建用 create`);
        const abilities: Partial<Record<Ability, number>> = { ...srdBase?.abilities };
        for (const a of ABILITIES) {
          const v = int(args[a]);
          if (v !== undefined) abilities[a] = v;
        }
        const input: CharacterInput = { ...srdBase, name: action === 'update' ? requireCharacter(c, name).name : name, abilities };
        const kind = str(args.kind) ?? (srdBase !== undefined ? 'monster' : undefined);
        if (kind !== undefined) input.kind = kind as CharacterKind;
        const optional = {
          player: str(args.player), playerId: memberId(exec, args.player_id, 'player_id'), className: str(args.class_name), level: int(args.level), maxHp: int(args.max_hp),
          ac: int(args.ac), attackBonus: int(args.attack_bonus), damage: str(args.damage), notes: str(args.notes),
          skills: parseSkills(strList(args.skills)), expertise: parseSkills(strList(args.expertise)), saves: parseAbilities(strList(args.saves)),
          weapons: parseWeapons(args.weapons), room: str(args.room), hitDie: str(args.hit_die), traits: strList(args.traits),
        };
        for (const [k, v] of Object.entries(optional)) {
          if (v !== undefined) (input as unknown as Record<string, unknown>)[k] = v;
        }
        // 新建的怪物/NPC 默认放在队伍主位置，才会进这个房间的先攻
        if (action === 'create' && input.room === undefined && input.kind !== undefined && input.kind !== 'pc') input.room = c.currentRoom;

        const count = action === 'create' ? Math.min(Math.max(int(args.count) ?? 1, 1), 20) : 1;
        if (count > 1) {
          const names = numberedNames(c, name, count);
          const made = names.map((n) => upsertCharacter(c, { ...input, name: n }).character);
          return `已建卡 ${made.length} 个：${names.join('、')}\n${sheet(made[0]!, whoOf(exec))}`;
        }
        if (action === 'create' && findCharacter(c, name)?.name === name) throw new Error(`已经有「${name}」了，改数据用 update，再加一只换个名字或传 count`);
        const roomsBefore = fightRooms(c);
        const { character, created } = upsertCharacter(c, input);
        const lines = [`${created ? '已建卡' : '已更新'}：`];
        // 战斗中换到交战房间以外（逃跑、去报信）：移出先攻表，不然它会一直占着回合
        const newRoom = str(args.room);
        if (!created && newRoom !== undefined && inInitiative(c, character.name) && !roomsBefore.has(newRoom)) {
          const wasCurrent = c.initiative!.order[c.initiative!.turn]?.name === character.name;
          leaveInitiative(c, character.name);
          lines.unshift(`${character.name} 离开了交战区域，已移出先攻表${wasCurrent ? '；它的回合到此结束，接着调用 dnd_initiative next' : ''}。`);
        }
        const add = strList(args.add_items) ?? [];
        const remove = strList(args.remove_items) ?? [];
        const gp = int(args.gp_change) ?? 0;
        if (add.length > 0 || remove.length > 0 || gp !== 0) changeInventory(c, character.name, add, remove, gp);
        lines.push(sheet(requireCharacter(c, character.name), whoOf(exec)));
        return lines.join('\n');
      });
    },
  );

  register(
    'dnd_resource',
    'Track limited-use resources: spell slots (e.g. "1环法术位"), lay on hands pool ("圣疗池"), bardic inspiration '
    + '("诗人激励"), class features ("战争祭司"), potions. set: create or change max; use: spend (fails if not enough); '
    + 'restore: give back (omit amount to refill). Spend only when the owning player says they use it.',
    {
      action: { type: 'string', enum: ['set', 'use', 'restore'] },
      character: { type: 'string' },
      resource: { type: 'string' },
      amount: { type: 'integer', description: 'use/restore: how much (default 1 / refill). For lay on hands, the HP spent.' },
      max: { type: 'integer', description: 'For set.' },
      current: { type: 'integer', description: 'For set: current value (default: full for a new resource).' },
      reset: { type: 'string', enum: ['short', 'long', 'none'], description: 'For set: which rest refills it.' },
    },
    ['action', 'character', 'resource'],
    (args, exec) => mutate(exec, (c) => {
      const name = String(args.character ?? '');
      const key = String(args.resource ?? '');
      const action = String(args.action);
      if (action === 'set') {
        const max = int(args.max);
        if (max === undefined) throw new Error('dnd_resource set 需要 max');
        const reset = args.reset === 'short' || args.reset === 'none' ? args.reset : 'long';
        const r = setResource(c, name, key, max, reset, int(args.current));
        return `${requireCharacter(c, name).name}「${key.trim()}」${r.current}/${r.max}`;
      }
      const result = action === 'use'
        ? useResource(c, name, key, int(args.amount) ?? 1)
        : restoreResource(c, name, key, int(args.amount));
      return `${requireCharacter(c, name).name}「${result.key}」${result.before}→${result.resource.current}/${result.resource.max}`;
    }),
  );

  register(
    'dnd_rest',
    'Short or long rest for the party (or the listed characters). short: refills short-rest resources; spend hit dice '
    + 'with `hit_dice` ({"卡厄斯": 1}), the tool rolls and heals. long: full HP, all resources, half the hit dice back. '
    + 'Not during combat.',
    {
      kind: { type: 'string', enum: ['short', 'long'] },
      characters: { type: 'array', items: { type: 'string' }, description: 'Omit for everyone in the party.' },
      hit_dice: { type: 'object', additionalProperties: { type: 'integer' }, description: 'short rest: character → dice to spend.' },
    },
    ['kind'],
    (args, exec) => mutate(exec, (c) => {
      const spend: Record<string, number> = {};
      if (args.hit_dice !== null && typeof args.hit_dice === 'object') {
        for (const [k, v] of Object.entries(args.hit_dice as Record<string, unknown>)) {
          const n = int(v);
          if (n !== undefined && n > 0) spend[k] = n;
        }
      }
      const kind = args.kind === 'long' ? 'long' : 'short';
      const results = rest(c, kind, strList(args.characters), spend, service.roller);
      return `${kind === 'long' ? '长休' : '短休'}完成：\n${results.map((r) => `${r.name}：${r.lines.join('，') || '无变化'}`).join('\n')}`;
    }),
  );

  register(
    'dnd_initiative',
    'Combat rounds. start: roll initiative for everyone alive in the current room (or the given participants) and '
    + 'sort. next: end the current creature\'s turn (on a PC turn only that player can end it: pass declared_by). '
    + 'join: add late arrivals (teammates who caught up, newly spawned monsters) to the running fight: rolls '
    + 'initiative only for `participants` and slots them in, keeping the round and everyone else\'s order; never '
    + 'end+start just to add someone. '
    + 'goto: fix the pointer when it disagrees with the story (name, optional round). end: leave combat and clear '
    + 'defeated monsters. status: show the order.',
    {
      action: { type: 'string', enum: ['start', 'join', 'next', 'goto', 'end', 'status'] },
      participants: { type: 'array', items: { type: 'string' }, description: 'Optional for start; required for join.' },
      room: { type: 'string', description: 'For start: room id where the fight happens (default: the party\'s main room).' },
      name: { type: 'string', description: 'For goto.' },
      round: { type: 'integer', description: 'For goto.' },
      declared_by: { type: 'string', description: 'For next on a PC turn: member id (the #U number in "[昵称 #U3]", pass "U3") of that PC\'s player, who said they are done.' },
      dm_override: { type: 'boolean', description: 'For next: skip an absent player\'s turn. Say so in the reply.' },
    },
    ['action'],
    (args, exec) => mutate(exec, (c, adventure) => {
      const action = String(args.action);
      // 指针落到 PC 时，本轮回复发完后给他发「结束回合」按钮
      const turnChanged = (): void => {
        if (deps.onTurnChange !== undefined) deps.onTurnChange(recordOf(exec));
      };
      if (action === 'start') {
        if (c.initiative !== undefined) throw new Error('已经在战斗中了，用 next 推进或 end 结束');
        const roomArg = str(args.room);
        const room = roomArg === undefined ? undefined : resolveRoom(roomGraph(adventure), roomArg)?.id;
        if (roomArg !== undefined && room === undefined) throw new Error(`没有这个房间: ${roomArg}`);
        const rolls = startInitiative(c, service.roller, strList(args.participants), room);
        turnChanged();
        const away = positionNote(c, adventure, rolls.map((r) => r.name), new Set([room ?? c.currentRoom]));
        return `先攻：\n${rolls.map((r, i) => `${i + 1}. ${r.name} ${r.detail}`).join('\n')}\n第 1 轮，${combatTurnPrompt(c, rolls[0]!.name, { recentSenders: sendersOf(exec) })}${away}`;
      }
      if (action === 'join') {
        const rooms = fightRooms(c);
        const rolls = joinInitiative(c, strList(args.participants) ?? [], service.roller);
        const state = requireInitiative(c);
        const current = state.order[state.turn]?.name;
        const away = positionNote(c, adventure, rolls.map((r) => r.name), rooms);
        return `加入战斗：${rolls.map((r) => `${r.name} ${r.detail}`).join('；')}\n第 ${state.round} 轮：${orderLine(c)}\n`
          + (current === undefined
            ? '调用 dnd_initiative next 轮到下一位。'
            : `仍是 ${current} 的回合；排在 ${current} 前面的新成员本轮已错过，下一轮才行动。`)
          + away;
      }
      if (action === 'next') {
        assertCanEndTurn(c, { declaredBy: memberId(exec, args.declared_by, 'declared_by'), recentSenders: sendersOf(exec), dmOverride: args.dm_override === true });
        const { round, current, newRound } = nextTurn(c);
        turnChanged();
        return `${newRound ? `进入第 ${round} 轮。` : ''}${combatTurnPrompt(c, current.name, { recentSenders: sendersOf(exec) })}`;
      }
      if (action === 'goto') {
        const entry = gotoTurn(c, String(args.name ?? ''), int(args.round));
        turnChanged();
        return `已调整：第 ${requireInitiative(c).round} 轮，${combatTurnPrompt(c, entry.name, { recentSenders: sendersOf(exec), force: true })}`;
      }
      if (action === 'end') {
        const { rounds, defeated } = endInitiative(c);
        return `战斗结束，共 ${rounds} 轮。${defeated.length > 0 ? `击败：${defeated.join('、')}` : ''}`;
      }
      return `第 ${requireInitiative(c).round} 轮：${orderLine(c)}`;
    }),
  );

  register(
    'dnd_move',
    'Move characters to an adjacent room. Omit `who` only when the WHOLE party goes; when one or a few go ahead '
    + '(scouting, sneaking, fetching something) pass `who` so the others stay put. Returns the player-facing '
    + 'description (narrate from this) and DM-only notes (use for rulings, never read aloud). First visit reveals '
    + 'the room and spawns its monsters. In combat, characters in the initiative order move only on their own turn (with `who`); '
    + 'those not in the fight yet (catching up) can move any time, then join with dnd_initiative join. '
    + 'Pass discover_hidden=true only after a successful check found a secret passage. Exits that need a check '
    + '(climbing, swimming) are rolled by the tool for each mover; those who fail stay behind. In a town you can go '
    + 'to any location the players know. From a dungeon\'s entry, or anywhere in a town, you can travel to another '
    + 'known site by its name or id.',
    {
      room: { type: 'string', description: 'Room id or name, or another site\'s id/name (from that site\'s entry).' },
      who: { type: 'array', items: { type: 'string' }, description: 'Characters who move; omit for the whole party.' },
      discover_hidden: { type: 'boolean' },
      dm_override: {
        type: 'boolean',
        description: 'Move a PC whose player has not spoken this turn: explicit delegation ("Kriv 先过去探路") or '
          + 'forced movement (pushed, dragged, grappled). Say who delegated it / what forced it in the reply. Not for '
          + 'quietly repositioning someone else\'s character.',
      },
    },
    ['room'],
    (args, exec) => mutate(exec, (c, adventure) => {
      const who = strList(args.who);
      if (who !== undefined && args.dm_override !== true) {
        const senders = sendersOf(exec);
        const silent = who
          .map((n) => c.characters.find((ch) => ch.name === n))
          .filter((ch) => ch !== undefined && ch.kind === 'pc' && ch.playerId !== undefined && !senders.includes(ch.playerId))
          .map((ch) => `${ch!.name} 是〈${ch!.player ?? ch!.playerId}〉的角色`);
        if (silent.length > 0) {
          throw new Error(
            `${silent.join('；')}，他本人这轮还没发话。拆开队伍要带走别人的卡，传 dm_override=true，`
            + '并在回复里写清是委托还是被推/被拖；全队一起走就不要给 who。',
          );
        }
      }
      const result = moveParty(c, adventure, String(args.room ?? ''), args.discover_hidden === true, who, service.roller);
      const lines: string[] = [];
      if (result.checks.length > 0) {
        lines.push(`出口检定：${result.checks.map((r) => `${r.name} ${r.detail}`).join('；')}`);
        if (result.failText !== undefined) lines.push(`【DM】没过的人留在原地，后果：${result.failText}（伤害用 dnd_apply）`);
      }
      if (result.movers.length === 0) {
        lines.push('没有人过去。');
      } else {
        const someStayed = result.checks.some((r) => !r.passed);
        lines.push(`${strList(args.who)?.length || someStayed ? result.movers.join('、') : '队伍'}进入「${result.room.name}」${result.firstVisit ? '（首次）' : ''}`);
        if (result.travelledFrom !== undefined) {
          lines.push(`【DM】这是离开「${result.travelledFrom.name}」、在地面上赶路到「${result.site.name}」，不是暗道或捷径；按下面的抵达描述叙述。`);
        }
        if (result.firstSiteVisit && result.site.arrival) lines.push(`【抵达「${result.site.name}」，可以念】${result.site.arrival}`);
        if (result.firstSiteVisit && result.site.features) lines.push(`【DM】「${result.site.name}」通用规则：${result.site.features}`);
        lines.push(`【玩家视角，可以描述】${result.view.playerView}`, `【DM 机密，勿念】${result.view.dmNotes}`);
        if (result.room.shop !== undefined) lines.push(`【店铺】${shopLine(result.room.shop)}`);
      }
      if (result.spawned.length > 0) {
        lines.push(`【DM 机密】本房间敌人：${result.spawned.map((m) => `${m.name} HP${m.hp} AC${m.ac} 命中+${m.attackBonus} 伤害${m.damage}${m.notes ? `（${m.notes}）` : ''}`).join('；')}`);
      }
      if (result.movers.length > 0) {
        const npcs = npcsIn(c, adventure, result.room.id);
        if (npcs.length > 0) lines.push(`【DM】这里的 NPC（dnd_lookup npc 看详情）：${npcs.map((n) => `${n.name}(${n.id})：${n.look}`).join('；')}`);
        const pending = pendingTriggers(c, adventure, result.room.id);
        if (pending.length > 0) lines.push(`【DM】这里可能发生（吻合时 dnd_story trigger）：${pending.map((t) => `${t.id}：${t.when}`).join('；')}`);
      }
      lines.push(`可见出口：${result.exits.map((e) => `${e.label} → ${e.known ? e.name : '未探索'}(${e.to})${e.locked === true ? '[暂时过不去]' : ''}`).join('；') || '无'}`);
      const positions = partyPositions(c);
      if (positions.size > 1) {
        lines.push(`队伍现在分开了：${[...positions].map(([room, members]) => `${findRoom(roomGraph(adventure), room)?.name ?? room}：${members.map((ch) => ch.name).join('、')}`).join('｜')}。没来的人看不到这里，别替他们行动。`);
      }
      if (result.story.length > 0) lines.push(`【剧情】${result.story.join('；')}`);
      const joinHint = combatJoinHint(c, result.room.id, result.movers, result.spawned.map((m) => m.name));
      if (joinHint !== undefined) lines.push(joinHint);
      return lines.join('\n');
    }),
  );

  register(
    'dnd_story',
    'Change story state written into the adventure, by id (ids come from 【团况】 and dnd_lookup). '
    + 'begin (no id): the opening is done and the party enters the first scene; returns what to narrate. '
    + 'trigger: an event listed as "可能发生" now happens (applies its flags, leads, reinforcements). '
    + 'fact: an NPC or captive reveals a piece of information (checks with a DC: dnd_check first, then passed=true); '
    + 'say only what the tool returns. lead: players learn a lead. flag: set/clear a declared flag. '
    + 'quest: offered/active/completed/rewarded/failed (rewarded pays gp/items to `to`). '
    + 'npc: attitude/room/met, or join=true (joins the party) / fight=true (fights the party), which creates the '
    + 'character sheet. chapter: move to another chapter.',
    {
      action: { type: 'string', enum: ['begin', 'trigger', 'fact', 'lead', 'flag', 'quest', 'npc', 'chapter'] },
      id: { type: 'string', description: 'Trigger / fact / lead / flag / quest / npc / chapter id.' },
      on: { type: 'boolean', description: 'For flag: true sets (default), false clears.' },
      passed: { type: 'boolean', description: 'For fact with a DC: the required check succeeded.' },
      status: { type: 'string', enum: ['offered', 'active', 'completed', 'rewarded', 'failed'], description: 'For quest.' },
      to: { type: 'string', description: 'For quest status=rewarded: character who receives the gp and items.' },
      attitude: { type: 'string', enum: ['friendly', 'indifferent', 'hostile'], description: 'For npc.' },
      room: { type: 'string', description: 'For npc: where the NPC is now (room id).' },
      met: { type: 'boolean', description: 'For npc.' },
      alive: { type: 'boolean', description: 'For npc that never entered play: dies (or survives) off-screen.' },
      join: { type: 'boolean', description: 'For npc: joins the party (creates a companion sheet).' },
      fight: { type: 'boolean', description: 'For npc: fights the party (creates a monster sheet in their room).' },
      hp: {
        type: 'integer',
        description: 'For npc with join/fight: current HP when the sheet is created or updated (e.g. a wounded captive '
          + 'at 0 or 1). Default: full.',
      },
    },
    ['action'],
    async (args, exec) => {
      const action = String(args.action);
      const id = String(args.id ?? '').trim();
      // NPC 上场要 SRD 数据时先取回来（网络请求不能放进同步的 mutate 里）
      let srdBase: Omit<CharacterInput, 'name'> | undefined;
      if (action === 'npc' && (args.join === true || args.fight === true)) {
        const { adventure } = service.require(recordOf(exec).sessionKey);
        const stat = findNpc(adventure, id)?.stat;
        if (stat !== undefined && !('hp' in stat)) srdBase = srdMonsterInput(await fetchSrd('monsters', stat.srd));
      }
      return mutate(exec, (c, adventure) => {
        const lines = storyAction(c, adventure, action, id, args, srdBase);
        for (const line of lines) pushLog(c, line);
        return lines.join('\n');
      });
    },
  );

  register(
    'dnd_lookup',
    'Read adventure content (DM eyes only, never read it aloud wholesale): npc (who they are, what they know and '
    + 'whether it was said, quests they offer), quest, site (rules, rooms, what groups there know), room (notes, '
    + 'events, NPCs), leads (all leads and which the players know). Omit id to list everything of that kind. '
    + 'brief=true (npc/room) returns one line: who is there with HP/conditions, attitude, unfired event and '
    + 'unsaid fact ids. Use it for quick checks; read the full card before revealing facts or ruling on DM notes.',
    {
      kind: { type: 'string', enum: ['npc', 'quest', 'site', 'room', 'leads'] },
      id: { type: 'string', description: 'Id or name; omit to list.' },
      brief: { type: 'boolean', description: 'npc/room only: one-line summary instead of the full card (default false).' },
    },
    ['kind'],
    (args, exec) => {
      const { campaign, adventure } = service.require(recordOf(exec).sessionKey);
      return lookup(campaign, adventure, String(args.kind), str(args.id), args.brief === true);
    },
  );

  register(
    'dnd_map',
    'Render the explored part of the dungeon map (unexplored rooms stay in fog) and send it to the group as an image.',
    { caption: { type: 'string', description: 'Optional short text sent with the map.' } },
    [],
    async (args, exec) => {
      const record = recordOf(exec);
      const { campaign, adventure } = service.require(record.sessionKey);
      const out = join(service.mapDir, `${record.sessionKey.replace(/[^a-zA-Z0-9_-]+/g, '_')}-${Date.now()}.png`);
      const path = await renderMapPng(campaign, adventure, out);
      if (path === undefined) throw new Error('dnd_map: 地图渲染需要 sharp，当前环境没装上');
      await deps.sendImage(record, path, str(args.caption));
      const { site, seen, total } = explored(campaign, adventure);
      return `「${site?.name ?? adventure.name}」地图已发到群里（已探索 ${seen}/${total} 个房间）。不用再复述地图内容。`;
    },
  );

  register(
    'dnd_progress',
    'Save where the campaign stands without ending it: after a scene wraps up, a deal or quest changes, players '
    + 'say they will stop soon, or they ask to save (存档). Progress is organised in sections 【位置】【队伍】'
    + '【物品与欠账】【任务与线头】【待办】. Send ONLY what changed: `set` replaces whole sections, `append` adds '
    + 'items, `remove` deletes items (any line containing the text); the tool merges them into the latest save. '
    + 'Use `summary` only for the first save or a full rewrite. Only the merged latest one is injected next time. '
    + 'Player-known information only: no DCs, monster stats or DM-only notes. Use this instead of '
    + 'qqbot_notes_save for campaign progress.',
    {
      summary: { type: 'string', description: 'Full rewrite (replaces the whole save). Prefer set/append/remove.' },
      set: {
        type: 'object',
        additionalProperties: { type: 'string' },
        description: 'Section → new content, e.g. {"位置":"修道院地窖门口"}. "" deletes the section.',
      },
      append: {
        type: 'object',
        additionalProperties: { type: 'array', items: { type: 'string' } },
        description: 'Section → items to add, e.g. {"待办":["给铁匠还 5gp"]}.',
      },
      remove: {
        type: 'object',
        additionalProperties: { type: 'array', items: { type: 'string' } },
        description: 'Section → items to drop (finished to-dos, paid debts), matched by contained text.',
      },
    },
    [],
    (args, exec) => {
      const text = str(args.summary);
      const patch = parseProgressPatch(args);
      if (text === undefined && isEmptyPatch(patch)) throw new Error('dnd_progress: 要给 summary（整份）或 set/append/remove（改动）');
      return mutate(exec, (c) => {
        // 先整份再叠改动：同一次调用里两者都给也说得通（重写 + 顺手勾掉一条）
        const base = text ?? c.summaries.at(-1)?.text;
        const result = isEmptyPatch(patch) ? { text: text!, changed: [], missed: [] } : applyProgressPatch(base, patch);
        if (result.text.trim() === '') throw new Error('dnd_progress: 合并后进度为空，没有写入');
        addSummary(c, result.text);
        const notes = [
          result.changed.length > 0 ? `改了：${result.changed.join('、')}` : '',
          result.missed.length > 0 ? `没找到要删的：${result.missed.join('；')}` : '',
          result.text.length > SUMMARY_MAX_CHARS ? `进度超过 ${SUMMARY_MAX_CHARS} 字被截断，删掉做完的条目或精简一下` : '',
        ].filter(Boolean);
        return `已写进团档，下次开团的「上次进度」用这一条。${notes.length > 0 ? `\n${notes.join('\n')}` : ''}`;
      });
    },
  );

  register(
    'dnd_chronicle',
    'The campaign\'s long-term plot ledger (DM eyes only). Visited rooms, defeated foes, quest changes, leads, facts and '
    + 'PC items are recorded automatically. add: record what the tools cannot see: improvised people and events, captives, '
    + 'promises and debts, loose threads, backstory, standing table rulings. search: look up the past by keywords before '
    + 'answering questions about it or denying something happened. list: unresolved entries and recent ones. close: an '
    + 'unresolved entry is settled.',
    {
      action: { type: 'string', enum: ['add', 'search', 'list', 'close'] },
      text: { type: 'string', description: 'For add: one fact in a sentence, with names.' },
      kind: { type: 'string', enum: [...CHRONICLE_KINDS], description: 'For add (default event). promise/captive/thread start unresolved.' },
      query: { type: 'string', description: 'For search: keywords separated by spaces; any match counts, e.g. "矮人 地图".' },
      id: { type: 'integer', description: 'For close: the entry number.' },
      outcome: { type: 'string', description: 'For close: how it ended.' },
    },
    ['action'],
    (args, exec) => mutate(exec, (c) => {
      const action = String(args.action);
      if (action === 'add') {
        const entry = addEntry(c, { text: String(args.text ?? ''), kind: args.kind as ChronicleKind | undefined });
        return `已记：${formatEntry(entry)}`;
      }
      if (action === 'close') {
        const id = int(args.id);
        if (id === undefined) throw new Error('dnd_chronicle close 要给 id');
        return `已了结：${formatEntry(closeEntry(c, id, str(args.outcome)))}`;
      }
      if (action === 'search') {
        const query = str(args.query);
        if (query === undefined) throw new Error('dnd_chronicle search 要给 query');
        const found = searchEntries(c, query);
        return found.length > 0
          ? found.map(formatEntry).join('\n')
          // 账本有开账时间，查不到不等于没发生：别让模型据此否认玩家
          : `账本里没搜到「${query}」。没记录不等于没发生，换个词再搜，或问玩家。`;
      }
      if (action === 'list') {
        const open = openEntries(c);
        const recent = recentEntries(c, 15).filter((e) => e.open !== true);
        return [
          `未了结（${open.length}）：${open.length > 0 ? `\n${open.map(formatEntry).join('\n')}` : '无'}`,
          `最近：${recent.length > 0 ? `\n${recent.map(formatEntry).join('\n')}` : '无'}`,
        ].join('\n');
      }
      throw new Error(`dnd_chronicle 不认识的 action: ${action}`);
    }),
  );

  register(
    'dnd_end',
    'End tonight\'s session when players want to stop. Write a story summary (what happened, party state, open '
    + 'threads); it is saved and injected next time the game starts. Progress is saved automatically after every '
    + 'change: do NOT call this when players only ask to save (存档) — it ends the game and every roll fails until /dnd start.',
    { summary: { type: 'string' } },
    ['summary'],
    (args, exec) => {
      const record = recordOf(exec);
      const text = str(args.summary);
      if (text === undefined) throw new Error('dnd_end: summary 不能为空');
      const state = mutate(exec, (c, adventure) => {
        addSummary(c, text);
        return summarize(c, adventure);
      });
      service.stop(record.sessionKey);
      return `已结团并保存进度。下次发送 /dnd start 继续。\n${state}`;
    },
  );

  register(
    'dnd_undo',
    'Roll back the game state when the table agrees an action was resolved wrongly ("卷回到…"). list: show recent '
    + 'changes, newest first. undo: revert the newest `steps` changes in one go. Never fake a rollback by healing '
    + 'dead monsters or restarting initiative. Also use it when a player takes back a choice that was already '
    + 'resolved (e.g. "不用神恩了" after the boosted attack landed): undo the attack AND the resource together, then '
    + 're-resolve; refunding only the slot while keeping its damage is wrong.',
    {
      action: { type: 'string', enum: ['list', 'undo'] },
      steps: { type: 'integer', description: 'For undo: how many changes to revert (see list).' },
    },
    ['action'],
    (args, exec) => {
      const key = recordOf(exec).sessionKey;
      service.require(key);
      if (args.action === 'undo') {
        const undone = service.store.undo(key, int(args.steps) ?? 1);
        const { campaign, adventure } = service.require(key);
        return `已撤销 ${undone.length} 步：\n${undone.map((l, i) => `${i + 1}. ${l}`).join('\n')}\n\n现在的团况：\n${summarize(campaign, adventure)}`;
      }
      const list = service.store.snapshots(key).slice(-15).reverse();
      if (list.length === 0) return '没有可以撤销的改动。';
      return `最近的改动（新→旧，undo steps=N 撤销前 N 条）：\n${list.map((s, i) => `${i + 1}. ${s.label}`).join('\n')}`;
    },
  );

  register(
    'dnd_srd',
    'Look up official 5e SRD data (monster stat block or spell) from dnd5eapi.co. `index` takes the SRD slug '
    + '("goblin", "fire-bolt"), the English name, or a common Chinese name (地精, 火球术); typos, case and '
    + 'spaces/hyphens are tolerated. When several entries fit, it lists candidates: pick one index and call again.',
    {
      kind: { type: 'string', enum: ['monster', 'spell'] },
      index: { type: 'string', description: 'Slug, English name or Chinese name.' },
    },
    ['kind', 'index'],
    async (args) => {
      const kind = args.kind === 'spell' ? 'spells' : 'monsters';
      const query = String(args.index ?? '');
      const found = await lookupSrd(kind, query);
      if ('candidates' in found) return candidatesText(query, found.candidates);
      return `${found.note !== undefined ? `${found.note}\n` : ''}${formatSrd(kind, found.data)}`;
    },
  );

  deps.logger.info(`im-qqbot: 跑团工具已注册 campaigns=${service.store.root}`);
}

/** dnd_story 的各个动作；返回事件文字。抛错时 mutate 不落盘，所以先校验再改 */
export function storyAction(
  c: Campaign,
  adventure: Adventure,
  action: string,
  id: string,
  args: Record<string, unknown>,
  srdBase?: Omit<CharacterInput, 'name'>,
): string[] {
  if (action === 'begin') {
    const { lines, room } = beginAdventure(c, adventure);
    const spawned = room === undefined ? [] : spawnEncounter(c, room);
    if (spawned.length > 0) {
      lines.push(`【DM 机密】这里的敌人：${spawned.map((m) => `${m.name} HP${m.hp} AC${m.ac} 命中+${m.attackBonus} 伤害${m.damage}${m.notes ? `（${m.notes}）` : ''}`).join('；')}`);
    }
    return lines;
  }
  if (id.length === 0) throw new Error('dnd_story: id 不能为空');
  if (action === 'trigger') {
    const result = fireTrigger(c, adventure, id);
    const lines = [...result.lines];
    if (result.spawn.length > 0) {
      const made = spawnMonsters(c, result.room.id, result.spawn);
      lines.push(`【DM 机密】「${result.room.name}」出现：${made.map((m) => `${m.name} HP${m.hp} AC${m.ac} 命中+${m.attackBonus} 伤害${m.damage}`).join('；')}`);
    }
    return lines;
  }
  if (action === 'fact') return revealFact(c, adventure, id, args.passed === true).lines;
  if (action === 'lead') return learnLead(c, adventure, id);
  if (action === 'flag') return setFlag(c, adventure, id, args.on !== false);
  if (action === 'chapter') return setChapter(c, adventure, id);
  if (action === 'quest') {
    const status = str(args.status) as QuestStatus | undefined;
    if (status === undefined || !QUEST_STATUSES.includes(status)) throw new Error(`dnd_story quest 要传 status：${QUEST_STATUSES.join('/')}`);
    const quest = findQuest(adventure, id);
    const reward = quest?.reward;
    const pays = status === 'rewarded' && reward !== undefined && ((reward.gp ?? 0) > 0 || (reward.items?.length ?? 0) > 0);
    const to = pays ? requireCharacter(c, str(args.to) ?? '') : undefined;
    const change = setQuestStatus(c, adventure, id, status);
    if (to !== undefined && change.reward !== undefined) {
      changeInventory(c, to.name, change.reward.items ?? [], [], change.reward.gp ?? 0);
      change.lines.push(`${to.name} 拿到：${[change.reward.gp ? `${change.reward.gp} gp` : '', ...(change.reward.items ?? [])].filter(Boolean).join('、')}`);
    }
    return change.lines;
  }
  if (action === 'npc') {
    const npc = findNpc(adventure, id);
    if (npc === undefined) throw new Error(`模组里没有 NPC「${id}」。有：${adventure.npcs.map((n) => n.id).join('、') || '（无）'}`);
    const attitude = str(args.attitude) as Attitude | undefined;
    if (attitude !== undefined && !ATTITUDES.includes(attitude)) throw new Error(`attitude 只能是 ${ATTITUDES.join('/')}`);
    if (args.join === true || args.fight === true) {
      if (args.join === true && args.fight === true) throw new Error('join 和 fight 只能选一个');
      const mode = args.join === true ? 'join' : 'fight';
      if (!npcAlive(c, npc.id)) throw new Error(`${npc.name} 已经死了`);
      const hp = int(args.hp);
      const { character, created } = upsertCharacter(c, { ...npcCharacterInput(c, npc, mode, srdBase), ...(hp !== undefined ? { hp } : {}) });
      // 态度本来就对时 updateNpc 只回一句「已更新」，上场这里不用重复
      const lines = updateNpc(c, adventure, npc.id, { met: true, attitude: attitude ?? (mode === 'fight' ? 'hostile' : 'friendly') }).lines
        .filter((l) => l !== `${npc.name} 已更新`);
      lines.unshift(mode === 'join'
        ? `${character.name} ${created ? '加入队伍（已建卡）' : '重新跟着队伍'}${npc.canJoin === true ? '' : '（模组没写他会入队，确认剧情说得通）'}`
        : `${character.name} 和队伍敌对${created ? `（已建卡，HP${character.hp} AC${character.ac}，在 ${character.room}）` : '，转为敌人'}`);
      return lines;
    }
    const patch: NpcState = {};
    if (attitude !== undefined) patch.attitude = attitude;
    const room = str(args.room);
    if (room !== undefined) patch.room = resolveRoom(roomGraph(adventure), room)?.id ?? room;
    if (typeof args.met === 'boolean') patch.met = args.met;
    if (typeof args.alive === 'boolean') patch.alive = args.alive;
    if (Object.keys(patch).length === 0) throw new Error('dnd_story npc 至少要传 attitude/room/met/alive/join/fight 之一');
    return updateNpc(c, adventure, npc.id, patch).lines;
  }
  throw new Error(`dnd_story 不认识的 action: ${action}`);
}

/** dnd_lookup：模组内容的 DM 视角卡片；不传 id 时列出这一类 */
export function lookup(c: Campaign, adventure: Adventure, kind: string, id: string | undefined, brief = false): string {
  if (kind === 'leads') return leadsCard(c, adventure);
  if (kind === 'npc') {
    if (id === undefined) {
      if (adventure.npcs.length === 0) return '这个模组没有具名 NPC。';
      return adventure.npcs.map((n) => `- ${n.id} ${n.name}：${n.role}（${npcRoom(c, n)}${npcAlive(c, n.id) ? '' : '，已死'}）`).join('\n');
    }
    const npc = findNpc(adventure, id);
    if (npc === undefined) throw new Error(`没有这个 NPC: ${id}`);
    return brief ? npcBrief(c, npc) : npcCard(c, adventure, npc);
  }
  if (kind === 'quest') {
    if (id === undefined) {
      if (adventure.quests.length === 0) return '这个模组没有任务。';
      return adventure.quests.map((q) => `- ${q.id} ${q.name}：${c.quests[q.id] ?? '还没提出'}`).join('\n');
    }
    const quest = findQuest(adventure, id);
    if (quest === undefined) throw new Error(`没有这个任务: ${id}`);
    return questCard(c, adventure, quest);
  }
  if (kind === 'site') {
    const site = id === undefined ? undefined : adventure.sites.find((s) => s.id === id || s.name === id);
    if (site !== undefined) return siteCard(c, adventure, site.id);
    if (adventure.sites.length === 1) return siteCard(c, adventure, adventure.sites[0]!.id);
    // 没找到（常见是传了模组 id）就列出全部场景
    return (id === undefined ? '' : `没有场景「${id}」，模组里的场景：\n`) + adventure.sites.map((s) => `- ${s.id} ${s.name}${c.knownSites.includes(s.id) ? '' : '（玩家还不知道）'}${s.summary ? `：${s.summary}` : ''}`).join('\n');
  }
  if (kind === 'room') {
    const room = resolveRoom(roomGraph(adventure), id ?? c.currentRoom);
    if (room === undefined) throw new Error(`没有这个房间: ${id}`);
    return brief ? roomBrief(c, adventure, room) : roomCard(c, adventure, room);
  }
  throw new Error(`dnd_lookup 不认识的 kind: ${kind}`);
}

/** 参战者里有人不在交战房间时的提醒：多半是赶过来了但没 dnd_move，战后位置会对不上 */
function positionNote(c: Campaign, adventure: Adventure, names: readonly string[], rooms: ReadonlySet<string>): string {
  const away = outsideRooms(c, names, rooms);
  if (away.length === 0) return '';
  const graph = roomGraph(adventure);
  const where = away.map((a) => `${a.name}（在「${findRoom(graph, a.room)?.name ?? a.room}」）`).join('、');
  return `\n【DM】${where} 不在交战的房间。已经赶到的，轮到他时先 dnd_move 过来（不在先攻表里的随时能移动）；`
    + '真是隔着房间远程参战就不用管。';
}

function orderLine(c: Campaign): string {
  const state = requireInitiative(c);
  return state.order.map((e, i) => (i === state.turn ? `▶${e.name}(${e.init})` : `${e.name}(${e.init})`)).join(' > ');
}

/**
 * 战斗中有人走进交战房间、或者刷出了新怪时，提醒模型用 join 拉进先攻表；
 * 不提醒的话模型要么让他们一直站着不动，要么 end 再 start 把整场重来。
 */
export function combatJoinHint(c: Campaign, room: string, movers: string[], spawned: string[]): string | undefined {
  if (c.initiative === undefined) return undefined;
  const fightRooms = new Set(c.initiative.order.map((e) => {
    const ch = findCharacter(c, e.name);
    return ch === undefined ? undefined : roomOf(c, ch);
  }));
  const arrivals = fightRooms.has(room) ? movers.filter((n) => !inInitiative(c, n)) : [];
  const late = [...arrivals, ...spawned.filter((n) => !inInitiative(c, n))];
  if (late.length === 0) return undefined;
  return `【DM】战斗进行中，${late.join('、')} 还不在先攻表里。他们参战就调用 dnd_initiative join participants=[${late.join(', ')}]；`
    + '不要 end 再 start。';
}

export interface TurnPromptOptions {
  /** false = 这场战斗已经给过完整规则，只给一句精简提示；缺省 true */
  full?: boolean;
  /** 轮到的 PC 的玩家最近没发过言 */
  absent?: boolean;
}

/** 轮到某角色时给模型的指引：怪物继续结算，PC 必须停下等玩家 */
export function turnPrompt(ch: Character | undefined, name: string, options: TurnPromptOptions = {}): string {
  const full = options.full !== false;
  if (ch === undefined || ch.kind !== 'pc') {
    return full
      ? `轮到 ${name}（由你决定行动）。结算完调用 dnd_initiative next，直到轮到某个 PC 为止。`
      : `轮到 ${name}（你决定），结算完 next。`;
  }
  if (ch.hp === 0 && !ch.conditions.includes('稳定') && !ch.conditions.includes('死亡')) {
    return `轮到 ${name}（0 HP）：掷死亡豁免 dnd_check type=death，然后 dnd_initiative next。`;
  }
  const player = ch.player ?? '玩家';
  const absent = options.absent === true
    ? `${player} 最近 10 分钟没发过言：问一句等他，一直不回才 next dm_override=true 跳过并在回复里说明。`
    : '';
  if (!full) return `轮到 ${name}〈${player}〉：停下等他本人宣告（规矩同前）。${absent}`;
  return `轮到 ${name}〈${player}〉。到此停下：描述局面后问他做什么，等他本人宣告；`
    + '不要替他选目标、选武器或推断行动，这条回复里也不要再结算别人的回合。'
    + `回复发出后系统会自动给他发「结束回合」按钮，不用你在回复里画按钮或列菜单。${absent}`;
}

/**
 * 战斗里的回合提示：每场战斗 PC、怪物各给一次完整规则，之后只给精简一句——完整规则在 DM 守则里本来就有，
 * 每个回合整段重复只是在上下文里堆 token。破例（反应/借机攻击打断了顺序、goto 修过指针）后下一个 PC 回合再给一次完整的。
 * 会改 c.initiative 上的记录，调用方要在 store.update 里用。
 */
export function combatTurnPrompt(c: Campaign, name: string, extra: { recentSenders?: readonly string[]; force?: boolean } = {}): string {
  const ch = findCharacter(c, name);
  const state = c.initiative;
  const kind = ch?.kind === 'pc' ? 'pc' : 'monster';
  const absent = ch?.kind === 'pc' && ch.playerId !== undefined && extra.recentSenders !== undefined
    && !extra.recentSenders.includes(ch.playerId);
  if (state === undefined) return turnPrompt(ch, name, { absent });
  const briefed = state.briefed ?? [];
  const full = extra.force === true || !briefed.includes(kind) || (kind === 'pc' && state.rebrief === true);
  if (!briefed.includes(kind)) state.briefed = [...briefed, kind];
  if (kind === 'pc') delete state.rebrief;
  else if (extra.force === true) state.rebrief = true;
  return turnPrompt(ch, name, { full, absent });
}

const srdLists = new Map<SrdKind, SrdEntry[]>();

/** SRD 全量索引（几百条 index+name），进程内只取一次；取不到时返回空，只靠中文名表和原样 slug */
async function srdList(kind: SrdKind): Promise<SrdEntry[]> {
  const cached = srdLists.get(kind);
  if (cached !== undefined) return cached;
  try {
    const res = await fetch(`https://www.dnd5eapi.co/api/2014/${kind}`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return [];
    const body = (await res.json()) as { results?: Array<{ index?: unknown; name?: unknown }> };
    const list = (body.results ?? [])
      .filter((r) => typeof r.index === 'string')
      .map((r) => ({ index: String(r.index), name: String(r.name ?? r.index) }));
    if (list.length > 0) srdLists.set(kind, list);
    return list;
  } catch {
    return [];
  }
}

export type SrdLookup =
  | { data: Record<string, unknown>; note?: string }
  | { candidates: SrdEntry[] };

/** 名字/拼错的 slug/中文名 → SRD 数据；有几个差不多的候选时不猜，交给调用方列出来 */
export async function lookupSrd(kind: SrdKind, query: string, list?: SrdEntry[]): Promise<SrdLookup> {
  const available = list ?? await srdList(kind);
  const resolved = resolveSrdQuery(query, available, zhTable(kind));
  if (resolved.kind === 'ambiguous') return { candidates: resolved.candidates };
  if (resolved.kind === 'none') {
    if (/\p{Script=Han}/u.test(query)) throw new Error(`SRD 里找不到「${query}」：中文名表没收录，换英文名或 index 再查`);
    // 索引没取到（网络问题）时按原样试一次，至少不比以前差
    if (available.length === 0) return { data: await fetchSrd(kind, query) };
    throw new Error(`SRD 里找不到「${query}」，也没有相近的名字。换个英文名再查`);
  }
  const data = await fetchSrd(kind, resolved.index);
  return resolved.kind === 'fuzzy' ? { data, note: `（「${query}」按 ${resolved.index} 查到）` } : { data };
}

/** 建卡用：拿不准是哪只就报错并列候选（建错怪比多问一次贵） */
async function requireSrd(kind: SrdKind, query: string): Promise<Record<string, unknown>> {
  const found = await lookupSrd(kind, query);
  if ('candidates' in found) throw new Error(candidatesText(query, found.candidates));
  return found.data;
}

export async function fetchSrd(kind: 'monsters' | 'spells', rawIndex: string): Promise<Record<string, unknown>> {
  const index = rawIndex.trim().toLowerCase().replace(/\s+/g, '-');
  if (!/^[a-z0-9-]+$/.test(index)) throw new Error('SRD index 只能是小写字母、数字和短横线，如 goblin、zombie');
  const res = await fetch(`https://www.dnd5eapi.co/api/2014/${kind}/${index}`, { signal: AbortSignal.timeout(10_000) });
  if (res.status === 404) throw new Error(`SRD 里没有 ${index}`);
  if (!res.ok) throw new Error(`SRD 请求失败 HTTP ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

const SRD_TRAITS: Record<string, string> = { 'Undead Fortitude': UNDEAD_FORTITUDE };

/** SRD 怪物 JSON → 角色卡字段：AC、HP、六维、第一个带命中加值的攻击、会自动处理的特性 */
export function srdMonsterInput(data: Record<string, unknown>): Omit<CharacterInput, 'name'> {
  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const ac = Array.isArray(data.armor_class) ? num((data.armor_class[0] as { value?: unknown } | undefined)?.value) : num(data.armor_class);
  const keys = { str: 'strength', dex: 'dexterity', con: 'constitution', int: 'intelligence', wis: 'wisdom', cha: 'charisma' } as const;
  const abilities: Partial<Record<Ability, number>> = {};
  for (const a of ABILITIES) {
    const v = num(data[keys[a]]);
    if (v !== undefined) abilities[a] = v;
  }
  const actions = Array.isArray(data.actions) ? data.actions as Array<Record<string, unknown>> : [];
  const attack = actions.find((a) => num(a.attack_bonus) !== undefined);
  // 多用途武器（长剑单手/双手）的伤害是二选一结构，取第一个选项
  type SrdDamage = { damage_dice?: unknown; from?: { options?: Array<{ damage_dice?: unknown }> } };
  const first = Array.isArray(attack?.damage) ? attack.damage[0] as SrdDamage | undefined : undefined;
  const dice = first?.damage_dice ?? first?.from?.options?.[0]?.damage_dice;
  const specials = Array.isArray(data.special_abilities) ? data.special_abilities as Array<{ name?: unknown }> : [];
  const traits = specials.map((s) => SRD_TRAITS[String(s.name)]).filter((t): t is string => t !== undefined);
  const input: Omit<CharacterInput, 'name'> = { kind: 'monster', abilities, srd: String(data.index ?? '') };
  if (ac !== undefined) input.ac = ac;
  const hp = num(data.hit_points);
  if (hp !== undefined) input.maxHp = hp;
  if (attack !== undefined) input.attackBonus = num(attack.attack_bonus)!;
  if (typeof dice === 'string') input.damage = dice.replace(/\s+/g, '');
  if (traits.length > 0) input.traits = traits;
  const notes = [attack !== undefined ? `攻击：${String(attack.name)}` : '', specials.map((s) => String(s.name)).join('、')].filter(Boolean).join('；');
  if (notes) input.notes = notes;
  return input;
}

/** 「地精」×3 → 接着现有编号往后排：地精1…，已有地精2 就从 地精3 开始 */
function numberedNames(c: Campaign, base: string, count: number): string[] {
  let n = 0;
  for (const ch of c.characters) {
    const m = ch.name.startsWith(base) ? /^(\d+)$/.exec(ch.name.slice(base.length)) : null;
    if (m !== null) n = Math.max(n, Number(m[1]));
  }
  return Array.from({ length: count }, (_, i) => `${base}${n + i + 1}`);
}

/** 把 SRD JSON 压成几行，避免整份 JSON 进上下文 */
export function formatSrd(kind: 'monsters' | 'spells', data: Record<string, unknown>): string {
  const text = (v: unknown): string => (Array.isArray(v) ? v.join(' ') : String(v ?? ''));
  if (kind === 'spells') {
    return [
      `${text(data.name)}｜${text(data.level)} 环 ${text((data.school as { name?: string } | undefined)?.name)}`,
      `施法时间 ${text(data.casting_time)}，距离 ${text(data.range)}，持续 ${text(data.duration)}${data.concentration === true ? '（专注）' : ''}`,
      text(data.desc).slice(0, 900),
      data.higher_level ? `升环：${text(data.higher_level).slice(0, 300)}` : '',
    ].filter(Boolean).join('\n');
  }
  const ac = Array.isArray(data.armor_class) ? (data.armor_class[0] as { value?: number } | undefined)?.value : data.armor_class;
  const abilities = (['strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma'] as const)
    .map((k) => `${k.slice(0, 3).toUpperCase()} ${String(data[k] ?? '?')}`).join(' ');
  const named = (v: unknown, max: number): string => (Array.isArray(v)
    ? v.map((a) => `${String((a as { name?: string }).name)}: ${String((a as { desc?: string }).desc ?? '')}`).join('\n').slice(0, max)
    : '');
  return [
    `${text(data.name)}｜${text(data.size)} ${text(data.type)}，CR ${text(data.challenge_rating)}`,
    `AC ${String(ac)}，HP ${text(data.hit_points)}（${text(data.hit_points_dice)}）`,
    abilities,
    named(data.special_abilities, 600),
    named(data.actions, 900),
  ].filter(Boolean).join('\n');
}
