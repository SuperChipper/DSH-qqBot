<div align="center">

<img width="120" src="https://img.shields.io/badge/🤖-QQ_Bot-blue?style=for-the-badge" alt="QQ Bot" />

**A QQ Bot plugin for [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) (dsh), connecting DeepSeek AI assistants to QQ private and group chats.**

[![npm version](https://img.shields.io/npm/v/@tencent-connect/dsh-qqbot)](https://www.npmjs.com/package/@tencent-connect/dsh-qqbot)
[![License](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/tencent-connect/dsh-qqbot)](https://github.com/tencent-connect/dsh-qqbot)
[![QQ Bot](https://img.shields.io/badge/QQ_Bot-API_v2-red)](https://bot.q.qq.com/wiki/)

<br/>

**[简体中文](./README.md) | English**

Scan to join the QQ group / channel

<table>
<tr>
<td align="center" width="50%"><img src="./docs/assets/qqgroup.jpg" height="360" alt="QQ Group QR Code" /><br /><b>QQ Developer Group</b><br /><sub>Group ID: 1032635674</sub></td>
<td align="center" width="50%"><img src="./docs/assets/qqchannel.jpg" height="360" alt="QQ Channel QR Code" /><br /><b>QQ Developer Channel</b><br /><sub>Channel ID: 20dnumts4z</sub></td>
</tr>
</table>

</div>

## Architecture

```
QQ User → QQ WebSocket → dsh-qqbot → ctx.agents → dsh agent loop → LLM
                                 ↑                           │
                                 └── session/event ──────────┘
                                       (assistant reply → QQ sendMarkdown)
```

## Installation

### Method 1: Manual

```bash
# Add to a profile
npx @deepseek-ai/dsh plugin --profile qqbot add @tencent-connect/dsh-qqbot

# Start
npx @deepseek-ai/dsh --profile qqbot
```

On first launch, the plugin detects missing credentials and automatically starts the QR flow: a QR code is printed in the terminal → scan it with the QQ mobile app → credentials are saved to the profile, so subsequent launches require no re-scan.

<img src="./docs/assets/qrcode.png" alt="QR code scan example" width="280" />

> **Note**: Upgrade to `0.4.0` or later for browser-link scanning, which avoids QR code misalignment in some terminals.

### Method 2: Local path

```bash
# Build
cd /path/to/dsh-qqbot
pnpm install && pnpm build

# Add to a profile (local path)
npx @deepseek-ai/dsh plugin --profile qqbot add /path/to/dsh-qqbot

# Start
export QQBOT_APPID="yourAppID" QQBOT_SECRET="yourAppSecret"
npx @deepseek-ai/dsh --profile qqbot
```

### Method 3: --patch dev mode

```bash
export QQBOT_APPID="yourAppID" QQBOT_SECRET="yourAppSecret"
npx @deepseek-ai/dsh web --patch /path/to/dsh-qqbot/cordis.dev.yml
```

### Method 4: Run as a DSH Web plugin (recommended)

Install the bot into the profile your DSH Web GUI is using, then manage it from the sidebar **Plugins** page:

1. Open DSH Web, go to **Plugins → Add plugin → Install third-party plugin**, and enter a local directory (e.g. `/path/to/dsh-qqbot`) or the package name `@tencent-connect/dsh-qqbot`.
2. Enable `@tencent-connect/dsh-qqbot` under **Installed plugins**.
3. Open the bundle to edit model, prompts, group reply probability, access control, owner openid, and the file-access allowlist in its config form; saving reloads the plugin automatically.
4. QR binding, credential rotation, and unbinding remain under **Settings → QQ Bot**.

> **Runtime**: in this mode the bot shares the DSH Web process, so closing Web takes the bot offline. Do not start the standalone `qqbot` profile (for example, an old launcher script) at the same time — the same QQ bot would open two connections and may reply twice. Use Method 1/2 if you need 24/7 standalone operation.

## Configuration

> When running as a DSH Web plugin, most fields can be edited under **Plugins → Installed plugins → `@tencent-connect/dsh-qqbot`**. `appId`/`appSecret` go through the binding flow, and `cwd` remains a profile-patch / environment concern.

| Config | Type | Default | Description |
|------|------|--------|------|
| `appId` | string | **required** | QQ Bot AppID (or via `QQBOT_APPID` env var) |
| `appSecret` | string | **required** | QQ Bot AppSecret (or via `QQBOT_SECRET` env var) |
| `provider` | string | `deepseek-official` | LLM provider name (empty inherits the host default) |
| `model` | string | `deepseek-flash` | Model name; the DSH `deepseek-official` V4.1 Flash (empty inherits the host default) |
| `preset` | string | - | Agent preset id |
| `cwd` | string | `process.cwd()` | Agent working directory |
| `ownerOpenid` | string | - | Bot owner QQ openid (used by the file-access allowlist) |
| `adminOpenids` | string[] | `[]` | Extra config admins (may change model/preset and click approvals) |
| `requireMention` | boolean | `true` | Whether group messages require @bot to trigger |
| `groupReplyProbability` | number | `0` | Chance (0–1) of replying to a group message without @bot; 0 disables |
| `groupPrompt` | string | - | Extra system prompt for group chats |
| `directPrompt` | string | - | Extra system prompt for direct chats |
| `textChunkLimit` | number | `4500` | Max chars per message |
| `streaming` | boolean | `true` | Enable streaming output (always disabled in groups) |
| `sessionIdleTimeout` | number | `1800000` | Session idle timeout (ms), default 30 min |
| `processingTimeoutMs` | number | `1800000` | Processing timeout (ms), aborts the current LLM call |
| `maxQueue` | number | `20` | Max concurrent queue length |
| `historyLimit` | number | `10` | Group history buffer size |
| `askTimeoutMs` | number | `300000` | Question timeout (ms), default 5 min (ask_user_question) |
| `showToolResults` | boolean | `false` | Show successful tool-call results (errors always shown) |
| `debug` | boolean | `false` | Debug mode |

### Access control (access)

| Config | Type | Default | Description |
|------|------|--------|------|
| `access.c2cMode` | `open`/`allowlist`/`disabled` | `open` | Direct-chat access mode |
| `access.c2cAllow` | string[] | `[]` | Direct-chat allowlist (user openid) |
| `access.groupMode` | `open`/`allowlist`/`disabled` | `open` | Group access mode |
| `access.groupAllow` | string[] | `[]` | Group allowlist (group openid) |

### File access (fileAccess)

| Config | Type | Default | Description |
|------|------|--------|------|
| `fileAccess.ownerOnly` | boolean | `true` | Only the owner's direct chat may access files (requires `ownerOpenid`) |
| `fileAccess.extraAllow` | string[] | `[]` | Extra openids allowed to access files |
| `fileAccess.sensitivePaths` | string[] | `[]` | Sensitive paths (deny list); access/sending is blocked when matched |

### Rich media (media)

| Config | Type | Default | Description |
|------|------|--------|------|
| `media.enabled` | boolean | `true` | Enable rich media understanding (image/video download + tool analysis) |
| `media.maxMB` | number | `200` | Max download size (MB) |
| `media.ttlHours` | number | `24` | Media lifetime (hours), 0 = never expire |

### Vision (vision)

| Config | Type | Default | Description |
|------|------|--------|------|
| `vision.enabled` | boolean | `false` | Enable vision (qqbot_describe_image tool) |
| `vision.provider` | string | - | Vision model provider (e.g. pi-ai) |
| `vision.model` | string | - | Vision model id (e.g. qwen-vl-max) |
| `vision.maxBytes` | number | `10MB` | Max image bytes |
| `vision.maxTokens` | number | `1024` | Max output tokens |
| `vision.timeoutMs` | number | `120000` | Vision call timeout (ms) |

> When the host exposes the `deepseek-vision` route, use `vision.provider: deepseek-vision` with `vision.model: deepseek-v4-flash`; the text V4.1 Flash is `deepseek-flash` under `deepseek-official`. Do not mix the two.

### File sending (sendFile)

| Config | Type | Default | Description |
|------|------|--------|------|
| `sendFile.restrictPaths` | boolean | `true` | Enable path allowlist (media + cwd + extraRoots only) |
| `sendFile.extraRoots` | string[] | `[]` | Extra allowed root directories |

### Sticker collection (stickers)

| Config | Type | Default | Description |
|------|------|--------|------|
| `stickers.enabled` | boolean | `true` | Enable `qqbot_save_sticker` and the dynamic sticker catalog |
| `stickers.root` | string | `''` | Sticker directory; empty = `stickers/` under the plugin root |
| `stickers.extraRoots` | string[] | `[]` | Extra source directories allowed for collection (besides media) |
| `stickers.maxBytes` | number | `8388608` | Max size per sticker (8 MB) |
| `stickers.maxAutoEntries` | number | `200` | Max auto-saved entries |

## Automatic sticker collection

When the bot sees an image from a user, it understands the image first and then decides — based on how it feels — whether the image is worth keeping. Collection is done by the `qqbot_save_sticker` tool:

- Called only when the bot genuinely thinks "this captures a mood I would use later"; ordinary screenshots and long text images are skipped.
- SHA-256 deduplication means the same image is never stored twice; the default name is `fish_<emotion>.png`, with a numeric suffix on collisions.
- Saving updates `stickers/index.json` and injects the new entry into the **current session's next turn** system prompt — no need to edit the fixed table in the persona.
- If the model occasionally writes the call as `<qqbot_save_sticker>...` text, the outbound layer strips the tags and executes the collection; users never see the XML.
- Files go to `stickers/` under the plugin root by default; set `stickers.root` to a writable directory if needed. Auto-saved images are local runtime data and are excluded by `.gitignore`.
- If `stickers.root` is outside the agent cwd, add it to `sendFile.extraRoots`; otherwise `qqbot_send_file` refuses to send from there.

> If you keep the old `stickers/save-sticker.ps1` locally, it still works manually and shares the same `index.json` with the in-plugin tool.

## Image/video/file with caption

`qqbot_send_file` now accepts `caption`: put the entire reply text in it and QQ sends it together with the media as one rich-media message.

- The QQ-session prompt asks the model to use `caption` when sending an image with text and not to repeat the text separately.
- This is the low-risk path: normal text replies keep streaming; if the model still writes separate text, two bubbles can still happen.
- A guaranteed single bubble requires deferring the turn's text to the end and sending it as the caption with the image (losing streaming on media turns); this is not enabled yet.
- If the model writes `<qqbot_send_file>...` as plain text, the outbound layer strips the tags instead of sending XML; pseudo tags do not trigger a second send.

## Bilibili read-only tools

The plugin registers six read-only tools so the bot can search Bilibili, inspect videos, read comments and subtitles:

- `bili_search`: search videos (title/BVID/author/plays/date)
- `bili_video`: one video's title, author, stats, description, pages
- `bili_comments`: top public comments
- `bili_subtitle`: video subtitles (**login required**)
- `bili_login` / `bili_login_check`: QR login and status check

Search, video info and comments use public endpoints and need no login. The subtitle endpoint returns `need_login_subtitle`, so subtitles require a one-time QR login. Tell the bot "log in to Bilibili"; it calls `bili_login`, sends the QR to the current conversation, and after you scan (choose "remember me / long-term") and confirm, it calls `bili_login_check` to save the credential.

The credential is stored only at `~/.dsh/bili-read/credential.json` on this machine; it is never committed or logged. No write tools (comment, upload, DM, favorite, coin) are registered.

**Login permission**: `bili_login` / `bili_login_check` are allowed only for the **owner/admin in a c2c chat**; calls from a group are rejected, so an arbitrary group member cannot bind their Bilibili account or grab the QR. `bili_subtitle` uses the login, so when a credential exists it is also c2c owner/admin-only; groups can still use `bili_search` / `bili_video` / `bili_comments` (guest mode, no owner account usage).

> Based on the interface/login approach of the `bilibili-mcp` bundled with [dsh-bili-scroll](https://github.com/c1overzz/dsh-bili-scroll) (MIT); this implementation keeps only the read-only parts and is pure Node, with no Python/uv dependency.

## Meme/sticker matching

New `qqbot_match_sticker`: when the user sends an image, first check the bot's own sticker library (`stickers/index.json`) by **SHA-256** for an identical file. On a hit it returns the emotion, note and file name; send it with `qqbot_send_file` or use the emotion in the reply. On a miss it returns `matched: false`.

The `meme-recognition` skill handles misses:

1. `qqbot_match_sticker` checks the local library first;
2. `qqbot_describe_image` transcribes the meme text and describes the template;
3. `web_search` checks KnowYourMeme, Moegirlpedia, Baidu Baike, Bilibili/Weibo/Xiaohongshu and cross-checks the name, origin and usage;
4. Answers with high/medium/low confidence; says “not found” instead of inventing an origin.

Limitation: this is **exact-hash only**, so it matches bit-identical files; QQ recompresses images, so the hit rate is limited. A perceptual hash (pHash/dHash) with `sharp` would handle recompressed/resized copies. No reverse-image upload for memes by default; trace.moe/SauceNAO are for anime, not memes.

## Native image input (deepseek-native)

The Web profile now has a pi-ai route `deepseek-native`:

- provider: `deepseek-native`
- model: `deepseek-flash` (DeepSeek V4.1 Flash)
- `defaultInput: [text, image]`, 1M context / 256K maxTokens
- The QQ bot is switched to `deepseek-native/deepseek-flash` with `vision.native: true`

With this enabled, inbound images are committed through `ctx.attachments.saveImage` and inserted into the user message as `ImageBlock`s, so the main model sees the original image directly instead of going through the `qqbot_describe_image` “image -> text description” chain. `qqbot_describe_image` remains for verbatim OCR, charts/tables, long screenshots, and other cases where native vision is not enough.

Notes:

- **Existing sessions do not switch automatically.** Send `/new` in QQ, or use `/model` to select `DeepSeek V4.1 Native`; only new sessions use native image input. Old sessions stay on `deepseek-official`.
- The Web GUI default model is still `deepseek-official/deepseek-flash`; to use native vision there, select `DeepSeek V4.1 Native` in the model picker.
- This route uses the generic pi-ai OpenAI adapter, not the official DeepSeek adapter. Tool calls and reasoning were smoke-tested with a subagent (`read_image` saw the image directly), but observe it for a few turns before relying on it long-term.
- To roll back: set `im-qqbot.provider` back to `deepseek-official` and `vision.native` to `false`; the original two-stage chain returns.

## Schedules and /new

DSH schedules are **session-local**: `/new` changes the sessionId, while old scheduled tasks remain bound to the old sessionId. The plugin now keeps a retired-session mapping (`old sessionId → current group record`) so a resumed old session can still route its output to the current QQ conversation; the old tasks themselves should still be recreated in the new session.

Starting with this version, `/new` also **captures the old session's active schedules** (daily / weekly / every) and injects a `[SCHEDULE MIGRATION AFTER /new]` instruction plus a JSON list into the new session's first message, so the model can call `schedule_list` / `schedule_create` to rebuild them. One-shot `after` / `at` tasks are not auto-migrated, to avoid recreating an already-expired reminder.

Group scheduled pushes also depend on QQ **proactive-message permission**: when the log says `主动消息失败, 无权限`, the group owner/admin must enable proactive push / full-message permission in the group bot settings. Failed sends are no longer lost: the plugin queues the text and injects an `[上次未送达]` hint on the next user message, so the model can resend within a fresh passive-reply window.

> After `/new`, read `state/schedule-migration.md` (or use `schedule_list` in the current session) and recreate the tasks with `schedule_create`.

## Permission model

- **Message entry**: `access.c2cMode` / `access.groupMode` gate at the SDK middleware layer; an empty allowlist under `allowlist` mode **denies everyone** (fail-closed) and never degrades to allow-all.
- **Config changes**: only `ownerOpenid` or `adminOpenids` may **modify** via `/model` and `/preset`; no-arg viewing/listing stays open. With neither configured, the legacy behavior is kept (a warning is logged); set `ownerOpenid` at minimum.
- **Approval buttons**: in a c2c chat the user can approve their own operations; in a group only the owner/admins may click Allow/Reject. Other clicks are ignored and the approval stays pending. If the owner is absent from a group, add trusted members to `adminOpenids`.
- **File access**: `fileAccess.ownerOnly` + `ownerOpenid`; `qqbot_send_file` also has its own path allowlist.
- **Local config page**: `/qqbot/im-qqbot/config` is for the local Web/Desktop app and relies on same-origin/local trust; do not expose DSH Web directly to the public internet.
- **Note**: `/new`, `/compact`, and `/stop` remain available to users who pass the access policy; ask if you want those locked down too.

## Built-in Commands

| Command | Description |
|------|------|
| `/new` (aliases `/reset` `/clear`) | Start a new session (clear context) |
| `/compact` | Compact session history (replace old records with a summary) |
| `/model` | View or switch model |
| `/preset` | View or switch agent preset (applies to new sessions) |
| `/stop` | Abort the current generation |
| `/bot-ping` | Network latency test (transport & processing time) |
| `/bot-version` | View version info |
| `/bot-status` | View current session status |
| `/bot-help` | View all commands |

## Core Modules

```
src/
├── index.ts                    # Cordis plugin entry (async apply)
├── config.ts                   # Config schema
├── types.ts                    # Global types
├── setup/                      # Credential binding (QR)
│   ├── index.ts                # Binding orchestration (ensureCredentials)
│   ├── binding-service.ts      # QR state machine (single source of truth in the host)
│   ├── bind-routes.ts          # In-app binding routes (/qqbot/im-qqbot/bind)
│   ├── presenters.ts           # Presentation strategy (terminal / browser fallback)
│   ├── qr-svg.ts               # QR SVG rendering (host side)
│   └── persist.ts              # Credential writes to cordis.patch.yml
├── client/                     # Browser half (dsh.client Web Bundle)
│   ├── index.ts                # Sidebar tab + plugin-manager config entry
│   ├── bind-page.ts            # In-app binding page (QR + status polling)
│   └── config-panel.ts         # Bundle-detail config form (access/model/prompts)
├── gateway/                    # Gateway assembly
│   ├── bootstrap.ts            # Startup wiring (session/event listeners, etc.)
│   └── middleware-setup.ts     # Middleware chain config
├── transport/                  # Transport layer
│   ├── inbound.ts              # QQ inbound message → agent.followup()
│   ├── outbound.ts             # session/event → QQ sendMarkdown
│   ├── outbound-buffer.ts      # Streaming buffer
│   ├── streaming-writer.ts     # Streaming writer
│   ├── reply-target.ts         # Reply target resolution
│   ├── msgid-cache.ts          # Passive reply msgid cache
│   ├── reply-limiter.ts        # Passive reply rate limiter
│   ├── tool-presenter.ts       # Tool-call presentation
│   └── chunker.ts              # Markdown chunking
├── session/                    # Session management
│   ├── session-manager.ts      # QQ peer → Agent mapping
│   └── idle-evictor.ts         # Idle eviction
├── model/                      # Model routing
│   ├── model-resolver.ts       # Route resolution
│   ├── prefs-store.ts          # Per-peer preference persistence
│   └── settings-reader.ts      # settings.yaml read-only
├── features/                   # Interaction features
│   ├── question-channel.ts     # ask_user_question Q&A channel
│   ├── approval-channel.ts     # approval confirmation channel
│   ├── group-memory.ts         # Persistent group memory
│   └── answer-parser.ts        # Answer parsing
├── media/                      # Media
│   ├── vision-tool.ts          # Image vision understanding
│   ├── send-file-tool.ts       # Send local files
│   ├── sticker-store.ts        # Sticker collection / dedupe / index / dynamic catalog
│   ├── save-sticker-tool.ts    # qqbot_save_sticker tool
│   └── media-cleaner.ts        # Media TTL cleanup
├── middleware/                 # Middleware
│   ├── question-answer.ts      # Q&A answer handling
│   └── attachment.ts           # Attachment handling
├── shared/                     # Shared utilities
│   ├── utils.ts                # Common helpers + profile resolution
│   ├── scope.ts                # scope/peer extraction
│   ├── send-helper.ts          # Chunked send
│   └── file-access.ts          # File access / sensitive-path guard
└── commands/                   # Slash commands
```

## Session Routing

sessionKey: `qqbot:${appId}:${scope}:${peerId}`, with the SessionId derived deterministically via SHA-256 so sessions survive restarts.

Resolution strategy: in-process reuse → persisted resume → fresh create.

## Design Principles

- **Pure Cordis plugin** — follows the dsh "Plugins, not loop changes" principle
- **Declarative dependencies** — `inject = ['agents']`, no direct coupling to other plugins
- **Session isolation** — one independent Agent per QQ direct user / group
- **Preset support** — mount presets (toolkits, prompts, etc.) via the `agent-presets` service
- **Idle eviction** — auto-dispose Agents on timeout to prevent memory leaks
- **Markdown output** — replies sent as Markdown with code-block/table-aware chunking
- **Image understanding** — supports `qqbot_describe_image` vision to analyze images sent by users
- **File sending** — supports `qqbot_send_file` to send local files to users (path allowlist enabled by default)
- **Question interaction** — supports `ask_user_question` with inline keyboard buttons (mutually exclusive) or numbered replies, one question at a time with timeout
- **Approval confirmation** — supports `approval/request` to ask for user confirmation on critical actions via allow/deny buttons

## Local Development

```bash
# Install dependencies
pnpm install

# Build
pnpm build

# Dev mode (watch)
pnpm dev

# Debug via --patch
export QQBOT_APPID="xxx" QQBOT_SECRET="xxx"
npx @deepseek-ai/dsh web --patch /path/to/dsh-qqbot/cordis.dev.yml
```

## Security & Privacy

- Credentials (AppID/AppSecret, API keys) belong only in the profile's `cordis.patch.yml` or environment variables — **never commit them**.
- `.gitignore` excludes `.env*`, `media/`, `stickers/`, `.dsh-sessions/`, and other local/runtime content. `media/` holds QQ direct/group attachment caches and may contain other people's private content; `stickers/` includes user-submitted art — confirm copyright and permission before committing either.
- Review `git status --short` and `git diff --cached` before committing. If a secret was committed by mistake, rotate the AppSecret in the QQ Open Platform immediately and clean the Git history.

## License

[MIT](./LICENSE)
