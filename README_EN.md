# DSH-qqBot

**[简体中文](./README.md) | English**

**A fork of [tencent-connect/dsh-qqbot](https://github.com/tencent-connect/dsh-qqbot). On top of the official QQ Bot plugin it adds a D&D campaign DM, long-term memory shared across sessions, a sticker library, read-only Bilibili tools, native image input and a set of group-chat improvements.**

> Installation, QR-code binding, the base config options, built-in commands and the overall architecture are unchanged from upstream: see the **[upstream README](https://github.com/tencent-connect/dsh-qqbot#readme)**. This file only covers what this repo adds or changes.

## What's new

| Area | Contents |
|------|----------|
| 🎲 Tabletop | D&D 5e AI dungeon master: dice, checks and initiative all go through tools, only a PC's own player can act for it, turn buttons, fog-of-war map, an original dungeon, wiki lookup |
| 💬 Group chat | Random interjections, persistent group memory, sees earlier images in the chat, answers only the triggering message, merged messages keep their senders, context cursor and auto-compaction |
| 🧠 Memory | A Markdown notes library shared by every session, recalled automatically by content; a group's own notes stay out of other groups |
| 😺 Stickers | Saves stickers based on the bot's mood, matches stickers by hash, a meme-recognition skill |
| 🖼 Media | Text and media in one message (`caption`), native image input via `deepseek-native`, voice recognition, video understanding, images in forwarded chats |
| 🔧 Tools | Read-only Bilibili tools, fanart picker, agent temp directory, scheduled cleanup |
| ⏰ Schedules | `/new` migrates scheduled tasks, failed proactive group messages are resent later |
| 🔒 Permissions | Empty allowlist fails closed, only owner/admins change config or click approvals, Bilibili login only in the owner's private chat, per-chat limits on terminal and file tools |
| 🧩 DSH integration | Install and configure from the DSH Web "Plugins" page, pet balance works with `deepseek-native` |

---

## 🎲 D&D 5e campaigns

Send `/dnd start` in a group and the bot becomes that group's dungeon master (DM). There is no preset switch and no new session: while a campaign is active, every turn gets two extra system-prompt sections (the DM rules and a compact campaign state), and after `/dnd end` the bot goes back to normal chat.

### Design principles

- **Every ruling goes through a tool.** Dice, checks, damage, HP, conditions, positions and resources only change through `dnd_*` tools; the model cannot make up numbers.
- **Secrets stay in tool results.** DCs, monster AC/HP, DM notes and secret doors only appear in tool results, and `dnd_*` results are never shown in the group. Players only hear a wound word for monsters (unhurt / lightly hurt / badly hurt / barely standing).
- **Only a PC's own player can act for it.** PCs are bound to their player's openid and only that player can declare their actions. The tool also checks that the player actually sent a message recently, so copying the openid off the sheet doesn't work.
- **Strict turn order.** In combat only the creature whose turn it is can act, and only a PC's own player can end that PC's turn (their bonus action or movement may still be unused).
- **Only a compact state goes into the prompt.** The full state lives in JSON; each turn gets a short summary, which keeps context costs down.

### For players

| Command | What it does |
|---------|--------------|
| `/dnd start [dungeon id]` | Start a campaign (an earlier campaign in the same dungeon resumes); in groups the message carries check-in buttons and the game opens once everyone is in |
| `/dnd new [dungeon id] [blank]` | Archive the old campaign and start fresh (blank drops the old character sheets) |
| `/dnd status` | Campaign state from the players' point of view |
| `/dnd checkin` | Re-send the check-in buttons |
| `/dnd end` | Pause (to get a story recap from the DM, just say you're stopping for tonight) |
| `/dnd dungeons` | List available dungeons |
| `/dnd search <term>` | Look up the [Huiji D&D wiki](https://dnd.huijiwiki.com/wiki/) (spells, skills, classes, feats, monsters…) |
| `/dnd spells [class]` | A class's spell list |
| `/dnd help` | How to play |

- **@ the bot and say what your character does.** Only that counts as an action. Chatting, rules questions and "show me the status" don't roll dice or use up your action.
- **Turn buttons.** When it's a PC's turn, the bot sends a message with buttons after the DM's reply.
  - **End turn**: only the PC's own player can use it; anyone else gets a "no permission" prompt. After the click, the tool advances initiative and the DM goes on to resolve the monsters' turns.
  - **Status**: answered directly by the tool, without the model.
  - **Attack / Cast / Other / Look up**: these only fill text into the clicker's own input box.
  - The bot needs message-button permission on the QQ Open Platform. If sending buttons fails, they switch off for the rest of that run and the game continues in plain text.
- **Splitting up.** Only the characters who said they're going move; everyone else stays put. The map marks every occupied room with a head count.
- **Rollbacks.** If the table agrees something was resolved wrongly, say "roll back to before X". The DM restores a snapshot instead of patching numbers by hand.

### DM tools

| Tool | Purpose |
|------|---------|
| `dnd_roll` | Any dice expression (`2d6+3`, `4d6kh3`…) |
| `dnd_check` | Skill/ability checks, saves, attacks, death saves. Keeps DC/AC hidden. Supports weapons, spell attacks, extra dice (guidance, bardic inspiration) and spending resources; applies damage on a hit |
| `dnd_apply` | Damage (with damage type and crits), healing, temp HP, conditions |
| `dnd_character` | Create and edit sheets: player binding, weapons, hit dice, items and gold. `srd=goblin count=3` adds improvised monsters with real SRD stats |
| `dnd_resource` | Spell slots, lay on hands pool, bardic inspiration, class feature uses |
| `dnd_rest` | Short rest (the tool rolls hit dice and heals) and long rest |
| `dnd_initiative` | Initiative start / next / goto / end / status; only creatures present join |
| `dnd_move` | Move between rooms (`who` for split parties, secret doors). Returns the player-facing description plus DM-only notes |
| `dnd_map` | Renders the explored part of the map with fog and sends it to the group (needs the optional `sharp` dependency) |
| `dnd_undo` | List recent changes, or undo N of them at once |
| `dnd_end` | End the session with a story recap, injected next time the campaign starts |
| `dnd_srd` | Look up 5e SRD monsters and spells (dnd5eapi.co) |

The tool layer also handles some rules on its own: PCs going down at 0 HP and making death saves, instant death from overflow damage, doubled dice on crits, and Undead Fortitude (not triggered by radiant damage or crits). Removing "dead" by hand is refused.

### Dungeons and data

- **Built-in dungeon "The Sunken Bell Monastery" (沉钟修道院).** An original 7-room dungeon for 3–5 characters of level 1–3, playable in one evening. Monster stats come from the SRD 5.1 (CC BY 4.0).
- **Custom dungeons.** Put JSON files with the same structure in `<dnd.root>/dungeons/` (room coordinates, player view, DM notes, exits and secret doors, encounters).
- **Campaign data.** One file per group at `<dnd.root>/campaigns/<session>.json`; change snapshots are kept in `campaigns/history/` (the last 40).
- **Copyright.** Don't commit the text of commercial modules (such as *Lost Mine of Phandelver*); keep them local for your own use.

---

## 💬 Group chat

- **Random interjections.** With `groupReplyProbability` > 0, group messages that don't @ the bot can trigger a reply at that probability. This is off while a campaign is active, so banter isn't mistaken for actions.
- **Persistent group memory.** Every group message, including ones that don't @ the bot, is written to JSONL, so long-term context survives restarts. Only messages since the last injection are added (the cursor is bound to the sessionId).
- **Sees earlier images.** When triggered, the bot downloads the latest few images from the chat history and tags them `[图片#n]`. They're attached natively only when the current message is about images; otherwise the paths stay available to look at on demand.
- **Answers only the triggering message.** History is background only; the reply targets `[Current message]`. Tool errors are hidden in group chats by default.
- **Merged messages keep their senders.** When several people @ the bot in a row and their messages get merged into one, each line keeps its own `[nickname (openid)]` instead of all being credited to the first sender.
- **Auto-compaction.** Once a session's context exceeds `autoCompactTokens` (default 120000), it is compacted in the background.
- **Passive reply window.** Once a group msgId has expired, replies are sent as proactive messages. Text that fails to send is held and offered to the model to resend with the next user message.

## 🧠 Shared notes (long-term memory)

The Markdown files under `notes.root` (default `cwd/notes`) are the bot's long-term memory. **Every group, private chat and local session shares the same set**, except for chat-specific notes:

- **Automatic recall.** Each message (including quoted text) is searched against the notes, and sufficiently relevant snippets are injected as `[共享笔记 · 可能相关]`.
- **Tools.** `qqbot_notes_search` searches; `qqbot_notes_save` creates a note or appends a section, stamped with the date and source.
- **Chat-specific notes.** `qqbot_notes_save` takes `scope`: `shared` (default) or `chat`. A `chat` note is stored under `notes/chats/<scope>_<peerId>/` and is only searched and recalled in that group or private chat, so one group's campaign isn't treated as something that happened in another. Notes that look like tabletop campaign records default to `chat`. Recalled chat notes are marked `[本会话]`, with a reminder that shared notes didn't necessarily happen in this group; campaign state comes from the `dnd_*` tools. Local sessions see every note.
- Search runs locally: BM25 with Chinese bigram tokenisation, no vector service. The index rebuilds automatically when files change.

> Shared notes are visible to every session, so something said in a private chat can be recalled in a group. Don't let the bot remember private information, and have the owner review `notes/` from time to time.

## 😺 Stickers

- **`qqbot_save_sticker`.** After seeing an image, the bot decides from its own mood whether to save it. Images are deduplicated by SHA-256, their real format is detected from the file header, and they're added to `stickers/index.json` and the sticker list in later turns.
- **`qqbot_match_sticker`.** Matches an incoming image exactly, by hash, against the bot's own sticker library.
- **`meme-recognition` skill.** When there's no match, it does OCR plus text search (KnowYourMeme, Moegirlpedia, Baidu, Bilibili…), answers with a confidence level and doesn't invent sources.

## 🖼 Media

- **Text and media together.** `qqbot_send_file` has a new `caption` parameter, so text and an image, video or file go out as one rich-media message. Stray `<qqbot_send_file>` text tags written by the model are stripped.
- **Native image input.** A new pi-ai route `deepseek-native` (`deepseek-flash`, text + image) plus `vision.native` hands images to the main model directly as `ImageBlock`s. `qqbot_describe_image` stays for OCR, charts and long screenshots. Existing sessions only switch after `/new` or `/model`.
- **Voice recognition.** With `asr.enabled`, voice messages that QQ didn't transcribe are downloaded (SILK is decoded to WAV with silk-wasm) and sent to an OpenAI-compatible `/audio/transcriptions` endpoint. The default is SiliconFlow SenseVoice; switching to Groq, OpenAI or a local whisper.cpp server only takes a different `baseUrl` and `model`.
- **Video understanding.** `qqbot_describe_video` uses ffmpeg to sample frames evenly from the first `video.maxSeconds` seconds (about one every 2 s, at most `video.maxFrames`), tiles them into one grid image for the vision model, and sends the audio track to `asr` at the same time. The result combines what's seen and what's said. It's registered only when vision is configured and ffmpeg/ffprobe can be found.
- **Images in forwarded chats.** QQ doesn't put the images from a forwarded chat record (合并转发) in the attachments; they only appear as `[附件n] 类型:图片 …` lines with a URL in the expanded text, and the URL stops working once it expires. These images are now extracted and downloaded to media (up to 8 per message), and the line is rewritten to `[图片#n: local path]`, numbered after earlier chat images. With `vision.native` on they go to the main model as native images, with a short note on which were downloaded and which only have a URL.

## 🔧 Tools

- **Read-only Bilibili tools.** `bili_search`, `bili_video`, `bili_comments` and `bili_subtitle`, plus QR login via `bili_login` / `bili_login_check`.
  - Read-only: no tools for posting comments, uploading or messaging.
  - Credentials stay on this machine in `~/.dsh/bili-read/`.
  - Login and subtitles are limited to the owner/admins in private chat.
  - The API approach follows [dsh-bili-scroll](https://github.com/c1overzz/dsh-bili-scroll) (MIT), reimplemented in plain Node.
- **Fanart picker `qqbot_fanart_pick`.** Draws a few candidates from pixiv/safebooru pairing tag pools and stitches them into a numbered contact sheet for the model to choose from; images that get sent are marked as seen.
- **Agent temp directory.** `tmpDir` (default `cwd/tmp`) is where scripts, screenshots and downloads go; entries untouched for `tmpTtlHours` are cleaned up automatically.
- **Scheduled cleanup.** Runs once at startup and then every hour, removing files by rule.
  - Built-in rules: files in `media/` older than `media.ttlHours`, plus oldest-first removal once the folder exceeds `media.maxTotalMB`; images in `media/fanart/` after 7 days (`seen*.json` is kept); `tmp/` per top-level entry (using the newest mtime inside it) after `tmpTtlHours`, plus oldest-first removal above `tmpMaxTotalMB`; and work folders that `qqbot_describe_video` left in the system temp folder after a crash, after 1 hour.
  - `cleanup.rules` adds more folders (such as `state/` for scheduled tasks). Each rule takes `unit` (`file` for each file, `entry` for each top-level entry as a whole), `ttlHours`, `keep` (names never deleted, such as `*.json` or `*.log`), `match`, `recursive` and `maxTotalMB`. A rule's folder must be inside the working directory, the plugin folder or the system temp folder, or the rule is ignored.
  - Symlinks are not followed; entries changed in the last 10 minutes are skipped when trimming to a size cap; `cleanup.dryRun` only logs what would be deleted.
  - The owner and admins can send `/bot-cleanup` to see each folder's usage and the last sweep, `/bot-cleanup run` to sweep now, or `/bot-cleanup dry` to see what would be deleted.
  - `~/.dsh/attachments` (dsh's own image store) is not touched, because older sessions still point to those files.

## ⏰ Scheduled tasks

- `/new` captures the old session's active daily/weekly/every tasks and injects instructions into the new session's first message to recreate them, deleting the originals so they don't fire twice. One-off tasks are not migrated.
- An "old sessionId → current session" mapping is kept, so an old task that is restored still reaches the current group.

## 🔒 Tighter permissions

- An empty `allowlist` now rejects everyone (fails closed) instead of falling back to allowing everyone.
- Changing `/model` or `/preset`, and clicking approval buttons in groups, is limited to `ownerOpenid` / `adminOpenids`.
- Approval cards are registered before they're sent, fixing a race with fast clicks; clicking an old card says it has expired.
- **Per-chat tool limits** (`toolAccess`). DSH's sandbox only restricts writes, not reads, so anyone in a group could have the bot read `~/.dsh/.env` or other groups' saves with pwsh/read/grep. A `tools.guard()` hook now checks each chat:
  - **Whitelisted chats** (the owner's private chat, `toolAccess.fullAccessGroups` / `fullAccessUsers`, and chats the owner approved in chat) are unrestricted.
  - **Other QQ chats** get no terminal (`pwsh` / `bash` / `terminal_*`) and no tools that start sub-agents (a sub-agent would bypass the check). File tools (read/grep/glob/write/edit/`qqbot_send_file` and so on) can only reach media, stickers, the temp directory and `toolAccess.readRoots`; symlinks are resolved first, and grep/glob need an explicit path. The prompt in these chats explains the limits.
  - `fileAccess.sensitivePaths` is blocked in every QQ chat, whitelisted or not.
  - Local sessions (Web/Desktop) are not affected.
- **`qqbot_tool_access`.** In the owner's private chat, asking the bot to "give group X the terminal" takes effect right away. In a group the model can only request it: the bot posts a confirm button, and the change applies only when the owner clicks it (QQ reports who clicked, so it can't be faked). Runtime grants are saved to `~/.dsh-qqbot/tool-access.json`.

## 🧩 DSH integration

- Install, enable and disable the plugin from the DSH Web "Plugins" page, and edit its config right on the details page (model, prompts, interjection probability, access control, owner openid, file allowlist…).
- Pet balance: registers a balance provider with the same interface for `deepseek-native`, including DeepSeek's peak/off-peak tiers.

---

## New config options

Upstream options are documented in the [upstream README](https://github.com/tencent-connect/dsh-qqbot#readme). These are new in this repo:

| Option | Default | Description |
|--------|---------|-------------|
| `groupReplyProbability` | `0` | Chance (0–1) of replying to a group message that doesn't @ the bot |
| `autoCompactTokens` | `120000` | Compact the context once it exceeds this many tokens (0 = off) |
| `tmpDir` / `tmpTtlHours` | `cwd/tmp` / `72` | Agent temp directory and how long before entries are cleaned up |
| `tmpMaxTotalMB` / `media.maxTotalMB` | `4096` / `1024` | Size cap for the temp directory / media; above it the oldest go first (0 = no cap) |
| `cleanup.rules` / `cleanup.dryRun` | `[]` / `false` | Extra cleanup rules; log only, delete nothing |
| `vision.native` | `false` | Hand images to the main model as native ImageBlocks |
| `asr.enabled` / `baseUrl` / `apiKey` / `model` | `false` / SiliconFlow / `''` (= `QQBOT_ASR_API_KEY`) / `FunAudioLLM/SenseVoiceSmall` | Online voice recognition |
| `asr.preferQQ` / `asr.timeoutMs` | `true` / `30000` | Skip the API when QQ already supplied recognised text; transcription timeout |
| `video.enabled` / `ffmpegPath` / `maxFrames` / `maxSeconds` | `true` / `''` (PATH) / `8` / `300` | Video understanding tool |
| `toolAccess.enabled` | `true` | Limit terminal and file tools per chat (off = every QQ chat can use the terminal and read any path) |
| `toolAccess.fullAccessGroups` / `fullAccessUsers` | `[]` / `[]` | Unrestricted group / private-chat openids (the owner's private chat is always unrestricted) |
| `toolAccess.readRoots` | `[]` | Extra directories file tools may reach in restricted chats (media, stickers and the temp directory are always allowed) |
| `stickers.*` | see config page | Sticker directory, allowed sources, size and entry limits |
| `notes.enabled` / `notes.root` | `true` / `cwd/notes` | Shared notes library |
| `notes.autoInject` / `injectTopK` / `injectMaxChars` / `injectMinCoverage` | `true` / `2` / `600` / `0.4` | Automatic recall |
| `fanart.enabled` / `proxy` / `poolDir` | `true` / `''` / `scripts/` | Fanart picker |
| `dnd.enabled` / `dnd.root` | `true` / `cwd/dnd` | Campaigns on/off and data directory |
| `dnd.turnButtons` | `true` | Send turn buttons when it's a player's turn |

## Running locally

```bash
pnpm install && pnpm build
npx @deepseek-ai/dsh plugin --profile qqbot add /path/to/dsh-qqbot
npx @deepseek-ai/dsh --profile qqbot
```

The plugin loads from `dist/`: after changing code, run `pnpm build` and **restart dsh** for it to take effect. Other install methods are in the upstream README.

## Security and privacy

- Keep credentials in the profile's `cordis.patch.yml` or in environment variables, never in the repo.
- Runtime data stays out of the repo: `media/` (attachments from group and private chats, which may involve other people's privacy), `stickers/` (user submissions), `notes/` (long-term memory), `dnd/` (campaign data) and `tmp/`.
- Check `git status --short` and `git diff --cached` before committing.

## Credits and license

- Upstream: [tencent-connect/dsh-qqbot](https://github.com/tencent-connect/dsh-qqbot) (MIT)
- Host: [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
- Monster and spell data: System Reference Document 5.1 (Wizards of the Coast, [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/))
- Rules reference: [Huiji D&D wiki](https://dnd.huijiwiki.com/wiki/)

[MIT](./LICENSE)
