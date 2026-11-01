/**
 * dnd_srd 的模糊查找：把模型写的名字（拼错、大小写、空格/连字符不一致、中文名）解析成 dnd5eapi 的 index。
 *
 * 以前 slug 差一个字母就 404，模型只能换着拼法重试好几轮。这里先查本地中文名表，再和 SRD 全量索引
 * （/api/2014/monsters 一次取回、进程内缓存）比编辑距离；唯一明显最优就直接用，几个差不多的就列候选让模型挑。
 */

export type SrdKind = 'monsters' | 'spells';

export interface SrdEntry {
  index: string;
  name: string;
}

export type SrdResolution =
  | { kind: 'exact'; index: string }
  | { kind: 'fuzzy'; index: string; matched: string }
  | { kind: 'ambiguous'; candidates: SrdEntry[] }
  | { kind: 'none' };

/** 常用怪物中文名（玩家/模组常见译名）→ SRD index；只收 SRD 5.1 里确实有的 */
export const SRD_MONSTER_ZH: Record<string, string> = {
  地精: 'goblin', 大地精: 'hobgoblin', 熊地精: 'bugbear', 狗头人: 'kobold', 兽人: 'orc', 食人魔: 'ogre', 巨魔: 'troll',
  枭熊: 'owlbear', 狼: 'wolf', 恐狼: 'dire-wolf', 座狼: 'worg', 巨鼠: 'giant-rat', 老鼠: 'rat', 鼠群: 'swarm-of-rats',
  蝙蝠: 'bat', 巨型蝙蝠: 'giant-bat', 蝙蝠群: 'swarm-of-bats', 巨型蜘蛛: 'giant-spider', 骷髅: 'skeleton', 僵尸: 'zombie',
  食尸鬼: 'ghoul', 妖鬼: 'ghast', 尸妖: 'wight', 怨灵: 'wraith', 幽灵: 'specter', 鬼魂: 'ghost', 阴影: 'shadow',
  女妖: 'banshee', 吸血鬼: 'vampire', 巫妖: 'lich', 木乃伊: 'mummy', 豺狼人: 'gnoll', 蜥蜴人: 'lizardfolk',
  鹰身女妖: 'harpy', 石像鬼: 'gargoyle', 拟形怪: 'mimic', 凝胶怪: 'gelatinous-cube', 石化蜥蜴: 'basilisk', 鸡蛇: 'cockatrice',
  牛头人: 'minotaur', 九头蛇: 'hydra', 蝎狮: 'manticore', 奇美拉: 'chimera', 狮鹫: 'griffon', 鹰头马: 'hippogriff',
  双足飞龙: 'wyvern', 红龙幼龙: 'red-dragon-wyrmling', 青年红龙: 'young-red-dragon', 成年红龙: 'adult-red-dragon',
  远古红龙: 'ancient-red-dragon', 狼人: 'werewolf', 鼠人: 'wererat', 巨型蜈蚣: 'giant-centipede', 强盗: 'bandit',
  强盗头子: 'bandit-captain', 暴徒: 'thug', 守卫: 'guard', 邪教徒: 'cultist', 邪教狂信徒: 'cult-fanatic', 侍僧: 'acolyte',
  祭司: 'priest', 法师: 'mage', 老兵: 'veteran', 骑士: 'knight', 平民: 'commoner', 贵族: 'noble', 斥候: 'scout',
  间谍: 'spy', 刺客: 'assassin', 狂战士: 'berserker', 角斗士: 'gladiator', 棕熊: 'brown-bear', 黑熊: 'black-bear',
  北极熊: 'polar-bear', 野猪: 'boar', 巨型野猪: 'giant-boar', 小鬼: 'imp', 夸塞魔: 'quasit', 地狱犬: 'hell-hound',
  锈怪: 'rust-monster', 赭色软泥怪: 'ochre-jelly', 黑布丁: 'black-pudding', 灰泥怪: 'gray-ooze', 吸血蝠: 'stirge',
  山丘巨人: 'hill-giant', 石巨人: 'stone-giant', 霜巨人: 'frost-giant', 火巨人: 'fire-giant', 变形怪: 'doppelganger',
  美杜莎: 'medusa', 鱼人: 'merfolk', 沙华鬼: 'sahuagin', 鬼火: 'will-o-wisp', 树精: 'dryad', 树人: 'treant',
  独角兽: 'unicorn', 掘地虫: 'ankheg', 地鲨: 'bulette', 腐肉爬虫: 'carrion-crawler', 暗幔怪: 'darkmantle',
  怯魔: 'dretch', 劣魔: 'lemure', 活化盔甲: 'animated-armor', 飞剑: 'flying-sword', 窒息毯: 'rug-of-smothering',
  鳄鱼: 'crocodile', 巨型青蛙: 'giant-frog', 巨蟾蜍: 'giant-toad', 毒蛇: 'poisonous-snake', 巨型毒蛇: 'giant-poisonous-snake',
  巨蟒: 'constrictor-snake', 獒犬: 'mastiff', 巨鹰: 'giant-eagle', 战马: 'warhorse', 骑乘马: 'riding-horse',
  灰矮人: 'duergar', 卓尔: 'drow', 食人魔僵尸: 'ogre-zombie', 牛头人骷髅: 'minotaur-skeleton',
};

/** 常用法术中文名 → SRD index */
export const SRD_SPELL_ZH: Record<string, string> = {
  火焰箭: 'fire-bolt', 圣火术: 'sacred-flame', 魔能爆: 'eldritch-blast', 魔法飞弹: 'magic-missile', 疗伤术: 'cure-wounds',
  治愈真言: 'healing-word', 光导箭: 'guiding-bolt', 祝福术: 'bless', 护盾术: 'shield', 法师护甲: 'mage-armor',
  睡眠术: 'sleep', 雷鸣波: 'thunderwave', 燃烧之手: 'burning-hands', 魅惑人类: 'charm-person', 侦测魔法: 'detect-magic',
  妖火: 'faerie-fire', 猎人印记: 'hunters-mark', 命令术: 'command', 庇护术: 'sanctuary', 信仰护盾: 'shield-of-faith',
  致伤术: 'inflict-wounds', 颤栗之触: 'chill-touch', 冷冻射线: 'ray-of-frost', 电爪: 'shocking-grasp', 光亮术: 'light',
  法师之手: 'mage-hand', 魔法伎俩: 'prestidigitation', 次级幻象: 'minor-illusion', 恶言相加: 'vicious-mockery',
  神导术: 'guidance', 抗性术: 'resistance', 奇术: 'thaumaturgy', 维生术: 'spare-the-dying', 毒气喷溅: 'poison-spray',
  酸液飞溅: 'acid-splash', 燃火术: 'produce-flame', 橡棍术: 'shillelagh', 德鲁伊伎俩: 'druidcraft', 纠缠术: 'entangle',
  云雾术: 'fog-cloud', 神莓术: 'goodberry', 七彩喷射: 'color-spray', 易容术: 'disguise-self', 羽落术: 'feather-fall',
  鉴定术: 'identify', 大步奔行: 'longstrider', 通晓语言: 'comprehend-languages', 塔莎狂笑术: 'hideous-laughter',
  英雄气概: 'heroism', 神恩: 'divine-favor', 防护善恶: 'protection-from-evil-and-good', 灼热射线: 'scorching-ray',
  人类定身术: 'hold-person', 迷踪步: 'misty-step', 隐形术: 'invisibility', 灵体武器: 'spiritual-weapon',
  治疗祷言: 'prayer-of-healing', 次级复原术: 'lesser-restoration', 援助术: 'aid', 黑暗术: 'darkness', 蛛网术: 'web',
  粉碎音波: 'shatter', 沉默术: 'silence', 暗示术: 'suggestion', 月华之光: 'moonbeam', 炽焰法球: 'flaming-sphere',
  朦胧术: 'blur', 镜影术: 'mirror-image', 敲击术: 'knock', 强化属性: 'enhance-ability', 识破隐形: 'see-invisibility',
  行动无踪: 'pass-without-trace', 尖刺丛生: 'spike-growth', 树肤术: 'barkskin', 火球术: 'fireball', 闪电束: 'lightning-bolt',
  法术反制: 'counterspell', 解除魔法: 'dispel-magic', 飞行术: 'fly', 加速术: 'haste', 回生术: 'revivify',
  灵体卫士: 'spirit-guardians', 群体治愈真言: 'mass-healing-word', 催眠图纹: 'hypnotic-pattern', 恐惧术: 'fear',
  召雷术: 'call-lightning', 缓慢术: 'slow', 臭云术: 'stinking-cloud', 雨夹雪: 'sleet-storm', 操纵死尸: 'animate-dead',
  降咒: 'bestow-curse', 移除诅咒: 'remove-curse', 昼明术: 'daylight', 巧言术: 'tongues', 水下呼吸: 'water-breathing',
  放逐术: 'banishment', 变形术: 'polymorph', 高等隐形术: 'greater-invisibility', 火墙术: 'wall-of-fire', 冰风暴: 'ice-storm',
  任意门: 'dimension-door', 枯萎术: 'blight', 防死结界: 'death-ward', 行动自如: 'freedom-of-movement', 石肤术: 'stoneskin',
  寒冰锥: 'cone-of-cold', 死者复活: 'raise-dead', 群体疗伤术: 'mass-cure-wounds', 焰击术: 'flame-strike',
  怪物定身术: 'hold-monster', 力场墙: 'wall-of-force', 死云术: 'cloudkill',
};

/** 比较用的键：小写，去掉空格、连字符、撇号等一切非字母数字（中文保留） */
export function srdKey(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

/** 带相邻交换的编辑距离（OSA）：fierball → fireball 算 1 */
export function editDistance(a: string, b: string): number {
  const A = [...a];
  const B = [...b];
  const d: number[][] = Array.from({ length: A.length + 1 }, (_, i) => [i, ...Array<number>(B.length).fill(0)]);
  for (let j = 1; j <= B.length; j++) d[0]![j] = j;
  for (let i = 1; i <= A.length; i++) {
    for (let j = 1; j <= B.length; j++) {
      const cost = A[i - 1] === B[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && A[i - 1] === B[j - 2] && A[i - 2] === B[j - 1]) v = Math.min(v, d[i - 2]![j - 2]! + 1);
      d[i]![j] = v;
    }
  }
  return d[A.length]![B.length]!;
}

const CJK = /\p{Script=Han}/u;

/** 能容忍的编辑距离：中文字少、一个字差别就大，放得更紧 */
function tolerance(key: string): number {
  const n = [...key].length;
  if (CJK.test(key)) return n <= 2 ? 0 : (n <= 4 ? 1 : 2);
  return n <= 4 ? 1 : (n <= 8 ? 2 : 3);
}

/** 分数越小越像；undefined = 不算候选 */
function score(query: string, candidate: string): number | undefined {
  if (query === candidate) return 0;
  const d = editDistance(query, candidate);
  // 包含关系（「火球」⊂「火球术」、red dragon ⊂ adult red dragon）：按多出来的长度轻微加罚，排在同距离的拼写错误之后
  const contains = [...query].length >= (CJK.test(query) ? 2 : 3) && candidate.includes(query)
    ? 1 + Math.min(0.9, ([...candidate].length - [...query].length) / 10)
    : undefined;
  const typo = d <= tolerance(query) ? d : undefined;
  if (typo === undefined) return contains;
  return contains === undefined ? typo : Math.min(typo, contains);
}

const MAX_CANDIDATES = 8;

/**
 * 纯函数：query → index。list 是 SRD 全量索引（可能拿不到，传空），zh 是中文名表。
 * 最优候选比第二名好出 0.5 以上才直接用，否则列候选。
 */
export function resolveSrdQuery(query: string, list: readonly SrdEntry[], zh: Readonly<Record<string, string>>): SrdResolution {
  const key = srdKey(query);
  if (key === '') return { kind: 'none' };
  const pool: SrdEntry[] = [...list, ...Object.entries(zh).map(([name, index]) => ({ index, name }))];
  for (const e of pool) {
    if (srdKey(e.index) === key || srdKey(e.name) === key) return { kind: 'exact', index: e.index };
  }
  const best = new Map<string, { entry: SrdEntry; score: number }>();
  for (const e of pool) {
    const s = Math.min(score(key, srdKey(e.index)) ?? Infinity, score(key, srdKey(e.name)) ?? Infinity);
    if (s === Infinity) continue;
    const prev = best.get(e.index);
    // 同一个 index 有中英两个名字时保留分数更低的，展示时英文名优先（模型拿去查的是 index）
    if (prev === undefined || s < prev.score) best.set(e.index, { entry: prev?.entry ?? e, score: s });
  }
  const ranked = [...best.values()].sort((a, b) => a.score - b.score || a.entry.index.localeCompare(b.entry.index));
  if (ranked.length === 0) return { kind: 'none' };
  const [first, second] = ranked;
  if (second === undefined || second.score - first!.score >= 0.5) {
    return { kind: 'fuzzy', index: first!.entry.index, matched: first!.entry.name };
  }
  return { kind: 'ambiguous', candidates: ranked.slice(0, MAX_CANDIDATES).map((r) => r.entry) };
}

export function zhTable(kind: SrdKind): Readonly<Record<string, string>> {
  return kind === 'spells' ? SRD_SPELL_ZH : SRD_MONSTER_ZH;
}

export function candidatesText(query: string, candidates: readonly SrdEntry[]): string {
  return `「${query}」有几个可能：${candidates.map((c) => (c.name === c.index ? c.index : `${c.index}（${c.name}）`)).join('、')}。用其中一个 index 再查。`;
}
