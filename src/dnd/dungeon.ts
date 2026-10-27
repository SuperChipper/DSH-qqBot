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
import type { Ability } from './rules.ts';
import { BUILTIN_DUNGEONS } from './dungeons/index.ts';

export interface DungeonExit {
  to: string;
  /** 出口描述，如「北边的铁门」 */
  label: string;
  /** 暗门：要先被发现（检定成功）才能通行和显示在地图上 */
  hidden?: boolean;
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
  const ids = new Set<string>();
  for (const room of d.rooms) {
    if (typeof room.id !== 'string' || ids.has(room.id)) throw new Error(`地城 ${d.id} 房间 id 缺失或重复: ${room.id}`);
    ids.add(room.id);
    for (const key of ['x', 'y', 'w', 'h'] as const) {
      if (typeof room[key] !== 'number') throw new Error(`房间 ${room.id} 缺少坐标 ${key}`);
    }
    if (!Array.isArray(room.exits)) throw new Error(`房间 ${room.id} 缺少 exits`);
  }
  for (const room of d.rooms) {
    for (const exit of room.exits) {
      if (!ids.has(exit.to)) throw new Error(`房间 ${room.id} 的出口指向不存在的房间 ${exit.to}`);
    }
  }
  if (typeof d.start !== 'string' || !ids.has(d.start)) throw new Error(`地城 ${d.id} 的 start 不是有效房间`);
  return {
    intro: '',
    hook: '',
    ...d,
  } as Dungeon;
}

export function findRoom(dungeon: Dungeon, roomId: string): DungeonRoom | undefined {
  return dungeon.rooms.find((r) => r.id === roomId);
}

/** 按 id 或名字找房间（模型可能传「祭坛厅」） */
export function resolveRoom(dungeon: Dungeon, query: string): DungeonRoom | undefined {
  const q = query.trim();
  return dungeon.rooms.find((r) => r.id === q) ?? dungeon.rooms.find((r) => r.name === q);
}

/** 两个房间之间的出口（任一方向声明都算连通） */
export function exitBetween(dungeon: Dungeon, from: string, to: string): DungeonExit | undefined {
  const a = findRoom(dungeon, from)?.exits.find((e) => e.to === to);
  if (a !== undefined) return a;
  const back = findRoom(dungeon, to)?.exits.find((e) => e.to === from);
  return back === undefined ? undefined : { ...back, to, label: back.label };
}

/** 某房间的全部出口（含其他房间指向它的那一侧） */
export function exitsOf(dungeon: Dungeon, roomId: string): DungeonExit[] {
  const own = findRoom(dungeon, roomId)?.exits ?? [];
  const result = [...own];
  for (const room of dungeon.rooms) {
    if (room.id === roomId) continue;
    for (const exit of room.exits) {
      if (exit.to === roomId && !result.some((e) => e.to === room.id)) {
        result.push({ to: room.id, label: `通往${room.name}`, ...(exit.hidden === true ? { hidden: true } : {}) });
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
