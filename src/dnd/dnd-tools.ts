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
import { type Advantage, rollD20, rollExpression } from './dice.ts';
import {
  type Campaign,
  type Character,
  type CharacterInput,
  type CharacterKind,
  type HpChange,
  addSummary,
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
  moveParty,
  nextTurn,
  partyPositions,
  pushLog,
  recordDeathFailures,
  removeCharacter,
  requireCharacter,
  requireInitiative,
  rest,
  restoreResource,
  roomOf,
  setResource,
  spawnMonsters,
  startInitiative,
  summarize,
  upsertCharacter,
  useResource,
  type Weapon,
  weaponDamage,
} from './campaign.ts';
import type { DndService } from './dnd-service.ts';
import { findRoom, resolveRoom } from './dungeon.ts';
import { renderMapPng } from './map-render.ts';
import {
  type NpcState,
  afterChange,
  fireTrigger,
  leadsCard,
  learnLead,
  npcAlive,
  npcCard,
  npcCharacterInput,
  npcRoom,
  npcsIn,
  pendingTriggers,
  questCard,
  revealFact,
  roomCard,
  setChapter,
  setFlag,
  setQuestStatus,
  shopLine,
  siteCard,
  updateNpc,
} from './story.ts';
import { ABILITIES, ABILITY_NAMES, type Ability, type Skill, SKILLS, parseAbility, parseSkill, skillLabel } from './rules.ts';

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

function sheet(ch: Character): string {
  const abilities = ABILITIES.map((a) => `${ABILITY_NAMES[a]}${ch.abilities[a]}`).join(' ');
  const lines = [
    `${ch.name}${ch.player ? `〈${ch.player}${ch.playerId ? ` ${ch.playerId}` : ''}〉` : ''}｜${ch.kind === 'pc' ? 'PC' : (ch.kind === 'npc' ? 'NPC' : '怪物')}${ch.className ? ` ${ch.className}` : ''} ${ch.level} 级`,
    `HP ${ch.hp}/${ch.maxHp}${ch.tempHp > 0 ? ` +${ch.tempHp}` : ''}  AC ${ch.ac}`,
    abilities,
  ];
  if (ch.skills.length > 0) lines.push(`熟练技能：${ch.skills.map(skillLabel).join('、')}`);
  if (ch.saves.length > 0) lines.push(`熟练豁免：${ch.saves.map((a) => ABILITY_NAMES[a]).join('、')}`);
  if (ch.attackBonus !== undefined || ch.damage !== undefined) lines.push(`攻击 +${attackModifier(ch)} 伤害 ${ch.damage ?? '?'}`);
  for (const w of ch.weapons ?? []) {
    lines.push(`武器 ${w.name}：命中 +${attackModifier(ch, w.ability ?? 'str')}，伤害 ${weaponDamage(ch, w)}${w.notes ? `（${w.notes}）` : ''}`);
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
      const result = fn(c, adventure);
      const story = afterChange(c, adventure);
      for (const line of story) pushLog(c, line);
      return (story.length > 0 && typeof result === 'string' ? `${result}\n【剧情】${story.join('；')}` : result) as T;
    }, exec.label);
  };

  const sendersOf = (exec: Exec): string[] => recentSenderIds(recordOf(exec), SENDER_WINDOW_MS);

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
    + 'damage is rolled (crits double the dice) and applied to the target automatically.',
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
      weapon: { type: 'string', description: 'For type=attack: weapon name from the attacker\'s sheet; damage and ability come from it.' },
      damage: {
        type: 'string',
        description: 'For type=attack: damage expression for spells/special attacks, or extra dice such as sneak attack "1d6". '
          + 'With `weapon` it is ADDED to the weapon damage.',
      },
      damage_type: { type: 'string', description: 'For type=attack: damage type, e.g. 光耀/穿刺 (radiant beats Undead Fortitude).' },
      advantage: { type: 'string', enum: ['none', 'advantage', 'disadvantage'] },
      bonus: { type: 'integer', description: 'Extra flat modifier (e.g. cover, magic weapon +1).' },
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
        description: 'openid of the player whose message declared this action (the id in "[昵称 (openid)]"). '
          + 'Required for a PC acting on their own; omit for monsters/NPCs.',
      },
      reaction: {
        type: 'boolean',
        description: 'A roll you (the DM) call for outside the actor\'s own declaration: contested checks, '
          + 'opportunity attacks, reactions. Skips the turn-order and player checks.',
      },
    },
    ['character', 'type'],
    (args, exec) => mutate(exec, (c) => {
      const ch = requireCharacter(c, String(args.character ?? ''));
      const type = String(args.type);
      const adv = advantageOf(args.advantage);
      const secret = args.secret === true;
      // 豁免和死亡豁免是被动发生的，不需要宣告；攻击和检定是主动行动
      if (type !== 'save' && type !== 'death') {
        assertCanAct(c, ch, { declaredBy: str(args.declared_by), reaction: args.reaction === true, recentSenders: sendersOf(exec) });
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
        const roll = rollD20(attackModifier(ch, ability) + bonus, adv, service.roller);
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
            const dmg = rollExpression(crit ? critExpression(expression) : expression, service.roller);
            lines.push(`伤害 ${dmg.detail}`);
            const change = applyDamage(c, target.name, dmg.total, { crit, damageType: str(args.damage_type), roller: service.roller });
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
      room: { type: 'string', description: 'Room id the character is in (monsters; PCs that split off).' },
      hit_die: { type: 'string', description: 'PCs: hit die, e.g. d10 (fighter/paladin/ranger), d8 (cleric/rogue/bard).' },
      traits: { type: 'array', items: { type: 'string' }, description: 'Auto-handled traits, e.g. ["不死坚韧"].' },
      add_items: { type: 'array', items: { type: 'string' }, description: 'Items picked up.' },
      remove_items: { type: 'array', items: { type: 'string' }, description: 'Items used up or handed over.' },
      gp_change: { type: 'integer', description: 'Gold gained (+) or spent (-).' },
      kind: { type: 'string', enum: ['pc', 'npc', 'monster'] },
      player: { type: 'string', description: 'Player nickname in the group (PCs).' },
      player_id: { type: 'string', description: 'Player openid from "[昵称 (openid)]" (PCs). Binds the PC so only this player can act for it.' },
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
          },
          required: ['name', 'damage'],
          additionalProperties: false,
        },
      },
      notes: { type: 'string' },
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
        return sheet(requireCharacter(campaign, String(args.name ?? '')));
      }
      // SRD 数据先取回来（网络请求不能放进同步的 mutate 里）
      const srdIndex = action === 'create' ? str(args.srd) : undefined;
      const srdBase = srdIndex === undefined ? undefined : srdMonsterInput(await fetchSrd('monsters', srdIndex));
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
          player: str(args.player), playerId: str(args.player_id), className: str(args.class_name), level: int(args.level), maxHp: int(args.max_hp),
          ac: int(args.ac), attackBonus: int(args.attack_bonus), damage: str(args.damage), notes: str(args.notes),
          skills: parseSkills(strList(args.skills)), saves: parseAbilities(strList(args.saves)),
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
          return `已建卡 ${made.length} 个：${names.join('、')}\n${sheet(made[0]!)}`;
        }
        if (action === 'create' && findCharacter(c, name)?.name === name) throw new Error(`已经有「${name}」了，改数据用 update，再加一只换个名字或传 count`);
        const { character, created } = upsertCharacter(c, input);
        const lines = [`${created ? '已建卡' : '已更新'}：`];
        const add = strList(args.add_items) ?? [];
        const remove = strList(args.remove_items) ?? [];
        const gp = int(args.gp_change) ?? 0;
        if (add.length > 0 || remove.length > 0 || gp !== 0) changeInventory(c, character.name, add, remove, gp);
        lines.push(sheet(requireCharacter(c, character.name)));
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
    + 'goto: fix the pointer when it disagrees with the story (name, optional round). end: leave combat and clear '
    + 'defeated monsters. status: show the order.',
    {
      action: { type: 'string', enum: ['start', 'next', 'goto', 'end', 'status'] },
      participants: { type: 'array', items: { type: 'string' }, description: 'Optional for start.' },
      room: { type: 'string', description: 'For start: room id where the fight happens (default: the party\'s main room).' },
      name: { type: 'string', description: 'For goto.' },
      round: { type: 'integer', description: 'For goto.' },
      declared_by: { type: 'string', description: 'For next on a PC turn: openid of that PC\'s player, who said they are done.' },
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
        return `先攻：\n${rolls.map((r, i) => `${i + 1}. ${r.name} ${r.detail}`).join('\n')}\n第 1 轮，${turnPrompt(findCharacter(c, rolls[0]!.name), rolls[0]!.name)}`;
      }
      if (action === 'next') {
        assertCanEndTurn(c, { declaredBy: str(args.declared_by), recentSenders: sendersOf(exec), dmOverride: args.dm_override === true });
        const { round, current, newRound } = nextTurn(c);
        turnChanged();
        return `${newRound ? `进入第 ${round} 轮。` : ''}${turnPrompt(findCharacter(c, current.name), current.name)}`;
      }
      if (action === 'goto') {
        const entry = gotoTurn(c, String(args.name ?? ''), int(args.round));
        turnChanged();
        return `已调整：第 ${requireInitiative(c).round} 轮，${turnPrompt(findCharacter(c, entry.name), entry.name)}`;
      }
      if (action === 'end') {
        const { rounds, defeated } = endInitiative(c);
        return `战斗结束，共 ${rounds} 轮。${defeated.length > 0 ? `击败：${defeated.join('、')}` : ''}`;
      }
      const state = requireInitiative(c);
      return `第 ${state.round} 轮：${state.order.map((e, i) => (i === state.turn ? `▶${e.name}(${e.init})` : `${e.name}(${e.init})`)).join(' > ')}`;
    }),
  );

  register(
    'dnd_move',
    'Move characters to an adjacent room. Omit `who` only when the WHOLE party goes; when one or a few go ahead '
    + '(scouting, sneaking, fetching something) pass `who` so the others stay put. Returns the player-facing '
    + 'description (narrate from this) and DM-only notes (use for rulings, never read aloud). First visit reveals '
    + 'the room and spawns its monsters. In combat only the current-turn character can move (with `who`). '
    + 'Pass discover_hidden=true only after a successful check found a secret passage. Exits that need a check '
    + '(climbing, swimming) are rolled by the tool for each mover; those who fail stay behind. In a town you can go '
    + 'to any location the players know. From a dungeon\'s entry, or anywhere in a town, you can travel to another '
    + 'known site by its name or id.',
    {
      room: { type: 'string', description: 'Room id or name, or another site\'s id/name (from that site\'s entry).' },
      who: { type: 'array', items: { type: 'string' }, description: 'Characters who move; omit for the whole party.' },
      discover_hidden: { type: 'boolean' },
    },
    ['room'],
    (args, exec) => mutate(exec, (c, adventure) => {
      const result = moveParty(c, adventure, String(args.room ?? ''), args.discover_hidden === true, strList(args.who), service.roller);
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
      return lines.join('\n');
    }),
  );

  register(
    'dnd_story',
    'Change story state written into the adventure, by id (ids come from 【团况】 and dnd_lookup). '
    + 'trigger: an event listed as "可能发生" now happens (applies its flags, leads, reinforcements). '
    + 'fact: an NPC or captive reveals a piece of information (checks with a DC: dnd_check first, then passed=true); '
    + 'say only what the tool returns. lead: players learn a lead. flag: set/clear a declared flag. '
    + 'quest: offered/active/completed/rewarded/failed (rewarded pays gp/items to `to`). '
    + 'npc: attitude/room/met, or join=true (joins the party) / fight=true (fights the party), which creates the '
    + 'character sheet. chapter: move to another chapter.',
    {
      action: { type: 'string', enum: ['trigger', 'fact', 'lead', 'flag', 'quest', 'npc', 'chapter'] },
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
    },
    ['action', 'id'],
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
    + 'events, NPCs), leads (all leads and which the players know). Omit id to list everything of that kind.',
    {
      kind: { type: 'string', enum: ['npc', 'quest', 'site', 'room', 'leads'] },
      id: { type: 'string', description: 'Id or name; omit to list.' },
    },
    ['kind'],
    (args, exec) => {
      const { campaign, adventure } = service.require(recordOf(exec).sessionKey);
      return lookup(campaign, adventure, String(args.kind), str(args.id));
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
    + 'dead monsters or restarting initiative.',
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
    'Look up official 5e SRD data (monster stat block or spell) from dnd5eapi.co. Use the SRD index slug, e.g. '
    + 'monster "goblin", "owlbear"; spell "fire-bolt", "cure-wounds".',
    {
      kind: { type: 'string', enum: ['monster', 'spell'] },
      index: { type: 'string' },
    },
    ['kind', 'index'],
    async (args) => {
      const kind = args.kind === 'spell' ? 'spells' : 'monsters';
      return formatSrd(kind, await fetchSrd(kind, String(args.index ?? '')));
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
      const { character, created } = upsertCharacter(c, npcCharacterInput(c, npc, mode, srdBase));
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
export function lookup(c: Campaign, adventure: Adventure, kind: string, id: string | undefined): string {
  if (kind === 'leads') return leadsCard(c, adventure);
  if (kind === 'npc') {
    if (id === undefined) {
      if (adventure.npcs.length === 0) return '这个模组没有具名 NPC。';
      return adventure.npcs.map((n) => `- ${n.id} ${n.name}：${n.role}（${npcRoom(c, n)}${npcAlive(c, n.id) ? '' : '，已死'}）`).join('\n');
    }
    const npc = findNpc(adventure, id);
    if (npc === undefined) throw new Error(`没有这个 NPC: ${id}`);
    return npcCard(c, adventure, npc);
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
    return roomCard(c, adventure, room);
  }
  throw new Error(`dnd_lookup 不认识的 kind: ${kind}`);
}

/** 轮到某角色时给模型的指引：怪物继续结算，PC 必须停下等玩家 */
export function turnPrompt(ch: Character | undefined, name: string): string {
  if (ch === undefined || ch.kind !== 'pc') {
    return `轮到 ${name}（由你决定行动）。结算完调用 dnd_initiative next，直到轮到某个 PC 为止。`;
  }
  if (ch.hp === 0 && !ch.conditions.includes('稳定') && !ch.conditions.includes('死亡')) {
    return `轮到 ${name}（0 HP）：掷死亡豁免 dnd_check type=death，然后 dnd_initiative next。`;
  }
  return `轮到 ${name}〈${ch.player ?? '玩家'}〉。到此停下：描述局面后问他做什么，等他本人宣告；`
    + '不要替他选目标、选武器或推断行动，这条回复里也不要再结算别人的回合。'
    + '回复发出后系统会自动给他发「结束回合」按钮，不用你在回复里画按钮或列菜单。';
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
