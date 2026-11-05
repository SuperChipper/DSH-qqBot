/**
 * 群聊人设 — 每个人设一个文件，按群选用。
 *
 * ~/.dsh-qqbot/personas/<id>.md，放进目录就能选，不用改配置也不用重载；每次都重新读目录，
 * 改文件下一轮就生效。文件头可写 name（显示名）和 names（群里叫 bot 的称呼），正文就是整段 system prompt。
 * 不选就用配置里的 groupPrompt，这个「默认」人设没有文件。
 *
 * 除了选中谁，还按「群 + 人设」记 sessionId：只换 prompt 没用，旧回复的语气会盖过新人设，
 * 所以每个人设有自己的会话，切回来接着聊。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import yaml from 'js-yaml';
import type { Logger } from '../types.ts';

export const DEFAULT_PERSONA_ID = 'default';
export const DEFAULT_PERSONA_NAME = '默认';

export interface Persona {
  id: string;
  name: string;
  /** 群里叫 bot 的称呼；空 = 沿用 replyDesire.names */
  names: string[];
  prompt: string;
}

interface PersonaState {
  /** 群 → 选中的人设 id；没有就是默认 */
  groups: Record<string, string>;
  /** 群 → 人设 id → sessionId */
  sessions: Record<string, Record<string, string>>;
}

const FRONT_MATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/;

/** 解析人设文件；正文为空或文件头写坏时抛错 */
export function parsePersona(id: string, text: string): Persona {
  const match = FRONT_MATTER_RE.exec(text);
  const head = match === null ? {} : yaml.load(match[1]!);
  const body = (match === null ? text : match[2]!).trim();
  if (body === '') throw new Error('正文为空');
  if (head === null || typeof head !== 'object' || Array.isArray(head)) throw new Error('文件头不是键值对');
  const { name, names } = head as { name?: unknown; names?: unknown };
  const list: unknown[] = Array.isArray(names) ? names : names === undefined || names === null ? [] : [names];
  return {
    id,
    name: typeof name === 'string' && name.trim() !== '' ? name.trim() : id,
    names: list.map((value) => String(value).trim()).filter((value) => value !== ''),
    prompt: body,
  };
}

export class PersonaStore {
  private readonly dir: string;
  private readonly statePath: string;
  private readonly logger?: Logger;
  private state: PersonaState = { groups: {}, sessions: {} };
  /** 每轮都读目录，坏文件只警告一次，不然日志会被刷满 */
  private readonly warned = new Set<string>();

  public constructor(options: { dir?: string; statePath?: string; logger?: Logger } = {}) {
    const home = resolve(homedir(), '.dsh-qqbot');
    this.dir = options.dir ?? join(home, 'personas');
    this.statePath = options.statePath ?? join(home, 'persona-state.json');
    this.logger = options.logger;
    try {
      if (existsSync(this.statePath)) {
        const parsed = JSON.parse(readFileSync(this.statePath, 'utf8')) as Partial<PersonaState>;
        this.state = { groups: parsed.groups ?? {}, sessions: parsed.sessions ?? {} };
      }
    } catch (err) {
      this.logger?.warn(`im-qqbot: 人设选择记录读取失败，各群回到默认人设: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 目录里的人设，按文件名排序；_ 开头的文件留给共用片段，不算人设 */
  public list(): Persona[] {
    let files: string[];
    try {
      files = readdirSync(this.dir).filter((file) => file.endsWith('.md') && !file.startsWith('_')).sort();
    } catch {
      return [];
    }
    const personas: Persona[] = [];
    for (const file of files) {
      const id = basename(file, '.md');
      if (id === DEFAULT_PERSONA_ID) continue;
      try {
        personas.push(parsePersona(id, readFileSync(join(this.dir, file), 'utf8')));
        this.warned.delete(file);
      } catch (err) {
        if (!this.warned.has(file)) {
          this.warned.add(file);
          this.logger?.warn(`im-qqbot: 人设文件 ${file} 无法使用，已跳过: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    return personas;
  }

  /** 按 id 或显示名找；默认人设没有文件，返回 undefined */
  public find(idOrName: string): Persona | undefined {
    const personas = this.list();
    return personas.find((persona) => persona.id === idOrName) ?? personas.find((persona) => persona.name === idOrName);
  }

  /** 这个群选中的人设；选的是默认，或文件已被删掉时返回 undefined */
  public current(groupId: string): Persona | undefined {
    const id = this.state.groups[groupId];
    return id === undefined ? undefined : this.list().find((persona) => persona.id === id);
  }

  public currentId(groupId: string): string {
    return this.current(groupId)?.id ?? DEFAULT_PERSONA_ID;
  }

  public select(groupId: string, personaId: string): void {
    if (personaId === DEFAULT_PERSONA_ID) delete this.state.groups[groupId];
    else this.state.groups[groupId] = personaId;
    this.save();
  }

  public sessionFor(groupId: string, personaId: string): string | undefined {
    return this.state.sessions[groupId]?.[personaId];
  }

  public rememberSession(groupId: string, personaId: string, sessionId: string): void {
    (this.state.sessions[groupId] ??= {})[personaId] = sessionId;
    this.save();
  }

  private save(): void {
    mkdirSync(dirname(this.statePath), { recursive: true });
    const tmp = `${this.statePath}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), 'utf8');
    renameSync(tmp, this.statePath);
  }
}
