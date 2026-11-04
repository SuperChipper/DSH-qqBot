/**
 * dsh-im-qqbot 插件配置 Schema
 */
import Schema from '@deepseek-ai/schemastery';

export interface AccessControlConfig {
  /** C2C 访问模式 */
  c2cMode: 'open' | 'allowlist' | 'disabled';
  /** C2C 白名单（user openid） */
  c2cAllow: string[];
  /** 群聊访问模式 */
  groupMode: 'open' | 'allowlist' | 'disabled';
  /** 群聊白名单（group openid） */
  groupAllow: string[];
}

export interface MediaConfig {
  /** 是否启用富媒体理解（图片/视频下载 + 工具分析） */
  enabled: boolean;
  /** 富媒体下载大小上限（MB），默认 200 */
  maxMB: number;
  /** 富媒体存活时长（小时，TTL），默认 24，0 = 永不过期 */
  ttlHours: number;
  /** media 目录总量上限（MB），超出时从最旧的删，默认 1024，0 = 不限 */
  maxTotalMB?: number;
}

/** 用户自定义清理规则 */
export interface CleanupRuleConfig {
  /** 规则名（日志 / 报告用，空 = 用 dir） */
  name: string;
  /** 目录（相对路径按 cwd 解析；必须位于 cwd / 插件目录 / 系统临时目录之内） */
  dir: string;
  /** file = 每个文件单独判断；entry = 每个顶层条目整体判断（取子树最新 mtime） */
  unit: 'file' | 'entry';
  /** 超过多少小时未改动就删除（0 = 不按时间删） */
  ttlHours: number;
  /** unit=file 时是否进入子目录 */
  recursive: boolean;
  /** 永不删除的文件/条目名（支持 * ?） */
  keep: string[];
  /** 非空时只处理命中的文件/条目名 */
  match: string[];
  /** 总量上限（MB），超出从最旧的删（0 = 不限） */
  maxTotalMB: number;
}

export interface CleanupConfig {
  /** 只记日志不删除（先看看会删什么） */
  dryRun: boolean;
  /** 额外的清理规则（media / tmp / 视频工作目录是内置规则） */
  rules: CleanupRuleConfig[];
}

export interface VisionConfig {
  /** 是否启用视觉理解（qqbot_describe_image 工具） */
  enabled: boolean;
  /** 是否把图片作为原生 ImageBlock 直接交给主模型（主模型路由必须声明 image 输入） */
  native: boolean;
  /** 视觉模型 provider（dsh 注册的 llm adapter，如 pi-ai） */
  provider: string;
  /** 视觉模型 id（如 qwen-vl-max） */
  model: string;
  /** 默认描述 prompt（调用未显式指定时使用） */
  defaultPrompt: string;
  /** 图片字节上限，默认 10MB */
  maxBytes: number;
  /** 输出 token 上限 */
  maxTokens: number;
  /** 视觉调用超时(ms) */
  timeoutMs: number;
}

export interface VideoConfig {
  /** 是否注册 qqbot_describe_video（需 vision 已配置 + ffmpeg 可用） */
  enabled: boolean;
  /** ffmpeg 可执行文件（空 = PATH 里的 ffmpeg；ffprobe 取同目录） */
  ffmpegPath: string;
  /** 每个视频最多抽多少帧（拼成一张宫格图交给视觉模型） */
  maxFrames: number;
  /** 最多分析视频前多少秒（画面抽帧 + 音轨转写） */
  maxSeconds: number;
}

export interface AsrConfig {
  /** 是否启用在线语音识别（QQ 未给出识别文本时转写语音） */
  enabled: boolean;
  /** OpenAI 兼容接口地址（POST {baseUrl}/audio/transcriptions） */
  baseUrl: string;
  /** 接口密钥（空 = 环境变量 QQBOT_ASR_API_KEY） */
  apiKey: string;
  /** 转写模型 id（如 FunAudioLLM/SenseVoiceSmall、whisper-large-v3） */
  model: string;
  /** QQ 自带 asr_refer_text 存在时优先使用，不再调用接口 */
  preferQQ: boolean;
  /** 转写调用超时(ms) */
  timeoutMs: number;
  /** 主接口连不上或 5xx 时改用的备用接口（如本机 whisper 优先、在线服务兜底）；旧配置没有这一组 */
  fallback?: AsrFallbackConfig;
}

/** 语音识别备用接口 */
export interface AsrFallbackConfig {
  enabled: boolean;
  /** OpenAI 兼容接口地址（POST {baseUrl}/audio/transcriptions） */
  baseUrl: string;
  /** 接口密钥（空 = 环境变量 QQBOT_ASR_API_KEY） */
  apiKey: string;
  model: string;
  timeoutMs: number;
}

export interface SendFileConfig {
  /** 是否启用路径白名单（默认 true，仅允许 media + cwd + extraRoots；关闭则任意路径） */
  restrictPaths: boolean;
  /** 额外允许访问的根目录（media 和 agent cwd 始终默认允许） */
  extraRoots: string[];
}

export interface SpeakConfig {
  /** 是否注册 qqbot_speak 语音合成工具 */
  enabled: boolean;
  /** edge-tts 音色名（ms neural voice） */
  voice: string;
  /** 语速调整，如 +8% / -5% */
  rate: string;
  /** 单条语音最多合成多少字（QQ 语音上限约 60 秒） */
  maxChars: number;
  /** edge-tts 可执行命令；空 = 依次尝试 edge-tts / python -m edge_tts / py -m edge_tts */
  command: string;
  /**
   * 本地 GPT-SoVITS 服务地址（如 http://127.0.0.1:8765）；空 = 只用 edge-tts。
   * 填了就先走本地服务，那边比 edge-tts 更像「有情绪的嗓子」，失败再退回 edge-tts。
   */
  gsvUrl: string;
  /** GPT-SoVITS 语速倍率，1.0 = 原速（edge-tts 的 rate 是百分比，两者不通用） */
  gsvSpeed: number;
}

export interface FileAccessConfig {
  /** 是否只有主人私聊能访问文件（ownerOpenid 未设置时不生效） */
  ownerOnly: boolean;
  /** 额外允许访问文件的 openid */
  extraAllow: string[];
  /** 敏感路径（拦截名单）：这些目录下的文件禁止访问/发送 */
  sensitivePaths: string[];
}

export interface ToolAccessConfig {
  /** 是否按会话限制工具（关闭 = 所有 QQ 会话都能用终端、读任意路径） */
  enabled: boolean;
  /** 能用终端、读写任意路径的群 openid（主人私聊始终可以） */
  fullAccessGroups: string[];
  /** 除主人外，私聊里能用终端、读写任意路径的 openid */
  fullAccessUsers: string[];
  /** 受限会话额外允许文件工具访问的目录（media、表情库、临时目录始终允许） */
  readRoots: string[];
}

export interface StickersConfig {
  /** 是否启用表情自动收藏（工具 + 动态表情清单） */
  enabled: boolean;
  /** 表情包目录；空字符串表示插件根目录下的 stickers/ */
  root: string;
  /** 除 media 目录外，额外允许作为收藏来源的根目录 */
  extraRoots: string[];
  /** 单张表情文件大小上限（字节） */
  maxBytes: number;
  /** 自动收藏条目上限（防止索引无限增长） */
  maxAutoEntries: number;
}

export interface BrowserConfig {
  enabled: boolean;
  allowedGroups: string[];
  mode: 'local' | 'cdp';
  channel: 'chrome' | 'msedge' | 'chromium';
  userDataDir: string;
  headless: boolean;
  locale: string;
  timezoneId: string;
  timeoutMs: number;
  maxTextChars: number;
}

export interface FanartConfig {
  /** 是否注册 qqbot_fanart_pick 搜图工具 */
  enabled: boolean;
  /** 访问 pixiv / safebooru 的 HTTP 代理（空 = 环境变量 HTTPS_PROXY，再退到 Windows 系统代理） */
  proxy: string;
  /** CP 池目录（pixiv-tags.json / fanart-tags.json）；空 = 插件根目录下的 scripts/ */
  poolDir: string;
}

export interface DndConfig {
  /** 是否启用跑团（/dnd 命令 + dnd_* 工具） */
  enabled: boolean;
  /** 跑团数据目录（campaigns/、自定义 dungeons/ 与 adventures/）；空 = 工作目录下的 dnd/ */
  root: string;
  /** 轮到 PC 时发「结束回合 / 查看状态」按钮（需要机器人有消息按钮权限） */
  turnButtons: boolean;
  /** 跑团期间也按 groupReplyProbability 随机插嘴（只吐槽、不结算）；false = 开团后只回 @ */
  interjections: boolean;
}

export interface ReplyJudgeConfig {
  /** 规则拿不准的文字消息交给模型打分（规则已放行 / 已拦下的不调模型） */
  enabled: boolean;
  /** 打分用的 provider；空 = 跟这个群的主模型一样 */
  provider: string;
  /** 打分用的模型；空 = 跟这个群的主模型一样 */
  model: string;
  /** 推理档位 id；空 = 自动选这个模型支持的最低档 */
  reasoningEffort: string;
  /** 群里安静多久(ms)才打一次分：连续几条只给最后一条打分 */
  debounceMs: number;
  /** 群里一直有人说话时，最多攒多久(ms)也要打一次分 */
  maxWaitMs: number;
  /** 给模型看的最近群消息条数 */
  contextMessages: number;
  /** 单次打分超时(ms)，超时按不接处理 */
  timeoutMs: number;
}

export interface ReplyDesireConfig {
  /** 群聊未 @ 时按回复欲望打分决定是否接话（替代纯随机插嘴）；关闭 = 只回 @ 与随机插嘴 */
  enabled: boolean;
  /** 放行阈值（0-1），越高越安静 */
  threshold: number;
  /** bot 的昵称/别名：群里点名这些词视为在叫 bot */
  names: string[];
  /** 对话窗口(ms)：bot 回复后这段时间内，刚聊过的人再说话更容易被接 */
  engagedMs: number;
  /** 对话窗口内最多靠打分连续接几轮（不含 @），到了就退出窗口，0 = 不进入对话窗口 */
  engagedMaxTurns: number;
  /** 模型打分 */
  judge: ReplyJudgeConfig;
}

/** 群聊串模式 */
export interface BanterConfig {
  /** 总开关；关掉时保留群列表 */
  enabled: boolean;
  /** 开启串模式的群 openid；不在列表里的群不受影响 */
  groups: string[];
}

/** 笔记语义检索（向量相似度，作为 RRF 第三路） */
export interface NotesSemanticConfig {
  /** 是否启用；关闭时只用 BM25 + 字面精确匹配 */
  enabled: boolean;
  /** OpenAI 兼容接口地址（POST {baseUrl}/embeddings） */
  baseUrl: string;
  /** 接口密钥（空 = 环境变量 QQBOT_EMBEDDING_API_KEY） */
  apiKey: string;
  /** 向量模型 id */
  model: string;
  /** 绝对下限：余弦相似度低于它的段一律不进语义榜（0-1） */
  minSimilarity: number;
  /** 相对门槛：要高出本次查询对全库相似度的中位数这么多才进语义榜/自动注入 */
  minMargin: number;
  /** 查询向量请求超时(ms)：超时这条消息就不走语义一路 */
  timeoutMs: number;
}

export interface NotesConfig {
  /** 是否启用共享笔记库（检索/记录工具 + 自动召回） */
  enabled: boolean;
  /** 笔记目录；空字符串表示 agent 工作目录（cwd）下的 notes/ */
  root: string;
  /** 是否在每条消息前自动注入相关笔记片段 */
  autoInject: boolean;
  /** 自动注入的最多片段数 */
  injectTopK: number;
  /** 自动注入的总字数上限 */
  injectMaxChars: number;
  /** 自动注入的最低查询词覆盖率（0-1），越高越保守 */
  injectMinCoverage: number;
  /** 语义检索 */
  semantic: NotesSemanticConfig;
}

export interface ImQQBotConfig {
  /** QQ Bot AppID */
  appId: string;
  /** QQ Bot AppSecret */
  appSecret: string;
  /** dsh LLM 提供商名称 */
  provider?: string;
  /** 模型名称 */
  model?: string;
  /** Agent preset id */
  preset?: string;
  /** Agent 工作目录（缺省回落到进程 cwd） */
  cwd?: string;
  /** Agent 临时目录（空 = cwd/tmp）：脚本、截图、抽帧、下载等中间文件统一放这里 */
  tmpDir: string;
  /** 临时目录里多少小时没改动的条目自动清理（0 = 不清理） */
  tmpTtlHours: number;
  /** 临时目录总量上限（MB），超出时从最旧的条目删（0 = 不限） */
  tmpMaxTotalMB?: number;
  /** 定期清理（内置 media / tmp 规则之外的额外目录） */
  cleanup?: CleanupConfig;
  /** 是否启用群消息 @mention 门控 */
  requireMention: boolean;
  /** 群聊未 @bot 时随机回复概率（0-1），0=关闭 */
  groupReplyProbability?: number;
  /** 群聊回复欲望门控（规则打分 + 对话窗口） */
  replyDesire: ReplyDesireConfig;
  /** 群聊串模式（按群开启） */
  banter: BanterConfig;
  /** 群聊额外 system prompt */
  groupPrompt?: string;
  /** 私聊额外 system prompt */
  directPrompt?: string;
  /** 单条消息最大长度（QQ 限制约 5000 字符） */
  textChunkLimit: number;
  /** 是否启用流式输出（群聊始终不启用） */
  streaming: boolean;
  /** 每会话最大闲置时长(ms)，超时自动回收 */
  sessionIdleTimeout: number;
  /** 并发队列最大长度 */
  maxQueue: number;
  /** 处理超时(ms)，超时中断当前 LLM 调用 */
  processingTimeoutMs: number;
  /** 待答问题超时(ms)，超时自动拒绝并提示（ask_user_question） */
  askTimeoutMs: number;
  /** 群历史缓冲条数 */
  historyLimit: number;
  /** QQ 会话上下文超过这么多 token 时，在轮次结束后自动压缩（0=关闭，交给 dsh 默认阈值） */
  autoCompactTokens: number;
  /** 私聊自动压缩阈值 = 模型上下文窗口 × 该比例（不低于 autoCompactTokens；0=私聊也用固定阈值） */
  autoCompactPrivateRatio: number;
  /** 上一轮调用过工具（多步任务进行中）时推迟自动压缩，直到收尾轮或阈值 1.5 倍 */
  autoCompactDeferOnTools: boolean;
  /** 访问控制 */
  access: AccessControlConfig;
  /** 是否展示工具调用成功结果（工具错误始终展示） */
  showToolResults: boolean;
  /** 调试模式 */
  debug: boolean;
  /** 富媒体理解（图片/视频） */
  media: MediaConfig;
  /** 视觉理解（qqbot_describe_image 工具，走 dsh llm + attachments） */
  vision: VisionConfig;
  /** 在线语音识别（OpenAI 兼容 /audio/transcriptions） */
  asr: AsrConfig;
  /** 视频理解（qqbot_describe_video：抽帧宫格 + 音轨 ASR） */
  video: VideoConfig;
  /** 附件发送（qqbot_send_file 工具） */
  sendFile: SendFileConfig;
  /** 语音合成（qqbot_speak 工具） */
  speak: SpeakConfig;
  /** bot 主人 QQ openid（私聊识别，用于文件访问白名单） */
  ownerOpenid?: string;
  /** 额外的配置管理员 QQ openid（可修改模型/preset、点击审批） */
  adminOpenids: string[];
  /** 文件访问白名单 */
  fileAccess: FileAccessConfig;
  /** 工具权限：哪些会话能用终端、文件工具能碰哪些目录 */
  toolAccess: ToolAccessConfig;
  /** 表情自动收藏（qqbot_save_sticker + 动态表情清单） */
  stickers: StickersConfig;
  /** 共享笔记库（qqbot_notes_search / qqbot_notes_save + 自动召回） */
  notes: NotesConfig;
  /** 搜图工具（qqbot_fanart_pick） */
  fanart: FanartConfig;
  browser?: BrowserConfig;
  /** 跑团（/dnd + dnd_* 工具） */
  dnd: DndConfig;
}

/** 清理规则子 Schema */
export const CleanupRuleSchema: Schema<CleanupRuleConfig> = Schema.object({
  name: Schema.string().default('').description('规则名（空=用目录）'),
  dir: Schema.string().default('').description('目录（相对路径按工作目录解析）'),
  unit: Schema.union(['file', 'entry']).default('file').description('file=逐个文件；entry=顶层条目整体'),
  ttlHours: Schema.number().default(72).description('多少小时未改动后删除（0=不按时间删）'),
  recursive: Schema.boolean().default(false).description('unit=file 时是否进入子目录'),
  keep: Schema.array(Schema.string()).default([]).description('永不删除的文件名（支持 * ?）'),
  match: Schema.array(Schema.string()).default([]).description('只处理这些文件名（空=全部）'),
  maxTotalMB: Schema.number().default(0).description('总量上限(MB)，0=不限'),
});

/** 清理配置子 Schema */
export const CleanupSchema: Schema<CleanupConfig> = Schema.object({
  dryRun: Schema.boolean().default(false).description('只记日志不删除'),
  rules: Schema.array(CleanupRuleSchema).default([]).description('额外的清理规则'),
});

/** 访问控制子 Schema（独立导出：config 路由的服务端校验复用） */
export const AccessControlSchema: Schema<AccessControlConfig> = Schema.object({
  c2cMode: Schema.union(['open', 'allowlist', 'disabled']).default('open').description('C2C访问模式'),
  c2cAllow: Schema.array(Schema.string()).default([]).description('C2C白名单'),
  groupMode: Schema.union(['open', 'allowlist', 'disabled']).default('open').description('群聊访问模式'),
  groupAllow: Schema.array(Schema.string()).default([]).description('群聊白名单'),
});

/** 工具权限子 Schema */
export const ToolAccessSchema: Schema<ToolAccessConfig> = Schema.object({
  enabled: Schema.boolean().default(true).description('是否按会话限制工具'),
  fullAccessGroups: Schema.array(Schema.string()).default([]).description('能用终端、读写任意路径的群 openid'),
  fullAccessUsers: Schema.array(Schema.string()).default([]).description('除主人外能用终端的私聊 openid'),
  readRoots: Schema.array(Schema.string()).default([]).description('受限会话额外允许访问的目录'),
});

/** 文件访问白名单子 Schema（独立导出：config 路由的服务端校验复用） */
export const FileAccessSchema: Schema<FileAccessConfig> = Schema.object({
  ownerOnly: Schema.boolean().default(true).description('是否只有主人私聊能访问文件'),
  extraAllow: Schema.array(Schema.string()).default([]).description('额外允许访问文件的 openid'),
  sensitivePaths: Schema.array(Schema.string()).default([]).description('敏感路径（拦截访问）'),
});

/** 表情自动收藏子 Schema */
export const StickersSchema: Schema<StickersConfig> = Schema.object({
  enabled: Schema.boolean().default(true).description('是否启用表情自动收藏'),
  root: Schema.string().default('').description('表情包目录（空=插件根目录/stickers）'),
  extraRoots: Schema.array(Schema.string()).default([]).description('额外允许的收藏来源目录'),
  maxBytes: Schema.number().default(8 * 1024 * 1024).description('单张表情大小上限（字节）'),
  maxAutoEntries: Schema.number().default(200).description('自动收藏条目上限'),
});

/** 笔记语义检索子 Schema */
export const NotesSemanticSchema: Schema<NotesSemanticConfig> = Schema.object({
  enabled: Schema.boolean().default(false).description('启用向量语义检索'),
  baseUrl: Schema.string().default('https://api.siliconflow.cn/v1').description('OpenAI 兼容接口地址（POST {baseUrl}/embeddings）'),
  apiKey: Schema.string().default('').description('接口密钥（空=环境变量 QQBOT_EMBEDDING_API_KEY）'),
  model: Schema.string().default('BAAI/bge-m3').description('向量模型'),
  minSimilarity: Schema.number().min(0).max(1).default(0.5).description('绝对下限：最低余弦相似度(0-1)'),
  minMargin: Schema.number().min(0).max(1).default(0.16).description('相对门槛：高出全库相似度中位数多少'),
  timeoutMs: Schema.number().min(500).max(30000).default(3000).description('查询向量超时(ms)'),
});

/** 共享笔记库子 Schema */
export const NotesSchema: Schema<NotesConfig> = Schema.object({
  enabled: Schema.boolean().default(true).description('是否启用共享笔记库'),
  root: Schema.string().default('').description('笔记目录（空=工作目录/notes）'),
  autoInject: Schema.boolean().default(true).description('是否自动在消息前注入相关笔记'),
  injectTopK: Schema.number().default(2).description('自动注入最多片段数'),
  injectMaxChars: Schema.number().default(600).description('自动注入总字数上限'),
  injectMinCoverage: Schema.number().default(0.4).description('自动注入最低查询词覆盖率(0-1)'),
  semantic: NotesSemanticSchema.description('向量语义检索'),
});

/** 浏览器子 Schema */
export const BrowserSchema: Schema<BrowserConfig> = Schema.object({
  enabled: Schema.boolean().default(false).description('启用主人私聊和授权群的浏览工具'),
  allowedGroups: Schema.array(Schema.string()).default([]).description('允许浏览的群 openid；空=仅主人私聊'),
  mode: Schema.union(['local', 'cdp']).default('local'),
  channel: Schema.union(['chrome', 'msedge', 'chromium']).default('chrome'),
  userDataDir: Schema.string().default('').description('独立浏览器目录；空=工作目录/.qqbot-browser'),
  headless: Schema.boolean().default(false),
  locale: Schema.string().default('zh-CN'),
  timezoneId: Schema.string().default('Asia/Shanghai'),
  timeoutMs: Schema.number().min(1000).max(120000).step(1).default(30000),
  maxTextChars: Schema.number().min(1000).max(50000).step(1).default(12000),
}).default({
  enabled: false, allowedGroups: [], mode: 'local', channel: 'chrome', userDataDir: '', headless: false,
  locale: 'zh-CN', timezoneId: 'Asia/Shanghai', timeoutMs: 30000, maxTextChars: 12000,
});

export const FanartSchema: Schema<FanartConfig> = Schema.object({
  enabled: Schema.boolean().default(true).description('是否启用 qqbot_fanart_pick 搜图工具'),
  proxy: Schema.string().default('').description('pixiv/safebooru 用的 HTTP 代理（空=HTTPS_PROXY 或系统代理）'),
  poolDir: Schema.string().default('').description('CP 池目录（空=插件根目录/scripts）'),
});

/** 跑团子 Schema */
export const DndSchema: Schema<DndConfig> = Schema.object({
  enabled: Schema.boolean().default(true).description('是否启用跑团（/dnd 命令与 dnd_* 工具）'),
  root: Schema.string().default('').description('跑团数据目录（空=工作目录/dnd）'),
  turnButtons: Schema.boolean().default(true).description('轮到玩家时发「结束回合 / 查看状态」按钮'),
  interjections: Schema.boolean().default(true).description('跑团期间也按插话概率随机吐槽（只吐槽、不结算行动）；关掉则开团后只回 @'),
});

export const REPLY_JUDGE_DEFAULTS: ReplyJudgeConfig = {
  enabled: false,
  provider: '',
  model: '',
  reasoningEffort: '',
  debounceMs: 2500,
  maxWaitMs: 15000,
  contextMessages: 20,
  timeoutMs: 15000,
};

/** 模型打分子 Schema */
export const ReplyJudgeSchema: Schema<ReplyJudgeConfig> = Schema.object({
  enabled: Schema.boolean().default(false).description('规则拿不准的文字消息交给模型打分'),
  provider: Schema.string().default('').description('打分 provider（空=这个群的主模型）'),
  model: Schema.string().default('').description('打分模型（空=这个群的主模型）'),
  reasoningEffort: Schema.string().default('').description('推理档位 id（空=自动选最低档）'),
  debounceMs: Schema.number().min(0).max(60000).default(2500).description('群里安静多久(ms)才打一次分'),
  maxWaitMs: Schema.number().min(0).max(300000).default(15000).description('一直有人说话时最多攒多久(ms)也要打分'),
  contextMessages: Schema.number().min(1).max(100).default(20).description('给模型看的最近群消息条数'),
  timeoutMs: Schema.number().min(1000).max(120000).default(15000).description('单次打分超时(ms)'),
}).default(REPLY_JUDGE_DEFAULTS);

/** 回复欲望子 Schema */
export const ReplyDesireSchema: Schema<ReplyDesireConfig> = Schema.object({
  enabled: Schema.boolean().default(false).description('群聊未@时按回复欲望打分决定是否接话'),
  threshold: Schema.number().default(0.6).description('放行阈值(0-1)，越高越安静'),
  names: Schema.array(Schema.string()).default([]).description('bot 昵称/别名，群里提到即视为在叫 bot'),
  engagedMs: Schema.number().default(90000).description('对话窗口(ms)：bot 回复后刚聊过的人更容易被接话'),
  engagedMaxTurns: Schema.number().default(8).description('对话窗口内最多靠打分连续接几轮，0=不进入对话窗口'),
  judge: ReplyJudgeSchema.description('模型打分'),
});

/** 串模式子 Schema */
export const BanterSchema: Schema<BanterConfig> = Schema.object({
  enabled: Schema.boolean().default(false).description('是否启用群聊串模式'),
  groups: Schema.array(Schema.string()).default([]).description('开启串模式的群 openid'),
});

/** 富媒体理解子 Schema（独立导出：config 面板的服务端校验复用） */
export const MediaSchema: Schema<MediaConfig> = Schema.object({
  enabled: Schema.boolean().default(true).description('是否启用富媒体理解（图片/视频下载 + 工具分析）'),
  maxMB: Schema.number().default(200).description('富媒体下载大小上限(MB)'),
  ttlHours: Schema.number().default(24).description('富媒体存活时长(小时)，0=永不过期'),
  maxTotalMB: Schema.number().default(1024).description('media 目录总量上限(MB)，超出从最旧的删，0=不限'),
}).default({
  enabled: true,
  maxMB: 200,
  ttlHours: 24,
  maxTotalMB: 1024,
});

/** 视觉理解子 Schema */
export const VisionSchema: Schema<VisionConfig> = Schema.object({
  enabled: Schema.boolean().default(false).description('是否启用视觉理解（qqbot_describe_image 工具）'),
  native: Schema.boolean().default(false).description('是否把图片作为原生 ImageBlock 直接交给主模型（主模型路由需声明 image 输入）'),
  provider: Schema.string().default('').description('视觉模型 provider（dsh 注册的 llm adapter，如 pi-ai）'),
  model: Schema.string().default('').description('视觉模型 id（如 qwen-vl-max）'),
  defaultPrompt: Schema.string().default('Describe this image in detail.').description('默认描述 prompt'),
  maxBytes: Schema.number().default(10 * 1024 * 1024).description('图片字节上限'),
  maxTokens: Schema.number().default(1024).description('输出 token 上限'),
  timeoutMs: Schema.number().default(120000).description('视觉调用超时(ms)'),
}).default({
  enabled: false,
  native: false,
  provider: '',
  model: '',
  defaultPrompt: 'Describe this image in detail.',
  maxBytes: 10 * 1024 * 1024,
  maxTokens: 1024,
  timeoutMs: 120000,
});

/** 语音识别子 Schema（apiKey 不随表单回传，服务端在写入时保留旧值） */
/** 语音识别备用接口子 Schema */
export const AsrFallbackSchema: Schema<AsrFallbackConfig> = Schema.object({
  enabled: Schema.boolean().default(false).description('主接口连不上时改用备用接口'),
  baseUrl: Schema.string().default('https://api.siliconflow.cn/v1').description('OpenAI 兼容接口地址'),
  apiKey: Schema.string().default('').description('接口密钥（空=环境变量 QQBOT_ASR_API_KEY）'),
  model: Schema.string().default('Qwen/Qwen3-ASR-1.7B').description('转写模型 id'),
  timeoutMs: Schema.number().min(1000).max(300000).default(30000).description('转写调用超时(ms)'),
});

export const AsrSchema: Schema<AsrConfig> = Schema.object({
  enabled: Schema.boolean().default(false).description('是否启用在线语音识别（QQ 未给出识别文本时转写语音）'),
  baseUrl: Schema.string().default('https://api.siliconflow.cn/v1').description('OpenAI 兼容接口地址（POST {baseUrl}/audio/transcriptions）'),
  apiKey: Schema.string().default('').description('接口密钥（空=环境变量 QQBOT_ASR_API_KEY）'),
  model: Schema.string().default('Qwen/Qwen3-ASR-1.7B').description('转写模型 id'),
  preferQQ: Schema.boolean().default(true).description('QQ 自带识别文本存在时优先使用'),
  timeoutMs: Schema.number().default(30000).description('转写调用超时(ms)'),
  fallback: AsrFallbackSchema.description('备用接口：主接口连不上或 5xx 时改用'),
}).default({
  enabled: false,
  baseUrl: 'https://api.siliconflow.cn/v1',
  apiKey: '',
  model: 'Qwen/Qwen3-ASR-1.7B',
  preferQQ: true,
  timeoutMs: 30000,
  fallback: {
    enabled: false,
    baseUrl: 'https://api.siliconflow.cn/v1',
    apiKey: '',
    model: 'FunAudioLLM/SenseVoiceSmall',
    timeoutMs: 30000,
  },
});

/** 视频理解子 Schema */
export const VideoSchema: Schema<VideoConfig> = Schema.object({
  enabled: Schema.boolean().default(true).description('是否注册 qqbot_describe_video（需 vision 已配置 + ffmpeg 可用）'),
  ffmpegPath: Schema.string().default('').description('ffmpeg 路径（空=PATH 里的 ffmpeg）'),
  maxFrames: Schema.number().default(8).description('每个视频最多抽帧数（拼成一张宫格图）'),
  maxSeconds: Schema.number().default(300).description('最多分析视频前多少秒'),
}).default({
  enabled: true,
  ffmpegPath: '',
  maxFrames: 8,
  maxSeconds: 300,
});

/** 附件发送子 Schema */
export const SendFileSchema: Schema<SendFileConfig> = Schema.object({
  restrictPaths: Schema.boolean().default(true).description('是否启用路径白名单（默认 true，仅允许 media + cwd + extraRoots）'),
  extraRoots: Schema.array(Schema.string()).default([]).description('额外允许访问的根目录'),
}).default({
  restrictPaths: true,
  extraRoots: [],
});

export const SpeakSchema: Schema<SpeakConfig> = Schema.object({
  enabled: Schema.boolean().default(true).description('是否注册 qqbot_speak 语音合成工具'),
  voice: Schema.string().default('zh-CN-XiaoyiNeural').description('edge-tts 音色名'),
  rate: Schema.string().default('+8%').description('语速调整，如 +8% / -5%'),
  maxChars: Schema.number().default(120).description('单条语音字数上限（QQ 语音约 60 秒）'),
  command: Schema.string().default('').description('edge-tts 可执行命令（空=自动探测）'),
  gsvUrl: Schema.string().default('').description('本地 GPT-SoVITS 服务地址（空=edge-tts）'),
  gsvSpeed: Schema.number().default(1.0).description('GPT-SoVITS 语速倍率（1.0=原速）'),
}).default({
  enabled: true,
  voice: 'zh-CN-XiaoyiNeural',
  rate: '+8%',
  maxChars: 120,
  command: '',
  gsvUrl: '',
  gsvSpeed: 1.0,
});

export const ConfigSchema: Schema<ImQQBotConfig> = Schema.object({
  appId: Schema.string().default('').description('QQ 机器人 AppID'),
  appSecret: Schema.string().default('').description('QQ 机器人 AppSecret'),
  provider: Schema.string().description('LLM provider name'),
  model: Schema.string().description('Model name'),
  preset: Schema.string().description('Agent preset id'),
  cwd: Schema.string().description('Agent working directory'),
  tmpDir: Schema.string().default('').description('Agent 临时目录（空=工作目录/tmp）'),
  tmpTtlHours: Schema.number().default(72).description('临时目录条目多少小时未改动后自动清理（0=不清理）'),
  tmpMaxTotalMB: Schema.number().default(4096).description('临时目录总量上限(MB)，超出从最旧的条目删，0=不限'),
  cleanup: CleanupSchema.default({ dryRun: false, rules: [] }).description('定期清理（内置 media/tmp 之外的额外目录）'),
  requireMention: Schema.boolean().default(true).description('群聊是否需要@bot触发'),
  groupReplyProbability: Schema.number().default(0).description('群聊未@时随机回复概率(0-1)，0=关闭'),
  replyDesire: ReplyDesireSchema.default({
    enabled: false,
    threshold: 0.6,
    names: [],
    engagedMs: 90000,
    engagedMaxTurns: 8,
    judge: REPLY_JUDGE_DEFAULTS,
  }).description('群聊回复欲望门控'),
  banter: BanterSchema.default({ enabled: false, groups: [] }).description('群聊串模式'),
  groupPrompt: Schema.string().description('群聊额外system prompt'),
  directPrompt: Schema.string().description('私聊额外system prompt'),
  textChunkLimit: Schema.number().default(4500).description('单条消息最大字符数'),
  streaming: Schema.boolean().default(true).description('是否启用流式输出（群聊始终不启用）'),
  sessionIdleTimeout: Schema.number().default(30 * 60 * 1000).description('会话闲置超时(ms)'),
  maxQueue: Schema.number().default(20).description('并发队列最大长度'),
  processingTimeoutMs: Schema.number().default(30 * 60 * 1000).description('处理超时(ms)，超时中断当前 LLM 调用'),
  askTimeoutMs: Schema.number().default(5 * 60 * 1000).description('待答问题超时(ms)，超时自动拒绝并提示'),
  historyLimit: Schema.number().default(10).description('群历史缓冲条数'),
  autoCompactTokens: Schema.number().default(160000).description('上下文超过此 token 数时自动压缩（0=关闭）；私聊另见 autoCompactPrivateRatio'),
  autoCompactPrivateRatio: Schema.number().min(0).max(0.9).default(0.5)
    .description('私聊自动压缩阈值占模型上下文窗口的比例（不低于 autoCompactTokens；0=私聊也用固定阈值）'),
  autoCompactDeferOnTools: Schema.boolean().default(true)
    .description('上一轮还在调工具时推迟自动压缩，等收尾轮或上下文到阈值 1.5 倍再压'),
  access: AccessControlSchema.default({
    c2cMode: 'open',
    c2cAllow: [],
    groupMode: 'open',
    groupAllow: [],
  }).description('访问控制'),
  showToolResults: Schema.boolean().default(false).description('是否展示工具调用结果（关闭时私聊仍展示错误，群聊不展示）'),
  debug: Schema.boolean().default(false),
  media: MediaSchema.description('富媒体理解配置'),
  vision: VisionSchema.description('视觉理解配置'),
  asr: AsrSchema.description('语音识别配置'),
  video: VideoSchema.description('视频理解配置'),
  sendFile: SendFileSchema.description('附件发送工具配置'),
  speak: SpeakSchema.description('语音合成工具配置（qqbot_speak）'),
  ownerOpenid: Schema.string().description('bot 主人 QQ openid（私聊识别，文件访问白名单）'),
  adminOpenids: Schema.array(Schema.string()).default([]).description('额外的配置管理员 openid（可修改模型/preset、点击审批）'),
  fileAccess: FileAccessSchema.default({
    ownerOnly: true,
    extraAllow: [],
    sensitivePaths: [],
  }).description('文件访问白名单'),
  toolAccess: ToolAccessSchema.default({
    enabled: true,
    fullAccessGroups: [],
    fullAccessUsers: [],
    readRoots: [],
  }).description('工具权限（终端白名单群、受限会话可访问的目录）'),
  stickers: StickersSchema.default({
    enabled: true,
    root: '',
    extraRoots: [],
    maxBytes: 8 * 1024 * 1024,
    maxAutoEntries: 200,
  }).description('表情自动收藏配置'),
  notes: NotesSchema.default({
    enabled: true,
    root: '',
    autoInject: true,
    injectTopK: 2,
    injectMaxChars: 600,
    injectMinCoverage: 0.4,
    semantic: {
      enabled: false,
      baseUrl: 'https://api.siliconflow.cn/v1',
      apiKey: '',
      model: 'BAAI/bge-m3',
      minSimilarity: 0.5,
      minMargin: 0.16,
      timeoutMs: 3000,
    },
  }).description('共享笔记库配置'),
  browser: BrowserSchema.description('Playwright 浏览器（CDP 地址用 QQBOT_BROWSER_CDP_ENDPOINT 环境变量）'),
  fanart: FanartSchema.default({
    enabled: true,
    proxy: '',
    poolDir: '',
  }).description('搜图工具配置'),
  dnd: DndSchema.default({
    enabled: true,
    root: '',
    turnButtons: true,
    interjections: true,
  }).description('跑团配置'),
});
