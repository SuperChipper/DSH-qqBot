#!/usr/bin/env node
/**
 * 从 safebooru 抓一张「百合」同人图并落盘。
 *
 * 用法:
 *   node fetch-fanart.cjs                 # 随机：60% 从 fanart-tags.json 的 CP 池里选，40% 随机百合
 *   node fetch-fanart.cjs --cp-only       # 只从 CP 池里选
 *   node fetch-fanart.cjs --random-only   # 只随机
 *   node fetch-fanart.cjs --cp=芙星        # 指定池里某个 CP（名字或 index）
 *   node fetch-fanart.cjs --tags "stelle_(honkai:_star_rail) march_7th_(honkai:_star_rail)"
 *   node fetch-fanart.cjs --count         # 只查数量，不下载
 *   node fetch-fanart.cjs [输出目录]       # 可选：落盘目录，默认 media/fanart
 *
 * 成功输出 JSON（最后一行）:
 *   {"ok":true,"path":"...","id":123,"cp":"芙星","tags":"...","source":"..."}
 *
 * 说明:
 * - 走系统 HTTPS_PROXY（默认 127.0.0.1:7897），沙箱里直连外网会断在 TLS 握手。
 * - 只挑 rating:general，按 id 去重（seen.json），并跳过政治化 / 战争拟人题材。
 */
'use strict';

const http = require('http');
const https = require('https');
const tls = require('tls');
const fs = require('fs');
const path = require('path');

const PROXY = (() => {
  const raw =
    process.env.HTTPS_PROXY || process.env.https_proxy ||
    process.env.HTTP_PROXY || process.env.http_proxy;
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return { host: u.hostname, port: Number(u.port || 8080) };
  } catch {
    return null;
  }
})();

const API = 'https://safebooru.org/index.php?page=dapi&s=post&q=index&json=1';
const BASE_TAGS = 'yuri rating:general 2girls';
const CP_RATE = Number(process.env.FANART_CP_RATE || 0.6);
const TAGS_FILE = path.join(__dirname, 'fanart-tags.json');
/** 分辨率下限（短边像素）：太小的图发群里糊，直接跳过 */
const MIN_EDGE = Number(process.env.FANART_MIN_EDGE || 800);
/** 候选池按面积取前 N 张再随机，避免抽到一堆小图 */
const TOP_N = 30;

/** 命中任一词的图直接跳过：政治化 / 战争拟人一类的图不适合丢进群 */
const BLOCKED_SUBSTRINGS = [
  'russo', 'ukrain', 'nazi', 'hitler', 'soviet', 'communist',
  'political', 'propaganda', 'countryball', 'military_occupation',
];

function isBlocked(post) {
  const tags = String(post?.tags || '').toLowerCase();
  return BLOCKED_SUBSTRINGS.some((word) => tags.includes(word));
}

function decodeChunked(buf) {
  const parts = [];
  let off = 0;
  while (off < buf.length) {
    const nl = buf.indexOf('\r\n', off);
    if (nl === -1) break;
    const sizeLine = buf.slice(off, nl).toString('latin1').split(';')[0].trim();
    const size = parseInt(sizeLine, 16);
    if (!Number.isFinite(size) || size <= 0) break;
    const start = nl + 2;
    parts.push(buf.slice(start, start + size));
    off = start + size + 2;
  }
  return Buffer.concat(parts);
}

function socketRequest(target, headers, timeout) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: PROXY.host,
      port: PROXY.port,
      method: 'CONNECT',
      path: `${target.hostname}:443`,
      timeout,
    });
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        return reject(new Error(`proxy CONNECT ${res.statusCode}`));
      }
      const t = tls.connect({ socket, servername: target.hostname }, () => {
        const head = [
          `GET ${target.pathname}${target.search} HTTP/1.1`,
          `Host: ${target.hostname}`,
          ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
          'Connection: close',
          '',
          '',
        ].join('\r\n');
        t.write(head);
      });
      let parsed = false;
      let headBuf = Buffer.alloc(0);
      let headerText = '';
      const chunks = [];
      let status = 0;
      t.on('data', (c) => {
        if (!parsed) {
          headBuf = Buffer.concat([headBuf, c]);
          const i = headBuf.indexOf('\r\n\r\n');
          if (i === -1) return;
          status = parseInt(headBuf.slice(9, 12).toString(), 10);
          headerText = headBuf.slice(0, i).toString('latin1').toLowerCase();
          parsed = true;
          const rest = headBuf.slice(i + 4);
          if (rest.length) chunks.push(rest);
        } else {
          chunks.push(c);
        }
      });
      t.on('end', () => {
        const raw = Buffer.concat(chunks);
        const body = headerText.includes('transfer-encoding: chunked') ? decodeChunked(raw) : raw;
        resolve({ status, body });
      });
      t.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('proxy timeout'));
    });
    req.end();
  });
}

function directRequest(target, headers, timeout) {
  return new Promise((resolve, reject) => {
    const req = https.get(target, { headers, timeout }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('direct timeout'));
    });
  });
}

async function get(urlStr) {
  const target = new URL(urlStr);
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
    Accept: '*/*',
  };
  const timeout = 30000;
  if (PROXY) {
    try {
      return await socketRequest(target, headers, timeout);
    } catch (err) {
      if (process.env.FANART_NO_FALLBACK) throw err;
      return await directRequest(target, headers, timeout);
    }
  }
  return await directRequest(target, headers, timeout);
}

function loadSeen(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return new Set(Array.isArray(data) ? data : []);
  } catch {
    return new Set();
  }
}

function saveSeen(file, seen) {
  const list = [...seen].slice(-500);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(list));
}

function loadCpPool() {
  try {
    const data = JSON.parse(fs.readFileSync(TAGS_FILE, 'utf8'));
    return Array.isArray(data) ? data.filter((e) => e && e.name && e.tags) : [];
  } catch {
    return [];
  }
}

function parseArgs(argv) {
  const opts = { mode: 'mix', cp: undefined, tags: undefined, count: false, outDir: undefined };
  for (const arg of argv) {
    if (arg === '--cp-only') opts.mode = 'cp';
    else if (arg === '--random-only') opts.mode = 'random';
    else if (arg === '--count') opts.count = true;
    else if (arg.startsWith('--cp=')) opts.cp = arg.slice(5);
    else if (arg.startsWith('--tags=')) opts.tags = arg.slice(7);
    else if (!arg.startsWith('--')) opts.outDir = arg;
  }
  return opts;
}

async function queryPage(tags, pid) {
  const listUrl = `${API}&tags=${encodeURIComponent(tags)}&limit=100&pid=${pid}`;
  const res = await get(listUrl);
  if (res.status !== 200) throw new Error(`api HTTP ${res.status}`);
  const text = res.body.toString('utf8').trim();
  const posts = text ? JSON.parse(text) : [];
  return Array.isArray(posts) ? posts : [];
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const outDir = path.resolve(opts.outDir || path.join(__dirname, '..', 'media', 'fanart'));
  const seenFile = path.join(outDir, 'seen.json');
  const seen = loadSeen(seenFile);
  const pool = loadCpPool();

  // 选定候选查询：每项 { cp, tags }
  const candidates = [];
  if (opts.tags) {
    candidates.push({ cp: undefined, tags: `${BASE_TAGS} ${opts.tags}` });
  } else if (opts.cp) {
    const hit = pool.find((e, i) => String(i) === opts.cp || e.name === opts.cp);
    if (!hit) {
      console.log(JSON.stringify({ ok: false, error: `CP 池里没有「${opts.cp}」` }));
      process.exitCode = 1;
      return;
    }
    candidates.push({ cp: hit.name, tags: `${BASE_TAGS} ${hit.tags}` });
  } else if (opts.mode === 'cp') {
    const shuffled = [...pool].sort(() => Math.random() - 0.5);
    for (const e of shuffled) candidates.push({ cp: e.name, tags: `${BASE_TAGS} ${e.tags}` });
  } else if (opts.mode === 'random') {
    candidates.push({ cp: undefined, tags: BASE_TAGS });
  } else {
    if (pool.length > 0 && Math.random() < CP_RATE) {
      const shuffled = [...pool].sort(() => Math.random() - 0.5);
      for (const e of shuffled) candidates.push({ cp: e.name, tags: `${BASE_TAGS} ${e.tags}` });
      candidates.push({ cp: undefined, tags: BASE_TAGS });
    } else {
      candidates.push({ cp: undefined, tags: BASE_TAGS });
    }
  }

  let lastErr = 'no candidate';
  for (const cand of candidates.slice(0, 6)) {
    if (opts.count) {
      try {
        const posts = await queryPage(cand.tags, 0);
        console.log(JSON.stringify({ ok: true, cp: cand.cp, tags: cand.tags, page0: posts.length }));
      } catch (err) {
        console.log(JSON.stringify({ ok: false, cp: cand.cp, error: err.message }));
      }
      continue;
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      // safebooru 的 pid 是页码（每页 100）；小 CP 只有第 0 页，乱跳页码必然拿到空列表
      const pid = attempt === 0 ? 0 : Math.floor(Math.random() * 8);
      let posts;
      try {
        posts = await queryPage(cand.tags, pid);
      } catch (err) {
        lastErr = `api ${err.message}`;
        continue;
      }
      if (posts.length === 0) {
        lastErr = cand.cp ? `「${cand.cp}」这页没图` : 'api 返回空列表';
        if (pid === 0) break;
        continue;
      }
      let usable = posts.filter(
        (p) =>
          p && p.id && !seen.has(p.id) && (p.sample_url || p.file_url) && !isBlocked(p) &&
          Math.min(Number(p.width) || 0, Number(p.height) || 0) >= MIN_EDGE
      );
      if (usable.length === 0) {
        lastErr = '这一页全抓过、被过滤或分辨率太低';
        continue;
      }
      // 面积大的通常画得更完整，取前 TOP_N 张再随机
      usable.sort((a, b) => (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0));
      usable = usable.slice(0, TOP_N);
      const post = usable[Math.floor(Math.random() * usable.length)];
      const imageUrl = post.sample_url || post.file_url;
      try {
        const img = await get(imageUrl);
        if (img.status !== 200 || img.body.length < 20000) {
          lastErr = `image HTTP ${img.status} / ${img.body.length}B`;
          continue;
        }
        const ext = (path.extname(new URL(imageUrl).pathname) || '.jpg').split('?')[0];
        const file = path.join(outDir, `yuri-${post.id}${ext}`);
        fs.mkdirSync(outDir, { recursive: true });
        fs.writeFileSync(file, img.body);
        seen.add(post.id);
        saveSeen(seenFile, seen);
        console.log(JSON.stringify({
          ok: true,
          path: file,
          id: post.id,
          cp: cand.cp,
          tags: post.tags,
          source: post.source,
        }));
        return;
      } catch (err) {
        lastErr = `image ${err.message}`;
      }
    }
  }
  if (opts.count) return;
  console.log(JSON.stringify({ ok: false, error: lastErr }));
  process.exitCode = 1;
}

main().catch((err) => {
  console.log(JSON.stringify({ ok: false, error: err.message }));
  process.exitCode = 1;
});
