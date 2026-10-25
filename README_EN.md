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
