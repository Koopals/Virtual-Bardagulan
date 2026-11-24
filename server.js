'use strict';
// Virtual Office server: serves the page and runs the real-time rooms over WebSockets.
// Start it with:  npm install  then  npm start   (needs Node.js 18 or newer)
//
// Optional settings (environment variables):
//   OFFICE_PASSWORD   one passcode for every room
//   ROOM_PASSWORDS    passcodes per room, as JSON, e.g. {"sjp":"blue-tiger"}  (wins over OFFICE_PASSWORD)
//   ICE_SERVERS       STUN/TURN servers for voice, as JSON, e.g. [{"urls":"turn:turn.example.com:3478","username":"u","credential":"p"}]
//   MAX_PER_ROOM      how many people fit in one room (default 40)
//   YOUTUBE_API_KEY   optional: a YouTube Data API key, turns on song search in the Music menu

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { createHub, roomName } = require('./hub');

const PORT = process.env.PORT || 3000;
const MAX_PER_ROOM = Number(process.env.MAX_PER_ROOM) || 40;

function jsonEnv(key, fallback, check) {
  const raw = process.env[key];
  if (!raw) return fallback;
  try { const v = JSON.parse(raw); if (check(v)) return v; } catch (e) {}
  console.warn(key + ' is not valid JSON, so it is ignored.');
  return fallback;
}
const ICE = jsonEnv('ICE_SERVERS', null, v => Array.isArray(v));
const ROOM_PASSWORDS = {};
Object.entries(jsonEnv('ROOM_PASSWORDS', {}, v => v && typeof v === 'object' && !Array.isArray(v)))
  .forEach(([k, v]) => { ROOM_PASSWORDS[roomName(k)] = String(v == null ? '' : v); });
const OFFICE_PASSWORD = String(process.env.OFFICE_PASSWORD || '');
const YT_KEY = String(process.env.YOUTUBE_API_KEY || '').trim();

// ---- optional YouTube song search (needs YOUTUBE_API_KEY) ----
const ytCache = new Map(), ytHits = new Map();
const unescapeHtml = s => String(s || '').replace(/&(amp|lt|gt|quot|#39|#x27);/g, (m, k) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", '#x27': "'" }[k]));
async function ytSearch(q) {
  const key = q.toLowerCase();
  const hit = ytCache.get(key); if (hit && Date.now() - hit.t < 30 * 60 * 1000) return hit.items;
  const u = 'https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoEmbeddable=true&videoCategoryId=10&maxResults=10&safeSearch=moderate&q=' + encodeURIComponent(q) + '&key=' + encodeURIComponent(YT_KEY);
  const r = await fetch(u);
  if (!r.ok) {
    let why = ''; try { const e = await r.json(); why = (e.error && (e.error.message || '')) + ''; } catch (e) {}
    console.warn('YouTube search failed (' + r.status + '): ' + why.slice(0, 200));
    throw new Error('youtube ' + r.status);
  }
  const d = await r.json();
  const items = (d.items || []).filter(it => it.id && it.id.videoId).map(it => ({
    id: it.id.videoId, title: unescapeHtml(it.snippet && it.snippet.title).slice(0, 100), channel: unescapeHtml(it.snippet && it.snippet.channelTitle).slice(0, 60),
    thumb: (it.snippet && it.snippet.thumbnails && (it.snippet.thumbnails.medium || it.snippet.thumbnails.default) || {}).url || ''
  }));
  ytCache.set(key, { t: Date.now(), items: items }); if (ytCache.size > 500) ytCache.delete(ytCache.keys().next().value);
  return items;
}
const passFor = room => Object.prototype.hasOwnProperty.call(ROOM_PASSWORDS, room) ? ROOM_PASSWORDS[room] : OFFICE_PASSWORD;

const hash = s => crypto.createHash('sha256').update('virtual-office:' + s).digest('hex');
const safeEqual = (a, b) => { const A = Buffer.from(String(a)), B = Buffer.from(String(b)); return A.length === B.length && crypto.timingSafeEqual(A, B); };

// The page learns it is online because this server switches its VO_SERVER setting to 'same'
// (whatever address index.html has, e.g. the Render address used by the GitHub Pages copy).
const page = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8')
  .replace(/^window\.VO_SERVER = '[^'\n]*';/m, () => "window.VO_SERVER = 'same'; window.VO_ICE = " + JSON.stringify(ICE).replace(/</g, '\\u003c') + '; window.VO_YTSEARCH = ' + (YT_KEY ? 'true' : 'false') + ';');

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    return res.end(page);
  }
  // the page may live on GitHub Pages, so these two routes allow other sites to call them
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(obj)); };
  if (url === '/api/yt-config') return send(200, { search: !!YT_KEY });
  if (url === '/api/yt-search') {
    if (!YT_KEY) return send(404, { error: 'search is off' });
    const q = String(new URL(req.url, 'http://x').searchParams.get('q') || '').trim().slice(0, 80);
    if (!q) return send(400, { error: 'empty' });
    const ip = String(req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || '').split(',')[0].trim();
    const now = Date.now(), list = (ytHits.get(ip) || []).filter(t => now - t < 60000);
    if (list.length >= 15) return send(429, { error: 'slow down' });
    list.push(now); ytHits.set(ip, list); if (ytHits.size > 2000) ytHits.clear();
    ytSearch(q).then(items => send(200, { items: items })).catch(() => send(502, { error: 'search failed' }));
    return;
  }
  if (url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
    return res.end('ok');
  }
  res.writeHead(404, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
  res.end('Not found');
});

const hub = createHub({ maxPerRoom: MAX_PER_ROOM, newId: () => crypto.randomBytes(6).toString('hex'), passFor: passFor, hash: hash, safeEqual: safeEqual });
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  const ip = String(req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || '').split(',')[0].trim();
  const client = hub.connect({
    ip: ip,
    send: text => { if (ws.readyState === 1) ws.send(text); },
    close: () => ws.close()
  });
  ws.on('message', data => client.message(data.toString()));
  ws.on('close', () => client.close());
  ws.on('error', () => {});
});

// Drop connections that stopped answering, so ghosts don't stay in the room.
setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    try { ws.ping(); } catch (e) {}
  });
}, 25000);
setInterval(() => hub.sweep(), 10 * 60 * 1000);

server.listen(PORT, () => {
  console.log('Virtual Office is running on http://localhost:' + PORT);
  console.log('Office password: ' + (OFFICE_PASSWORD ? 'on' : 'off') + ' · room passwords: ' + Object.keys(ROOM_PASSWORDS).length + ' · TURN/STUN servers: ' + (ICE ? ICE.length : 'default') + ' · YouTube search: ' + (YT_KEY ? 'on' : 'off'));
});
