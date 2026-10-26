import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BiliClient,
  cookieFromLoginUrl,
  mixinKey,
  signWbi,
  stripHtml,
} from './client.ts';
import { registerBiliTools } from './tools.ts';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bili-client-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('WBI signing', () => {
  it('mixinKey 固定取 32 位，签名包含 wts/w_rid', () => {
    const mixin = mixinKey('7cd084941338484aae1ad9425b84077c', '4932caff0ff746eab6f01bf08b70ac45');
    expect(mixin).toHaveLength(32);
    const query = signWbi({ search_type: 'video', keyword: '大肥鱼' }, mixin, 1792947000);
    expect(query).toContain('wts=1792947000');
    expect(query).toMatch(/w_rid=[0-9a-f]{32}/);
    expect(query).toContain('keyword=%E5%A4%A7%E8%82%A5%E9%B1%BC');
  });
});

describe('text helpers', () => {
  it('stripHtml 去掉搜索高亮标签', () => {
    expect(stripHtml('<em class="keyword">大肥鱼</em> 测试 &amp; more')).toBe('大肥鱼 测试 & more');
  });

  it('cookieFromLoginUrl 只提取登录需要的字段', () => {
    const cookie = cookieFromLoginUrl(
      'https://passport.bilibili.com/x/passport-login/web/crossDomain?SESSDATA=a%2Cb&bili_jct=jct&DedeUserID=42&DedeUserID__ckMd5=ck&sid=sid&other=x',
    );
    expect(cookie).toBe('SESSDATA=a,b; bili_jct=jct; DedeUserID=42; DedeUserID__ckMd5=ck; sid=sid');
    expect(cookieFromLoginUrl('not a url')).toBeUndefined();
  });
});

describe('BiliClient credential store', () => {
  it('读取、保存、清除本机凭证', () => {
    const path = join(tempDir(), 'credential.json');
    const client = new BiliClient(path);
    expect(client.hasCredential()).toBe(false);

    writeFileSync(path, JSON.stringify({ cookie: 'SESSDATA=test', savedAt: 1 }), 'utf8');
    const loaded = new BiliClient(path);
    expect(loaded.hasCredential()).toBe(true);

    loaded.clearCredential();
    expect(loaded.hasCredential()).toBe(false);
    expect(() => readFileSync(path, 'utf8')).toThrow();
  });
});

describe('registerBiliTools', () => {
  it('只注册只读工具，不注册发评论/投稿/私信', () => {
    const names: string[] = [];
    registerBiliTools(
      { register: (definition: unknown) => { names.push((definition as { name: string }).name); } },
      { client: {} as BiliClient, logger: { info: () => {}, warn: () => {} } },
    );
    expect(names).toEqual(['bili_search', 'bili_video', 'bili_comments', 'bili_subtitle', 'bili_login', 'bili_login_check']);
    expect(names.some((name) => /reply|send|upload|favorite|message/i.test(name))).toBe(false);
  });

  it('权限门拒绝时不会生成登录二维码', async () => {
    const defs = new Map<string, { execute(args: unknown, exec: { signal: AbortSignal; agent?: unknown }): Promise<unknown> }>();
    registerBiliTools(
      { register: (definition: unknown) => { const tool = definition as { name: string } & { execute: (args: unknown, exec: { signal: AbortSignal; agent?: unknown }) => Promise<unknown> }; defs.set(tool.name, tool); } },
      {
        client: {} as BiliClient,
        logger: { info: () => {}, warn: () => {} },
        permission: () => ({ allowed: false, reason: '只有主人可以登录 B 站' }),
      },
    );
    const login = defs.get('bili_login');
    expect(login).toBeDefined();
    await expect(login!.execute({}, { signal: new AbortController().signal, agent: {} })).rejects.toThrow('只有主人可以登录 B 站');
  });
});
