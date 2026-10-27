/**
 * 已发图记录：只有真正发进群的那张才记，没被选中的候选下次还能抽到。
 *
 * 沿用 scripts/fetch-*.cjs 的文件格式（media/fanart/seen.json 存 booru 数字 id，
 * seen-pixiv.json 存 pixiv 字符串 id），两边混用也不会重复发。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { FanartSource } from './types.ts';

/** 每个源最多保留多少条（与脚本一致） */
const MAX_SEEN = 500;

const FILES: Record<FanartSource, string> = {
  booru: 'seen.json',
  pixiv: 'seen-pixiv.json',
};

/** 候选图文件名：pixiv-<id>.<ext> / yuri-<id>.<ext>（booru 沿用脚本的 yuri- 前缀） */
const PREFIX: Record<FanartSource, string> = {
  pixiv: 'pixiv',
  booru: 'yuri',
};

export function candidateFileName(source: FanartSource, id: string, ext: string): string {
  return `${PREFIX[source]}-${id}${ext}`;
}

/** 从候选图文件名认回 source + id；不是候选图返回 undefined */
export function parseCandidateFileName(name: string): { source: FanartSource; id: string } | undefined {
  const m = /^(pixiv|yuri)-(\d+)\.[a-z0-9]+$/i.exec(name);
  if (!m) return undefined;
  return { source: m[1]!.toLowerCase() === 'pixiv' ? 'pixiv' : 'booru', id: m[2]! };
}

export class FanartSeenStore {
  private readonly dir: string;

  public constructor(dir: string) {
    this.dir = dir;
  }

  public load(source: FanartSource): Set<string> {
    const file = join(this.dir, FILES[source]);
    try {
      const data = JSON.parse(readFileSync(file, 'utf8')) as unknown;
      return new Set(Array.isArray(data) ? data.map(String) : []);
    } catch {
      return new Set();
    }
  }

  public mark(source: FanartSource, id: string): void {
    const list = [...this.load(source)].filter((x) => x !== id);
    list.push(id);
    const kept = list.slice(-MAX_SEEN);
    // booru 那份给脚本读，脚本按数字 id 比较
    const out = source === 'booru' ? kept.map((x) => (/^\d+$/.test(x) ? Number(x) : x)) : kept;
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, FILES[source]), JSON.stringify(out));
  }
}

/**
 * 发送成功后调用：发出去的文件若是候选目录里的候选图，就记为已发。
 * 返回是否记录了。
 */
export function markSentCandidate(store: FanartSeenStore, candidatesDir: string, sentPath: string): boolean {
  const abs = resolve(sentPath);
  if (resolve(dirname(abs)) !== resolve(candidatesDir) || !existsSync(abs)) return false;
  const parsed = parseCandidateFileName(basename(abs));
  if (parsed === undefined) return false;
  store.mark(parsed.source, parsed.id);
  return true;
}
