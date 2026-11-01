/**
 * 跑团进行中写笔记时的 DM 机密兜底检查。纯函数，不依赖宿主，便于单测。
 *
 * 笔记会被自动注入到之后的消息前面，只标「可能相关」，模型很容易当成玩家已知的信息念出来；
 * 而团况注入里的 DM 笔记是明确标了「勿念」的。所以开团时不让机密落进笔记。
 *
 * 只拦「几乎不可能是玩家已知」的写法：DC 数值、点名 DM 笔记/机密、怪物的 HP/AC 数值。
 * 「暗门」「伏击」这类词不拦——发现之后就是玩家已知的，拦了误伤太多；玩家角色的 HP/AC 照常可记。
 */

const DC_PATTERN = /\bDC\s*[:：=]?\s*\d+/i;
const DM_ONLY_PATTERN = /DM\s*(?:笔记|机密)|勿念|只给你裁定/i;
const PC_DC_PATTERN = /(?:施法|法术|豁免|力量|敏捷|体质|智力|感知|魅力)\s*DC\s*[:：=]?\s*\d+/gi;
const STAT_PATTERN = /(?:\bHP|\bAC|生命值|护甲等级)\s*[:：=]?\s*\d+/i;

/**
 * 返回拦截原因；没问题返回 undefined。
 * monsterNames：本团里怪物的名字（地精1、红标恶棍3 等），和 HP/AC 数字出现在同一行才算泄露；
 * 同行的 NPC 队友（kind=npc）不算，他们的状态玩家看得到。
 * pcNames：玩家角色的名字；点名玩家角色的行里的 DC 是法术豁免 DC 这类角色卡数值，放行。
 */
export function findDmSecret(text: string, monsterNames: readonly string[], pcNames: readonly string[] = []): string | undefined {
  if (DM_ONLY_PATTERN.test(text)) return '含有 DM 笔记/机密内容';
  // 「地精1」「地精2」去掉编号后按「地精」匹配，免得每只怪都要点名
  const monsters = [...new Set(monsterNames.map((n) => n.replace(/\s*\d+$/, '').trim()).filter((n) => n.length >= 2))];
  const pcs = pcNames.map((n) => n.trim()).filter((n) => n.length >= 2);
  for (const line of text.split(/\r?\n/)) {
    const monster = monsters.find((n) => line.includes(n));
    // 点名玩家角色、又没提怪物的行里，「施法 DC12」「魅力 DC13」这种是角色卡上的法术豁免 DC，玩家自己知道；
    // 门锁、陷阱的 DC 前面不是施法/属性词，照拦
    const aboutPc = monster === undefined && pcs.some((n) => line.includes(n));
    const checked = aboutPc ? line.replace(PC_DC_PATTERN, '') : line;
    if (DC_PATTERN.test(checked)) return '含有 DC 数值';
    if (monster !== undefined && STAT_PATTERN.test(line)) return `含有「${monster}」的 HP/AC 数值`;
  }
  return undefined;
}
