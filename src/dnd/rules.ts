/**
 * 5e 规则的最小子集：属性调整值、熟练加值、技能 → 属性映射。
 * 中英文名都能识别，模型传「察觉」「perception」都行。
 */

export const ABILITIES = ['str', 'dex', 'con', 'int', 'wis', 'cha'] as const;
export type Ability = typeof ABILITIES[number];

export const ABILITY_NAMES: Record<Ability, string> = {
  str: '力量', dex: '敏捷', con: '体质', int: '智力', wis: '感知', cha: '魅力',
};

export const SKILLS = {
  athletics: { ability: 'str', name: '运动' },
  acrobatics: { ability: 'dex', name: '体操' },
  sleight_of_hand: { ability: 'dex', name: '巧手' },
  stealth: { ability: 'dex', name: '隐匿' },
  arcana: { ability: 'int', name: '奥秘' },
  history: { ability: 'int', name: '历史' },
  investigation: { ability: 'int', name: '调查' },
  nature: { ability: 'int', name: '自然' },
  religion: { ability: 'int', name: '宗教' },
  animal_handling: { ability: 'wis', name: '驯兽' },
  insight: { ability: 'wis', name: '洞悉' },
  medicine: { ability: 'wis', name: '医药' },
  perception: { ability: 'wis', name: '察觉' },
  survival: { ability: 'wis', name: '求生' },
  deception: { ability: 'cha', name: '欺瞒' },
  intimidation: { ability: 'cha', name: '威吓' },
  performance: { ability: 'cha', name: '表演' },
  persuasion: { ability: 'cha', name: '游说' },
} as const satisfies Record<string, { ability: Ability; name: string }>;
export type Skill = keyof typeof SKILLS;

export function abilityModifier(score: number): number {
  return Math.floor((score - 10) / 2);
}

export function proficiencyBonus(level: number): number {
  return 2 + Math.floor((Math.max(1, level) - 1) / 4);
}

function normalizeKey(input: string): string {
  return input.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

/** 「力量」「str」「Strength」→ str */
export function parseAbility(input: string): Ability | undefined {
  const key = normalizeKey(input);
  for (const ability of ABILITIES) {
    if (key === ability || ABILITY_NAMES[ability] === input.trim()) return ability;
  }
  const full: Record<string, Ability> = {
    strength: 'str', dexterity: 'dex', constitution: 'con', intelligence: 'int', wisdom: 'wis', charisma: 'cha',
  };
  return full[key];
}

/** 其他常见中文译名（各版本规则书和模组译法不一） */
const SKILL_ALIASES: Record<string, Skill> = {
  生存: 'survival',
  潜行: 'stealth',
  杂技: 'acrobatics',
  特技: 'acrobatics',
  手上功夫: 'sleight_of_hand',
  奥术: 'arcana',
  侦查: 'investigation',
  驯养动物: 'animal_handling',
  动物驯养: 'animal_handling',
  洞察: 'insight',
  医疗: 'medicine',
  侦察: 'perception',
  欺骗: 'deception',
  恐吓: 'intimidation',
  说服: 'persuasion',
};

/** 「察觉」「perception」「Sleight of Hand」→ skill key */
export function parseSkill(input: string): Skill | undefined {
  const key = normalizeKey(input);
  if (key in SKILLS) return key as Skill;
  const trimmed = input.trim();
  for (const [skill, info] of Object.entries(SKILLS)) {
    if (info.name === trimmed) return skill as Skill;
  }
  return SKILL_ALIASES[trimmed];
}

export function skillLabel(skill: Skill): string {
  return SKILLS[skill].name;
}
