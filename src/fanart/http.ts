/**
 * 搜图用的最小 HTTP GET：支持 HTTP CONNECT 代理（pixiv / booru 在国内直连基本不通）。
 *
 * 代理来源依次是：插件配置 fanart.proxy → 环境变量 HTTPS_PROXY / HTTP_PROXY →
 * Windows 系统代理（HKCU Internet Settings）。都没有就直连。
 */
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';

export interface HttpResponse {
  status: number;
  body: Buffer;
}

export type HttpGet = (url: string, headers?: Record<string, string>) => Promise<HttpResponse>;

interface ProxyAddress {
  host: string;
  port: number;
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const DEFAULT_TIMEOUT_MS = 20_000;
const CRLF = '\r\n';

/** 解析 "http://host:port" / "host:port"，非法返回 undefined */
export function parseProxy(raw: string | undefined): ProxyAddress | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  try {
    const url = new URL(value.includes('://') ? value : `http://${value}`);
    if (!url.hostname) return undefined;
    return { host: url.hostname, port: Number(url.port || 8080) };
  } catch {
    return undefined;
  }
}

/** Windows 系统代理（只读一次）：ProxyEnable=1 时取 ProxyServer */
let windowsProxyCache: string | null | undefined;
function readWindowsProxy(): string | undefined {
  if (process.platform !== 'win32') return undefined;
  if (windowsProxyCache !== undefined) return windowsProxyCache ?? undefined;
  windowsProxyCache = null;
  try {
    const out = execFileSync(
      'reg',
      ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'],
      { encoding: 'utf8', timeout: 5000, windowsHide: true },
    );
    const enabled = /ProxyEnable\s+REG_DWORD\s+0x1\b/.test(out);
    const server = /ProxyServer\s+REG_SZ\s+(\S+)/.exec(out)?.[1];
    // "http=a:1;https=b:2" 形式取 https 那项
    const picked = server?.includes('=')
      ? (/https=([^;]+)/.exec(server)?.[1] ?? /http=([^;]+)/.exec(server)?.[1])
      : server;
    if (enabled && picked) windowsProxyCache = picked;
  } catch {
    // 读不到注册表就当没有系统代理
  }
  return windowsProxyCache ?? undefined;
}

export function resolveProxy(configured: string | undefined): ProxyAddress | undefined {
  return parseProxy(configured)
    ?? parseProxy(process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy)
    ?? parseProxy(readWindowsProxy());
}

/** 解 chunked 响应体 */
export function decodeChunked(buf: Buffer): Buffer {
  const parts: Buffer[] = [];
  let off = 0;
  while (off < buf.length) {
    const nl = buf.indexOf(CRLF, off);
    if (nl === -1) break;
    const size = parseInt(buf.subarray(off, nl).toString('latin1').split(';')[0]!.trim(), 16);
    if (!Number.isFinite(size) || size <= 0) break;
    const start = nl + 2;
    parts.push(buf.subarray(start, start + size));
    off = start + size + 2;
  }
  return Buffer.concat(parts);
}

/** 把原始 HTTP/1.1 响应拆成状态码 + body */
export function parseRawResponse(raw: Buffer): HttpResponse {
  const end = raw.indexOf(CRLF + CRLF);
  if (end === -1) throw new Error('响应头不完整');
  const head = raw.subarray(0, end).toString('latin1');
  const status = parseInt(head.slice(9, 12), 10);
  const body = raw.subarray(end + 4);
  return { status, body: /transfer-encoding:\s*chunked/i.test(head) ? decodeChunked(body) : body };
}

/**
 * 经 CONNECT 隧道发 HTTPS 请求。直接在 TLS socket 上写原始请求：
 * 用 https.request + createConnection 走隧道时，pixiv 的请求会一直挂到超时。
 */
function viaProxy(target: URL, headers: Record<string, string>, proxy: ProxyAddress, timeoutMs: number): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const connect = http.request({
      host: proxy.host,
      port: proxy.port,
      method: 'CONNECT',
      path: `${target.hostname}:443`,
      timeout: timeoutMs,
    });
    connect.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`proxy CONNECT ${res.statusCode}`));
        return;
      }
      const chunks: Buffer[] = [];
      const t = tls.connect({ socket, servername: target.hostname }, () => {
        t.write([
          `GET ${target.pathname}${target.search} HTTP/1.1`,
          `Host: ${target.hostname}`,
          ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
          'Connection: close',
          '',
          '',
        ].join(CRLF));
      });
      t.setTimeout(timeoutMs, () => t.destroy(new Error('request timeout')));
      t.on('data', (c: Buffer) => chunks.push(c));
      t.on('end', () => {
        try {
          resolve(parseRawResponse(Buffer.concat(chunks)));
        } catch (err) {
          reject(err);
        }
      });
      t.on('error', reject);
    });
    connect.on('timeout', () => connect.destroy(new Error('proxy timeout')));
    connect.on('error', reject);
    connect.end();
  });
}

function direct(target: URL, headers: Record<string, string>, timeoutMs: number): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const req = https.get(target, { headers, timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
  });
}

/** 创建 GET 函数：有代理走代理，代理失败再直连一次（直连也失败时报代理那边的错） */
export function createHttpGet(proxyConfig: string | undefined, timeoutMs = DEFAULT_TIMEOUT_MS): HttpGet {
  const proxy = resolveProxy(proxyConfig);
  return async (url, extra = {}) => {
    const target = new URL(url);
    const headers = { 'User-Agent': UA, Accept: '*/*', ...extra };
    if (proxy !== undefined) {
      try {
        return await viaProxy(target, headers, proxy, timeoutMs);
      } catch (err) {
        try {
          return await direct(target, headers, timeoutMs);
        } catch {
          throw err;
        }
      }
    }
    return await direct(target, headers, timeoutMs);
  };
}
