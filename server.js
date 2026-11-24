'use strict';
// Virtual Office server: serves the page and runs the real-time rooms over WebSockets.
// Start it with:  npm install  then  npm start   (needs Node.js 18 or newer)
//
// Optional settings (environment variables):
//   OFFICE_PASSWORD   one passcode for every room
//   ROOM_PASSWORDS    passcodes per room, as JSON, e.g. {"sjp":"blue-tiger"}  (wins over OFFICE_PASSWORD)
//   ICE_SERVERS       STUN/TURN servers for voice, as JSON, e.g. [{"urls":"turn:turn.example.com:3478","username":"u","credential":"p"}]
//   MAX_PER_ROOM      how many people fit in one room (default 40)

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
const passFor = room => Object.prototype.hasOwnProperty.call(ROOM_PASSWORDS, room) ? ROOM_PASSWORDS[room] : OFFICE_PASSWORD;

const hash = s => crypto.createHash('sha256').update('virtual-office:' + s).digest('hex');
const safeEqual = (a, b) => { const A = Buffer.from(String(a)), B = Buffer.from(String(b)); return A.length === B.length && crypto.timingSafeEqual(A, B); };

// The page learns it is online because this server switches its VO_SERVER setting to 'same'.
const page = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8')
  .replace("window.VO_SERVER = '';", "window.VO_SERVER = 'same'; window.VO_ICE = " + JSON.stringify(ICE).replace(/</g, '\\u003c') + ';');

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    return res.end(page);
  }
  if (url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
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
  console.log('Office password: ' + (OFFICE_PASSWORD ? 'on' : 'off') + ' · room passwords: ' + Object.keys(ROOM_PASSWORDS).length + ' · TURN/STUN servers: ' + (ICE ? ICE.length : 'default'));
});
