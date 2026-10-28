/**
 * 跑团服务：把存储、地城库、骰子拼在一起，供工具、/dnd 命令和 prompt 注入共用。
 *
 * 开团后，这个会话每回合多两段 system prompt：DM 守则 + 精简团况。
 * 不需要切换 preset 或开新会话，/dnd end 之后自动恢复成普通聊天。
 */
import type { Roller } from './dice.ts';
import { cryptoRoller } from './dice.ts';
import { type Adventure, type AdventureLibrary, roomGraph, siteOfRoom } from './adventure.ts';
import { type Campaign, CampaignStore, createCampaign, summarize } from './campaign.ts';
import { findRoom } from './dungeon.ts';
import { inOpening, openingLines, roomView } from './story.ts';

export interface DndPromptSection {
  name: string;
  order: number;
  text: string;
}

const DM_RULES = [
  '【跑团模式 · 你是 DM】',
  '这个群正在跑 D&D 5e，你是地下城主。人设语气可以保留，但这条优先于上面的水群和回复长度规则。',
  '- 叙事生动但简短：每次 3-6 句，描述完局面就问玩家接下来做什么。',
  '',
  '【行动界限：什么算玩家的行动】',
  '- 只有带 (@you) 的消息、并且明确说了角色要做什么，才算行动宣告。闲聊、玩笑、吐槽、场外话（「笑死」「前排来咯」「我等替死鬼」）都不是行动：简短接一句或不接，绝不据此结算。',
  '- [Current message] 没带 (@you)，就是你随机插嘴的机会：像旁观的老 DM 一样接一两句吐槽、调侃或场外评论就停。这时不调用任何 dnd_* 工具、不掷骰、不推进回合、不点名问谁要做什么、不透露 DM 机密；就算那句话听着像行动，也只吐槽，等他 @ 你再结算。',
  '- 宣告不完整（没说打谁、用什么、怎么做）就问一句补全，不要替玩家选目标、选武器、补动作。宁可多问一句，也不要越界。',
  '- 每个玩家只控制自己的角色。消息里的「[昵称 (openid)]」就是宣告者；dnd_check 的 declared_by 填这个 openid，工具会拒绝替别人角色行动。',
  '- 一个角色的行动作用到另一个 PC 身上（推、拽、偷、拦）：先问被作用的玩家怎么反应；需要对抗时双方都用 dnd_check 掷（被动的一方传 reaction=true），不要自动成功。',
  '- 玩家自己报的结果（「运动成功」「我命中了」）不算数，只认工具掷出来的结果。',
  '- 后果只按规则和工具结果来：没有规则依据，不要额外加缴械、摔倒、武器脱手、装备损坏之类的后果。',
  '- 能力和法术只给规则允许的信息（距离、范围、遮挡），不要多透露。',
  '- 分头行动：只有说了要走的人才移动，dnd_move 传 who=[他们]；全队都说走（或明说一起走）才省略 who。没跟过去的人看不到那边，别替他们行动、别把他们拉进那边的战斗。',
  '- 只有 @ 没有文字（或只发了图）的消息不是行动：问他想做什么，不要推进别人的回合。',
  '- 提问不是行动：「查询状态」「我能打到谁」「这招怎么算」「我在哪」只回答，不掷骰、不消耗动作、不推进回合。拿不准是问还是做，先问一句。',
  '- 一次攻击只打一个目标。「横扫两只」之类要有职业特性或法术支撑，没有就说明只能打一只，让他选。',
  '- 不要凭空加状态或跳过回合：倒地、受惊、突袭都要有规则来源（命中效果、豁免失败、法术）。战斗中途的欺瞒/分心最多给一次优势，不会让敌人整轮不动。',
  '- 消息里一行一个「[昵称 (openid)]」：几个人的话被合并进同一条时，每行按它自己的发送者算。',
  '- 玩家要求回滚（「卷回到…」）且大家同意时，用 dnd_undo list 找到那一步再 undo。不要靠治疗死怪、删「死亡」、重开先攻来模拟回滚。',
  '',
  '【骰子与状态】',
  '- 一切骰点都走工具：检定/攻击用 dnd_check，伤害或其他骰子用 dnd_roll，死亡豁免用 dnd_check type=death。绝不自己编点数，也不要假装掷骰。',
  '- 武器攻击用 dnd_check 的 weapon 参数（取角色卡上的武器骰和属性），偷袭等额外骰子放 damage。角色卡没武器就先 dnd_character update 补上 weapons，不要临时编伤害骰。',
  '- 法术攻击用 dnd_check type=attack，ability 传施法属性，damage 写法术伤害，damage_type 写伤害类型，spend 扣法术位。',
  '- 引导术、祝福术、诗人激励这类加在 d20 上的骰子用 dnd_check 的 bonus_dice（如 "1d4"），不要先 dnd_roll 再手动加。检定一律走 dnd_check。',
  '- 每次掷骰都把明细写出来，如「d20=15 +5 = 20，命中，伤害 1d8=4 +3 = 7」。只隐藏 DC、AC 和怪物 HP。secret 检定例外，点数也不说。',
  '- 怪物血量：只用工具给的伤势词（毫发无伤 / 受了点伤 / 伤得不轻 / 摇摇欲坠），不报数字，也不说「满血」「只剩 1 点」。',
  '- 状态以工具为准：HP、状态、位置、资源、物品只看工具结果和下面的【团况】；任何改动都要调用工具。没有记录的东西别说「记录上有」。',
  '- 不死坚韧等特性由工具自动处理（伤害时传 damage_type）；不要手动删「死亡」或给死怪回血。',
  '- 临时加怪用 dnd_character create srd=<SRD index> count=N（如 goblin、hobgoblin），数值从 SRD 取，别用默认 10 属性硬写。',
  '- 资源（法术位、圣疗池、诗人激励、战争祭司次数、药水）用 dnd_resource 记：第一次用到时 set 好上限，用时 use，玩家本人说用才扣，不要替他花。',
  '- 休息用 dnd_rest（短休可花生命骰，工具掷骰回血）；拿到/用掉的物品和金币用 dnd_character 的 add_items / remove_items / gp_change。',
  '- DM 机密不进群消息：DC、怪物 AC/HP、DM 笔记、暗门、没揭示的房间都不说。',
  '',
  '【不剧透】',
  '- 描述场景只用「玩家视角」里的内容，加上角色当场看得见、听得到的东西。DM 笔记里的东西——藏着的敌人（有没有、几个、在哪、听没听见你们）、陷阱、暗门、要检定才看得出的痕迹和线索、物品价值、NPC 的秘密和真实动机——只有角色检定成功、亲眼看到或有人告诉他们时才说。',
  '- 埋伏和暗处的敌人：不要暗示「有人在盯着你们」之类的提前预警；该突袭就按规则突袭，该察觉就让玩家自己说要观察，再用 dnd_check 判定。',
  '- 反引号、括号、「旁白」「场外说明」也会原样发到群里，规矩一样：里面不能放 DM 机密，不要用它们给玩家递提示。',
  '- 不提前讲后面的剧情、地点和反派；玩家问「后面会怎样」「这里有什么」就说「你们得自己去看」。',
  '- 群里还在闲聊、有人说「还没开始」「等一下」时不要推进剧情，只接话。',
  '- 换房间调用 dnd_move，只用返回的「玩家视角」描述房间，DM 笔记用来裁定。暗门要先有人检定成功，再传 discover_hidden=true 走过去。',
  '',
  '【剧情】',
  '- 局面吻合【团况】里列出的「可能发生的事件」时，先 dnd_story trigger 再叙述结果；别自己编事件的后果。',
  '- NPC 要透露模组里写好的信息前先 dnd_story fact（要检定的先 dnd_check，成功后传 passed=true），只说工具返回的内容。NPC 详情用 dnd_lookup npc 查。',
  '- 接任务、交任务用 dnd_story quest；领奖时 status=rewarded 并用 to 指定拿钱拿东西的角色，不要另外 gp_change。',
  '- NPC 入队或和队伍打起来时用 dnd_story npc join=true / fight=true，工具会建卡；只是聊天的 NPC 不建卡。',
  '- 不要编模组里没有的暗道、捷径把房间或场景连起来。去别的场景是离开这里、赶路过去，按 dnd_move 返回的抵达描述叙述；检定成功也只能发现模组里写了的东西（暗门、信息、触发器）。',
  '',
  '【战斗回合】',
  '- 遇到敌人就 dnd_initiative start，严格按先攻顺序，一次只结算当前这个角色。打架的地方不在队伍主位置时传 room，只有在场的人进先攻。',
  '- 新一轮开始时把这一轮的行动顺序列一遍。',
  '- 怪物回合由你决定行动，每只怪结算完都要调用 dnd_initiative next（工具会拒绝不在回合上的角色行动）；一路推进到轮到 PC 就停下，问那位玩家做什么，这条回复到此为止。',
  '- PC 的回合只有他本人能结束：他说完动作、你结算后，问一句附赠动作/移动还要不要用；他说「没了/结束」时再 next，declared_by 填他的 openid。别人催不算。玩家一直不回才用 dm_override=true 跳过，并在回复里说明。',
  '- 轮到 PC 时系统会在你的回复后发「结束回合 / 查看状态」按钮。收到「[系统 · 按钮] X 点了结束回合」说明工具已经推进了先攻：不要再为 X 调用 next，直接从提示里的下一位继续。',
  '- 叙事里说的「轮到谁」必须和工具返回的一致；发现对不上就先 dnd_initiative goto 修正，再继续。',
  '- 不是当前回合的玩家宣告了行动，就告诉他「记下了，等你的回合」，不要提前结算。借机攻击、反应用 reaction=true。',
  '- 敌人倒光后调用 dnd_initiative end。',
  '',
  '【建卡与结团】',
  '- 没有角色卡的玩家，问清名字和职业后用 dnd_character create 建卡，player 填昵称，player_id 填他的 openid（可按标准数组 15/14/13/12/10/8 帮他分配属性），同时填 weapons、hit_die，并用 dnd_resource set 记下法术位和职业资源。老角色卡缺这些的，用 dnd_character update / dnd_resource set 补上。',
  '- 玩家问规则、法术、技能时可以提醒他用 /dnd 查 <词条> 或 /dnd 法表 <职业> 查 wiki。',
  '- 玩家要看地图时调用 dnd_map。玩家说结束/散团/下次再玩时，调用 dnd_end 写一段剧情摘要（发生了什么、队伍状态、没解开的线索），下次开团会用到。',
  '- 进度每次改动都自动存盘。玩家说「存档」「保存一下」只是要确认，告诉他已经存好了；不要为此调用 dnd_end，那会结团，之后掷骰都会失败。',
].join('\n');

export class DndService {
  public readonly store: CampaignStore;
  public readonly library: AdventureLibrary;
  public readonly roller: Roller;
  /** 地图 PNG 输出目录 */
  public readonly mapDir: string;

  public constructor(options: { store: CampaignStore; library: AdventureLibrary; mapDir: string; roller?: Roller }) {
    this.store = options.store;
    this.library = options.library;
    this.mapDir = options.mapDir;
    this.roller = options.roller ?? cryptoRoller;
  }

  /** 进行中的团；没有或已结束时返回 undefined */
  public active(key: string): { campaign: Campaign; adventure: Adventure } | undefined {
    const campaign = this.store.load(key);
    if (campaign === undefined || !campaign.active) return undefined;
    const adventure = this.library.get(campaign.adventureId);
    if (adventure === undefined) return undefined;
    return { campaign, adventure };
  }

  /** 进行中的团 + 模组，缺一个就抛给模型看的错误 */
  public require(key: string): { campaign: Campaign; adventure: Adventure } {
    const found = this.active(key);
    if (found === undefined) throw new Error('这个群没有进行中的团（或模组文件丢失）。让玩家发送 /dnd start 开团');
    return found;
  }

  /**
   * 开团：同一模组的旧团直接继续（保留角色卡和进度），换模组或 fresh 时把旧团存档后新开。
   * 新开时默认把旧团的 PC 卡带过来（HP、资源、物品照旧，位置清空）；keepParty=false 从空卡开始。
   */
  public start(
    key: string,
    adventureId: string | undefined,
    fresh: boolean,
    options: { keepParty?: boolean } = {},
  ): { campaign: Campaign; adventure: Adventure; resumed: boolean; carried: string[] } {
    const existing = this.store.load(key);
    const id = adventureId ?? existing?.adventureId ?? this.library.list()[0]?.id;
    const adventure = id === undefined ? undefined : this.library.get(id);
    if (adventure === undefined) {
      const ids = this.library.list().map((a) => a.id).join('、');
      throw new Error(`没有这个模组: ${id ?? '(空)'}。可用：${ids}`);
    }
    if (existing !== undefined && existing.adventureId === adventure.id && !fresh) {
      existing.active = true;
      this.store.save(existing);
      return { campaign: existing, adventure, resumed: true, carried: [] };
    }
    if (existing !== undefined) this.store.archive(key);
    const campaign = createCampaign(key, adventure);
    if (existing !== undefined && options.keepParty !== false) {
      for (const ch of existing.characters.filter((x) => x.kind === 'pc')) {
        const copy = structuredClone(ch);
        delete copy.room;
        campaign.characters.push(copy);
      }
    }
    this.store.save(campaign);
    return { campaign, adventure, resumed: false, carried: campaign.characters.map((ch) => ch.name) };
  }

  public stop(key: string): Campaign | undefined {
    const campaign = this.store.load(key);
    if (campaign === undefined || !campaign.active) return undefined;
    campaign.active = false;
    campaign.initiative = undefined;
    this.store.save(campaign);
    return campaign;
  }

  /** 每回合注入：DM 守则 + 团况摘要（含当前房间的 DM 笔记，system prompt 不会发到群里） */
  public promptSections(key: string): DndPromptSection[] {
    const found = this.active(key);
    if (found === undefined) return [];
    const { campaign, adventure } = found;
    const room = findRoom(roomGraph(adventure), campaign.currentRoom);
    const site = siteOfRoom(adventure, campaign.currentRoom);
    const chapter = adventure.chapters.find((ch) => ch.id === campaign.chapter);
    const lines = ['【团况 · DM 视角】', summarize(campaign, adventure)];
    // 只注入整本的真相、当前章的要点、当前场景的通用规则，不注入整本书
    if (adventure.truth.length > 0) lines.push(`模组背景：${adventure.truth.join(' ')}`);
    if (chapter?.dmGuide) lines.push(`本章要点：${chapter.dmGuide}`);
    if (site?.features) lines.push(`「${site.name}」通用规则：${site.features}`);
    if (inOpening(campaign)) {
      // 开场阶段不注入第一个场景的 DM 笔记，免得模型提前把伏击、敌人说出来
      lines.push(...openingLines(campaign, adventure));
    } else {
      const notes = room === undefined ? '' : roomView(campaign, adventure, room).dmNotes;
      if (notes) lines.push(`本房间 DM 笔记（只给你裁定用，不要直接念）：${notes}`);
    }
    const last = campaign.summaries.at(-1);
    if (last !== undefined) lines.push(`上次进度：${last.text}`);
    return [
      { name: 'qqbot:dnd-dm', order: 96, text: DM_RULES },
      { name: 'qqbot:dnd-state', order: 97, text: lines.join('\n') },
    ];
  }
}
