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

export interface SendFileConfig {
  /** 是否启用路径白名单（默认 true，仅允许 media + cwd + extraRoots；关闭则任意路径） */
  restrictPaths: boolean;
  /** 额外允许访问的根目录（media 和 agent cwd 始终默认允许） */
  extraRoots: string[];
}

export interface FileAccessConfig {
  /** 是否只有主人私聊能访问文件（ownerOpenid 未设置时不生效） */
  ownerOnly: boolean;
  /** 额外允许访问文件的 openid */
  extraAllow: string[];
  /** 敏感路径（拦截名单）：这些目录下的文件禁止访问/发送 */
  sensitivePaths: string[];
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
  /** 是否启用群消息 @mention 门控 */
  requireMention: boolean;
  /** 群聊未 @bot 时随机回复概率（0-1），0=关闭 */
  groupReplyProbability?: number;
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
  /** 附件发送（qqbot_send_file 工具） */
  sendFile: SendFileConfig;
  /** bot 主人 QQ openid（私聊识别，用于文件访问白名单） */
  ownerOpenid?: string;
  /** 额外的配置管理员 QQ openid（可修改模型/preset、点击审批） */
  adminOpenids: string[];
  /** 文件访问白名单 */
  fileAccess: FileAccessConfig;
  /** 表情自动收藏（qqbot_save_sticker + 动态表情清单） */
  stickers: StickersConfig;
}

/** 访问控制子 Schema（独立导出：config 路由的服务端校验复用） */
export const AccessControlSchema: Schema<AccessControlConfig> = Schema.object({
  c2cMode: Schema.union(['open', 'allowlist', 'disabled']).default('open').description('C2C访问模式'),
  c2cAllow: Schema.array(Schema.string()).default([]).description('C2C白名单'),
  groupMode: Schema.union(['open', 'allowlist', 'disabled']).default('open').description('群聊访问模式'),
  groupAllow: Schema.array(Schema.string()).default([]).description('群聊白名单'),
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

export const ConfigSchema: Schema<ImQQBotConfig> = Schema.object({
  appId: Schema.string().default('').description('QQ 机器人 AppID'),
  appSecret: Schema.string().default('').description('QQ 机器人 AppSecret'),
  provider: Schema.string().description('LLM provider name'),
  model: Schema.string().description('Model name'),
  preset: Schema.string().description('Agent preset id'),
  cwd: Schema.string().description('Agent working directory'),
  requireMention: Schema.boolean().default(true).description('群聊是否需要@bot触发'),
  groupReplyProbability: Schema.number().default(0).description('群聊未@时随机回复概率(0-1)，0=关闭'),
  groupPrompt: Schema.string().description('群聊额外system prompt'),
  directPrompt: Schema.string().description('私聊额外system prompt'),
  textChunkLimit: Schema.number().default(4500).description('单条消息最大字符数'),
  streaming: Schema.boolean().default(true).description('是否启用流式输出（群聊始终不启用）'),
  sessionIdleTimeout: Schema.number().default(30 * 60 * 1000).description('会话闲置超时(ms)'),
  maxQueue: Schema.number().default(20).description('并发队列最大长度'),
  processingTimeoutMs: Schema.number().default(30 * 60 * 1000).description('处理超时(ms)，超时中断当前 LLM 调用'),
  askTimeoutMs: Schema.number().default(5 * 60 * 1000).description('待答问题超时(ms)，超时自动拒绝并提示'),
  historyLimit: Schema.number().default(10).description('群历史缓冲条数'),
  access: AccessControlSchema.default({
    c2cMode: 'open',
    c2cAllow: [],
    groupMode: 'open',
    groupAllow: [],
  }).description('访问控制'),
  showToolResults: Schema.boolean().default(false).description('是否展示工具调用成功结果（错误始终展示）'),
  debug: Schema.boolean().default(false),
  media: Schema.object({
    enabled: Schema.boolean().default(true).description('是否启用富媒体理解（图片/视频下载 + 工具分析）'),
    maxMB: Schema.number().default(200).description('富媒体下载大小上限(MB)'),
    ttlHours: Schema.number().default(24).description('富媒体存活时长(小时)，0=永不过期'),
  }).default({
    enabled: true,
    maxMB: 200,
    ttlHours: 24,
  }).description('富媒体理解配置'),
  vision: Schema.object({
    enabled: Schema.boolean().default(false).description('是否启用视觉理解（qqbot_describe_image 工具）'),
    native: Schema.boolean().default(false).description('是否把图片作为原生 ImageBlock 交给主模型（主模型路由需声明 image 输入）'),
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
  }).description('视觉理解配置'),
  sendFile: Schema.object({
    restrictPaths: Schema.boolean().default(true).description('是否启用路径白名单（默认 true，仅允许 media + cwd + extraRoots）'),
    extraRoots: Schema.array(Schema.string()).default([]).description('额外允许访问的根目录'),
  }).default({
    restrictPaths: true,
    extraRoots: [],
  }).description('附件发送工具配置'),
  ownerOpenid: Schema.string().description('bot 主人 QQ openid（私聊识别，文件访问白名单）'),
  adminOpenids: Schema.array(Schema.string()).default([]).description('额外的配置管理员 openid（可修改模型/preset、点击审批）'),
  fileAccess: FileAccessSchema.default({
    ownerOnly: true,
    extraAllow: [],
    sensitivePaths: [],
  }).description('文件访问白名单'),
  stickers: StickersSchema.default({
    enabled: true,
    root: '',
    extraRoots: [],
    maxBytes: 8 * 1024 * 1024,
    maxAutoEntries: 200,
  }).description('表情自动收藏配置'),
});
