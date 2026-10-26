/**
 * qqbot_notes_search / qqbot_notes_save — 共享笔记库的检索与记录工具。
 *
 * 笔记库被所有 QQ 会话（各个群、私聊）和本机会话共享：一个会话里记下的东西，
 * 别的会话下次检索就能用。记录时自动标注来源（群聊/私聊），方便主人回看和清理。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { DshAgent, SessionManager } from '../session/index.ts';
import type { Logger } from '../types.ts';
import type { NoteHit, NotesStore, SaveNoteResult } from './notes-store.ts';

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
  + 'confidence), secrets, or one-off chatter; everything saved is visible to every group and private chat. '
  + 'A new title creates a new note file; pass `file` of an existing note to append a section to it.';

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
    async execute(args: unknown): Promise<Record<string, unknown>> {
      const { query, limit } = args as SearchArgs;
      if (typeof query !== 'string' || query.trim().length === 0) {
        throw new Error('qqbot_notes_search: `query` 不能为空');
      }
      const n = typeof limit === 'number' && Number.isFinite(limit) ? Math.min(8, Math.max(1, Math.floor(limit))) : 4;
      const hits = store.search(query, n).map((hit) => ({
        file: hit.file,
        heading: hit.heading,
        text: hit.text,
        score: Math.round(hit.score * 100) / 100,
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
      const { title, content, file } = args as SaveArgs;
      if (typeof title !== 'string' || typeof content !== 'string') {
        throw new Error('qqbot_notes_save: `title` 和 `content` 必须是字符串');
      }
      const record = exec.agent !== undefined ? manager.findByAgent(exec.agent as DshAgent) : undefined;
      const source = record === undefined ? '本机会话' : (record.scope === 'group' ? '群聊' : '私聊');
      return store.save({
        title,
        content,
        source,
        ...(typeof file === 'string' && file.trim().length > 0 ? { file } : {}),
      });
    },
  });

  logger.info(`im-qqbot: 笔记工具已注册 root=${store.root}`);
}
