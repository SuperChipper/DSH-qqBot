/**
 * QQ 平台渲染的「消息记录」文本 — 拆开后重新排版给模型看。
 *
 * 平台不给结构化数据，而是把几种完全不同的东西都渲染成同一种文本塞进 content / msg_elements[0].content：
 *   === 消息 1 ===
 *   [消息内容] …
 *   [发送者] …
 *   [消息类型] 引用消息
 *   [附件1] 类型:图片 …
 *   [关联消息]
 *   --- 第1条 ---
 *       [消息内容] …
 *
 * 1. 合并转发：一串消息，前面可能有 [群聊的聊天记录]。转发里套转发时，内层那条只有 [发送者]，
 *    内容平台不给——不标出来的话模型会以为这人什么都没说，或者自己编里面有什么。
 * 2. 引用一条回复：只有 消息 1，[关联消息] 是它回复的那条，不是转发。
 * 3. 群设为「仅 @ + N 条上下文」时的引用：消息 1 是空的「引用消息」（被引用的原文平台没给），
 *    后面跟的是上下文。SDK 把 msg_elements[0] 整段当引用原文，模型就会把上下文当成被引用的话。
 */
import { faceText } from './reply-desire.ts';

export interface RecordItem {
  content: string;
  sender?: string;
  isQuote: boolean;
  /** [附件n] 行原文（可能已被改写成 [图片#n: 路径]） */
  attachments: string[];
  related: RecordItem[];
}

export interface ParsedRecord {
  /** 带 [群聊的聊天记录] 标题，是明确的合并转发 */
  titled: boolean;
  items: RecordItem[];
}

export interface QuoteParts {
  /** 引用块正文；undefined = 平台没给被引用的原文 */
  quote?: string;
  /** 平台附带的上下文（不是被引用的内容） */
  context?: string;
}

const TITLE = '[群聊的聊天记录]';
const ITEM_RE = /^=== 消息 \d+ ===$/;
const RELATED_ITEM_RE = /^--- 第\d+条 ---$/;
const FIELD_RE = /^\[(消息内容|发送者|消息类型)\] ?(.*)$/;
const ATTACHMENT_RE = /^\[附件\d+\]/;
const FACE_RE = /<faceType=(\d+),faceId="[^"]*",ext="([^"]*)">/g;

/** 嵌套转发、不支持的消息类型：平台只给发送者不给内容 */
export const EMPTY_ITEM_NOTE = '（平台没给内容，多半是嵌套的聊天记录或不支持的消息，看不到里面）';
export const QUOTE_MISSING_NOTE = '（平台没给被引用的原文，你看不到这条；对方问起就直说看不到，别拿上下文或猜测顶替）';

function emptyItem(): RecordItem {
  return { content: '', isQuote: false, attachments: [], related: [] };
}

/** 解析平台渲染的消息记录；不是这种格式返回 undefined */
export function parseRecord(text: string): ParsedRecord | undefined {
  const lines = text.replace(/\r/g, '').split('\n');
  let start = 0;
  const titled = lines[0]?.trim() === TITLE;
  if (titled) start = 1;
  if (!ITEM_RE.test(lines[start]?.trim() ?? '')) return undefined;

  const items: RecordItem[] = [];
  let item = emptyItem();
  let current = item;
  let inContent = false;
  for (const raw of lines.slice(start)) {
    const line = raw.trim();
    if (ITEM_RE.test(line)) {
      item = emptyItem();
      items.push(item);
      current = item;
      inContent = false;
    } else if (RELATED_ITEM_RE.test(line)) {
      current = emptyItem();
      item.related.push(current);
      inContent = false;
    } else if (line === '[关联消息]') {
      inContent = false;
    } else if (ATTACHMENT_RE.test(line)) {
      current.attachments.push(line);
      inContent = false;
    } else {
      const field = FIELD_RE.exec(line);
      if (field !== null) {
        const value = field[2]!;
        if (field[1] === '消息内容') {
          current.content = value;
          inContent = true;
        } else {
          if (field[1] === '发送者') current.sender = value.trim();
          else if (value.trim() === '引用消息') current.isQuote = true;
          inContent = false;
        }
      } else if (inContent) {
        current.content += `\n${raw}`;
      }
    }
  }
  for (const each of items) {
    each.content = cleanContent(each.content);
    for (const related of each.related) related.content = cleanContent(related.content);
  }
  return { titled, items };
}

function cleanContent(content: string): string {
  return content
    .replace(FACE_RE, (_m, type: string, ext: string) => (type === '6' ? '[表情包]' : faceText(ext)))
    .replace(/<@!?[^>\s]+>/g, '')
    .trim();
}

function isBlank(item: RecordItem): boolean {
  return item.content === '' && item.attachments.length === 0 && item.related.length === 0;
}

function renderBody(item: RecordItem, indent: string): string {
  const parts: string[] = [];
  const nestedRecord = item.content === TITLE;
  if (nestedRecord) {
    parts.push(`[聊天记录，共 ${item.related.length} 条]`);
  } else if (item.content !== '') {
    parts.push(item.content);
  } else if (item.attachments.length === 0 && item.related.length === 0) {
    parts.push(EMPTY_ITEM_NOTE);
  }
  for (const attachment of item.attachments) parts.push(`${indent}${attachment}`);
  if (nestedRecord) {
    parts.push(renderList(item.related, `${indent}  `));
  } else {
    for (const related of item.related) {
      const who = related.sender !== undefined ? `${related.sender}：` : '';
      parts.push(`${indent}（这条在回复 ${who}${renderBody(related, `${indent}  `)}）`);
    }
  }
  return parts.join('\n');
}

function renderList(items: readonly RecordItem[], indent = ''): string {
  return items.map((item, i) => {
    const who = item.sender !== undefined ? `${item.sender}：` : '';
    return `${indent}${i + 1}. ${who}${renderBody(item, `${indent}   `)}`;
  }).join('\n');
}

/** 合并转发排版成编号列表；不是消息记录就原样返回 */
export function renderChatRecord(text: string): string {
  const parsed = parseRecord(text);
  if (parsed === undefined) return text;
  const items = parsed.items.filter((item) => !(isBlank(item) && item.sender === undefined));
  if (items.length === 0) return text;
  if (!parsed.titled && items.length === 1) return renderBody(items[0]!, '');
  return `[聊天记录，共 ${items.length} 条]\n${renderList(items)}`;
}

/** 把引用块文本拆成真正被引用的内容和平台附带的上下文 */
export function splitQuote(text: string): QuoteParts {
  const parsed = parseRecord(text);
  if (parsed === undefined) return { quote: text };
  const [first, ...rest] = parsed.items;
  // 第一条是空的「引用消息」：被引用的原文平台没给，后面的是上下文
  if (first !== undefined && first.isQuote && isBlank(first) && first.sender === undefined) {
    const context = rest.filter((item) => !(isBlank(item) && item.sender === undefined));
    return context.length > 0 ? { context: renderList(context) } : {};
  }
  return { quote: renderChatRecord(text) };
}
