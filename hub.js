'use strict';
// Room hub for Virtual Office: keeps each room's players, relays their updates and voice
// call setup, and checks room passcodes. It has no network code of its own, so it can be
// tested without a server.

const STATE_KEYS = ['name', 'role', 'look', 'status', 'custom', 'mic', 'emote', 'held', 'talk', 'fx', 'desk', 'task', 'zone', 'mv'];
const EV_KEYS = ['type', 'to', 'style', 'item', 'laptop', 'kind', 'key', 'id', 'list', 'title', 'src', 't0', 'room', 'url', 'table', 'act', 'mv', 'n', 'seat', 'made', 'pts', 'score', 'next'];
const GAME_TABLES = ['chess', 'checkers', 'reversi', 'connect4', 'ttt'];
const newTable = () => ({ seats: [null, null], log: [] });
// message id and the message being replied to (who wrote it, their name and a short quote)
function chatExtra(m) {
  const x = {};
  if (m.mid) x.mid = str(m.mid, 24);
  if (m.re && typeof m.re === 'object') x.re = { mid: str(m.re.mid, 24), u: str(m.re.u, 24), n: str(m.re.n, 20), t: str(m.re.t, 90) };
  return x;
}

const str = (v, n) => String(v == null ? '' : v).slice(0, n);
const roomName = v => str(v, 24).toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'lobby';

function cleanState(s) {
  const out = {};
  if (!s || typeof s !== 'object') return out;
  for (const k of STATE_KEYS) if (Object.prototype.hasOwnProperty.call(s, k)) out[k] = s[k];
  if ('name' in out) out.name = str(out.name, 20);
  if ('role' in out) out.role = str(out.role, 30);
  if (out.mv && out.mv.path && Array.isArray(out.mv.path)) out.mv.path = out.mv.path.slice(0, 200);
  if (out.zone !== undefined) out.zone = out.zone === 'room' ? 'room' : 'floor';
  let size = 0;
  try { size = JSON.stringify(out).length; } catch (e) { return {}; }
  return size > 20000 ? {} : out;
}

function createHub(opts) {
  opts = opts || {};
  const newId = opts.newId || (() => Math.random().toString(16).slice(2, 14));
  const MAX = opts.maxPerRoom || 40;
  const now = opts.now || (() => Date.now());
  const passFor = opts.passFor || (() => '');            // passcode set by the server owner, per room
  const hash = opts.hash || (s => 'h:' + s);
  const same = opts.safeEqual || ((a, b) => a === b);
  const TOKEN_MS = 12 * 3600 * 1000;                     // people already inside can reconnect without the passcode
  const rooms = new Map(), locks = new Map(), tokens = new Map(), ipFails = new Map();

  const roomOf = name => {
    let r = rooms.get(name);
    if (!r) { r = { clients: new Map(), music: null, games: {} }; GAME_TABLES.forEach(g => { r.games[g] = newTable(); }); rooms.set(name, r); }
    return r;
  };
  const send = (c, obj) => { try { c.sock.send(JSON.stringify(obj)); } catch (e) {} };
  const broadcast = (room, obj, exceptId, filter) => {
    const s = JSON.stringify(obj);
    for (const c of room.clients.values()) {
      if (c.id === exceptId || (filter && !filter(c))) continue;
      try { c.sock.send(s); } catch (e) {}
    }
  };
  // The passcode a room needs right now: one set by the server owner wins over one set inside the room.
  const needOf = name => { const p = passFor(name); return p ? hash(String(p)) : (locks.get(name) || ''); };
  const ipBlocked = ip => { const f = ipFails.get(ip); return !!(ip && f && f.n >= 10 && now() < f.until); };
  const ipFail = ip => { if (!ip) return; let f = ipFails.get(ip); if (!f || now() > f.until) f = { n: 0, until: now() + 10 * 60 * 1000 }; f.n++; ipFails.set(ip, f); };
  const issueToken = (c, name) => {
    const tk = newId() + newId();
    tokens.set(tk, { room: name, need: needOf(name), exp: now() + TOKEN_MS });
    if (tokens.size > 5000) sweep();
    return tk;
  };
  function sweep() {
    const t = now();
    for (const [k, v] of tokens) if (v.exp < t) tokens.delete(k);
    for (const [k, v] of ipFails) if (v.until < t) ipFails.delete(k);
  }

  function connect(sock) {
    const c = { id: newId(), sock: sock, room: null, state: {}, tokens: 60, last: now(), rtok: 200, rlast: now(), fails: 0, ip: str(sock.ip, 64) };

    function message(raw) {
      let m;
      try { m = JSON.parse(String(raw)); } catch (e) { return; }
      if (!m || typeof m !== 'object') return;
      const t = now();

      if (m.t === 'va') {   // voice carried by the server, for people whose networks block direct voice
        c.vtok = Math.min(40, (c.vtok == null ? 40 : c.vtok) + (t - (c.vlast || t)) / 50); c.vlast = t;   // about 20 packets a second
        if (c.vtok < 1 || !c.room) return;
        c.vtok -= 1;
        const room = rooms.get(c.room); if (!room) return;
        const d = typeof m.d === 'string' && m.d.length <= 4000 && /^[A-Za-z0-9+/=]+$/.test(m.d) ? m.d : null; if (!d) return;
        const to = Array.isArray(m.to) ? m.to.slice(0, 40) : [];
        const out = JSON.stringify({ t: 'va', from: c.id, d: d, s: (+m.s | 0) & 0xffff });
        to.forEach(id => { const tgt = room.clients.get(String(id)); if (tgt && tgt !== c) { try { tgt.sock.send(out); } catch (e) {} } });
        return;
      }

      if (m.t === 'rtc') {   // voice call setup: passed straight to one person in the same room
        c.rtok = Math.min(200, c.rtok + (t - c.rlast) / 20); c.rlast = t;
        if (c.rtok < 1 || !c.room) return;
        c.rtok -= 1;
        const room = rooms.get(c.room); if (!room) return;
        const tgt = room.clients.get(String(m.to)); if (!tgt) return;
        let size = 0; try { size = JSON.stringify(m.data).length; } catch (e) { return; }
        if (size > 20000) return;
        send(tgt, { t: 'rtc', from: c.id, data: m.data });
        return;
      }

      c.tokens = Math.min(60, c.tokens + (t - c.last) / 50); c.last = t;   // about 20 messages a second, bursts of 60
      if (c.tokens < 1) return;
      c.tokens -= 1;

      if (m.t === 'hello') {
        if (c.room) return;
        const name = roomName(m.room);
        if (ipBlocked(c.ip)) { send(c, { t: 'auth', room: name, reason: 'blocked' }); try { sock.close(); } catch (e) {} return; }
        const need = needOf(name);
        if (need) {
          const tk = tokens.get(str(m.token, 64));
          const tokenOk = !!(tk && tk.room === name && tk.need === need && t < tk.exp);
          if (!tokenOk) {
            const given = str(m.pass, 64);
            if (!given || !same(hash(given), need)) {
              if (given) { c.fails++; ipFail(c.ip); }
              send(c, { t: 'auth', room: name, reason: given ? 'wrong' : 'needed' });
              if (c.fails >= 5) { try { sock.close(); } catch (e) {} }
              return;
            }
          }
        }
        const room = roomOf(name);
        if (room.clients.size >= MAX) { send(c, { t: 'full' }); try { sock.close(); } catch (e) {} return; }
        c.room = name;
        c.state = cleanState(m.state);
        const peers = [...room.clients.values()].map(p => ({ id: p.id, state: p.state }));
        room.clients.set(c.id, c);
        send(c, { t: 'welcome', id: c.id, room: name, peers: peers, music: room.music, movie: room.movie || null, games: room.games, token: issueToken(c, name), locked: !!need, admin: !!passFor(name) });
        broadcast(room, { t: 'join', id: c.id, state: c.state }, c.id);
        return;
      }
      if (!c.room) return;
      const room = rooms.get(c.room);
      if (!room) return;

      if (m.t === 'state') {
        const p = cleanState(m.patch);
        if (!Object.keys(p).length) return;
        Object.assign(c.state, p);
        broadcast(room, { t: 'state', id: c.id, patch: p }, c.id);
      } else if (m.t === 'chat') {
        const text = str(m.text, 300).trim();
        if (!text) return;
        if (m.to) {   // whisper: only the person it's for gets it
          const tgt = room.clients.get(String(m.to));
          if (tgt) send(tgt, Object.assign({ t: 'chat', from: c.id, text: text, to: true }, chatExtra(m)));
          return;
        }
        const out = Object.assign({ t: 'chat', from: c.id, text: text, voice: !!m.voice, priv: !!m.priv }, chatExtra(m));
        if (m.priv) {   // said inside the meeting room: only people inside get the words
          broadcast(room, out, c.id, p => p.state.zone === 'room');
          broadcast(room, { t: 'muf', from: c.id }, c.id, p => p.state.zone !== 'room');
        } else broadcast(room, out, c.id);
      } else if (m.t === 'lock') {   // anyone inside can set or remove the room passcode
        if (passFor(c.room)) { send(c, { t: 'lockres', ok: false, why: 'admin' }); return; }
        const code = str(m.code, 64).trim();
        if (code && code.length < 3) { send(c, { t: 'lockres', ok: false, why: 'short' }); return; }
        if (code) locks.set(c.room, hash(code)); else locks.delete(c.room);
        broadcast(room, { t: 'locked', on: !!code, by: c.id });
        for (const p of room.clients.values()) send(p, { t: 'token', token: issueToken(p, c.room) });   // everyone inside can still reconnect
      } else if (m.t === 'ev') {
        const ev = { t: 'ev', from: c.id, k: str(m.k, 12) };
        for (const k of EV_KEYS) {
          if (!(k in m)) continue;
          const v = m[k];
          ev[k] = (typeof v === 'number' && isFinite(v)) || typeof v === 'boolean' ? v : str(v, k === 'url' ? 1000 : 120);
        }
        if (ev.k === 'game') {   // board games: the hub keeps seats and the move list so late joiners see the same board
          const tb = room.games[ev.table];
          if (!tb) return;
          if (ev.act === 'seat') {
            const i = ev.seat === 1 ? 1 : 0;
            if (tb.seats[i] && tb.seats[i] !== c.id) { send(c, { t: 'ev', from: c.id, k: 'game', table: ev.table, act: 'seatno' }); return; }
            tb.seats = tb.seats.map(x => x === c.id ? null : x); tb.seats[i] = c.id;
            if (!tb.seats[1 - i]) tb.log = [];
          } else if (ev.act === 'unseat') tb.seats = tb.seats.map(x => x === c.id ? null : x);
          else if (ev.act === 'reset' || ev.act === 'move') {
            if (tb.seats.indexOf(c.id) < 0) return;
            if (ev.act === 'reset') tb.log = [];
            else {
              const n = tb.log.length;   // moves alternate, so the seat whose turn it is follows from the count
              if (ev.n !== n || tb.seats[n % 2] !== c.id || !tb.seats[1 - n % 2] || n >= 800) return;
              tb.log.push({ act: 'move', mv: str(ev.mv, 16) });
            }
          } else return;
          broadcast(room, ev);
          return;
        }
        if (ev.k === 'music') room.music = ev.kind === 'stop' ? null : Object.assign({}, ev, { by: c.id });
        if (ev.k === 'movie') room.movie = ev.kind === 'stop' ? null : Object.assign({}, ev, { by: c.id });
        if (ev.k === 'dance' && ev.to) {   // dance invites go to one person
          const tgt = room.clients.get(String(ev.to));
          if (tgt) send(tgt, ev);
          return;
        }
        broadcast(room, ev, c.id);
      }
      // anything else (like the 'hb' keep-alive) is ignored
    }

    function close() {
      const name = c.room;
      if (!name) return;
      c.room = null;
      const room = rooms.get(name);
      if (!room) return;
      room.clients.delete(c.id);
      for (const g of GAME_TABLES) { const tb = room.games[g]; if (tb && tb.seats.indexOf(c.id) > -1) { tb.seats = tb.seats.map(x => x === c.id ? null : x); if (!tb.seats[0] && !tb.seats[1]) tb.log = []; } }
      broadcast(room, { t: 'leave', id: c.id });
      if (!room.clients.size) rooms.delete(name);
    }

    return { id: c.id, message: message, close: close };
  }

  return { connect: connect, rooms: rooms, sweep: sweep };
}

module.exports = { createHub: createHub, cleanState: cleanState, roomName: roomName };
