# Changelog

> [简体中文](./CHANGELOG.md)

This file records significant dsh-qqbot updates from a product perspective, focusing on user-visible changes.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Added

- **DSH plugin management**: install, enable/disable, and configure `@tencent-connect/dsh-qqbot` from the DSH Web Plugins page and the bundle detail form, without hand-editing profile files.
- **More editable settings**: group reply probability, group history size, session idle timeout, owner openid, and file-access allowlist / sensitive paths.
- **Automatic sticker collection**: the bot decides — based on how it feels about an image — whether to call `qqbot_save_sticker`; the tool deduplicates by content hash, updates `stickers/index.json`, and injects the new sticker into later turns' catalog, so the fixed persona table no longer needs manual edits.
- **Media with caption**: `qqbot_send_file` now accepts `caption`, so an image/video/file and the full reply can be sent as one rich-media message; the QQ-session prompt prefers caption over a separate text reply.
- **Bilibili read-only tools**: added `bili_search`, `bili_video`, `bili_comments`, `bili_subtitle` and QR login `bili_login` / `bili_login_check`; read-only, credentials stored locally, no comment/upload/DM write tools.
- **Native image input**: added the `deepseek-native` pi-ai route (`deepseek-flash`, text+image) and `vision.native`; QQ inbound images are committed as attachments and passed as ImageBlocks to the main model, skipping the `qqbot_describe_image` transcription. The tool remains as the OCR/chart fallback.
- **Automatic schedule migration after `/new`**: `/new` captures the old session's active daily/weekly/every schedules and injects a `schedule_list` / `schedule_create` rebuild instruction into the new session's first message; one-shot after/at tasks are not migrated.
- **Meme/sticker matching**: added `qqbot_match_sticker` (SHA-256 against the local `stickers/index.json`) plus a `meme-recognition` skill that falls back to OCR + KnowYourMeme/Moegirlpedia/Baidu/Bilibili text search. Exact hash only for now; perceptual hash is a follow-up.

### Changed

- **Config location**: in-app config moved from Settings → QQ Bot to Plugins → Installed plugins → `@tencent-connect/dsh-qqbot`; Settings keeps QR binding and status.
- **Linked installs**: profile resolution now uses `ctx.baseUrl`, `DSH_PROFILE_DIR`, and the installed link, fixing QR/config writes that could not locate the profile for local-path installs.
- **Runtime note**: in Web-plugin mode the bot shares the DSH Web process; do not run the standalone profile at the same time, or the same bot may open two connections.

### Fixed

- **Model ID clarification**: under `deepseek-official`, V4.1 Flash is `deepseek-flash`; `deepseek-v4-flash` belongs to the `deepseek-vision` route. This avoids keeping the old ID on the official route.
- **Long prompts failed to save**: raised the manual-config request body limit from 4KB to 256KB, so the config panel can save two full system prompts without `request body too large`.
- **Pseudo tool-call fallback**: when the model writes `qqbot_save_sticker` as text tags, the outbound layer strips the tags and executes the collection instead of sending XML to the user.
- **Pseudo send_file fallback**: `<qqbot_send_file>...` text tags are stripped by the outbound layer and do not trigger a second send.
- **Old session lost after `/new`**: kept a retired-session mapping (`old sessionId → current session`) so a resumed old schedule still routes to the current QQ conversation; failed sends are queued and a `[上次未送达]` hint is injected on the next user message for a resend.
- **Approval card failed**: pending is now registered before the card is sent (race fix); stale cards/plugin-reload clicks say “审批已失效” instead of showing a QQ approval failure.

### Security

- **Hardened permissions**: an empty allowlist no longer degrades to `['*']` (fail-closed); `/model` and `/preset` changes are owner/admin-only; approval buttons accept only owner/admin clicks; added `adminOpenids`.
- **Bilibili login permission**: `bili_login` / `bili_login_check` are c2c owner/admin-only and rejected in groups; when a credential exists, `bili_subtitle` is also c2c owner/admin-only; search/video/comments now use guest mode and do not consume the owner's account.

### Documentation

- README covers the Web-plugin workflow, file-access settings, automatic sticker collection, and safe-commit guidance; `.gitignore` / `.npmignore` now exclude runtime media and the local sticker pack.

## [0.5.2] - 2026-10-12

### Fixed

- **Fixed clean installs failing to activate**: 0.5.1 shipped with the old SDK range (`^1.0.4`), so clean installs resolved 1.0.4 and the disconnect logging feature crashed at startup (`TypeError`), failing plugin activation. The range is now `^1.0.5`.
- **Graceful degradation on stale SDKs**: environments that still carry an older SDK now skip the disconnect listener with an upgrade hint instead of failing activation.

## [0.5.1] - 2026-10-12

### Added

- **In-app QR binding**: bind your bot entirely from the DSH Desktop / Web settings page — scan with your phone's QQ or enter the AppID / AppSecret manually, with live binding status; the sidebar opens a guided page automatically while unbound. Credential rotation and unbinding are one click away.
- **In-app config panel**: no more hand-editing files — c2c/group access control (open, allowlist, disabled), mention-required in groups, streaming, tool-result display, model overrides and extra prompts, all applied automatically on save.

### Improved

- **Upgraded the QQ Bot SDK to 1.0.5**: disconnects are now logged with the reason and whether the bot will recover on its own, and a connection that can never be established fails fast with a clear reason instead of waiting forever.

## [0.5.0] - 2026-09-08

### Added

- **Image understanding**: send images to the bot and it will automatically understand their content (screenshots, photos, charts, etc.), and can analyze them together with text instructions.
- **File sending**: the bot can send local files (documents, images, etc.) directly to you, no longer limited to plain-text replies.
- **Proactive questions**: when the bot encounters uncertain information, it proactively asks you questions, letting you pick an answer with a single tap for smoother interaction.
- **Action confirmation**: before performing sensitive or critical operations, the bot requests confirmation, which you approve or block via "Allow/Deny" buttons.
- **Session compaction**: new `/compact` command to compress the current session history in one step, preserving context while freeing space — ideal for very long conversations.
- **Preset switching**: new `/preset` command to view or switch the bot's persona/behavior preset.
- **Network latency test**: upgraded `/bot-ping` to return network transport time and plugin processing time, making it easier to diagnose connection latency.

### Improved

- Long-task execution timeout extended to 30 minutes, so complex tasks are no longer interrupted mid-way.
- Direct and group chats now receive more context-appropriate system prompts.
- Failed proactive message pushes automatically fall back to passive replies, reducing "the bot didn't respond" situations.
- Media files such as images are automatically cleaned up after use, avoiding long-term disk usage.

### Fixed

- Fixed the `/stop` command not actually aborting in-progress generation (it was previously a no-op).
- Fixed the registration order of the approval channel, ensuring confirmation requests are captured and handled correctly.

### Documentation

- README updated with the new `/preset` and `/compact` commands, plus QR-code upgrade guidance.

## [0.4.0] - 2026-08-16

### Added

- **QR link**: when the QR code renders incorrectly, you can click the link printed in the terminal to complete scanning in a browser.

### Improved

- Supports auto-saving QR credentials on Windows (previously failed due to path issues).
- When auto-saving credentials fails, it now clearly guides manual configuration instead of silently dropping existing config.

### Documentation

- Added QR-code screenshots and upgrade guidance.

## [0.3.0] - 2026-08-15

### Added

- **File understanding**: send a file to the bot and it will automatically download and understand its contents, supporting extract, read, analyze, and more.
- **Streaming replies**: replies are displayed incrementally in real time, no need to wait for full generation — a smoother, more natural experience.
- **Visible progress**: when the bot runs tasks (running commands, reading/writing files), you can see what it is doing — no longer a "black box".
- **Error feedback**: when a task ends abnormally, the bot clearly explains the reason, no more "half replies" or "no response at all".

### Improved

- Correctly displays the speaker's nickname in group chats instead of an unreadable string.
- Automatically clears group chat history after replying to avoid cross-conversation interference.
- Voice messages are recognized and kept as text only, without extra invalid links.
- The bot now "actually gets things done": for requests like "download, extract, install", it executes real tool actions instead of just restating the steps.

### Fixed

- Fixed the bot being unable to read/write files (the working directory was misconfigured).
- Fixed duplicate content and too-few chunks in streaming replies.

## [0.1.0] - 2026-08-14

### Added

- **First release**: QQ bot integrated with an AI assistant, supporting direct and group chats.
- **Model switching**: supports switching between different AI models.
- **Common commands**: built-in help, status query, session management, and more.
- **QR binding**: bind the bot by scanning a QR code on first use, with simple setup.

### Fixed

- Fixed config parsing issues.
