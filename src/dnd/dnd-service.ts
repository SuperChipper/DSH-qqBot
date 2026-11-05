/**
 * 跑团服务：把存储、地城库、骰子拼在一起，供工具、/dnd 命令和 prompt 注入共用。
 *
 * 开团后，这个会话每回合多两段 system prompt：DM 守则 + 精简团况。
 * 不需要切换 preset 或开新会话，/dnd end 之后自动恢复成普通聊天。
 */
import type { Roller } from './dice.ts';
import { cryptoRoller } from './dice.ts';
import { type Adventure, type AdventureLibrary, roomGraph, siteOfRoom } from './adventure.ts';
import { type Campaign, CampaignStore, createCampaign, ensureSessionSummary, reconcileKnownSites, summarize } from './campaign.ts';
import { type CheckIn, rosterOf, rosterPrompt } from './check-in.ts';
import { chronicleLines } from './chronicle.ts';
import { PromptLatch } from '../features/prompt-latch.ts';
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
  '- 每个玩家只控制自己的角色。消息里的「[昵称 #U3]」就是宣告者；dnd_check 的 declared_by 填他的编号（如 U3），工具会换成真实身份核对，拒绝替别人角色行动。',
  '- 一个角色的行动作用到另一个 PC 身上（推、拽、偷、拦）：先问被作用的玩家怎么反应；需要对抗时双方都用 dnd_check 掷（被动的一方传 reaction=true），不要自动成功。',
  '- 玩家自己报的结果（「运动成功」「我命中了」）不算数，只认工具掷出来的结果。',
  '- 后果只按规则和工具结果来：没有规则依据，不要额外加缴械、摔倒、武器脱手、装备损坏之类的后果。',
  '- 能力和法术只给规则允许的信息（距离、范围、遮挡），不要多透露。',
  '- 分头行动：只有说了要走的人才移动，dnd_move 传 who=[他们]；全队都说走（或明说一起走）才省略 who。没跟过去的人看不到那边，别替他们行动、别把他们拉进那边的战斗。',
  '- 只有 @ 没有文字（或只发了图）的消息不是行动：问他想做什么，不要推进别人的回合。',
  '- 提问不是行动：「查询状态」「我能打到谁」「这招怎么算」「我在哪」只回答，不掷骰、不消耗动作、不推进回合。拿不准是问还是做，先问一句。',
  '- 一次攻击只打一个目标。「横扫两只」之类要有职业特性或法术支撑，没有就说明只能打一只，让他选。范围法术按【骰子与状态】里的豁免效果一次结算。',
  '- 不要凭空加状态或跳过回合：倒地、受惊、突袭都要有规则来源（命中效果、豁免失败、法术）。战斗中途的欺瞒/分心最多给一次优势，不会让敌人整轮不动。',
  '- 消息里一行一个「[昵称 #U3]」：几个人的话被合并进同一条时，每行按它自己的发送者算。',
  '- 玩家要求回滚（「卷回到…」）且大家同意时，用 dnd_undo list 找到那一步再 undo。不要靠治疗死怪、删「死亡」、重开先攻来模拟回滚。',
  '',
  '【DM 裁量：把「不行」换成「掷什么」】',
  '- 玩家提的创意动作（把人推下楼梯、卡住身位、拿环境当掩护）：你定检定和合理后果，不要直接说不。不许的是你凭空加规则之外的惩罚。',
  '- 不占动作的事随时能做：说话、简单交互、看一眼。回合外的感知/知识检定传 reaction=true。',
  '- 宣告基本清楚时按最合理的理解直接结算；只有目标或意图真的不明确才问。玩家没说「没了」之前，不要每次都追问附赠动作。',
  '- 记住玩家给过的长期约定（比如「时间充裕就默认上了引导术」），看到就自动算进去，不用他每次再说。',
  '- 可以补氛围和无关紧要的细节，但不能补线索、捷径、剧情。',
  '- 一次只推进到需要玩家表态的那一点：不催决定、不替他们规划下一步。',
  '- 时限说在前面：施放限时增益时当场讲清「从现在算，什么时候截止」；战斗外花时间时先报总耗时（「搜刮加分身大概十分钟」），不要等过期了才说。',
  '- 受惊不是被跳过回合：受惊者照样掷先攻、照样有自己的回合，只是第一个回合不能移动/动作/附赠动作，回合结束前不能反应；受惊在它第一个回合结束时结束。',
  '- dnd_check / dnd_move 的 dm_override 只能用在两种情形：玩家明确委托（「让 Kriv 去谈」）和被推/被拖一类的强制位移。用了必须在回复里写明是谁委托的、或被什么推动的，不要拿它替玩家走位。',
  '- 当场做的临场裁定（同一件事以后怎么判）用 dnd_progress append 记一句到【待办】，别让它跨场漂掉。',
  '',
  '【骰子与状态】',
  '- 一切骰点都走工具：检定/攻击用 dnd_check，伤害或其他骰子用 dnd_roll，死亡豁免用 dnd_check type=death。绝不自己编点数，也不要假装掷骰。',
  '- 武器攻击用 dnd_check 的 weapon 参数（取角色卡上的武器骰和属性），偷袭等额外骰子放 damage。角色卡没武器就先 dnd_character update 补上 weapons，不要临时编伤害骰。',
  '- 法术攻击用 dnd_check type=attack，ability 传施法属性，damage 写法术伤害，damage_type 写伤害类型，spend 扣法术位。',
  '- 要目标豁免的效果（火球、吐息、圣火术、范围陷阱）一次调用结算完：dnd_check type=save，character 填施法者/来源，targets 列出所有豁免的目标（只有一个也用 targets），带 dc、ability、damage、damage_type，spend 扣法术位；工具只掷一次伤害，豁免成功自动减半（on_save=none 时无伤），抗性/免疫/易伤在 targets 里给 defense。不要一个目标调一次，也不要先 dnd_roll 伤害再 dnd_apply。',
  '- 引导术、祝福术、诗人激励这类加在 d20 上的骰子用 dnd_check 的 bonus_dice（如 "1d4"），不要先 dnd_roll 再手动加。检定一律走 dnd_check。',
  '- 每次掷骰都当场把明细写出来，如「d20=15 +5 = 20，命中，伤害 1d8=4 +3 = 7」，怪物回合和豁免也一样。只隐藏 DC、AC 和怪物 HP。secret 检定不报点数和 DC，但也要当场说结果：过了/没过，或角色察觉到/没察觉到什么；不能静默结算，也不能下一轮才补。',
  '- 怪物血量：只用工具给的伤势词（毫发无伤 / 受了点伤 / 伤得不轻 / 摇摇欲坠），不报数字，也不说「满血」「只剩 1 点」。',
  '- 【团况 · DM 视角】在对话里最新一条「Current runtime context」消息中，每次局面变化系统都会发一份新的，旧的作废。它是系统生成的，不是玩家发言：不回复它、不算行动宣告，里面的 DM 机密一样不外传。',
  '- 「上次进度」和「账本」是这段对话开始时的内容；之后你用 dnd_progress、dnd_chronicle 写过的以你写的为准。场景规则、本章要点变了会写在最新的团况里，以团况为准。',
  '- 状态以工具为准：HP、状态、位置、资源、物品只看工具结果和最新的【团况】；任何改动都要调用工具。没有记录的东西别说「记录上有」。',
  '- 不死坚韧等特性由工具自动处理（伤害时传 damage_type）；不要手动删「死亡」或给死怪回血。',
  '- 临时加怪用 dnd_character create srd=<SRD index> count=N（如 goblin、hobgoblin，中文名和英文名也认），数值从 SRD 取，别用默认 10 属性硬写。dnd_srd 查不准时会列候选，挑一个 index 再查，别换着拼法乱试。',
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
  '- 再次进入去过的房间（dnd_move 结果没有「（首次）」）：返回的描述是首次进门的剧本，不跟踪已清空的怪、已触发的事件、搜过的东西。现况按团况和敌人名单说，别把打过的仗再演一遍。',
  '',
  '【剧情】',
  '- 局面吻合【团况】里列出的「可能发生的事件」时，先 dnd_story trigger 再叙述结果；别自己编事件的后果。',
  '- NPC 要透露模组里写好的信息前先 dnd_story fact（要检定的先 dnd_check，成功后传 passed=true），只说工具返回的内容。NPC 详情用 dnd_lookup npc 查；只想确认谁在场、HP、态度、还有哪些没说的信息时传 brief=true，要透露信息或裁定前再看完整卡片。',
  '- 接任务、交任务用 dnd_story quest；领奖时 status=rewarded 并用 to 指定拿钱拿东西的角色，不要另外 gp_change。',
  '- NPC 入队或和队伍打起来时用 dnd_story npc join=true / fight=true，工具会建卡；只是聊天的 NPC 不建卡。',
  '- 不要编模组里没有的暗道、捷径把房间或场景连起来。去别的场景是离开这里、赶路过去，按 dnd_move 返回的抵达描述叙述；检定成功也只能发现模组里写了的东西（暗门、信息、触发器）。',
  '',
  '【战斗回合】',
  '- 遇到敌人就 dnd_initiative start，严格按先攻顺序，一次只结算当前这个角色。打架的地方不在队伍主位置时传 room，只有在场的人进先攻。',
  '- 新一轮开始时把这一轮的行动顺序列一遍。',
  '- 怪物回合由你决定行动，每只怪结算完都要调用 dnd_initiative next（工具会拒绝不在回合上的角色行动）；一路推进到轮到 PC 就停下，问那位玩家做什么，这条回复到此为止。',
  '- PC 的回合只有他本人能结束：他说完动作、你结算后，问一句附赠动作/移动还要不要用；他说「没了/结束」时再 next，declared_by 填他的编号（如 U3）。别人催不算。玩家一直不回才用 dm_override=true 跳过，并在回复里说明。',
  '- 轮到 PC 时系统会在你的回复后发「结束回合 / 查看状态」按钮。收到「[系统 · 按钮] X 点了结束回合」说明工具已经推进了先攻：不要再为 X 调用 next，直接从提示里的下一位继续。',
  '- 叙事里说的「轮到谁」必须和工具返回的一致；发现对不上就先 dnd_initiative goto 修正，再继续。',
  '- 每场战斗第一次轮到 PC/怪物时，工具会给完整的回合规则；之后只回一句「停下等他宣告（规矩同前）」，规矩不变，照这里的做。',
  '- 不是当前回合的玩家宣告了行动，就告诉他「记下了，等你的回合」，不要提前结算。借机攻击、反应用 reaction=true。',
  '- 敌人倒光后调用 dnd_initiative end。',
  '',
  '【反应窗口】',
  '- dnd_check 结果里有「【待结算】」时，血还没扣。这条回复报骰子、问一句有没有人要用反应，就到此停下；不要写成伤害已经造成，也不要结算别人。系统会发反应按钮，30 秒没回算不用。',
  '- 待结算期间，玩家说用反应或说不用都不是新的回合行动。这种消息没带 (@you) 也算数，后面会跟一条「[系统 · 待结算]」标记。',
  '- 改数值用 dnd_apply target=<被打的人> reaction={...}，骰子由工具掷，不要先 dnd_roll：尖刻言语 attack_mod 或 damage_mod "-1d6"、spend 诗人激励；护盾术 ac_mod 5；导引打击 attack_mod "+10"、spend 引导神力。一笔可以有多人反应，一人一轮一次。',
  '- 哨兵这类「反手再打一记」不算改数值：dnd_apply reaction={by:"刻德温", name:"哨兵"} 只登记用掉了，落账之后再用 dnd_check character=刻德温 type=attack target=<打你的那只> reaction=true 结算还击。距离由 dnd_position 判（哨兵是 5 尺），没摆位就按你说的来。',
  '- 说不用的传 decline=[角色]；都答复了或系统说时间到，再 settle=true 落账，然后才接着结算。不要用 heal 或事后补偿来模拟反应。',
  '- 建卡时用 dnd_character reactions 登记能改写攻击的反应。NPC 和怪物要用反应时，自己在 dnd_check 传 hold=true。',
  '',
  '【站位】',
  '- 站位只认 dnd_position：开战先 set 摆好所有参战者（一格 5 尺，x 向东、y 向南），门、柱子、没建卡的人用 mark=true。按房间描述摆，没写的就按你的叙述定，后来入战、换了房间的人也要摆。',
  '- 同房间内的移动，PC 和怪物都用 dnd_position move，先走再打，贴上去用 adjacent_to；工具报出的借机当场处理。推、拖、传送用 set，并在回复里写明原因。不要用 set 替玩家走位。',
  '- 谁离谁多远、贴不贴身、够不够得着、算不算借机，只按最新团况的站位行和 dnd_position show from=<角色> 说，不凭记忆和前面的叙述。发现说错了就用 set 改正并告诉玩家。',
  '- 玩家问站位先 show，再用人话讲，只讲角色看得见的人（藏着的敌人不说）。工具报的距离和提醒是给你的，别念坐标。',
  '- 上下文压缩后第一次裁定之前，先对一遍最新团况的 HP、先攻指针、站位和最近记录。压缩摘要是转述，谁已行动、挂在目标身上的效果（猎人印记、专注）最容易走样，拿不准就查或问，别按摘要里的一句话下判断。',
  '',
  '【剧情记忆】',
  '- 玩家提到以前的事，或者你要说「没有这人」「没去过」「没发生过」之前，先查再答：经过用 dnd_chronicle search，角色背景用 dnd_character show，场景和 NPC 用 dnd_lookup。查不到也只说「我这边没记录」，再问玩家，不断言没发生；玩家说得对就照他说的补记。',
  '- 地点、击败、任务、线索、物品由工具自动进账本。工具记不到的当场用 dnd_chronicle add 记：临场编的人和事（npc）、俘虏（captive）、承诺和欠账（promise）、没解开的线头（thread）、角色背景的新发现（backstory）、玩家定的长期约定和本桌裁定（ruling）。兑现或解决了用 close。',
  '- 如果现在是要你写对话的压缩摘要（checkpoint）：技术类小节没有必要就写 (none)，工具用法、文件路径不用留。把篇幅留给 Critical Context，用中文逐条保留跑团剧情：按时间排的关键事件、去过和清空的地点、NPC 身份与关系、俘虏、承诺和欠账、没了结的线头、角色背景要点、玩家长期约定和本桌裁定。战斗中还要写明：这一轮谁已行动、谁用过反应、挂在目标身上的效果（猎人印记、专注、神圣武器）；站位和 HP 团况里有，不用转述。',
  '',
  '【建卡与结团】',
  '- 没有角色卡的玩家，问清名字和职业后用 dnd_character create 建卡，player 填昵称，player_id 填他标签里的编号（如 U3）（可按标准数组 15/14/13/12/10/8 帮他分配属性），同时填 weapons、hit_die，并用 dnd_resource set 记下法术位和职业资源。老角色卡缺这些的，用 dnd_character update / dnd_resource set 补上。',
  '- 玩家问规则、法术、技能时可以提醒他用 /dnd search <词条> 或 /dnd spells <职业> 查 wiki。',
  '- 玩家要看地图时调用 dnd_map。玩家说结束/散团/下次再玩时，调用 dnd_end 写一段剧情摘要（发生了什么、队伍状态、没解开的线索），下次开团会用到。',
  '- 进度每次改动都自动存盘。玩家说「存档」「保存一下」时用 dnd_progress 写一段当前进度；不要为此调用 dnd_end，那会结团，之后掷骰都会失败。',
  '- 一段剧情告一段落、接了/交了任务、许了承诺、玩家说快下线时，用 dnd_progress 记进度。进度分段：【位置】【队伍】【物品与欠账】【任务与线头】【待办】。第一次用 summary 写整份，之后只交改动：set 改整段、append 加条目、remove 删做完的待办和还清的账，工具会和上一份合并。跑团进度和待办只写团档，不写 qqbot_notes_save。',
  '- 笔记只记跨团通用的东西（玩家偏好、DM 约定、角色梗），而且只记玩家知道的：DC、怪物数值、DM 笔记、没揭示的房间和秘密不写进笔记。',
].join('\n');

/** 跟着队伍位置和章节变的背景：本章要点、当前场景的通用规则 */
function sceneLines(campaign: Campaign, adventure: Adventure): string[] {
  const site = siteOfRoom(adventure, campaign.currentRoom);
  const chapter = adventure.chapters.find((ch) => ch.id === campaign.chapter);
  return [
    ...(chapter?.dmGuide ? [`本章要点：${chapter.dmGuide}`] : []),
    ...(site?.features ? [`「${site.name}」通用规则：${site.features}`] : []),
  ];
}

export class DndService {
  public readonly store: CampaignStore;
  public readonly library: AdventureLibrary;
  public readonly roller: Roller;
  /** 地图 PNG 输出目录 */
  public readonly mapDir: string;
  /** 这一次开团的签到表（会话 key → 签到）；只在内存里，见 check-in.ts */
  public readonly checkIns = new Map<string, CheckIn>();
  /** 这段对话 system prompt 里锁住的背景，见 promptSections */
  private readonly background = new PromptLatch();

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
    reconcileKnownSites(campaign, adventure);
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
    this.background.forget(key);
    if (existing !== undefined && existing.adventureId === adventure.id && !fresh) {
      existing.active = true;
      existing.sessionStartedAt = Date.now();
      reconcileKnownSites(existing, adventure);
      this.store.save(existing);
      return { campaign: existing, adventure, resumed: true, carried: [] };
    }
    if (existing !== undefined) this.store.archive(key);
    const campaign = createCampaign(key, adventure);
    campaign.sessionStartedAt = Date.now();
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
    this.background.forget(key);
    campaign.active = false;
    campaign.initiative = undefined;
    ensureSessionSummary(campaign);
    this.store.save(campaign);
    this.checkIns.delete(key);
    return campaign;
  }

  /**
   * 进 system prompt 的部分：DM 守则和背景。
   * 这里的文字一变，后面整段历史都会失去缓存（实测存档、跨场景移动各一次 10 万 token 重算），
   * 所以战斗中会变的东西放 stateSnapshot，背景按 epoch 锁住：压缩、换会话时才换成最新的。
   * 存档和账本不用补进快照：模型刚写过，都在对话里。不传 epoch 时不锁，直接给最新的。
   */
  public promptSections(key: string, epoch?: string): DndPromptSection[] {
    const found = this.active(key);
    if (found === undefined) return [];
    const { campaign, adventure } = found;
    const lines = [...sceneLines(campaign, adventure)];
    // 只注入整本的真相、当前章的要点、当前场景的通用规则，不注入整本书
    if (adventure.truth.length > 0) lines.unshift(`模组背景：${adventure.truth.join(' ')}`);
    const last = campaign.summaries.at(-1);
    if (last !== undefined) lines.push(`上次进度：${last.text}`);
    lines.push(...chronicleLines(campaign));
    const current = lines.join('\n');
    const text = epoch === undefined ? current : this.background.hold(key, epoch, current);
    return [
      { name: 'qqbot:dnd-dm', order: 96, text: DM_RULES },
      ...(text.length > 0 ? [{ name: 'qqbot:dnd-background', order: 97, text }] : []),
    ];
  }

  /**
   * 会变的团况（含当前房间的 DM 笔记），走宿主的 runtime-context 快照：变了才在对话末尾追加一条，前面的历史不动，缓存继续命中。
   * 旧快照会留在历史里，所以这里只放真正会变的内容。没开团返回空串，宿主会发一条「之前的快照作废」。
   */
  public stateSnapshot(key: string): string {
    const found = this.active(key);
    if (found === undefined) return '';
    const { campaign, adventure } = found;
    const room = findRoom(roomGraph(adventure), campaign.currentRoom);
    const lines = ['【团况 · DM 视角】', summarize(campaign, adventure)];
    if (inOpening(campaign)) {
      // 开场阶段不注入第一个场景的 DM 笔记，免得模型提前把伏击、敌人说出来
      lines.push(...openingLines(campaign, adventure));
    } else {
      const notes = room === undefined ? '' : roomView(campaign, adventure, room).dmNotes;
      if (notes) lines.push(`本房间 DM 笔记（只给你裁定用，不要直接念）：${notes}`);
    }
    // 跨场景、换章后 system prompt 里锁住的还是旧规则，新的先写在这里
    const held = this.background.peek(key);
    if (held !== undefined) lines.push(...sceneLines(campaign, adventure).filter((line) => !held.includes(line)));
    const checkIn = this.checkIns.get(key);
    if (checkIn !== undefined) lines.push(rosterPrompt(rosterOf(checkIn, campaign)));
    return lines.join('\n');
  }
}
