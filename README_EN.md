# DSH-qqBot

**[简体中文](./README.md) | English**

**A fork of [tencent-connect/dsh-qqbot](https://github.com/tencent-connect/dsh-qqbot). On top of the official QQ Bot plugin it adds a D&D campaign DM, long-term memory shared across sessions, a sticker library, read-only Bilibili tools, native image input and a set of group-chat improvements.**

> Installation, QR-code binding, the base config options, built-in commands and the overall architecture are unchanged from upstream: see the **[upstream README](https://github.com/tencent-connect/dsh-qqbot#readme)**. This file only covers what this repo adds or changes.

## What's new

| Area | Contents |
|------|----------|
| 🎲 Tabletop | D&D 5e AI dungeon master: dice, checks and initiative all go through tools, only a PC's own player can act for it, turn buttons, fog-of-war map, an original dungeon, wiki lookup |
| 💬 Group chat | Random interjections, persistent group memory, sees earlier images in the chat, answers only the triggering message, merged messages keep their senders, context cursor and auto-compaction |
| 🧠 Memory | A Markdown notes library shared by every session, recalled automatically by content |
| 😺 Stickers | Saves stickers based on the bot's mood, matches stickers by hash, a meme-recognition skill |
| 🖼 Media | Text and media in one message (`caption`), native image input via `deepseek-native` |
| 🔧 Tools | Read-only Bilibili tools, fanart picker, agent temp directory |
| ⏰ Schedules | `/new` migrates scheduled tasks, failed proactive group messages are resent later |
| 🔒 Permissions | Empty allowlist fails closed, only owner/admins change config or click approvals, Bilibili login only in the owner's private chat |
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
| `/dnd start [dungeon id]` | Start a campaign (an earlier campaign in the same dungeon resumes) |
| `/dnd new [dungeon id]` | Archive the old campaign and start fresh |
| `/dnd status` | Campaign state from the players' point of view |
| `/dnd end` | Pause (to get a story recap from the DM, just say you're stopping for tonight) |
| `/dnd dungeons` | List available dungeons |
| `/dnd 查 <term>` | Look up the [Huiji D&D wiki](https://dnd.huijiwiki.com/wiki/) (spells, skills, classes, feats, monsters…) |
| `/dnd 法表 [class]` | A class's spell list |
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

The Markdown files under `notes.root` (default `cwd/notes`) are the bot's long-term memory. **Every group, private chat and local session shares the same set:**

- **Automatic recall.** Each message (including quoted text) is searched against the notes, and sufficiently relevant snippets are injected as `[共享笔记 · 可能相关]`.
- **Tools.** `qqbot_notes_search` searches; `qqbot_notes_save` creates a note or appends a section, stamped with the date and source.
- Search runs locally: BM25 with Chinese bigram tokenisation, no vector service. The index rebuilds automatically when files change.

> Notes are visible to every session, so something said in a private chat can be recalled in a group. Don't let the bot remember private information, and have the owner review `notes/` from time to time.

## 😺 Stickers

- **`qqbot_save_sticker`.** After seeing an image, the bot decides from its own mood whether to save it. Images are deduplicated by SHA-256, their real format is detected from the file header, and they're added to `stickers/index.json` and the sticker list in later turns.
- **`qqbot_match_sticker`.** Matches an incoming image exactly, by hash, against the bot's own sticker library.
- **`meme-recognition` skill.** When there's no match, it does OCR plus text search (KnowYourMeme, Moegirlpedia, Baidu, Bilibili…), answers with a confidence level and doesn't invent sources.

## 🖼 Media

- **Text and media together.** `qqbot_send_file` has a new `caption` parameter, so text and an image, video or file go out as one rich-media message. Stray `<qqbot_send_file>` text tags written by the model are stripped.
- **Native image input.** A new pi-ai route `deepseek-native` (`deepseek-flash`, text + image) plus `vision.native` hands images to the main model directly as `ImageBlock`s. `qqbot_describe_image` stays for OCR, charts and long screenshots. Existing sessions only switch after `/new` or `/model`.

## 🔧 Tools

- **Read-only Bilibili tools.** `bili_search`, `bili_video`, `bili_comments` and `bili_subtitle`, plus QR login via `bili_login` / `bili_login_check`.
  - Read-only: no tools for posting comments, uploading or messaging.
  - Credentials stay on this machine in `~/.dsh/bili-read/`.
  - Login and subtitles are limited to the owner/admins in private chat.
  - The API approach follows [dsh-bili-scroll](https://github.com/c1overzz/dsh-bili-scroll) (MIT), reimplemented in plain Node.
- **Fanart picker `qqbot_fanart_pick`.** Draws a few candidates from pixiv/safebooru pairing tag pools and stitches them into a numbered contact sheet for the model to choose from; images that get sent are marked as seen.
- **Agent temp directory.** `tmpDir` (default `cwd/tmp`) is where scripts, screenshots and downloads go; entries untouched for `tmpTtlHours` are cleaned up automatically.

## ⏰ Scheduled tasks

- `/new` captures the old session's active daily/weekly/every tasks and injects instructions into the new session's first message to recreate them, deleting the originals so they don't fire twice. One-off tasks are not migrated.
- An "old sessionId → current session" mapping is kept, so an old task that is restored still reaches the current group.

## 🔒 Tighter permissions

- An empty `allowlist` now rejects everyone (fails closed) instead of falling back to allowing everyone.
- Changing `/model` or `/preset`, and clicking approval buttons in groups, is limited to `ownerOpenid` / `adminOpenids`.
- Approval cards are registered before they're sent, fixing a race with fast clicks; clicking an old card says it has expired.

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
| `vision.native` | `false` | Hand images to the main model as native ImageBlocks |
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
