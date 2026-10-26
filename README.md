<div align="center">

<img width="120" src="https://img.shields.io/badge/🤖-QQ_Bot-blue?style=for-the-badge" alt="QQ Bot" />

**基于 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) 的 QQ Bot 插件，将 DeepSeek AI 助手接入 QQ 私聊与群聊。**

[![npm version](https://img.shields.io/npm/v/@tencent-connect/dsh-qqbot)](https://www.npmjs.com/package/@tencent-connect/dsh-qqbot)
[![License](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/tencent-connect/dsh-qqbot)](https://github.com/tencent-connect/dsh-qqbot)
[![QQ Bot](https://img.shields.io/badge/QQ_Bot-API_v2-red)](https://bot.q.qq.com/wiki/)

<br/>

**[English](./README_EN.md) | 简体中文**

扫码加入 QQ 群 / 频道

<table>
<tr>
<td align="center" width="50%"><img src="./docs/assets/qqgroup.jpg" height="360" alt="QQ 群二维码" /><br /><b>QQ 开发者交流群</b><br /><sub>群号: 1032635674</sub></td>
<td align="center" width="50%"><img src="./docs/assets/qqchannel.jpg" height="360" alt="QQ 频道二维码" /><br /><b>QQ 开发者社区频道</b><br /><sub>频道号: 20dnumts4z</sub></td>
</tr>
</table>

</div>

## 架构

```
QQ 用户 → QQ WebSocket → dsh-qqbot → ctx.agents → dsh agent loop → LLM
                                 ↑                           │
                                 └── session/event ──────────┘
                                       (assistant reply → QQ sendMarkdown)
```

## 安装

### 方式一：手动执行

```bash
# 安装到 profile
npx @deepseek-ai/dsh plugin --profile qqbot add @tencent-connect/dsh-qqbot

# 启动
npx @deepseek-ai/dsh --profile qqbot
```

首次启动时，插件检测到凭据未配置会自动进入扫码引导：终端输出二维码 → 手机 QQ 扫码绑定 → 凭据自动保存到 profile，后续启动无需再次扫码。

DSH **桌面版 / Web** 下会自动打开应用内「QQ Bot 绑定」页（右侧边栏），端内渲染二维码并实时展示绑定状态，扫码成功后自动完成保存与插件重载；CLI 模式保持终端二维码引导。设置 `QQBOT_BIND_OPEN_BROWSER=1` 可在无端内页的环境额外拉起系统浏览器扫码页作为降级通道。

<img src="./docs/assets/qrcode.png" alt="二维码扫码示意图" width="280" />

> **提示**：建议升级至 `0.4.0` 以上版本扫码，支持点击链接在浏览器打开，避免部分终端二维码渲染错位的问题。

### 方式二：本地路径安装

```bash
# 构建
cd /path/to/dsh-qqbot
pnpm install && pnpm build

# 安装到 profile（本地路径）
npx @deepseek-ai/dsh plugin --profile qqbot add /path/to/dsh-qqbot

# 启动
export QQBOT_APPID="你的AppID" QQBOT_SECRET="你的AppSecret"
npx @deepseek-ai/dsh --profile qqbot
```

### 方式三：--patch 开发模式

```bash
export QQBOT_APPID="你的AppID" QQBOT_SECRET="你的AppSecret"
npx @deepseek-ai/dsh web --patch /path/to/dsh-qqbot/cordis.dev.yml
```

### 方式四：作为 DSH Web 插件运行（推荐）

把 bot 装进当前 DSH Web 使用的 profile，就能在侧栏「插件」里统一安装、启停和调整配置：

1. 打开 DSH Web，侧栏 **插件 → 添加插件 → 安装第三方插件**，输入本地目录（如 `/path/to/dsh-qqbot`）或包名 `@tencent-connect/dsh-qqbot`。
2. 安装完成后在 **已安装插件** 中启用 `@tencent-connect/dsh-qqbot`。
3. 点进该组合包，在详情页的配置表单里调整模型、提示词、群聊回复概率、访问控制、主人 openid 与文件访问白名单；保存后插件自动重载。
4. 扫码绑定、更换凭据、解绑仍在 **设置 → QQ 机器人**。

> **运行方式**：这种方式下 bot 与 DSH Web 同进程，关闭 Web 即下线。请勿同时启动独立 `qqbot` profile（例如旧的启动脚本），否则同一个 QQ 机器人会建立两个连接并可能重复回复。需要 7×24 独立运行时，继续使用方式一/二。

## 配置项

> 在 DSH Web 插件管理中运行时，多数配置可直接在 **插件 → 已安装插件 → `@tencent-connect/dsh-qqbot`** 的配置页修改；`appId`/`appSecret` 走绑定流程，`cwd` 仍由 profile patch / 环境变量控制。

| 配置 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `appId` | string | **必填** | QQ Bot AppID（或通过 `QQBOT_APPID` 环境变量） |
| `appSecret` | string | **必填** | QQ Bot AppSecret（或通过 `QQBOT_SECRET` 环境变量） |
| `provider` | string | `deepseek-official` | LLM 提供商名称（留空继承宿主默认） |
| `model` | string | `deepseek-flash` | 模型名称；DSH `deepseek-official` 当前的 V4.1 Flash（留空继承宿主默认） |
| `preset` | string | - | Agent preset id |
| `cwd` | string | `process.cwd()` | Agent 工作目录 |
| `ownerOpenid` | string | - | bot 主人 QQ openid（文件访问白名单识别） |
| `adminOpenids` | string[] | `[]` | 额外的配置管理员 openid（可修改模型/preset、点击审批） |
| `requireMention` | boolean | `true` | 群聊是否需要 @bot 才触发 |
| `groupReplyProbability` | number | `0` | 群聊未 @bot 时随机回复概率（0–1），0=关闭 |
| `groupPrompt` | string | - | 群聊额外 system prompt |
| `directPrompt` | string | - | 私聊额外 system prompt |
| `textChunkLimit` | number | `4500` | 单条消息最大字符数 |
| `streaming` | boolean | `true` | 是否启用流式输出（群聊始终不启用） |
| `sessionIdleTimeout` | number | `1800000` | 会话闲置超时(ms)，默认 30 分钟 |
| `processingTimeoutMs` | number | `1800000` | 处理超时(ms)，超时中断当前 LLM 调用 |
| `maxQueue` | number | `20` | 并发队列最大长度 |
| `historyLimit` | number | `10` | 群历史缓冲条数 |
| `askTimeoutMs` | number | `300000` | 待答问题超时(ms)，默认 5 分钟（ask_user_question） |
| `showToolResults` | boolean | `false` | 是否展示工具调用成功结果（错误始终展示） |
| `debug` | boolean | `false` | 调试模式 |

### 访问控制（access）

| 配置 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `access.c2cMode` | `open`/`allowlist`/`disabled` | `open` | 私聊访问模式 |
| `access.c2cAllow` | string[] | `[]` | 私聊白名单（user openid） |
| `access.groupMode` | `open`/`allowlist`/`disabled` | `open` | 群聊访问模式 |
| `access.groupAllow` | string[] | `[]` | 群聊白名单（group openid） |

### 文件访问（fileAccess）

| 配置 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `fileAccess.ownerOnly` | boolean | `true` | 是否仅主人私聊可访问文件（需配合 `ownerOpenid`） |
| `fileAccess.extraAllow` | string[] | `[]` | 额外允许访问文件的 openid |
| `fileAccess.sensitivePaths` | string[] | `[]` | 敏感路径（拦截名单），命中后禁止访问/发送 |

### 富媒体理解（media）

| 配置 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `media.enabled` | boolean | `true` | 是否启用富媒体理解（图片/视频下载 + 工具分析） |
| `media.maxMB` | number | `200` | 富媒体下载大小上限(MB) |
| `media.ttlHours` | number | `24` | 富媒体存活时长(小时)，0=永不过期 |

### 视觉理解（vision）

| 配置 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `vision.enabled` | boolean | `false` | 是否启用视觉理解（qqbot_describe_image 工具） |
| `vision.provider` | string | - | 视觉模型 provider（如 pi-ai） |
| `vision.model` | string | - | 视觉模型 id（如 qwen-vl-max） |
| `vision.maxBytes` | number | `10MB` | 图片字节上限 |
| `vision.maxTokens` | number | `1024` | 输出 token 上限 |
| `vision.timeoutMs` | number | `120000` | 视觉调用超时(ms) |

> 如果宿主提供 `deepseek-vision` 路由，视觉理解可用 `vision.provider: deepseek-vision`、`vision.model: deepseek-v4-flash`；文字对话的 V4.1 Flash 是 `deepseek-official` 下的 `deepseek-flash`，两者不要混用。

### 附件发送（sendFile）

| 配置 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `sendFile.restrictPaths` | boolean | `true` | 是否启用路径白名单（仅 media + cwd + extraRoots） |
| `sendFile.extraRoots` | string[] | `[]` | 额外允许访问的根目录 |

### 表情收藏（stickers）

| 配置 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `stickers.enabled` | boolean | `true` | 是否启用 `qqbot_save_sticker` 与动态表情清单 |
| `stickers.root` | string | `''` | 表情包目录；空=插件根目录下的 `stickers/` |
| `stickers.extraRoots` | string[] | `[]` | 除 media 外额外允许作为收藏来源的目录 |
| `stickers.maxBytes` | number | `8388608` | 单张表情大小上限（8 MB） |
| `stickers.maxAutoEntries` | number | `200` | 自动收藏条目上限 |

## 表情自动收藏

bot 看到用户发来的图片时，会先理解图片，再根据自己当下的情绪决定要不要收藏。收藏由 `qqbot_save_sticker` 工具完成：

- 只在 bot 真觉得「这张图能表达我以后会用的情绪」时才调用；普通截图、长文截图不会存。
- 按 SHA-256 去重，同一张图不会重复入库；文件名默认 `fish_<情绪>.png`，同名自动追加序号。
- 收藏后更新 `stickers/index.json`，并把新条目动态注入**当前会话下一回合**的 system prompt（不需要改人设里的固定对照表）。
- 如果模型偶尔把调用写成 `<qqbot_save_sticker>...` 文本标签，出站层会剥离标签并补执行收藏，用户不会看到 XML。
- 默认写入插件根目录的 `stickers/`；可用 `stickers.root` 改到可写目录。自动收藏的图片属于本地运行数据，默认被 `.gitignore` 排除。
- 如果 `stickers.root` 不在 agent cwd 之下，记得把它加进 `sendFile.extraRoots`，否则 `qqbot_send_file` 会拒绝发送。

> 如果你本地保留了旧的 `stickers/save-sticker.ps1`，它仍可手动使用；它和插件内的工具共用同一份 `index.json`。

## 图文同发（caption）

`qqbot_send_file` 新增 `caption` 参数：发图片/视频/文件时，把整段文字放进 `caption`，QQ 会把它和媒体作为同一条富媒体消息发出。

- 插件会在 QQ 会话 prompt 里优先要求：发图配文时用 `caption`，不要再单独回一段文字。
- 这是低风险方案，正常文字回复仍保留流式；如果模型仍单独写文字，仍可能出现两条气泡。
- 要 100% 保证一个气泡，需要出站层把本轮文字延迟到回合结束、再作为 caption 随图发送（会牺牲图片回合的流式）；目前没有启用。
- 如果模型把 `qqbot_send_file` 写成 `<qqbot_send_file>...` 文本标签，出站层会剥离该标签，不再把 XML 发给用户；为避免重复发送，伪标签不会触发第二次发送。

## B 站只读工具

插件注册了 6 个只读工具，肥鱼可以直接搜 B 站、看视频信息、读评论和字幕：

- `bili_search`：按关键词搜视频（标题/BVID/UP主/播放/日期）
- `bili_video`：单个视频的标题、UP主、播放/点赞/评论/收藏、简介、分P
- `bili_comments`：视频热门评论
- `bili_subtitle`：视频字幕（**需要登录**）
- `bili_login` / `bili_login_check`：扫码登录与状态检查

搜索、视频信息和评论走公开接口，不需要登录；字幕接口会返回 `need_login_subtitle`，所以字幕需要一次扫码登录。在 QQ 里对肥鱼说「登录 B 站」，它会调用 `bili_login` 把二维码发到当前会话；用手机 B 站扫码（确认时选「记住我 / 长期」），扫完说一声，它再调用 `bili_login_check` 保存凭证。

凭证只落在本机 `~/.dsh/bili-read/credential.json`，不进仓库、不打日志。工具集**不注册**发评论、投稿、私信、收藏、投币等写操作；想发内容仍由你自己决定。

**登录权限**：`bili_login` / `bili_login_check` 只允许**私聊里的主人/管理员**调用；群聊里调用会直接拒绝，避免任意群成员扫码把自己的 B 站号绑到 bot 上，也避免二维码在群里被抢扫。`bili_subtitle` 用登录态字幕，所以在已有凭证时也只对私聊主人/管理员开放；群聊仍可用 `bili_search` / `bili_video` / `bili_comments`（这三个用游客态，不消耗主人账号）。

> 参考了 [dsh-bili-scroll](https://github.com/c1overzz/dsh-bili-scroll) 内置的 `bilibili-mcp`（MIT）的接口与登录思路；这里只保留只读部分，并用纯 Node 实现，不依赖 Python/uv。

## 梗图/表情匹配

新增 `qqbot_match_sticker`：用户发来一张图时，先按 **SHA-256** 在 bot 自己的表情库 `stickers/index.json` 里查完全相同的图片。命中会返回情绪、备注和文件名，可以立即用 `qqbot_send_file` 发出去，或直接用这个情绪回应；不命中则返回 `matched: false`。

配套的 `meme-recognition` skill 负责「没命中」的情况：

1. `qqbot_match_sticker` 先查本地表情库；
2. `qqbot_describe_image` 转写梗图上的文字并描述模板；
3. 用 `web_search` 查 KnowYourMeme、萌娘百科、百度百科、B站/微博/小红书等来源，交叉核对梗的名称、出处和用法；
4. 按高/中/低置信度输出，查不到就说查不到，不编出处。

限制：目前是**精确哈希**，只匹配字节完全相同的图片；QQ 会重压缩图片，所以实际命中率有限。下一步可以加感知哈希（pHash/dHash），用 `sharp` 解码后比对，能匹配压缩/缩放后的同一张图。默认不上传图片做梗图反向搜索；trace.moe/SauceNAO 面向动漫，不适合梗图。

## 共享笔记（长期记忆）

`notes.root` 目录（默认是 agent 工作目录 `cwd` 下的 `notes/`）里的 Markdown 文件是 bot 的长期记忆，**所有群、私聊和本机会话共用一份**：

- **自动召回**：每条入站消息（含引用原文）都会检索笔记库，足够相关时把最多 `injectTopK` 段、共 `injectMaxChars` 字以 `[共享笔记 · 可能相关]` 注入到消息前。只撞上一个词的短消息（「哈哈」「随便」）不注入；`injectMinCoverage` 越高越保守。
- **`qqbot_notes_search`**：模型主动检索，返回最相关的几段。
- **`qqbot_notes_save`**：模型把值得长期记住的东西写进笔记库；新标题建文件，传 `file` 则追加小节，自动标注记录日期和来源（群聊/私聊/本机会话）。
- 检索是本地的：按 `#`/`##`/`###` 切段，中文二字切词 + BM25，不需要向量服务；文件改动后自动重建索引，人手增删改笔记立即生效。

注意：写进笔记的内容对所有会话可见，私聊里的东西也可能在群里被召回。不要让 bot 记隐私；群友也能通过聊天影响 bot 记什么，主人可以定期翻看 `notes/` 清理。设 `notes.enabled: false` 可整体关闭，`notes.autoInject: false` 只保留工具。

## 原生读图（deepseek-native）

Web profile 新增了一个 pi-ai 路由 `deepseek-native`：

- provider: `deepseek-native`
- model: `deepseek-flash`（DeepSeek V4.1 Flash）
- `defaultInput: [text, image]`，context 1M / maxTokens 256K
- QQ bot 已切到 `deepseek-native/deepseek-flash`，并开启 `vision.native: true`

开启后，入站图片会通过 `ctx.attachments.saveImage` 变成 `ImageBlock` 直接放进 user message，主模型直接看原图，不再先经过 `qqbot_describe_image` 的「图片 → 文字描述」链路。`qqbot_describe_image` 仍保留，用于逐字 OCR、图表/表格、长截图等原生看不动或需要专门提取的场景。

注意：

- **现有会话不会自动换模型**。在 QQ 里发 `/new`，或用 `/model` 选 `DeepSeek V4.1 Native`，新会话才会走原生读图；旧会话仍是旧的 `deepseek-official` 路由。
- Web GUI 的默认模型仍是 `deepseek-official/deepseek-flash`；要在 GUI 里原生读图，在模型选择里选 `DeepSeek V4.1 Native`。
- 这个路由走 pi-ai 的通用 OpenAI 适配器，不是官方 DeepSeek adapter；工具调用/推理已用子 agent 验收过（`read_image` 直接看图成功），但正式长期使用前建议再观察几轮。
- 如果 pi-ai 路由出现问题，回退方式：把 `im-qqbot.provider` 改回 `deepseek-official`，并把 `vision.native` 设为 `false`，原两段式链路即可恢复。
- 桌宠余额：`deepseek-native` 不在 dsh-pet 的内置余额 provider 表里。QQ 插件启动时会通过 `petApi7340.balance.register` 注册一个同接口的 `deepseek-native` provider（`/user/balance` + `DEEPSEEK_API_KEY`），所以桌宠在 native 下仍能查余额，并带 DeepSeek 峰/谷档位（北京时间工作日 9–12、14–18 为峰，其余及周末为谷）。若停用 QQ 插件，桌宠对 native 会退回 `unsupported`。

## 定时任务与 /new

DSH 的 schedule 是 **session-local** 的：`/new` 会换 sessionId，旧定时任务仍绑在旧 sessionId 上，不会自动迁移。插件现在会保留「旧 sessionId → 当前群会话」的退役映射，让旧 session 被 `schedule` 恢复时仍能把结果路由到当前 QQ 会话；但旧任务本身仍建议在新会话里重建。

从本版起，`/new` 还会**自动捕获旧会话的 active 定时任务**（daily / weekly / every），在新会话的第一条消息里注入 `[SCHEDULE MIGRATION AFTER /new]` 指令和 JSON 清单，让模型调用 `schedule_list` / `schedule_create` 重建。一次性的 `after` / `at` 任务不自动迁移，避免把已过期的一次性提醒误重建。

群聊的定时推送还受 QQ **主动消息权限**限制：日志里出现 `主动消息失败, 无权限` 时，需要群主/管理员在「群机器人 → 设置权限」里开启主动推送/全量消息。发送失败的内容不会再丢：插件会挂起，等下一次用户消息时注入 `[上次未送达]` 提示，模型可以在新的被动回复窗口里补发。

> `/new` 后如果旧任务仍需要，读 `state/schedule-migration.md`（或让 bot 用 `schedule_list` 查看当前会话）再 `schedule_create` 重建。

## 权限模型

- **消息入口**：`access.c2cMode` / `access.groupMode` 在 SDK 中间件层拦截；`allowlist` 下白名单为空会**拒绝所有**（fail-closed），不会退化成全放行。
- **改配置**：`/model`、`/preset` 的**修改**只允许 `ownerOpenid` 或 `adminOpenids` 中的用户；不带参数的查看/列出不受限。未配置 owner/admin 时保持旧行为（启动时打 warn），建议至少设置 `ownerOpenid`。
- **审批按钮**：c2c 会话本人可以审批自己的操作；群聊只有主人/管理员能点「允许/拒绝」。其他人的点击会被忽略，审批保持等待；群聊里如果主人不在，可把可信成员加入 `adminOpenids`。
- **文件访问**：`fileAccess.ownerOnly` + `ownerOpenid` 控制；`qqbot_send_file` 还有独立的路径白名单。
- **本地配置页**：`/qqbot/im-qqbot/config` 用于本机 Web/Desktop，依赖同源/本机信任；不要把 DSH Web 直接暴露到公网。
- **注意**：`/new`、`/compact`、`/stop` 仍是会话操作，对通过访问控制的用户开放；如果需要连这些也锁死，可以再加。

## 内置命令

| 命令 | 说明 |
|------|------|
| `/new`（别名 `/reset` `/clear`） | 开始新会话（清空上下文） |
| `/compact` | 压缩会话历史（摘要替换旧记录，保留上下文） |
| `/model` | 查看或切换模型 |
| `/preset` | 查看或切换 agent preset（新会话生效） |
| `/stop` | 中止当前生成 |
| `/bot-ping` | 网络延迟检测（返回传输与处理耗时） |
| `/bot-version` | 查看版本信息 |
| `/bot-status` | 查看当前会话状态 |
| `/bot-help` | 查看所有指令 |

## 核心模块

```
src/
├── index.ts                    # Cordis 插件入口（async apply）
├── config.ts                   # 配置 Schema
├── types.ts                    # 全局类型定义
├── setup/                      # 凭据绑定（扫码）
│   ├── index.ts                # 绑定编排（ensureCredentials）
│   ├── binding-service.ts      # 扫码状态机（宿主内唯一事实源）
│   ├── bind-routes.ts          # 端内绑定页路由（/qqbot/im-qqbot/bind）
│   ├── presenters.ts           # 呈现策略（终端/浏览器降级）
│   ├── qr-svg.ts               # 二维码 SVG 渲染（宿主侧）
│   └── persist.ts              # 凭据写入 cordis.patch.yml
├── client/                     # 浏览器半边（dsh.client Web Bundle）
│   ├── index.ts                # 侧栏 Tab + 插件管理页配置入口
│   ├── bind-page.ts            # 端内绑定页（二维码 + 状态轮询）
│   └── config-panel.ts         # 插件详情页配置表单（访问/模型/提示词等）
├── gateway/                    # 网关装配
│   ├── bootstrap.ts            # 启动装配（监听 session/event 等）
│   └── middleware-setup.ts     # 中间件链配置
├── transport/                  # 传输层
│   ├── inbound.ts              # QQ 入站消息 → agent.followup()
│   ├── outbound.ts             # session/event → QQ sendMarkdown
│   ├── outbound-buffer.ts      # 流式缓冲
│   ├── streaming-writer.ts     # 流式写入
│   ├── reply-target.ts         # 回复目标解析
│   ├── msgid-cache.ts          # 被动回复 msgid 缓存
│   ├── reply-limiter.ts        # 被动回复限流
│   ├── tool-presenter.ts       # 工具调用展示
│   └── chunker.ts              # Markdown 文本切分
├── session/                    # 会话管理层
│   ├── session-manager.ts      # QQ peer → Agent 映射
│   └── idle-evictor.ts         # 闲置回收
├── model/                      # 模型路由层
│   ├── model-resolver.ts       # 路由解析
│   ├── prefs-store.ts          # per-peer 偏好持久化
│   └── settings-reader.ts      # settings.yaml 只读
├── features/                   # 交互特性
│   ├── question-channel.ts     # ask_user_question 问答通道
│   ├── approval-channel.ts     # approval 审批确认通道
│   ├── group-memory.ts         # 群聊持久化记忆
│   └── answer-parser.ts        # 答案解析
├── media/                      # 多媒体
│   ├── vision-tool.ts          # 图片视觉理解
│   ├── send-file-tool.ts       # 发送本地文件
│   ├── sticker-store.ts        # 表情收藏/去重/索引/动态清单
│   ├── save-sticker-tool.ts    # qqbot_save_sticker 工具
│   └── media-cleaner.ts        # 媒体 TTL 清理
├── middleware/                 # 中间件
│   ├── question-answer.ts      # 问答答案处理
│   └── attachment.ts           # 附件处理
├── shared/                     # 共享工具
│   ├── utils.ts                # 通用函数与 profile 定位
│   ├── scope.ts                # scope/peer 提取
│   ├── send-helper.ts          # 分块发送
│   └── file-access.ts          # 文件访问/敏感路径拦截
└── commands/                   # 斜杠命令
```

## 会话路由

sessionKey: `qqbot:${appId}:${scope}:${peerId}`，由 SHA-256 确定性派生 SessionId，重启后可恢复。

解析策略：进程内复用 → 持久化恢复 → 全新创建。

## 设计原则

- **纯 Cordis 插件** — 遵循 dsh "Plugins, not loop changes" 原则
- **声明式依赖** — `inject = ['agents']`，不直接耦合其他插件
- **会话隔离** — 每个 QQ 私聊用户/群聊各一个独立 Agent
- **Preset 支持** — 可通过 `agent-presets` 服务挂载预设（工具集、prompt 等）
- **闲置回收** — 超时自动 dispose Agent，防止内存泄漏
- **Markdown 输出** — 回复以 Markdown 格式发送，支持代码块/表格感知切分
- **图片理解** — 支持 `qqbot_describe_image` 视觉理解，可分析用户发送的图片
- **附件发送** — 支持 `qqbot_send_file` 将本地文件发送给用户（默认启用路径白名单）
- **问答互动** — 支持 `ask_user_question`，单选生成内联按钮（点一个其余变灰）、多选回复编号，逐题推进 + 问题级超时
- **操作确认** — 支持 `approval/request`，关键操作通过「允许/拒绝」按钮请求用户确认

## 本地开发

```bash
# 安装依赖
pnpm install

# 构建
pnpm build

# 开发模式（watch）
pnpm dev

# 用 --patch 方式调试
export QQBOT_APPID="xxx" QQBOT_SECRET="xxx"
npx @deepseek-ai/dsh web --patch /path/to/dsh-qqbot/cordis.dev.yml
```

## 安全与隐私

- 凭据（AppID/AppSecret、API Key）只应存在于 profile 的 `cordis.patch.yml` 或环境变量中，**不要提交**。
- `.gitignore` 默认排除 `.env*`、`media/`、`stickers/`、`.dsh-sessions/` 等本地/运行期内容。`media/` 是 QQ 私聊/群聊附件缓存，可能包含他人隐私；`stickers/` 含用户投稿，提交前请确认版权与授权。
- 提交前用 `git status --short` 和 `git diff --cached` 复查；若曾误提交密钥，请立即在 QQ 开放平台重置 AppSecret，并清理 Git 历史。

## License

[MIT](./LICENSE)
