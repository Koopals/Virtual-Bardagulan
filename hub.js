'use strict';
// Room hub for Virtual Office: keeps each room's players, relays their updates and voice
// call setup, and checks room passcodes. It has no network code of its own, so it can be
// tested without a server.

const STATE_KEYS = ['name', 'role', 'look', 'status', 'custom', 'mic', 'emote', 'held', 'talk', 'fx', 'desk', 'task', 'zone', 'mv', 'call'];
const EV_KEYS = ['type', 'to', 'style', 'item', 'laptop', 'kind', 'key', 'id', 'list', 'title', 'src', 't0', 'room', 'url', 'table', 'act', 'mv', 'n', 'seat', 'made', 'pts', 'score', 'next', 'on', 'x', 'y', 'kk', 'd'];
const GAME_TABLES = ['chess', 'checkers', 'reversi', 'connect4', 'ttt'];
const newTable = () => ({ seats: [null, null], log: [] });
const ARC_TABLES = ['pong', 'hockey', 'foos', 'darts', 'cycles'];
const newArc = () => ({ seats: [null, null], st: '', watch: new Set() });   // game room arcade tables: seats, the last game state, who is watching
const arcView = r => { const o = {}; ARC_TABLES.forEach(g => { const t = r.arc && r.arc[g]; if (t) o[g] = { seats: t.seats, st: t.seats[0] && t.seats[1] ? t.st : '' }; }); return o; };
// 🏛️ town hall screen sharing: one presenter; viewers are joined into a tree (the presenter feeds 4, everyone else passes it on to 3)
const TH_FAN0 = 4, TH_FAN = 3;
const newHall = () => ({ hands: [], floor: null, quiet: false, next: null, nextT: 0 });   // town hall Q&A: raised hands in order, who has the floor, quiet mode, a pending hand-over
const hallView = h => ({ hands: h.hands.slice(), floor: h.floor, quiet: h.quiet, next: h.next });
const newTh = () => ({ by: null, title: '', t0: 0, par: new Map(), kids: new Map(), bad: new Map(), fails: new Map(), snap: new Set() });
const newBill = () => ({ seats: [null, null], st: '', turn: 0, n: 0, shooter: null });   // the billiards table: seats, last settled position, whose turn
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
  if (out.call !== undefined) out.call = typeof out.call === 'string' && /^[A-Za-z0-9]{1,40}$/.test(out.call) ? out.call : null;   // the 📞 talk someone is in
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
    if (!r) { r = { clients: new Map(), music: null, games: {}, bill: newBill(), arc: {}, th: newTh(), hall: newHall() }; GAME_TABLES.forEach(g => { r.games[g] = newTable(); }); ARC_TABLES.forEach(g => { r.arc[g] = newArc(); }); rooms.set(name, r); }
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
  // ---- town hall tree ----
  const thTo = (room, id, obj) => { const x = room.clients.get(id); if (x) send(x, Object.assign({ t: 'ev', from: '', k: 'th' }, obj)); };
  const thUnder = (th, node, anc) => { let p = node, n = 0; while (p && n++ < 120) { if (p === anc) return true; if (p === th.by) return false; p = th.par.get(p); } return false; };
  const thDepth = (th, id) => { let d = 0, p = id; while (p && p !== th.by && d < 120) { p = th.par.get(p); d++; } return p === th.by ? d : 999; };
  function thDetach(room, id, tell) {
    const th = room.th, p = th.par.get(id); if (p === undefined) return;
    th.par.delete(id); const k = th.kids.get(p); if (k) k.delete(id);
    if (tell) thTo(room, p, { act: 'unkid', id: id });
  }
  function thAttach(room, id) {
    const th = room.th; if (!th.by || id === th.by || !room.clients.has(id)) return;
    thDetach(room, id, true);
    const bad = th.bad.get(id) || new Set();
    let best = null, bs = 1e9;
    for (const p of [th.by].concat(Array.from(th.par.keys()))) {
      if (p === id || bad.has(p) || !room.clients.has(p) || th.snap.has(p)) continue;
      const d = thDepth(th, p); if (d >= 999 || (p !== th.by && thUnder(th, p, id))) continue;
      const n = (th.kids.get(p) || new Set()).size; if (n >= (p === th.by ? TH_FAN0 : TH_FAN)) continue;
      const s = d * 10 + n; if (s < bs) { bs = s; best = p; }
    }
    if (!best) { thSnapOn(room, id); return; }
    th.par.set(id, best); if (!th.kids.has(best)) th.kids.set(best, new Set()); th.kids.get(best).add(id);
    thTo(room, best, { act: 'kid', id: id }); thTo(room, id, { act: 'parent', id: best });
  }
  function thOrphans(room, id) {   // someone left the tree: their children find new parents (and keep their own children)
    const th = room.th, ks = Array.from(th.kids.get(id) || []); th.kids.delete(id);
    ks.forEach(k => th.par.delete(k)); ks.forEach(k => thAttach(room, k));
  }
  function thSnapOn(room, id) {   // no working direct connection: a still picture through the server instead
    const th = room.th; thDetach(room, id, true); thOrphans(room, id);
    th.snap.add(id); thTo(room, id, { act: 'snap', on: 1 }); if (th.by) thTo(room, th.by, { act: 'snapn', n: th.snap.size });
  }
  function thRemove(room, id) {
    const th = room.th; if (!th || !th.by) return;
    thDetach(room, id, true); thOrphans(room, id);
    if (th.snap.delete(id)) thTo(room, th.by, { act: 'snapn', n: th.snap.size });
    th.bad.delete(id); th.fails.delete(id);
  }
  const hallSend = room => broadcast(room, { t: 'ev', from: '', k: 'hall', act: 'state', st: hallView(room.hall) });
  function thStop(room) {
    const th = room.th; if (!th || !th.by) return; const by = th.by; room.th = newTh(); broadcast(room, { t: 'ev', from: by, k: 'th', act: 'stop', by: by });
    const hl = room.hall; if (hl && (hl.quiet || hl.next)) { hl.quiet = false; hl.next = null; hallSend(room); }
  }
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

      if (m.t === 'ev' && m.k === 'arc' && (m.act === 'in' || m.act === 'st')) {   // game room arcade, live updates: their own allowance so they never crowd out chat and movement
        c.atok = Math.min(80, (c.atok == null ? 80 : c.atok) + (t - (c.alast || t)) / 25); c.alast = t;   // about 40 a second
        if (c.atok < 1 || !c.room) return;
        c.atok -= 1;
        const room = rooms.get(c.room); if (!room) return;
        const table = String(m.table || ''), tb = room.arc && ARC_TABLES.indexOf(table) > -1 ? room.arc[table] : null; if (!tb) return;
        if (m.act === 'in') {   // Player 2's controls go only to Player 1, who runs the game
          if (tb.seats[1] !== c.id || !tb.seats[0]) return;
          const host = room.clients.get(tb.seats[0]); if (!host) return;
          const num = v => typeof v === 'number' && isFinite(v) ? Math.max(-1000, Math.min(100000, v)) : 0;
          send(host, { t: 'ev', from: c.id, k: 'arc', table: table, act: 'in', x: num(m.x), y: num(m.y), kk: num(m.kk), d: num(m.d) });
          return;
        }
        if (tb.seats[0] !== c.id || !tb.seats[1] || typeof m.url !== 'string' || m.url.length > 6000) return;   // the game itself, from Player 1 to the players and watchers
        tb.st = m.url;
        broadcast(room, { t: 'ev', from: c.id, k: 'arc', table: table, act: 'st', url: m.url }, c.id, x => tb.seats.indexOf(x.id) > -1 || tb.watch.has(x.id));
        return;
      }

      if (m.t === 'snap') {   // town hall fallback picture: from the presenter to the people who can't get the live stream
        c.stok = Math.min(3, (c.stok == null ? 3 : c.stok) + (t - (c.slast || t)) / 600); c.slast = t;
        if (c.stok < 1 || !c.room) return;
        c.stok -= 1;
        const room = rooms.get(c.room); if (!room || !room.th || room.th.by !== c.id || !room.th.snap.size) return;
        const d = typeof m.d === 'string' && m.d.length <= 62000 && /^[A-Za-z0-9+/=]+$/.test(m.d) ? m.d : null; if (!d) return;
        const out = JSON.stringify({ t: 'snap', from: c.id, d: d });
        room.th.snap.forEach(id => { const x = room.clients.get(id); if (x) { try { x.sock.send(out); } catch (e) {} } });
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
        send(c, { t: 'welcome', id: c.id, room: name, peers: peers, music: room.music, movie: room.movie || null, games: room.games, bill: room.bill || null, arc: arcView(room), th: room.th && room.th.by ? { by: room.th.by, title: room.th.title } : null, hall: hallView(room.hall || (room.hall = newHall())), token: issueToken(c, name), locked: !!need, admin: !!passFor(name) });
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
          ev[k] = (typeof v === 'number' && isFinite(v)) || typeof v === 'boolean' ? v : str(v, k === 'url' ? (m.k === 'arc' ? 6000 : 1000) : 120);
        }
        if (ev.k === 'hall') {   // 🏛️ town hall Q&A
          const hl = room.hall || (room.hall = newHall()), th = room.th || (room.th = newTh());
          const host = th.by ? th.by === c.id : true, id = typeof ev.id === 'string' ? ev.id : '';
          if (ev.act === 'hand') { if (th.by === c.id || hl.hands.indexOf(c.id) > -1 || hl.floor === c.id || hl.hands.length >= 60) return; hl.hands.push(c.id); }
          else if (ev.act === 'lower') { const who = id || c.id; if (who !== c.id && !host) return; const n = hl.hands.length; hl.hands = hl.hands.filter(x => x !== who); if (hl.hands.length === n) return; }
          else if (ev.act === 'floor') { if (!host) return; const who = id && room.clients.has(id) ? id : null; if (who === hl.floor) return; hl.floor = who; if (who) hl.hands = hl.hands.filter(x => x !== who); }
          else if (ev.act === 'yield') { if (hl.floor !== c.id) return; hl.floor = null; }
          else if (ev.act === 'clear') { if (!host || !hl.hands.length) return; hl.hands = []; }
          else if (ev.act === 'quiet') { if (!th.by || th.by !== c.id) return; const on = !!ev.on; if (on === hl.quiet) return; hl.quiet = on; }
          else if (ev.act === 'pass') {
            if (!th.by || th.by !== c.id || !id || id === c.id || !room.clients.has(id)) return;
            hl.next = id; hl.nextT = t; send(room.clients.get(id), { t: 'ev', from: c.id, k: 'hall', act: 'invite', by: c.id });
          }
          else if (ev.act === 'decline') { if (hl.next !== c.id) return; hl.next = null; if (th.by) { const p = room.clients.get(th.by); if (p) send(p, { t: 'ev', from: c.id, k: 'hall', act: 'declined', id: c.id }); } }
          else return;
          hallSend(room);
          return;
        }
        if (ev.k === 'th') {   // 🏛️ town hall screen sharing
          const th = room.th || (room.th = newTh());
          if (ev.act === 'start') {
            const hl = room.hall || (room.hall = newHall()), handover = hl.next === c.id && t - hl.nextT < 90000;
            if (th.by && th.by !== c.id && room.clients.has(th.by) && !handover) { send(c, { t: 'ev', from: '', k: 'th', act: 'busy', by: th.by }); return; }
            room.th = newTh(); room.th.by = c.id; room.th.title = typeof ev.title === 'string' ? ev.title.slice(0, 80) : ''; room.th.t0 = t;
            broadcast(room, { t: 'ev', from: c.id, k: 'th', act: 'start', by: c.id, title: room.th.title });
            hl.next = null; hl.hands = hl.hands.filter(x => x !== c.id); if (hl.floor === c.id) hl.floor = null; hallSend(room);
            return;
          }
          if (ev.act === 'stop') { if (th.by === c.id) thStop(room); return; }
          if (!th.by || c.id === th.by) return;
          if (ev.act === 'want') {
            if (th.snap.has(c.id)) { thTo(room, c.id, { act: 'snap', on: 1 }); return; }
            const p = th.par.get(c.id);
            if (p && thDepth(th, c.id) < 999) { thTo(room, p, { act: 'kid', id: c.id }); thTo(room, c.id, { act: 'parent', id: p }); return; }
            thAttach(room, c.id); return;
          }
          if (ev.act === 'leave') { thRemove(room, c.id); return; }
          if (ev.act === 'fail') {
            if (th.par.get(c.id) !== ev.id) return;
            const b = th.bad.get(c.id) || new Set(); b.add(ev.id); th.bad.set(c.id, b);
            const f = (th.fails.get(c.id) || 0) + 1; th.fails.set(c.id, f);
            if (f >= 3) thSnapOn(room, c.id); else thAttach(room, c.id);
            return;
          }
          return;
        }
        if (ev.k === 'arc') {   // game room arcade: Player 1 runs the game and sends it out; Player 2 sends their controls to Player 1
          const tb = room.arc && room.arc[ev.table]; if (!tb) return;
          if (ev.act === 'watch') { if (ev.on) { if (tb.watch.size < 60) tb.watch.add(c.id); } else tb.watch.delete(c.id); return; }
          if (ev.act === 'seat') {
            const i = ev.seat === 1 ? 1 : 0;
            if (tb.seats[i] && tb.seats[i] !== c.id) { send(c, { t: 'ev', from: c.id, k: 'arc', table: ev.table, act: 'seatno' }); return; }
            tb.seats = tb.seats.map(x => x === c.id ? null : x); tb.seats[i] = c.id; tb.st = '';
            broadcast(room, ev); return;
          }
          if (ev.act === 'unseat') { if (tb.seats.indexOf(c.id) < 0) return; tb.seats = tb.seats.map(x => x === c.id ? null : x); tb.st = ''; broadcast(room, ev); return; }
          if (tb.seats.indexOf(c.id) < 0) return;
          if (ev.act === 'reset') { tb.st = ''; broadcast(room, ev); return; }
          return;   // live game updates ('in' and 'st') are handled further up, with their own allowance
        }
        if (ev.k === 'bill') {   // online billiards: two seats; the player whose turn it is shoots, then sends where the balls stopped
          const tb = room.bill || (room.bill = newBill());
          const clear = () => { tb.st = ''; tb.turn = 0; tb.n = 0; tb.shooter = null; };
          if (ev.act === 'seat') {
            const i = ev.seat === 1 ? 1 : 0;
            if (tb.seats[i] && tb.seats[i] !== c.id) { send(c, { t: 'ev', from: c.id, k: 'bill', act: 'seatno' }); return; }
            tb.seats = tb.seats.map(x => x === c.id ? null : x); tb.seats[i] = c.id;
            if (!tb.seats[1 - i]) clear();
            broadcast(room, ev); return;
          }
          if (ev.act === 'unseat') { tb.seats = tb.seats.map(x => x === c.id ? null : x); if (!tb.seats[0] && !tb.seats[1]) clear(); broadcast(room, ev); return; }
          if (tb.seats.indexOf(c.id) < 0) return;
          if (ev.act === 'reset') { clear(); broadcast(room, ev); return; }
          if (ev.act === 'shot') { if (!tb.seats[0] || !tb.seats[1] || tb.seats[tb.turn] !== c.id || ev.n !== tb.n || typeof ev.mv !== 'string') return; tb.n++; tb.shooter = c.id; broadcast(room, ev, c.id); return; }
          if (ev.act === 'res') { if (tb.shooter !== c.id || typeof ev.url !== 'string') return; tb.st = ev.url; tb.turn = ev.seat === 1 ? 1 : 0; tb.shooter = null; broadcast(room, ev, c.id); return; }
          return;
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
        if ((ev.k === 'dance' || ev.k === 'call') && ev.to) {   // dance invites and 📞 talk requests go to one person
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
      if (room.th && room.th.by) { if (room.th.by === c.id) thStop(room); else thRemove(room, c.id); }
      { const hl = room.hall; if (hl && (hl.hands.indexOf(c.id) > -1 || hl.floor === c.id || hl.next === c.id)) { hl.hands = hl.hands.filter(x => x !== c.id); if (hl.floor === c.id) hl.floor = null; if (hl.next === c.id) hl.next = null; hallSend(room); } }
      if (room.arc) ARC_TABLES.forEach(g => { const tb = room.arc[g]; if (!tb) return; tb.watch.delete(c.id); if (tb.seats.indexOf(c.id) > -1) { tb.seats = tb.seats.map(x => x === c.id ? null : x); tb.st = ''; } });
      { const tb = room.bill; if (tb) { if (tb.shooter === c.id) tb.shooter = null; if (tb.seats.indexOf(c.id) > -1) { tb.seats = tb.seats.map(x => x === c.id ? null : x); if (!tb.seats[0] && !tb.seats[1]) { tb.st = ''; tb.turn = 0; tb.n = 0; } } } }
      broadcast(room, { t: 'leave', id: c.id });
      if (!room.clients.size) rooms.delete(name);
    }

    return { id: c.id, message: message, close: close };
  }

  return { connect: connect, rooms: rooms, sweep: sweep };
}

module.exports = { createHub: createHub, cleanState: cleanState, roomName: roomName };
