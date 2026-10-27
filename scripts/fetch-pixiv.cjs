#!/usr/bin/env node
/**
 * 从 pixiv 抓一张「百合 / 全年龄」作品并落盘（不需要登录）。
 *
 * 用法:
 *   node fetch-pixiv.cjs                 # 从 pixiv-tags.json 的池里随机选一个 CP 搜
 *   node fetch-pixiv.cjs --cp=天琴组      # 指定池里的某个 CP（名字或 index）
 *   node fetch-pixiv.cjs --word="ホタル ステラ"
 *   node fetch-pixiv.cjs --count         # 只打印每个 CP 的搜索结果数
 *   node fetch-pixiv.cjs [输出目录]
 *
 * 成功输出 JSON（最后一行）:
 *   {"ok":true,"path":"...","id":151329303,"cp":"天琴组","title":"...","source":"https://www.pixiv.net/artworks/151329303"}
 *
 * 说明:
 * - 走系统 HTTPS_PROXY（默认 127.0.0.1:7897）；i.pximg.net 必须带 Referer。
 * - 只取 xRestrict===0（全年龄）、非 R-18、非 AI 生成的作品（--ai 可放开 AI）。
 * - 按作品 id 去重（seen-pixiv.json）。
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

const TAGS_FILE = path.join(__dirname, 'pixiv-tags.json');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
/** 分辨率下限（短边像素） */
const MIN_EDGE = Number(process.env.FANART_MIN_EDGE || 800);
/** 候选按面积取前 N 张再随机 */
const TOP_N = 25;
/** CP 只锁了单个角色时，靠这些 tag 保证画面里确实是百合 */
const YURI_TAGS = ['百合', 'yuri', 'ガールズラブ', 'girls_love', 'レズ', '女同', '2girls'];
/** 内容黑名单：同 booru 那支，政治化/战争拟人不要 */
const BLOCKED_SUBSTRINGS = [
  'russo', 'ukrain', 'nazi', 'hitler', 'soviet', 'communist',
  'political', 'propaganda', 'countryball', 'r-18', 'r18',
];

function decodeChunked(buf) {
  const parts = [];
  let off = 0;
  while (off < buf.length) {
    const nl = buf.indexOf('\r\n', off);
    if (nl === -1) break;
    const size = parseInt(buf.slice(off, nl).toString('latin1').split(';')[0].trim(), 16);
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
        t.write([
          `GET ${target.pathname}${target.search} HTTP/1.1`,
          `Host: ${target.hostname}`,
          ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
          'Connection: close',
          '',
          '',
        ].join('\r\n'));
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

async function get(urlStr, extraHeaders = {}) {
  const target = new URL(urlStr);
  const headers = { 'User-Agent': UA, Accept: '*/*', ...extraHeaders };
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
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify([...seen].slice(-500)));
}

function loadPool() {
  try {
    const data = JSON.parse(fs.readFileSync(TAGS_FILE, 'utf8'));
    return Array.isArray(data) ? data.filter((e) => e && e.name && e.words) : [];
  } catch {
    return [];
  }
}

function parseArgs(argv) {
  const opts = { cp: undefined, word: undefined, count: false, allowAi: false, outDir: undefined };
  for (const arg of argv) {
    if (arg === '--count') opts.count = true;
    else if (arg === '--ai') opts.allowAi = true;
    else if (arg.startsWith('--cp=')) opts.cp = arg.slice(5);
    else if (arg.startsWith('--word=')) opts.word = arg.slice(7);
    else if (!arg.startsWith('--')) opts.outDir = arg;
  }
  return opts;
}

async function search(word, page) {
  const q = encodeURIComponent(word);
  const url = `https://www.pixiv.net/ajax/search/artworks/${q}?word=${q}&order=date_d&mode=all&p=${page}&s_mode=s_tag&type=all&lang=zh`;
  const res = await get(url, { Referer: 'https://www.pixiv.net/' });
  if (res.status !== 200) throw new Error(`search HTTP ${res.status}`);
  const data = JSON.parse(res.body.toString('utf8'));
  if (data.error) throw new Error('search 返回 error');
  return data.body?.illustManga?.data || [];
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const outDir = path.resolve(opts.outDir || path.join(__dirname, '..', 'media', 'fanart'));
  const seenFile = path.join(outDir, 'seen-pixiv.json');
  const seen = loadSeen(seenFile);
  const pool = loadPool();

  const targets = [];
  if (opts.word) {
    targets.push({ cp: undefined, word: opts.word });
  } else if (opts.cp) {
    const hit = pool.find((e, i) => String(i) === opts.cp || e.name === opts.cp);
    if (!hit) {
      console.log(JSON.stringify({ ok: false, error: `pixiv 池里没有「${opts.cp}」` }));
      process.exitCode = 1;
      return;
    }
    targets.push({ cp: hit.name, word: hit.words, require: hit.require, requireGroups: hit.requireGroups, exclude: hit.exclude, pairPinned: hit.pairPinned });
  } else {
    for (const e of [...pool].sort(() => Math.random() - 0.5)) {
      targets.push({ cp: e.name, word: e.words, require: e.require, requireGroups: e.requireGroups, exclude: e.exclude, pairPinned: e.pairPinned });
    }
  }

  if (opts.count) {
    for (const t of targets) {
      try {
        const items = await search(t.word, 1);
        console.log(JSON.stringify({ ok: true, cp: t.cp, word: t.word, page1: items.length }));
      } catch (err) {
        console.log(JSON.stringify({ ok: false, cp: t.cp, word: t.word, error: err.message }));
      }
    }
    return;
  }

  let lastErr = 'no candidate';
  for (const t of targets.slice(0, 5)) {
    let usable = [];
    // 关键词搜索是全文匹配，命中里混着无关的作品；一页筛不出东西就换页再来
    for (let attempt = 0; attempt < 3 && usable.length === 0; attempt++) {
      let items;
      try {
        items = await search(t.word, 1);
      } catch (err) {
        lastErr = `search ${err.message}`;
        continue;
      }
      usable = items.filter((it) => {
        if (!it || !it.id || it.xRestrict !== 0) return false;
        if (!opts.allowAi && it.aiType === 2) return false;
        if (seen.has(it.id)) return false;
        // 只要单张插画：manga(1)/ugoira(2) 的首图经常只是封面或分镜
        if (it.illustType !== 0) return false;
        // 多页作品只发第一页容易断章取义（四格、条漫），干脆不要
        if (Number(it.pageCount) > 1) return false;
        // 分辨率太低的直接跳过（像素图、缩略图、长条分镜）
        const w = Number(it.width) || 0;
        const h = Number(it.height) || 0;
        if (Math.min(w, h) < MIN_EDGE) return false;
        const tags = Array.isArray(it.tags) ? it.tags : [];
        const lowered = tags.map((tag) => String(tag).toLowerCase());
        if (lowered.some((tag) => BLOCKED_SUBSTRINGS.some((bad) => tag.includes(bad)))) return false;
        // 关键词搜索是全文匹配，"ホタル" 也会命中别的作品（比如 ステラソラ 里那位），所以按 tag 精确过滤
        if (Array.isArray(t.require) && t.require.length > 0) {
          if (!t.require.every((tag) => tags.includes(tag))) return false;
        }
        // requireGroups：每组代表一个角色，组内任一别名命中即可；所有组都要命中才算这对 CP
        if (Array.isArray(t.requireGroups) && t.requireGroups.length > 0) {
          const hitAll = t.requireGroups.every(
            (group) => Array.isArray(group) && group.some((alt) => tags.some((tag) => tag.includes(alt)))
          );
          if (!hitAll) return false;
        }
        if (Array.isArray(t.exclude) && t.exclude.length > 0) {
          if (tags.some((tag) => t.exclude.some((bad) => tag.includes(bad)))) return false;
        }
        // 两个人都被 tag 锁住了才算配对；只锁一个角色的 CP 还得自带百合 tag，否则多半是单人图
        const pairPinned =
          t.pairPinned === true ||
          (Array.isArray(t.requireGroups) && t.requireGroups.length >= 2) ||
          (Array.isArray(t.require) && t.require.length >= 2);
        if (!pairPinned && !tags.some((tag) => YURI_TAGS.includes(tag))) return false;
        return true;
      });
      // 面积大的更像正经插画，取前 TOP_N 张再随机
      usable.sort((a, b) => (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0));
      usable = usable.slice(0, TOP_N);
      if (usable.length === 0) lastErr = `${t.cp || t.word} 这页没有可用的`;
      if (process.env.FANART_DEBUG) {
        console.error(`[debug] ${t.cp || t.word} items=${items.length} usable=${usable.length} tags0=${JSON.stringify((items[0] || {}).tags)} ai0=${(items[0] || {}).aiType} x0=${(items[0] || {}).xRestrict}`);
      }
    }
    if (usable.length === 0) continue;
    const pick = usable[Math.floor(Math.random() * usable.length)];
    try {
      const pagesRes = await get(`https://www.pixiv.net/ajax/illust/${pick.id}/pages?lang=zh`, {
        Referer: 'https://www.pixiv.net/',
      });
      const pages = JSON.parse(pagesRes.body.toString('utf8'));
      // 优先 master1200（regular）：原图动辄十几 MB，发群没必要
      const imgUrl = pages?.body?.[0]?.urls?.regular || pages?.body?.[0]?.urls?.original;
      if (!imgUrl) throw new Error('拿不到原图地址');
      const img = await get(imgUrl, { Referer: 'https://www.pixiv.net/' });
      if (img.status !== 200 || img.body.length < 20000) {
        throw new Error(`image HTTP ${img.status} / ${img.body.length}B`);
      }
      const ext = (path.extname(new URL(imgUrl).pathname) || '.jpg').split('?')[0];
      const file = path.join(outDir, `pixiv-${pick.id}${ext}`);
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(file, img.body);
      seen.add(pick.id);
      saveSeen(seenFile, seen);
      console.log(JSON.stringify({
        ok: true,
        path: file,
        id: pick.id,
        cp: t.cp,
        title: pick.title,
        author: pick.userName,
        tags: pick.tags,
        source: `https://www.pixiv.net/artworks/${pick.id}`,
      }));
      return;
    } catch (err) {
      lastErr = `image ${err.message}`;
    }
  }
  console.log(JSON.stringify({ ok: false, error: lastErr }));
  process.exitCode = 1;
}

main().catch((err) => {
  console.log(JSON.stringify({ ok: false, error: err.message }));
  process.exitCode = 1;
});
