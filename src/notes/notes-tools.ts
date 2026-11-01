/**
 * qqbot_notes_search / qqbot_notes_save — 共享笔记库的检索与记录工具。
 *
 * 笔记库被所有 QQ 会话（各个群、私聊）和本机会话共享：一个会话里记下的东西，
 * 别的会话下次检索就能用。记录时自动标注来源（群聊/私聊），方便主人回看和清理。
 * scope="chat" 的笔记只属于当前群/私聊（如跑团进度、队伍配置），别的会话检索不到。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { DshAgent, SessionManager } from '../session/index.ts';
import type { Logger } from '../types.ts';
import { chatKeyOf, type NoteHit, type NotesStore, type SaveNoteResult } from './notes-store.ts';
import { findDmSecret } from '../features/campaign-secrets.ts';

export const NOTES_SEARCH_TOOL_NAME = 'qqbot_notes_search';
export const NOTES_SAVE_TOOL_NAME = 'qqbot_notes_save';

/** 检索结果里每段正文的最大字数 */
const SEARCH_SNIPPET_CHARS = 800;

const SEARCH_DESCRIPTION =
  'Search the shared notes library: long-term Markdown notes shared by every QQ group, private chat and local '
  + 'session. Use it when the conversation touches something you may have noted before (a series you watched, '
  + 'a person/group fact, a running joke, a how-to), or when an injected "[共享笔记]" hint looks relevant and you '
  + 'need more of it. Query with the key nouns in Chinese or English; returns the best matching sections.';

const SAVE_DESCRIPTION =
  'Write something worth remembering across all conversations into the shared notes library. Save your own '
  + 'distilled knowledge: summaries of what you read/watched, stable facts about a group, recurring jokes, '
  + 'lessons about how to reply. Do not save private information (phone numbers, addresses, anything said in '
  + 'confidence), secrets, or one-off chatter. scope="shared" (default) is visible to every group and private '
  + 'chat; scope="chat" is visible only to the current group/private chat — use it for anything tied to this '
  + 'chat alone: a D&D/TRPG campaign (party, characters, levels, progress, house rules, DM conventions), plans or '
  + 'facts about this group\'s members. Notes that look like TRPG campaign records default to "chat". '
  + 'For a running campaign, notes are only for things that outlive it (player preferences, DM conventions, running '
  + 'jokes): progress, loot, open threads and to-dos go into the campaign via dnd_progress, and DM secrets (DCs, '
  + 'monster stats, DM-only room notes, unrevealed things) never go into notes. '
  + 'A new title creates a new note file; pass `file` of an existing note to append a section to it.';

/** 看起来像跑团存档/约定的内容：没指定 scope 时默认只记到本会话，免得串到别的群 */
const CAMPAIGN_NOTE_PATTERN = /跑团|开团|结团|带团|模组|\/dnd|\bDM\b|\bKP\b|先攻|检定|角色卡|法术位|环位|\bHP\b/;

export function looksLikeCampaignNote(title: string, content: string): boolean {
  return CAMPAIGN_NOTE_PATTERN.test(`${title}\n${content}`);
}

interface ToolsRegistryLike {
  register(definition: unknown): unknown;
}

interface SearchArgs {
  query: string;
  limit?: number;
}

interface SaveArgs {
  title: string;
  content: string;
  file?: string;
  scope?: 'shared' | 'chat';
}

function renderHits(query: string, hits: readonly NoteHit[]): string {
  if (hits.length === 0) return `笔记库里没有和「${query}」相关的内容。`;
  return hits.map((hit, i) => {
    const text = hit.text.length > SEARCH_SNIPPET_CHARS ? `${hit.text.slice(0, SEARCH_SNIPPET_CHARS)}…` : hit.text;
    return `#${i + 1} ${hit.file} › ${hit.heading}\n${text}`;
  }).join('\n\n');
}

export function registerNotesTools(
  ctx: Context,
  store: NotesStore,
  manager: SessionManager,
  logger: Logger,
): void {
  const tools = ctx.get('tools') as ToolsRegistryLike | undefined;
  if (!tools?.register) {
    logger.warn('im-qqbot: tools 服务不可用，笔记工具未注册');
    return;
  }

  tools.register({
    name: NOTES_SEARCH_TOOL_NAME,
    description: SEARCH_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look for, e.g. "大肥鱼小课堂 第四集" or "群里谁养猫".' },
        limit: { type: 'integer', description: 'Max sections to return (1-8, default 4).' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          hits: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                file: { type: 'string' },
                heading: { type: 'string' },
                text: { type: 'string' },
                score: { type: 'number' },
                exact: { type: 'array', items: { type: 'string' } },
                similarity: { type: 'number' },
              },
              required: ['file', 'heading', 'text', 'score'],
              additionalProperties: false,
            },
          },
        },
        required: ['query', 'hits'],
        additionalProperties: false,
      },
      render: (_args: unknown, value: unknown): ContentBlock[] => {
        const v = value as { query: string; hits: NoteHit[] };
        return [{ type: 'text', text: renderHits(v.query, v.hits) }];
      },
    },
    async execute(args: unknown, exec: { agent?: unknown }): Promise<Record<string, unknown>> {
      const { query, limit } = args as SearchArgs;
      if (typeof query !== 'string' || query.trim().length === 0) {
        throw new Error('qqbot_notes_search: `query` 不能为空');
      }
      const n = typeof limit === 'number' && Number.isFinite(limit) ? Math.min(8, Math.max(1, Math.floor(limit))) : 4;
      const record = exec.agent !== undefined ? manager.findByAgent(exec.agent as DshAgent) : undefined;
      const chatKey = record === undefined ? undefined : chatKeyOf(record.scope, record.peerId);
      const hits = (await store.searchHybrid(query, n, chatKey)).map((hit) => ({
        file: hit.file,
        heading: hit.heading,
        text: hit.text,
        score: Math.round(hit.score * 100) / 100,
        ...(hit.exact === undefined ? {} : { exact: hit.exact.matched }),
        ...(hit.similarity === undefined ? {} : { similarity: Math.round(hit.similarity * 100) / 100 }),
      }));
      return { query, hits };
    },
  });

  tools.register({
    name: NOTES_SAVE_TOOL_NAME,
    description: SAVE_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short title of the note or section.' },
        content: { type: 'string', description: 'Markdown body. Keep it distilled; lists are fine.' },
        file: { type: 'string', description: 'Optional existing note file name to append to (e.g. 大肥鱼小课堂-课堂笔记.md).' },
        scope: {
          type: 'string',
          enum: ['shared', 'chat'],
          description: '"shared" = every chat can see it; "chat" = only this group/private chat (TRPG campaigns, this group\'s own affairs).',
        },
      },
      required: ['title', 'content'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          created: { type: 'boolean' },
          chars: { type: 'integer' },
          message: { type: 'string' },
        },
        required: ['file', 'created', 'chars', 'message'],
        additionalProperties: false,
      },
      render: (_args: unknown, value: unknown): ContentBlock[] => [
        { type: 'text', text: (value as SaveNoteResult).message },
      ],
    },
    async execute(args: unknown, exec: { agent?: unknown }): Promise<SaveNoteResult> {
      const { title, content, file, scope } = args as SaveArgs;
      if (typeof title !== 'string' || typeof content !== 'string') {
        throw new Error('qqbot_notes_save: `title` 和 `content` 必须是字符串');
      }
      const record = exec.agent !== undefined ? manager.findByAgent(exec.agent as DshAgent) : undefined;
      const source = record === undefined ? '本机会话' : (record.scope === 'group' ? '群聊' : '私聊');
      // 本会话开着团时，笔记会在之后的消息里被自动检索出来，DM 机密一旦写进去就可能被念给玩家
      const campaign = record === undefined ? undefined : manager.dndService?.active(record.sessionKey)?.campaign;
      if (campaign !== undefined) {
        const monsters = campaign.characters.filter((ch) => ch.kind === 'monster').map((ch) => ch.name);
        // 「刻德温 Kodwin」在笔记里常只写中文名或英文名，拆开分别匹配
        const pcs = campaign.characters.filter((ch) => ch.kind === 'pc').flatMap((ch) => ch.name.split(/\s+/));
        const secret = findDmSecret(`${title}\n${content}`, monsters, pcs);
        if (secret !== undefined) {
          throw new Error(`qqbot_notes_save: 跑团进行中，笔记${secret}。DM 机密（DC、怪物数值、DM 笔记）不写进笔记，去掉后再记；跑团进度用 dnd_progress 写进团档。`);
        }
      }
      // 本机会话没有「本会话」可言，一律记到共享区
      const chatOnly = record !== undefined
        && (scope === 'chat' || (scope === undefined && looksLikeCampaignNote(title, content)));
      return store.save({
        title,
        content,
        source,
        ...(chatOnly ? { chatKey: chatKeyOf(record.scope, record.peerId) } : {}),
        ...(typeof file === 'string' && file.trim().length > 0 ? { file } : {}),
      });
    },
  });

  logger.info(`im-qqbot: 笔记工具已注册 root=${store.root}`);
}
