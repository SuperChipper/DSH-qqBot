/**
 * 内置原创小地城「沉钟修道院」：7 个房间，1-3 级 3-5 人一晚能打完。
 *
 * 剧情与房间文本为本项目原创。怪物数值取自 System Reference Document 5.1
 * （Wizards of the Coast，CC BY 4.0，https://creativecommons.org/licenses/by/4.0/）。
 */
import type { Dungeon } from '../dungeon.ts';

const giantRat = {
  srd: 'giant-rat', name: '巨鼠', hp: 7, ac: 12, initBonus: 2, attackBonus: 4, damage: '1d4+2',
  notes: '群居战术：同一目标 5 尺内有其他巨鼠时攻击具优势。',
};
const skeleton = {
  srd: 'skeleton', name: '骷髅', hp: 13, ac: 13, initBonus: 2, attackBonus: 4, damage: '1d6+2',
  notes: '易伤钝击；不会说话，只会执行「守住骨堂」的旧命令。',
};
const goblin = {
  srd: 'goblin', name: '地精', hp: 7, ac: 15, initBonus: 2, attackBonus: 4, damage: '1d6+2',
  notes: '灵巧脱逃：每回合可用附赠动作撤离或躲藏。半数倒下就想谈条件。',
};
const zombie = {
  srd: 'zombie', name: '溺尸', hp: 22, ac: 8, initBonus: -2, attackBonus: 3, damage: '1d6+1',
  notes: '不死坚韧：工具自动处理（伤害时传 damage_type，光耀和重击不触发）。',
  abilities: { str: 13, dex: 6, con: 16, int: 3, wis: 6, cha: 5 },
  traits: ['不死坚韧'],
};
const ghoul = {
  srd: 'ghoul', name: '守钟人（食尸鬼）', hp: 22, ac: 12, initBonus: 2, attackBonus: 4, damage: '2d6+2',
  abilities: { str: 13, dex: 15, con: 10, int: 7, wis: 10, cha: 6 },
  notes: '爪击命中的非精灵/非不死目标需过体质豁免 DC 10，失败则麻痹 1 分钟（每回合末可重骰）。',
};

export const SUNKEN_BELL: Dungeon = {
  id: 'sunken-bell',
  name: '沉钟修道院',
  credits: '原创地城；怪物数值来自 SRD 5.1（CC BY 4.0）。',
  intro: [
    '山谷里的修道院百年前随地陷沉进了泥沼，只剩钟楼尖顶露在外面。',
    '最后一任守钟修士为了不让圣钟落进强盗手里，把自己锁在钟井里饿死，化成了食尸鬼「守钟人」。',
    '圣物龛里供着「静默之铃」：摇响时方圆 30 尺内的不死生物要过感知豁免 DC 12，失败则 1 分钟内无法靠近摇铃者。',
    '一伙地精刚从法衣室的破墙钻进来，想偷银器去换吃的；它们怕守钟人，愿意出卖情报换活路。',
    '目标：找到静默之铃，或者让钟声重新响起（敲响钟井里的沉钟会让守钟人安息）。',
  ].join('\n'),
  hook: '村里的老人说，每到雨夜，泥沼里就会传来闷闷的钟声——可那口钟一百年前就沉下去了。最近已经有两个采药人没回来。',
  start: 'gate',
  rooms: [
    {
      id: 'gate', name: '塌陷门厅', x: 10, y: 14, w: 4, h: 3,
      playerView: '半截门厅斜插进泥里，石地砖缝里渗着黑水。北边一道拱门通往更深处，拱门上方刻着一口钟的浮雕，钟舌被凿掉了。',
      dmNotes: '安全区。墙角有采药人留下的背篓（一瓶治疗药水，2d4+2）。察觉 DC 10 能听见北边传来细碎的抓挠声（巨鼠）。',
      exits: [{ to: 'nave', label: '北边的拱门' }],
    },
    {
      id: 'nave', name: '钟楼残殿', x: 9, y: 8, w: 6, h: 5,
      playerView: '主殿的长椅泡得发胀，倒得横七竖八。天花板开了个大洞，雨水顺着垂下来的锈链滴落。东西两侧各有一扇门，北边是一段往下走的石阶。',
      dmNotes: '3 只巨鼠在啃采药人的尸体。尸体口袋里有一张字条：「钟在下面，别让它停」。西门通藏骨堂，东门通法衣室，北阶下到沉钟井。',
      exits: [
        { to: 'ossuary', label: '西侧的木门' },
        { to: 'vestry', label: '东侧的小门' },
        { to: 'bellshaft', label: '北边往下的石阶' },
      ],
      encounter: [{ ...giantRat, count: 3 }],
    },
    {
      id: 'ossuary', name: '藏骨堂', x: 2, y: 8, w: 5, h: 4,
      playerView: '墙上嵌满头骨，每个眼窝里都塞着一截燃尽的蜡烛。屋子中央摆着一张石桌，上面放着一本泡烂的名册。',
      dmNotes: '2 具骷髅站在门两侧，有人踏进屋中央才动。名册（调查 DC 12）记载圣物龛的入口「在骨墙之后，在钟井之西」。北墙是暗门（调查或察觉 DC 14）通往圣物龛。',
      exits: [{ to: 'reliquary', label: '北墙的骨堆后面', hidden: true }],
      encounter: [{ ...skeleton, count: 2 }],
    },
    {
      id: 'vestry', name: '法衣室', x: 17, y: 9, w: 4, h: 3,
      playerView: '衣柜全被撬开，烂掉的法衣扔了一地。东墙有个刚挖开的破洞，泥土还是新的。北边一扇半掩的门后传来水声。',
      dmNotes: '2 只地精正往麻袋里塞银烛台（共值 25 gp）。被发现时先威胁，劣势时求饶，愿意告诉玩家「钟井里有东西，会用铁链拖人」。',
      exits: [{ to: 'cloister', label: '北边半掩的门' }],
      encounter: [{ ...goblin, count: 2 }],
    },
    {
      id: 'cloister', name: '淹水回廊', x: 16, y: 3, w: 6, h: 4,
      playerView: '回廊整个泡在齐腰深的水里，水面漂着浮萍。柱子之间挂着褪色的经幡。西边的拱廊通向一个圆形的大厅。',
      dmNotes: '困难地形。一具溺尸藏在水下，等第一个人走到回廊中央时抓住对方的腿（力量豁免 DC 11，失败被擒抱）。水底有一把 +1 硬头锤（银质，对守钟人特别有用）。',
      exits: [{ to: 'bellshaft', label: '西边的拱廊' }],
      encounter: [{ ...zombie, count: 1 }],
    },
    {
      id: 'bellshaft', name: '沉钟井', x: 9, y: 2, w: 6, h: 4,
      playerView: '一口青铜巨钟半埋在圆形大厅中央的泥里，钟身上缠满铁链。一个干瘦的人影蹲在钟顶，背对着你们，正在一下一下地用指甲刮钟。',
      dmNotes: 'Boss：守钟人。它不主动攻击，除非有人碰钟或拔武器；可以用宗教/游说 DC 13 和它说话，它只会重复「钟不能停」。用钝器敲钟三次（每次一个动作）可让它安息。西墙有暗门（察觉 DC 15，看到泥上的拖痕）通往圣物龛。',
      exits: [{ to: 'reliquary', label: '西墙的拖痕尽头', hidden: true }],
      encounter: [{ ...ghoul, count: 1 }],
    },
    {
      id: 'reliquary', name: '圣物龛', x: 2, y: 2, w: 5, h: 4,
      playerView: '一间干燥得出奇的小石室，空气里有股蜡和铁锈的味道。神龛上放着一只巴掌大的银铃，铃舌用红绳缠着。',
      dmNotes: '静默之铃（见地城简介）。神龛下有 60 gp 和一卷防护邪恶与善良卷轴。拿走铃时，守钟人如果还活着会立刻察觉并赶来。',
      exits: [],
    },
  ],
};
