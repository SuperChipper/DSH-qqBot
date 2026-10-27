# DSH-qqBot

**[English](./README_EN.md) | 简体中文**

**[tencent-connect/dsh-qqbot](https://github.com/tencent-connect/dsh-qqbot) 的二次开发版本：在官方 QQ Bot 插件的基础上，加了 D&D 跑团 DM、跨会话长期记忆、表情收藏、B 站只读工具、原生读图和一系列群聊体验改进。**

> 安装、扫码绑定、基础配置项、内置命令和整体架构都沿用上游，请看 **[上游 README](https://github.com/tencent-connect/dsh-qqbot#readme)**。本文只介绍这个仓库新增和改动的部分。

## 新增内容一览

| 方向 | 内容 |
|------|------|
| 🎲 跑团 | D&D 5e AI 地下城主：掷骰/检定/先攻全走工具、行动只认本人、回合按钮、迷雾地图、原创地城、wiki 速查 |
| 💬 群聊 | 概率插话、持久化群记忆、能看群里的历史图片、只回应触发消息、合并消息保留发送者、上下文游标与自动压缩 |
| 🧠 记忆 | 所有会话共享的 Markdown 笔记库，按内容自动召回 |
| 😺 表情 | 按情绪自动收藏表情、按哈希匹配表情、梗图识别 skill |
| 🖼 媒体 | 图文同发（caption）、`deepseek-native` 原生读图 |
| 🔧 工具 | B 站只读工具、同人图挑选（fanart picker）、Agent 临时目录 |
| ⏰ 定时 | `/new` 自动迁移定时任务、群聊主动消息失败后补发 |
| 🔒 权限 | allowlist fail-closed、主人/管理员才能改配置和点审批、B 站登录仅限私聊主人 |
| 🧩 DSH 集成 | 在 DSH Web「插件」页安装和配置、桌宠余额兼容 `deepseek-native` |

---

## 🎲 D&D 5e 跑团

在群里发 `/dnd start`，bot 就变成这个群的地下城主（DM）。不用换 preset 或开新会话：开团后每回合额外注入「DM 守则 + 精简团况」两段 system prompt，`/dnd end` 后恢复普通聊天。

### 设计原则

- **所有裁定都走工具**：骰点、检定、伤害、HP、状态、位置、资源都只能通过 `dnd_*` 工具改动，模型不能自己编点数。
- **机密留在工具结果里**：DC、怪物 AC/HP、DM 笔记、暗门都只出现在工具结果中（`dnd_*` 的结果永远不在群里展示）；怪物血量对玩家只给伤势词（毫发无伤 / 受了点伤 / 伤得不轻 / 摇摇欲坠）。
- **行动只认本人**：PC 绑定玩家 openid，只有本人宣告才能行动；工具还会核对这个人最近确实发过消息，模型照抄 openid 也冒充不了。
- **严格回合制**：战斗中只有当前回合的角色能主动行动；PC 的回合只有本人能结束（附赠动作、移动还没用完）。
- **每回合只注入精简摘要**：完整状态存在 JSON 里，prompt 里只放团况摘要，控制上下文成本。

### 玩家怎么玩

| 命令 | 说明 |
|------|------|
| `/dnd start [地城id]` | 开团（同一地城的旧团接着跑） |
| `/dnd new [地城id]` | 存档旧团，从头开新团 |
| `/dnd status` | 玩家视角的团况 |
| `/dnd end` | 暂停（想让 DM 写剧情摘要就直接说「今天先到这」） |
| `/dnd dungeons` | 列出可用地城 |
| `/dnd 查 <词条>` | 查 [灰机 D&D wiki](https://dnd.huijiwiki.com/wiki/)（法术、技能、职业、专长、怪物…） |
| `/dnd 法表 [职业]` | 职业法术列表 |
| `/dnd help` | 玩法说明 |

- **@bot 并说清楚角色做什么**才算行动；闲聊、问规则、「查询状态」都不算，不掷骰也不消耗动作。
- **回合按钮**：轮到 PC 时，bot 在 DM 的回复后补一条带按钮的消息。
  - 「结束回合」：只有本人点击有效，其他人点会收到无权限提示；点击后先攻由工具推进，DM 接着结算怪物回合。
  - 「查看状态」：由工具直接回复，不经过模型。
  - 「攻击 / 施法 / 其他行动 / 查询」：只往自己的输入框里预填文字。
  - 机器人需要开通 QQ 开放平台的消息按钮权限；发送失败会在本次运行中自动关闭按钮，退回纯文字推进。
- **分头行动**：只有说了要走的人才会移动，其他人留在原地；地图上每个有人的房间各标一个人数。
- **判错了可以回滚**：大家同意的话说「卷回到 xx 之前」，DM 会用快照撤销，不会靠改数字硬凑。

### DM 工具

| 工具 | 作用 |
|------|------|
| `dnd_roll` | 任意骰子表达式（`2d6+3`、`4d6kh3`…） |
| `dnd_check` | 技能/属性检定、豁免、攻击、死亡豁免；隐藏 DC/AC；武器、法术攻击、额外骰（引导术/激励）、消耗资源，命中后自动扣血 |
| `dnd_apply` | 伤害（带伤害类型/重击）、治疗、临时 HP、状态 |
| `dnd_character` | 建卡/改卡（玩家绑定、武器、生命骰、物品金币）；`srd=goblin count=3` 从 SRD 取真实数值临时加怪 |
| `dnd_resource` | 法术位、圣疗池、诗人激励、职业特性次数 |
| `dnd_rest` | 短休（工具掷生命骰回血）/ 长休 |
| `dnd_initiative` | 先攻 start / next / goto / end / status；只拉在场的人 |
| `dnd_move` | 房间移动（`who` 分头行动、暗门发现），返回玩家视角描述 + DM 机密 |
| `dnd_map` | 渲染已探索部分的迷雾地图并发到群里（需要可选依赖 `sharp`） |
| `dnd_undo` | 列出最近改动 / 一次撤销 N 步 |
| `dnd_end` | 结团并写剧情摘要，下次开团时注入 |
| `dnd_srd` | 查 5e SRD 怪物/法术（dnd5eapi.co） |

工具层还自动处理部分规则：PC 0 HP 倒地与死亡豁免、溢出伤害即死、重击骰子翻倍、「不死坚韧」（光耀伤害和重击不触发）；手动解除「死亡」会被拒绝。

### 地城与数据

- **内置地城「沉钟修道院」**：原创的 7 房间小地城，适合 1–3 级、3–5 人一晚打完，怪物数值取自 SRD 5.1（CC BY 4.0）。
- **自定义地城**：把同结构的 JSON 放进 `<dnd.root>/dungeons/`（房间坐标、玩家视角、DM 笔记、出口/暗门、遭遇）。
- **团的数据**：每个群一份 `<dnd.root>/campaigns/<会话>.json`，改动快照存在 `campaigns/history/`（最近 40 步）。
- **版权**：商业模组（如《凡达林的失落矿坑》）的文本不要提交进仓库，只放在本地自用。

---

## 💬 群聊体验

- **概率插话**：`groupReplyProbability` > 0 时，没有 @bot 的群消息也会按概率触发回复；开团期间自动关闭，避免把闲聊当成行动。
- **持久化群记忆**：所有群消息（包括没 @bot 的）落盘为 JSONL，重启后能接上长期上下文；只注入上次之后的新消息（游标绑定 sessionId）。
- **能看群里的历史图片**：被触发时下载最近几张历史图片，标成 `[图片#n]`。当前消息在说图时才原生注入，其余的留路径按需查看。
- **只回应触发消息**：历史只作背景，回复只针对 `[Current message]`；群聊里默认隐藏工具报错。
- **合并消息保留发送者**：几个人连续 @bot 被合并成一条时，每行带上自己的 `[昵称 (openid)]`，不会都算到第一个人头上。
- **自动压缩**：会话上下文超过 `autoCompactTokens`（默认 120000）后在后台压缩。
- **被动回复窗口**：群聊 msgId 过期后改为主动发送；发送失败的文字会挂起，等下一次用户消息时提示模型补发。

## 🧠 共享笔记（长期记忆）

`notes.root`（默认 `cwd/notes`）下的 Markdown 是 bot 的长期记忆，**所有群、私聊和本机会话共用一份**：

- **自动召回**：每条消息（含引用原文）检索笔记库，足够相关时注入 `[共享笔记 · 可能相关]`。
- **工具**：`qqbot_notes_search` 检索，`qqbot_notes_save` 新建或追加小节（自动标注日期和来源）。
- 本地 BM25 + 中文二字切词，不需要向量服务；文件改动后自动重建索引。

> 笔记对所有会话可见，私聊内容也可能在群里被召回。不要让 bot 记隐私，主人应定期翻看 `notes/` 清理。

## 😺 表情

- **`qqbot_save_sticker`**：bot 看到图片后按自己的情绪决定要不要收藏。按 SHA-256 去重，按文件头识别真实格式，写入 `stickers/index.json`，并注入后续对话的表情清单。
- **`qqbot_match_sticker`**：用户发来的图按哈希在自己的表情库里精确匹配。
- **`meme-recognition` skill**：没命中时 OCR + 文本检索（KnowYourMeme、萌娘百科、百度、B 站…），按置信度回答，不编出处。

## 🖼 媒体

- **图文同发**：`qqbot_send_file` 新增 `caption`，文字和图片/视频/文件作为同一条富媒体消息发出；模型误写的 `<qqbot_send_file>` 文本标签会被剥离。
- **原生读图**：新增 pi-ai 路由 `deepseek-native`（`deepseek-flash`，text + image）和 `vision.native`，图片作为 `ImageBlock` 直接交给主模型；`qqbot_describe_image` 保留给 OCR、图表、长截图。已有会话需要 `/new` 或 `/model` 切换后才生效。

## 🔧 工具

- **B 站只读工具**：`bili_search`、`bili_video`、`bili_comments`、`bili_subtitle`，以及扫码登录 `bili_login` / `bili_login_check`。
  - 只读，不注册发评论、投稿、私信等写操作。
  - 凭证只存在本机 `~/.dsh/bili-read/`。
  - 登录和字幕仅限私聊主人/管理员。
  - 参考了 [dsh-bili-scroll](https://github.com/c1overzz/dsh-bili-scroll)（MIT）的接口思路，用纯 Node 实现。
- **同人图挑选 `qqbot_fanart_pick`**：从 pixiv/safebooru 的 CP 标签池抽几张候选，拼成带编号的预览图让模型挑选；发出去的图记为已看过。
- **Agent 临时目录**：`tmpDir`（默认 `cwd/tmp`），脚本、截图、下载都写在这里；超过 `tmpTtlHours` 没改动的条目自动清理。

## ⏰ 定时任务

- `/new` 会捕获旧会话里还在生效的 daily/weekly/every 任务，在新会话第一条消息中注入重建指令，并删除旧会话里的原任务避免重复触发；一次性任务不迁移。
- 保留「旧 sessionId → 当前会话」的映射，旧任务恢复时仍能路由到当前群。

## 🔒 权限收紧

- `allowlist` 为空时拒绝所有人（fail-closed），不再退化成全放行。
- `/model`、`/preset` 的修改，以及群聊审批按钮，只有 `ownerOpenid` / `adminOpenids` 能操作。
- 审批卡片先登记再发送，修复快速点击的竞态；旧卡片点击会提示已失效。

## 🧩 DSH 集成

- 可以在 DSH Web 的「插件」页安装、启停，并在详情页直接修改配置（模型、提示词、插话概率、访问控制、主人 openid、文件白名单…）。
- 桌宠余额：为 `deepseek-native` 注册同接口的余额 provider，并带 DeepSeek 峰/谷档位。

---

## 新增配置项

上游已有的配置项见[上游 README](https://github.com/tencent-connect/dsh-qqbot#readme)。下面是本仓库新增的：

| 配置 | 默认值 | 说明 |
|------|--------|------|
| `groupReplyProbability` | `0` | 群聊未 @ 时随机回复概率（0–1） |
| `autoCompactTokens` | `120000` | 上下文超过此 token 数时自动压缩（0 = 关闭） |
| `tmpDir` / `tmpTtlHours` | `cwd/tmp` / `72` | Agent 临时目录及清理时间 |
| `vision.native` | `false` | 图片作为原生 ImageBlock 交给主模型 |
| `stickers.*` | 见配置页 | 表情目录、来源白名单、大小与条目上限 |
| `notes.enabled` / `notes.root` | `true` / `cwd/notes` | 共享笔记库 |
| `notes.autoInject` / `injectTopK` / `injectMaxChars` / `injectMinCoverage` | `true` / `2` / `600` / `0.4` | 自动召回 |
| `fanart.enabled` / `proxy` / `poolDir` | `true` / `''` / `scripts/` | 同人图挑选 |
| `dnd.enabled` / `dnd.root` | `true` / `cwd/dnd` | 跑团开关与数据目录 |
| `dnd.turnButtons` | `true` | 轮到玩家时发回合按钮 |

## 本地运行

```bash
pnpm install && pnpm build
npx @deepseek-ai/dsh plugin --profile qqbot add /path/to/dsh-qqbot
npx @deepseek-ai/dsh --profile qqbot
```

插件加载的是 `dist/`：改完代码要 `pnpm build`，并**重启 dsh** 才会生效。其他安装方式见上游 README。

## 安全与隐私

- 凭据只放在 profile 的 `cordis.patch.yml` 或环境变量里，不要提交。
- 运行期数据不进仓库：`media/`（群聊和私聊附件，可能涉及他人隐私）、`stickers/`（用户投稿）、`notes/`（长期记忆）、`dnd/`（团的数据）、`tmp/`。
- 提交前用 `git status --short` 和 `git diff --cached` 复查。

## 致谢与许可

- 上游：[tencent-connect/dsh-qqbot](https://github.com/tencent-connect/dsh-qqbot)（MIT）
- 宿主：[deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
- 怪物与法术数据：System Reference Document 5.1（Wizards of the Coast，[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)）
- 规则查阅：[灰机 D&D wiki](https://dnd.huijiwiki.com/wiki/)

[MIT](./LICENSE)
