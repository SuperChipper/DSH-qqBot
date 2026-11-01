import { describe, it, expect } from 'vitest';
import { adventureFromDungeon, validateAdventure } from './adventure.ts';
import { createCampaign, moveParty, upsertCharacter } from './campaign.ts';
import { SUNKEN_BELL } from './dungeons/sunken-bell.ts';
import { buildTextMap } from './text-map.ts';

const BELL = adventureFromDungeon(SUNKEN_BELL);

/** 按字形数（一个 emoji 算一格）量一行有多宽 */
function width(line: string): number {
  return [...new Intl.Segmenter('zh', { granularity: 'grapheme' }).segment(line)].length;
}

function gridRows(text: string): string[] {
  const lines = text.split('\n');
  return lines.slice(1, lines.indexOf(''));
}

describe('文字地图', () => {
  it('只画去过的房间，队伍位置用 📍，图例列房间名和能去的方向', () => {
    const c = createCampaign('group:m', BELL);
    upsertCharacter(c, { name: '艾琳', maxHp: 9 });
    const start = buildTextMap(c, BELL);
    expect(start).toContain('🗺️ 沉钟修道院（已探索 1/7）');
    expect(start).toContain('📍 你们在：塌陷门厅');
    expect(start).toContain('🚪 能去：北边的拱门（未探索）');
    expect(start).not.toContain('藏骨堂');

    moveParty(c, BELL, 'nave');
    const map = buildTextMap(c, BELL);
    expect(map).toContain('📍 你们在：钟楼残殿');
    expect(map).toContain('1️⃣塌陷门厅');
    expect(map).not.toContain('圣物龛');
    const rows = gridRows(map);
    expect(rows.join('')).toContain('📍');
    expect(rows.join('')).toContain('1️⃣');
    for (const row of rows) expect(width(row)).toBeLessThanOrEqual(12);
  });

  it('分头行动时每组都标 📍', () => {
    const c = createCampaign('group:m', BELL);
    upsertCharacter(c, { name: '艾琳', maxHp: 9 });
    upsertCharacter(c, { name: '布洛克', maxHp: 12 });
    moveParty(c, BELL, 'nave');
    moveParty(c, BELL, 'vestry', false, ['艾琳']);
    const map = buildTextMap(c, BELL);
    expect(gridRows(map).join('').split('📍').length - 1).toBe(2);
    expect(map).toMatch(/📍 你们在：(钟楼残殿、法衣室|法衣室、钟楼残殿)/);
  });

  it('城镇只画知道的地点，画布不暴露藏着的地方', () => {
    const adv = validateAdventure({
      id: 'town', name: '小镇', start: 'gate',
      flags: [{ id: 'secret-known' }],
      sites: [{
        id: 'town', name: '小镇', kind: 'hub', entry: 'gate',
        rooms: [
          { id: 'gate', name: '镇口', playerView: '镇口。' },
          { id: 'inn', name: '旅馆', playerView: '旅馆。' },
          { id: 'cellar', name: '密室', playerView: '密室。', knownWhen: 'secret-known' },
        ],
      }],
    });
    const c = createCampaign('group:t', adv);
    const map = buildTextMap(c, adv);
    expect(map).toContain('2️⃣旅馆');
    expect(map).not.toContain('密室');
    // 两个已知地点排在一行，画布只到第二个地点为止
    for (const row of gridRows(map)) expect(width(row)).toBeLessThanOrEqual(12);
    expect(map).toContain('🗺️ 小镇（已探索 1/2）');
  });
});
