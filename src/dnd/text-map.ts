/**
 * 聊天框里的文字地图：把队伍所在的场景画成 emoji 方格，直接发在群里，不用渲染图片。
 *
 * QQ 聊天框不是等宽字体，ASCII 框线（+--|）和中英文混排都会歪；单个 emoji 宽度基本一致，
 * 所以格子只用 emoji。房间名放在图下面的图例里，格子里只放编号。
 * 迷雾规则和 PNG 地图一样：地城只画去过的房间、画布按整张图算（房间位置始终不变）；
 * 城镇画玩家知道的地点、画布只按已知地点算（不暴露还藏着几个地方）。
 */
import { type Adventure, isHub, siteOfRoom } from './adventure.ts';
import { type Campaign, explored, partyPositions, visibleExits } from './campaign.ts';
import type { DungeonRoom } from './dungeon.ts';
import { locationKnown } from './story.ts';

/** 手机上一行放 12 个 emoji 不会折行 */
const MAX_COLS = 12;
const MAX_ROWS = 14;
const FOG = '⬛';
const ROOM = '🟫';
const PARTY = '📍';
/** 房间编号：keycap 数字用完换水果（regional indicator 字母挨在一起会被拼成国旗，不能用） */
const LABELS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟', '🍎', '🍊', '🍋', '🍇', '🍓', '🍒', '🥝', '🍑', '🍍', '🥥'];

interface Box {
  room: DungeonRoom;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export function buildTextMap(c: Campaign, adv: Adventure): string {
  const site = siteOfRoom(adv, c.currentRoom) ?? adv.sites[0]!;
  const hub = isHub(site);
  const shown = site.rooms.filter((r) => (hub ? locationKnown(c, adv, r) : c.revealed.includes(r.id)));
  const frame = hub ? shown : site.rooms;
  const { seen, total } = explored(c, adv);
  const lines = [`🗺️ ${site.name}（已探索 ${seen}/${total}）`];
  if (shown.length === 0) return [...lines, '（还什么都没看到）'].join('\n');

  const ox = Math.min(...frame.map((r) => r.x));
  const oy = Math.min(...frame.map((r) => r.y));
  const spanX = Math.max(...frame.map((r) => r.x + r.w)) - ox;
  const spanY = Math.max(...frame.map((r) => r.y + r.h)) - oy;
  // 等比缩放到手机宽度以内；大场景里挨得近的房间可能缩进同一格，编号以先画的为准，图例里都列出
  const scale = Math.max(1, spanX / MAX_COLS, spanY / MAX_ROWS);
  const cols = Math.max(1, Math.ceil(spanX / scale));
  const rows = Math.max(1, Math.ceil(spanY / scale));
  const grid: string[][] = Array.from({ length: rows }, () => Array<string>(cols).fill(FOG));
  const cell = (v: number, max: number): number => Math.min(max - 1, Math.max(0, Math.floor(v / scale)));

  const boxes: Box[] = shown.map((room) => {
    const x0 = cell(room.x - ox, cols);
    const y0 = cell(room.y - oy, rows);
    return {
      room,
      x0,
      y0,
      x1: Math.max(x0, cell(room.x + room.w - ox - 0.001, cols)),
      y1: Math.max(y0, cell(room.y + room.h - oy - 0.001, rows)),
    };
  });
  for (const b of boxes) {
    for (let y = b.y0; y <= b.y1; y++) for (let x = b.x0; x <= b.x1; x++) grid[y]![x] = ROOM;
  }

  const occupied = new Set(partyPositions(c).keys());
  if (occupied.size === 0) occupied.add(c.currentRoom);
  const legend: string[] = [];
  boxes.forEach((b, i) => {
    const label = LABELS[i] ?? '▪️';
    const cx = Math.floor((b.x0 + b.x1) / 2);
    const cy = Math.floor((b.y0 + b.y1) / 2);
    grid[cy]![cx] = occupied.has(b.room.id) ? PARTY : label;
    legend.push(`${label}${plainName(b.room.name)}`);
  });
  // 上下全是迷雾的行在手机上白占地方，裁掉；左右不裁，东西方向保持不变
  const blank = (row: string[]): boolean => row.every((x) => x === FOG);
  while (grid.length > 1 && blank(grid[0]!)) grid.shift();
  while (grid.length > 1 && blank(grid[grid.length - 1]!)) grid.pop();
  lines.push(...grid.map((row) => row.join('')));

  const names = [...occupied].map((id) => site.rooms.find((r) => r.id === id)?.name).filter((n): n is string => n !== undefined);
  lines.push('', `${PARTY} 你们在：${names.map(plainName).join('、') || '?'}`);
  for (let i = 0; i < legend.length; i += 3) lines.push(legend.slice(i, i + 3).join('　'));
  const exits = visibleExits(c, adv);
  if (exits.length > 0) {
    lines.push(`🚪 能去：${exits.map((e) => {
      const name = plainName(e.name);
      const where = !e.known ? '（未探索）' : (e.label.includes(name) ? '' : `（${name}）`);
      return `${plainName(e.label.replace(/^通往/, '去'))}${where}${e.locked === true ? '[过不去]' : ''}`;
    }).join('；')}`);
  }
  return lines.join('\n');
}

/** 模组房间名常带书里的区域号（「3. 狗洞」），和地图上的 emoji 编号放一起会看混，图例里去掉 */
function plainName(name: string): string {
  return name.replace(/(^|去)\d+[a-z]?\.\s*/, '$1');
}
