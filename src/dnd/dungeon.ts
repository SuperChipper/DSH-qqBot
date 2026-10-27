/**
 * 地城房间图：房间、连通关系，以及 DM / 玩家两份描述。
 *
 * 地城预先写好，不做程序化生成：房间坐标决定地图渲染，
 * dmNotes 只进工具结果给模型看，playerView 才是可以说给玩家的内容。
 *
 * 除内置地城外，`<dnd 根目录>/dungeons/*.json` 里的同结构文件也会被加载，
 * 可以自己写模组。商业模组的文本请只放在本地，不要提交进仓库。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { Logger } from '../types.ts';
import type { Condition, KnowledgeBlock, Trigger, Variant } from './adventure.ts';
import type { Ability } from './rules.ts';
import { BUILTIN_DUNGEONS } from './dungeons/index.ts';

export interface DungeonExit {
  to: string;
  /** 出口描述，如「北边的铁门」 */
  label: string;
  /** 暗门：要先被发现（检定成功）才能通行和显示在地图上 */
  hidden?: boolean;
  /** 通过要检定（爬竖井、攀岩）：工具给每个移动的人掷骰，失败的留在原地 */
  check?: ExitCheck;
  /** 条件满足前过不去（锁着的门、塌方） */
  requires?: Condition;
  /** 过不去时给模型的说明，如「铁门锁着，钥匙在头目身上」 */
  lockedText?: string;
}

export interface ExitCheck {
  /** 技能（如 athletics / 运动）或属性（如 str / 力量），二选一 */
  skill?: string;
  ability?: string;
  dc: number;
  /** 失败的后果（DM 视角），模型据此用 dnd_apply 结算 */
  fail: string;
}

export interface DungeonMonster {
  /** 5e SRD 怪物 index（dnd5eapi.co），可用 dnd_srd 查完整数据 */
  srd?: string;
  name: string;
  count: number;
  hp: number;
  ac: number;
  /** 先攻加值（通常是敏捷调整值） */
  initBonus: number;
  /** 命中加值 */
  attackBonus: number;
  /** 攻击伤害表达式，如 1d6+2 */
  damage: string;
  /** 给 DM 看的一句话战术/特性 */
  notes?: string;
  /** 和默认 10 不同的属性值（豁免、不死坚韧要用） */
  abilities?: Partial<Record<Ability, number>>;
  /** 工具自动处理的特性，如「不死坚韧」 */
  traits?: string[];
}

export interface DungeonRoom {
  id: string;
  name: string;
  /** 网格坐标与尺寸（格），地图渲染用 */
  x: number;
  y: number;
  w: number;
  h: number;
  /** 可以念给玩家的描述 */
  playerView: string;
  /** 只有 DM 能看：陷阱、暗门、怪物动机、宝物 */
  dmNotes: string;
  exits: DungeonExit[];
  encounter?: DungeonMonster[];
  /** 条件触发的剧情变化（模组里的 Developments） */
  triggers?: Trigger[];
  /** 条件满足时换一套描述（如强盗被清掉之后） */
  variants?: Variant[];
  /** 住在这个房间的具名 NPC id（Npc.home 指过来的也算） */
  npcs?: string[];
  knowledge?: KnowledgeBlock[];
  /** 城镇地点：满足后玩家才知道这个地方（如打听到的强盗窝）；不写 = 一开始就知道 */
  knownWhen?: Condition;
  /** 城镇地点：店铺，卖什么、单价上限 */
  shop?: { sells: string; maxPrice?: number };
}

/** 只要房间列表的地方（找房间、算出口）：单个地城和整本模组的全部房间都能传 */
export interface RoomGraph {
  rooms: readonly DungeonRoom[];
}

export interface Dungeon {
  id: string;
  name: string;
  /** 开团时给模型的背景简介（DM 视角） */
  intro: string;
  /** 开团时念给玩家的开场 */
  hook: string;
  start: string;
  rooms: DungeonRoom[];
  /** 来源/许可说明 */
  credits?: string;
}

/** 校验地城结构；不合法时抛出带原因的错误 */
export function validateDungeon(input: unknown): Dungeon {
  const d = input as Partial<Dungeon>;
  if (typeof d !== 'object' || d === null) throw new Error('地城必须是对象');
  if (typeof d.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(d.id)) throw new Error('地城 id 只能用小写字母、数字和短横线');
  if (typeof d.name !== 'string' || !Array.isArray(d.rooms) || d.rooms.length === 0) throw new Error(`地城 ${d.id} 缺少 name 或 rooms`);
  validateRooms(d.id, d.rooms, new Set());
  if (typeof d.start !== 'string' || !d.rooms.some((r) => r.id === d.start)) throw new Error(`地城 ${d.id} 的 start 不是有效房间`);
  return {
    intro: '',
    hook: '',
    ...d,
  } as Dungeon;
}

/**
 * 校验一组房间：坐标、出口齐全，出口只指向同一组里的房间。
 * seen 是别处已经用掉的房间 id（整本模组里房间 id 全局唯一），校验完会把这组的 id 加进去。
 */
export function validateRooms(owner: string, rooms: readonly DungeonRoom[], seen: Set<string>): void {
  const ids = new Set<string>();
  for (const room of rooms) {
    if (typeof room.id !== 'string' || ids.has(room.id) || seen.has(room.id)) throw new Error(`${owner} 房间 id 缺失或重复: ${room.id}`);
    ids.add(room.id);
    for (const key of ['x', 'y', 'w', 'h'] as const) {
      if (typeof room[key] !== 'number') throw new Error(`房间 ${room.id} 缺少坐标 ${key}`);
    }
    if (!Array.isArray(room.exits)) throw new Error(`房间 ${room.id} 缺少 exits`);
  }
  for (const room of rooms) {
    for (const exit of room.exits) {
      if (!ids.has(exit.to)) throw new Error(`房间 ${room.id} 的出口指向不存在的房间 ${exit.to}`);
      if (exit.check !== undefined && (typeof exit.check.dc !== 'number' || (exit.check.skill === undefined && exit.check.ability === undefined))) {
        throw new Error(`房间 ${room.id} → ${exit.to} 的出口检定需要 dc 和 skill/ability`);
      }
    }
  }
  for (const id of ids) seen.add(id);
}

export function findRoom(dungeon: RoomGraph, roomId: string): DungeonRoom | undefined {
  return dungeon.rooms.find((r) => r.id === roomId);
}

/** 按 id 或名字找房间（模型可能传「祭坛厅」） */
export function resolveRoom(dungeon: RoomGraph, query: string): DungeonRoom | undefined {
  const q = query.trim();
  return dungeon.rooms.find((r) => r.id === q) ?? dungeon.rooms.find((r) => r.name === q);
}

/** 两个房间之间的出口（任一方向声明都算连通） */
export function exitBetween(dungeon: RoomGraph, from: string, to: string): DungeonExit | undefined {
  const a = findRoom(dungeon, from)?.exits.find((e) => e.to === to);
  if (a !== undefined) return a;
  const back = findRoom(dungeon, to)?.exits.find((e) => e.to === from);
  return back === undefined ? undefined : { ...back, to, label: back.label };
}

/** 某房间的全部出口（含其他房间指向它的那一侧） */
export function exitsOf(dungeon: RoomGraph, roomId: string): DungeonExit[] {
  const own = findRoom(dungeon, roomId)?.exits ?? [];
  const result = [...own];
  for (const room of dungeon.rooms) {
    if (room.id === roomId) continue;
    for (const exit of room.exits) {
      if (exit.to === roomId && !result.some((e) => e.to === room.id)) {
        result.push({ ...exit, to: room.id, label: `通往${room.name}` });
      }
    }
  }
  return result;
}

/** 无向出口 key，用于记录已发现的暗门 */
export function exitKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** 内置地城 + 目录里的自定义地城（同 id 时自定义覆盖内置） */
export class DungeonLibrary {
  private readonly dir: string | undefined;
  private readonly logger: Logger | undefined;

  public constructor(dir?: string, logger?: Logger) {
    this.dir = dir;
    this.logger = logger;
  }

  public list(): Dungeon[] {
    const byId = new Map<string, Dungeon>();
    for (const d of BUILTIN_DUNGEONS) byId.set(d.id, d);
    for (const d of this.loadCustom()) byId.set(d.id, d);
    return [...byId.values()];
  }

  public get(id: string): Dungeon | undefined {
    return this.list().find((d) => d.id === id);
  }

  private loadCustom(): Dungeon[] {
    if (this.dir === undefined || !existsSync(this.dir)) return [];
    const result: Dungeon[] = [];
    for (const name of readdirSync(this.dir).sort()) {
      if (extname(name).toLowerCase() !== '.json') continue;
      try {
        result.push(validateDungeon(JSON.parse(readFileSync(join(this.dir, name), 'utf8'))));
      } catch (err) {
        this.logger?.warn(`im-qqbot: 地城 ${name} 加载失败: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return result;
  }
}
