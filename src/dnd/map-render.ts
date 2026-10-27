/**
 * 地图渲染：只画已揭示的房间，没揭示的部分就是迷雾（画布底色），不需要真正的迷雾机制。
 *
 * 先拼 SVG（纯函数，可测），再用可选依赖 sharp 转 PNG；sharp 装不上时返回 undefined。
 * 画布尺寸按队伍所在场景的整张图算，房间位置始终一致，玩家每次看到的是同一张图逐渐展开。
 * 别的场景的房间不画；从场景入口去别的场景的出口也不画（只在出口列表里）。
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Campaign } from './campaign.ts';
import { partyPositions, visibleExits } from './campaign.ts';
import { type Adventure, siteOfRoom } from './adventure.ts';
import { type DungeonRoom, exitKey, findRoom } from './dungeon.ts';

const CELL = 36;
const PAD = 1;
const TITLE_H = 44;
const FONT = "'Microsoft YaHei','PingFang SC','Noto Sans CJK SC','Source Han Sans SC',sans-serif";

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

interface Box { cx: number; cy: number; hw: number; hh: number }

function boxOf(room: DungeonRoom, ox: number, oy: number): Box {
  return {
    cx: (room.x - ox + room.w / 2) * CELL,
    cy: (room.y - oy + room.h / 2) * CELL + TITLE_H,
    hw: (room.w * CELL) / 2,
    hh: (room.h * CELL) / 2,
  };
}

/** 从房间中心朝目标方向，伸出房间边缘 extra 像素的点 */
function stubEnd(from: Box, to: Box, extra: number): { x: number; y: number } {
  const dx = to.cx - from.cx;
  const dy = to.cy - from.cy;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const t = Math.min(ux === 0 ? Infinity : from.hw / Math.abs(ux), uy === 0 ? Infinity : from.hh / Math.abs(uy));
  return { x: from.cx + ux * (t + extra), y: from.cy + uy * (t + extra) };
}

export function buildMapSvg(c: Campaign, adv: Adventure): string {
  const dungeon = siteOfRoom(adv, c.currentRoom) ?? adv.sites[0]!;
  const ox = Math.min(...dungeon.rooms.map((r) => r.x)) - PAD;
  const oy = Math.min(...dungeon.rooms.map((r) => r.y)) - PAD;
  const maxX = Math.max(...dungeon.rooms.map((r) => r.x + r.w)) + PAD;
  const maxY = Math.max(...dungeon.rooms.map((r) => r.y + r.h)) + PAD;
  const width = (maxX - ox) * CELL;
  const height = (maxY - oy) * CELL + TITLE_H;

  const revealed = dungeon.rooms.filter((r) => c.revealed.includes(r.id));
  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`);
  parts.push(`<rect width="${width}" height="${height}" fill="#1b1d22"/>`);
  // 迷雾里的淡网格，让人知道地图还有没走到的地方
  parts.push('<g stroke="#262931" stroke-width="1">');
  for (let x = 0; x <= width; x += CELL) parts.push(`<line x1="${x}" y1="${TITLE_H}" x2="${x}" y2="${height}"/>`);
  for (let y = TITLE_H; y <= height; y += CELL) parts.push(`<line x1="0" y1="${y}" x2="${width}" y2="${y}"/>`);
  parts.push('</g>');
  parts.push(`<text x="16" y="29" font-family="${FONT}" font-size="20" font-weight="bold" fill="#e8dcc0">${esc(dungeon.name)}</text>`);
  parts.push(`<text x="${width - 16}" y="29" font-family="${FONT}" font-size="14" fill="#9a927f" text-anchor="end">已探索 ${revealed.length}/${dungeon.rooms.length}</text>`);

  // 通道画在房间下面，房间盖住中心那段，只露出房间之间的部分
  const drawn = new Set<string>();
  parts.push('<g stroke="#b9a77c" stroke-width="6" stroke-linecap="round">');
  for (const room of revealed) {
    const from = boxOf(room, ox, oy);
    for (const exit of visibleExits(c, adv, room.id)) {
      const key = exitKey(room.id, exit.to);
      const target = findRoom(dungeon, exit.to);
      if (target === undefined || drawn.has(key)) continue;
      const to = boxOf(target, ox, oy);
      const dashed = c.discoveredExits.includes(key) ? ' stroke-dasharray="10 8"' : '';
      if (exit.known) {
        drawn.add(key);
        parts.push(`<line x1="${from.cx}" y1="${from.cy}" x2="${to.cx}" y2="${to.cy}"${dashed}/>`);
      } else {
        // 通往未揭示房间：只画一小截，并标问号，不暴露目标房间的位置和大小
        const end = stubEnd(from, to, CELL * 0.9);
        parts.push(`<line x1="${from.cx}" y1="${from.cy}" x2="${end.x.toFixed(1)}" y2="${end.y.toFixed(1)}"${dashed}/>`);
        parts.push(`<text x="${end.x.toFixed(1)}" y="${(end.y + 6).toFixed(1)}" font-family="${FONT}" font-size="18" font-weight="bold" fill="#e8dcc0" stroke="none" text-anchor="middle">?</text>`);
      }
    }
  }
  parts.push('</g>');

  for (const room of revealed) {
    const x = (room.x - ox) * CELL;
    const y = (room.y - oy) * CELL + TITLE_H;
    const current = room.id === c.currentRoom;
    parts.push(`<rect x="${x}" y="${y}" width="${room.w * CELL}" height="${room.h * CELL}" rx="4" fill="${current ? '#e9d9a8' : '#cfc2a0'}" stroke="${current ? '#d4552f' : '#6e6146'}" stroke-width="${current ? 4 : 2}"/>`);
    parts.push(`<text x="${x + (room.w * CELL) / 2}" y="${y + 24}" font-family="${FONT}" font-size="15" font-weight="bold" fill="#3a3122" text-anchor="middle">${esc(room.name)}</text>`);
  }

  // 分头行动时每个有人的房间各画一个标记，数字是该房间的人数
  const positions = partyPositions(c);
  const marked = positions.size > 0 ? [...positions] : [[c.currentRoom, []] as const];
  for (const [roomId, members] of marked) {
    const here = findRoom(dungeon, roomId);
    if (here === undefined || !c.revealed.includes(here.id)) continue;
    const box = boxOf(here, ox, oy);
    parts.push(`<circle cx="${box.cx}" cy="${box.cy + 8}" r="11" fill="#d4552f" stroke="#fff" stroke-width="2"/>`);
    if (members.length > 0) {
      parts.push(`<text x="${box.cx}" y="${box.cy + 13}" font-family="${FONT}" font-size="13" font-weight="bold" fill="#fff" text-anchor="middle">${members.length}</text>`);
    }
  }
  parts.push('</svg>');
  return parts.join('');
}

type SharpFactory = (input?: unknown) => { png(): { toFile(path: string): Promise<unknown> } };

let sharpPromise: Promise<SharpFactory | undefined> | undefined;

async function loadSharp(): Promise<SharpFactory | undefined> {
  sharpPromise ??= import('sharp')
    .then((mod) => ((mod as { default?: unknown }).default ?? mod) as SharpFactory)
    .catch(() => undefined);
  return sharpPromise;
}

/** 渲染 PNG 到 outPath；sharp 不可用时返回 undefined */
export async function renderMapPng(c: Campaign, adv: Adventure, outPath: string): Promise<string | undefined> {
  const sharp = await loadSharp();
  if (sharp === undefined) return undefined;
  mkdirSync(dirname(outPath), { recursive: true });
  await sharp(Buffer.from(buildMapSvg(c, adv))).png().toFile(outPath);
  return outPath;
}
