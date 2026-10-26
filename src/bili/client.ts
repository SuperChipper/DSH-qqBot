/**
 * Bilibili 只读客户端。
 *
 * - 搜索/视频信息/评论：游客 cookie + WBI 签名即可，无需登录；
 * - 字幕：B 站要求登录（need_login_subtitle），所以提供一次扫码登录；
 * - 凭证只落在本机 ~/.dsh/bili-read/credential.json，不写进仓库、不打日志。
 *
 * 端点与签名思路参考 dsh-bili-scroll 内置的 bilibili-mcp（MIT），这里只保留只读部分。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const BASE_HEADERS: Record<string, string> = {
  'user-agent': USER_AGENT,
  referer: 'https://www.bilibili.com/',
  origin: 'https://www.bilibili.com',
  accept: 'application/json, text/plain, */*',
};
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28,
  14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21,
  56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];
const GUEST_COOKIE_TTL_MS = 6 * 60 * 60 * 1000;
const WBI_TTL_MS = 60 * 60 * 1000;
const CREDENTIAL_PATH = join(homedir(), '.dsh', 'bili-read', 'credential.json');

export interface BiliCredential {
  cookie: string;
  savedAt: number;
}

export interface BiliSearchItem {
  bvid: string;
  title: string;
  author: string;
  play: number;
  pubdate: number;
  duration: string;
  description: string;
}

export interface BiliVideoInfo {
  bvid: string;
  aid: number;
  cid: number;
  title: string;
  author: string;
  authorUid: number;
  pubdate: number;
  duration: number;
  description: string;
  cover: string;
  stats: { view: number; like: number; reply: number; favorite: number; coin: number; share: number };
  pages: Array<{ cid: number; page: number; part: string; duration: number }>;
}

export interface BiliComment {
  rpid: number;
  author: string;
  message: string;
  like: number;
  ctime: number;
  replyCount: number;
}

export interface BiliSubtitle {
  lan: string;
  lines: number;
  text: string;
  truncated: boolean;
}

export interface BiliLoginStart {
  qrcodeKey: string;
  url: string;
  expiresInSeconds: number;
}

export type BiliLoginStatus =
  | { state: 'waiting'; message: string }
  | { state: 'scanned'; message: string }
  | { state: 'expired'; message: string }
  | { state: 'success'; message: string; cookieSaved: true };

export class BiliApiError extends Error {
  public readonly code: number;

  public constructor(code: number, message: string) {
    super(`Bilibili API ${code}: ${message}`);
    this.name = 'BiliApiError';
    this.code = code;
  }
}

export function md5(value: string): string {
  return createHash('md5').update(value).digest('hex');
}

/** WBI mixin key：从 img/sub key 按固定表取 32 位 */
export function mixinKey(imgKey: string, subKey: string): string {
  const raw = imgKey + subKey;
  return MIXIN_KEY_ENC_TAB.map((index) => raw[index] ?? '').join('').slice(0, 32);
}

/** WBI 签名，返回带 wts/w_rid 的 query string */
export function signWbi(params: Record<string, string | number>, mixin: string, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const all: Record<string, string | number> = { ...params, wts: nowSeconds };
  const query = Object.keys(all)
    .sort()
    .map((key) => {
      const value = String(all[key]).replace(/[!'()*]/g, '');
      return `${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
    })
    .join('&');
  return `${query}&w_rid=${md5(query + mixin)}`;
}

export function stripHtml(value: string): string {
  return value.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
}

function cookieFromSetCookie(headers: Headers): string | undefined {
  const setCookies = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
  const wanted = new Map<string, string>();
  for (const line of setCookies) {
    const first = line.split(';', 1)[0] ?? '';
    const index = first.indexOf('=');
    if (index <= 0) continue;
    const name = first.slice(0, index).trim();
    if (['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'sid'].includes(name)) {
      wanted.set(name, first.slice(index + 1).trim());
    }
  }
  if (wanted.size === 0) return undefined;
  return [...wanted.entries()].map(([key, value]) => `${key}=${value}`).join('; ');
}

export function cookieFromLoginUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    const wanted = ['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'sid'];
    const values = wanted
      .map((key) => [key, parsed.searchParams.get(key)])
      .filter((entry): entry is [string, string] => entry[1] !== null && entry[1] !== '');
    return values.length > 0 ? values.map(([key, value]) => `${key}=${value}`).join('; ') : undefined;
  } catch {
    return undefined;
  }
}

async function readJson(response: Response): Promise<{ code?: number; message?: string; data?: unknown }> {
  const text = await response.text();
  try {
    return JSON.parse(text) as { code?: number; message?: string; data?: unknown };
  } catch {
    throw new Error(`Bilibili 返回了非 JSON（HTTP ${response.status}）：${text.slice(0, 120)}`);
  }
}

export class BiliClient {
  private guestCookie: { value: string; expiresAt: number } | undefined;
  private wbi: { mixin: string; expiresAt: number } | undefined;
  private credential: BiliCredential | undefined;

  public constructor(private readonly credentialPath: string = CREDENTIAL_PATH) {
    this.loadCredential();
  }

  public hasCredential(): boolean {
    return this.credential !== undefined;
  }

  /** 当前 cookie：已登录用登录态，否则游客 cookie */
  private async currentCookie(): Promise<string> {
    return this.credential?.cookie ?? (await this.getGuestCookie());
  }

  private async getGuestCookie(): Promise<string> {
    if (this.guestCookie && this.guestCookie.expiresAt > Date.now()) return this.guestCookie.value;
    const response = await fetch('https://api.bilibili.com/x/frontend/finger/spi', {
      headers: BASE_HEADERS,
      signal: AbortSignal.timeout(15000),
    });
    const body = await readJson(response);
    const data = (body.data ?? {}) as { b_3?: string; b_4?: string };
    if (!data.b_3) throw new Error('Bilibili 游客 cookie 获取失败');
    const value = `buvid3=${data.b_3}${data.b_4 ? `; buvid4=${data.b_4}` : ''}`;
    this.guestCookie = { value, expiresAt: Date.now() + GUEST_COOKIE_TTL_MS };
    return value;
  }

  private async getWbi(): Promise<string> {
    if (this.wbi && this.wbi.expiresAt > Date.now()) return this.wbi.mixin;
    // WBI key 是公开的，用游客 cookie 即可，避免把主人账号用在普通搜索上
    const cookie = await this.getGuestCookie();
    const response = await fetch('https://api.bilibili.com/x/web-interface/nav', {
      headers: { ...BASE_HEADERS, cookie },
      signal: AbortSignal.timeout(15000),
    });
    const body = await readJson(response);
    // 未登录时 code=-101，但 data.wbi_img 仍然有效
    const data = (body.data ?? {}) as { wbi_img?: { img_url?: string; sub_url?: string } };
    const img = data.wbi_img?.img_url?.split('/').pop()?.split('.')[0];
    const sub = data.wbi_img?.sub_url?.split('/').pop()?.split('.')[0];
    if (!img || !sub) throw new Error(`Bilibili WBI key 获取失败：${body.code ?? '?'} ${body.message ?? ''}`);
    const mixin = mixinKey(img, sub);
    this.wbi = { mixin, expiresAt: Date.now() + WBI_TTL_MS };
    return mixin;
  }

  private async getJson(
    url: string,
    options: { allowNonZero?: boolean; authenticated?: boolean } = {},
  ): Promise<unknown> {
    // 默认游客态：搜索/视频/评论不消耗主人账号；只有字幕显式使用登录态
    const cookie = options.authenticated === true ? await this.currentCookie() : await this.getGuestCookie();
    const response = await fetch(url, {
      headers: { ...BASE_HEADERS, cookie },
      signal: AbortSignal.timeout(20000),
    });
    const body = await readJson(response);
    if (options.allowNonZero !== true && body.code !== 0) {
      throw new BiliApiError(body.code ?? -1, body.message ?? 'unknown error');
    }
    return body.data;
  }

  public async search(keyword: string, limit = 10, order: 'totalrank' | 'click' | 'pubdate' = 'totalrank'): Promise<BiliSearchItem[]> {
    const mixin = await this.getWbi();
    const query = signWbi(
      { search_type: 'video', keyword, page: 1, order },
      mixin,
    );
    const data = (await this.getJson(`https://api.bilibili.com/x/web-interface/wbi/search/type?${query}`)) as {
      result?: Array<Record<string, unknown>>;
    };
    return (data.result ?? []).slice(0, Math.min(Math.max(limit, 1), 20)).map((item) => ({
      bvid: String(item.bvid ?? ''),
      title: stripHtml(String(item.title ?? '')),
      author: String(item.author ?? ''),
      play: Number(item.play ?? 0),
      pubdate: Number(item.pubdate ?? 0),
      duration: String(item.duration ?? ''),
      description: stripHtml(String(item.description ?? '')),
    }));
  }

  public async video(bvid: string): Promise<BiliVideoInfo> {
    const data = (await this.getJson(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`)) as Record<string, unknown>;
    const owner = (data.owner ?? {}) as { name?: string; mid?: number };
    const stat = (data.stat ?? {}) as Record<string, number>;
    const pages = Array.isArray(data.pages) ? data.pages : [];
    return {
      bvid: String(data.bvid ?? bvid),
      aid: Number(data.aid ?? 0),
      cid: Number(data.cid ?? 0),
      title: String(data.title ?? ''),
      author: String(owner.name ?? ''),
      authorUid: Number(owner.mid ?? 0),
      pubdate: Number(data.pubdate ?? 0),
      duration: Number(data.duration ?? 0),
      description: String(data.desc ?? ''),
      cover: String(data.pic ?? ''),
      stats: {
        view: Number(stat.view ?? 0),
        like: Number(stat.like ?? 0),
        reply: Number(stat.reply ?? 0),
        favorite: Number(stat.favorite ?? 0),
        coin: Number(stat.coin ?? 0),
        share: Number(stat.share ?? 0),
      },
      pages: pages.map((page: Record<string, unknown>) => ({
        cid: Number(page.cid ?? 0),
        page: Number(page.page ?? 0),
        part: String(page.part ?? ''),
        duration: Number(page.duration ?? 0),
      })),
    };
  }

  public async comments(bvid: string, limit = 10): Promise<BiliComment[]> {
    const video = await this.video(bvid);
    const count = Math.min(Math.max(limit, 1), 30);
    const data = (await this.getJson(
      `https://api.bilibili.com/x/v2/reply?oid=${video.aid}&type=1&pn=1&ps=${count}&sort=2`,
    )) as { replies?: Array<Record<string, unknown>> };
    return (data.replies ?? []).map((reply) => {
      const member = (reply.member ?? {}) as { uname?: string };
      const content = (reply.content ?? {}) as { message?: string };
      return {
        rpid: Number(reply.rpid ?? 0),
        author: String(member.uname ?? ''),
        message: String(content.message ?? ''),
        like: Number(reply.like ?? 0),
        ctime: Number(reply.ctime ?? 0),
        replyCount: Number(reply.rcount ?? 0),
      };
    });
  }

  public async subtitle(bvid: string): Promise<BiliSubtitle | undefined> {
    const video = await this.video(bvid);
    if (!video.cid) throw new Error(`视频 ${bvid} 没有 cid`);
    const mixin = await this.getWbi();
    const query = signWbi({ bvid, cid: video.cid }, mixin);
    const data = (await this.getJson(`https://api.bilibili.com/x/player/wbi/v2?${query}`, { authenticated: true })) as {
      need_login_subtitle?: boolean;
      subtitle?: { subtitles?: Array<{ lan?: string; subtitle_url?: string }> };
    };
    const subtitles = data.subtitle?.subtitles ?? [];
    if (subtitles.length === 0) {
      if (data.need_login_subtitle === true && !this.hasCredential()) {
        throw new Error('这个视频的字幕需要登录 B 站：请先调用 bili_login 扫码登录，再重试');
      }
      return undefined;
    }
    const chosen = subtitles.find((item) => (item.lan ?? '').startsWith('zh')) ?? subtitles[0]!;
    const rawUrl = chosen.subtitle_url ?? '';
    if (!rawUrl) return undefined;
    const url = rawUrl.startsWith('//') ? `https:${rawUrl}` : rawUrl;
    const response = await fetch(url, { headers: { ...BASE_HEADERS, cookie: await this.currentCookie() }, signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`字幕下载失败：HTTP ${response.status}`);
    const body = (await response.json()) as { body?: Array<{ from?: number; to?: number; content?: string }> };
    const lines = body.body ?? [];
    const full = lines.map((line) => String(line.content ?? '').trim()).filter(Boolean).join('\n');
    const truncated = full.length > 12000;
    return {
      lan: String(chosen.lan ?? ''),
      lines: lines.length,
      text: truncated ? `${full.slice(0, 12000)}\n…（已截断）` : full,
      truncated,
    };
  }

  /** 生成扫码登录二维码（返回 URL 和 key，由调用方画图） */
  public async loginStart(): Promise<BiliLoginStart> {
    const cookie = await this.getGuestCookie();
    const response = await fetch('https://passport.bilibili.com/x/passport-login/web/qrcode/generate', {
      headers: { ...BASE_HEADERS, cookie },
      signal: AbortSignal.timeout(15000),
    });
    const body = await readJson(response);
    if (body.code !== 0) throw new BiliApiError(body.code ?? -1, body.message ?? '二维码生成失败');
    const data = (body.data ?? {}) as { url?: string; qrcode_key?: string };
    if (!data.url || !data.qrcode_key) throw new Error('Bilibili 没有返回二维码');
    return { qrcodeKey: data.qrcode_key, url: data.url, expiresInSeconds: 180 };
  }

  /** 轮询扫码状态；成功时保存 cookie 到本机 */
  public async loginPoll(qrcodeKey: string): Promise<BiliLoginStatus> {
    const cookie = await this.getGuestCookie();
    const response = await fetch(
      `https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(qrcodeKey)}`,
      { headers: { ...BASE_HEADERS, cookie }, signal: AbortSignal.timeout(15000) },
    );
    const body = await readJson(response);
    const data = (body.data ?? {}) as { code?: number; message?: string; url?: string };
    const code = data.code ?? body.code ?? -1;
    if (code === 0) {
      const fromHeaders = cookieFromSetCookie(response.headers);
      const fromUrl = data.url ? cookieFromLoginUrl(data.url) : undefined;
      const cookieValue = fromHeaders ?? fromUrl;
      if (!cookieValue) throw new Error('扫码成功但 Bilibili 没有返回登录 cookie');
      this.saveCredential({ cookie: cookieValue, savedAt: Date.now() });
      return { state: 'success', message: 'B 站登录成功，凭证已保存到本机', cookieSaved: true };
    }
    if (code === 86090) return { state: 'scanned', message: '已扫码，等待手机确认' };
    if (code === 86038) return { state: 'expired', message: '二维码已失效，请重新调用 bili_login' };
    return { state: 'waiting', message: data.message ?? '等待扫码' };
  }

  public clearCredential(): void {
    this.credential = undefined;
    if (existsSync(this.credentialPath)) rmSync(this.credentialPath, { force: true });
  }

  private loadCredential(): void {
    try {
      if (!existsSync(this.credentialPath)) return;
      const parsed = JSON.parse(readFileSync(this.credentialPath, 'utf8')) as Partial<BiliCredential>;
      if (typeof parsed.cookie === 'string' && parsed.cookie.length > 0) {
        this.credential = { cookie: parsed.cookie, savedAt: Number(parsed.savedAt ?? 0) };
      }
    } catch {
      // 损坏的凭证当作未登录，下一次扫码覆盖
    }
  }

  private saveCredential(credential: BiliCredential): void {
    this.credential = credential;
    mkdirSync(dirname(this.credentialPath), { recursive: true });
    writeFileSync(this.credentialPath, `${JSON.stringify(credential, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
}
