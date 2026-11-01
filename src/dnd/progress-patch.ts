/**
 * dnd_progress 的增量写入：进度文本按「【段名】」分段，模型只交改动的段（set 覆盖、append 追加条目、remove 删条目），
 * 由这里和上一条进度合并。以前每次都要整份重写，存一次档就把整段进度再生成一遍。
 *
 * 不带段头的旧进度（或停团兜底摘要）整体算作开头的无名段，原样保留，新段接在后面。
 */

export interface ProgressSection {
  /** '' = 第一个段头之前的内容 */
  name: string;
  lines: string[];
}

export interface ProgressPatch {
  /** 段名 → 新内容（整段替换）；空字符串删掉这一段 */
  set?: Record<string, string>;
  /** 段名 → 追加的条目（每条一行，自动加「- 」） */
  append?: Record<string, string[]>;
  /** 段名 → 要删的条目：删掉这一段里包含该文字的行 */
  remove?: Record<string, string[]>;
}

export interface PatchResult {
  text: string;
  /** 实际改到的段 */
  changed: string[];
  /** remove 里没找到的条目，回给模型核对 */
  missed: string[];
}

const HEADER_RE = /^【([^】]+)】\s*(.*)$/;

export function parseProgress(text: string): ProgressSection[] {
  const sections: ProgressSection[] = [{ name: '', lines: [] }];
  for (const line of text.split(/\r?\n/)) {
    const m = HEADER_RE.exec(line.trim());
    if (m !== null) {
      sections.push({ name: m[1]!.trim(), lines: m[2]!.trim() === '' ? [] : [m[2]!.trim()] });
    } else if (line.trim() !== '') {
      sections.at(-1)!.lines.push(line.trimEnd());
    }
  }
  return sections.filter((s) => s.name !== '' || s.lines.length > 0);
}

export function formatProgress(sections: readonly ProgressSection[]): string {
  return sections
    .filter((s) => s.lines.length > 0)
    .map((s) => (s.name === '' ? s.lines.join('\n') : `【${s.name}】${s.lines.length === 1 ? s.lines[0] : `\n${s.lines.join('\n')}`}`))
    .join('\n');
}

/** 模型可能传「【待办】」或「待办」 */
function sectionName(raw: string): string {
  return raw.trim().replace(/^【|】$/g, '').trim();
}

function asItem(text: string): string {
  const t = text.trim();
  return /^[-·•*]/.test(t) ? t : `- ${t}`;
}

/** 比较条目时忽略列表符号和空白 */
function bare(text: string): string {
  return text.replace(/^[-·•*]\s*/, '').replace(/\s+/g, '');
}

export function isEmptyPatch(patch: ProgressPatch): boolean {
  return [patch.set, patch.append, patch.remove].every((m) => m === undefined || Object.keys(m).length === 0);
}

export function applyProgressPatch(base: string | undefined, patch: ProgressPatch): PatchResult {
  const sections = parseProgress(base ?? '');
  const changed = new Set<string>();
  const missed: string[] = [];
  const get = (name: string): ProgressSection => {
    let s = sections.find((x) => x.name === name);
    if (s === undefined) {
      s = { name, lines: [] };
      sections.push(s);
    }
    return s;
  };

  for (const [raw, value] of Object.entries(patch.set ?? {})) {
    const name = sectionName(raw);
    get(name).lines = value.split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim() !== '');
    changed.add(name);
  }
  for (const [raw, items] of Object.entries(patch.remove ?? {})) {
    const name = sectionName(raw);
    const s = sections.find((x) => x.name === name);
    for (const item of items) {
      const key = bare(item);
      const before = s?.lines.length ?? 0;
      if (s !== undefined && key !== '') s.lines = s.lines.filter((l) => !bare(l).includes(key));
      if ((s?.lines.length ?? 0) === before) missed.push(`${name}：${item}`);
      else changed.add(name);
    }
  }
  for (const [raw, items] of Object.entries(patch.append ?? {})) {
    const name = sectionName(raw);
    const s = get(name);
    for (const item of items) {
      if (item.trim() === '') continue;
      // 已经有同样的条目就不重复加（模型重试、两次存档写了同一条）
      if (!s.lines.some((l) => bare(l) === bare(item))) s.lines.push(asItem(item));
      changed.add(name);
    }
  }
  return { text: formatProgress(sections), changed: [...changed], missed };
}

/** 工具参数 → ProgressPatch：值可以是字符串或字符串数组 */
export function parseProgressPatch(args: { set?: unknown; append?: unknown; remove?: unknown }): ProgressPatch {
  const map = (value: unknown, joinWith: string | undefined): Record<string, string[]> | undefined => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const out: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const list = Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : (typeof v === 'string' ? [v] : []);
      if (sectionName(k) === '') continue;
      out[k] = joinWith === undefined ? list : [list.join(joinWith)];
    }
    return out;
  };
  const patch: ProgressPatch = {};
  const set = map(args.set, '\n');
  if (set !== undefined) patch.set = Object.fromEntries(Object.entries(set).map(([k, v]) => [k, v[0] ?? '']));
  const append = map(args.append, undefined);
  if (append !== undefined) patch.append = append;
  const remove = map(args.remove, undefined);
  if (remove !== undefined) patch.remove = remove;
  return patch;
}
