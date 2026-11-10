/* 24/7 server alerts: checks Hyperliquid public data every minute and sends Telegram messages, even when no browser is open.
   Triggers: price level, funding rate, 24h move, open-interest change over 1h. */
const express = require('express'), crypto = require('crypto');

module.exports = function (db, auth, SECRET, authLimit) {
  db.exec(`CREATE TABLE IF NOT EXISTS tg(user_id INTEGER PRIMARY KEY, token_enc TEXT NOT NULL, chat_id TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS alerts(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, coin TEXT NOT NULL, kind TEXT NOT NULL, op TEXT NOT NULL, value REAL NOT NULL, cooldown_min INTEGER NOT NULL DEFAULT 30, active INTEGER NOT NULL DEFAULT 1, last_fired INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')));`);
  const KEY = crypto.createHash('sha256').update('elpp-tg|' + SECRET).digest();
  const enc = t => { const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', KEY, iv), b = Buffer.concat([c.update(t, 'utf8'), c.final()]); return [iv, c.getAuthTag(), b].map(x => x.toString('base64')).join('.'); };
  const dec = s => { try { const [iv, tag, b] = s.split('.').map(x => Buffer.from(x, 'base64')), d = crypto.createDecipheriv('aes-256-gcm', KEY, iv); d.setAuthTag(tag); return Buffer.concat([d.update(b), d.final()]).toString('utf8'); } catch (e) { return null; } };
  const q = {
    tgGet: db.prepare('SELECT * FROM tg WHERE user_id = ?'), tgSet: db.prepare('INSERT INTO tg(user_id, token_enc, chat_id) VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET token_enc = excluded.token_enc, chat_id = excluded.chat_id'), tgDel: db.prepare('DELETE FROM tg WHERE user_id = ?'),
    list: db.prepare('SELECT id, coin, kind, op, value, cooldown_min, active, last_fired FROM alerts WHERE user_id = ? ORDER BY id DESC'), count: db.prepare('SELECT COUNT(*) AS n FROM alerts WHERE user_id = ?'),
    ins: db.prepare('INSERT INTO alerts(user_id, coin, kind, op, value, cooldown_min) VALUES (?,?,?,?,?,?)'), del: db.prepare('DELETE FROM alerts WHERE id = ? AND user_id = ?'), tog: db.prepare('UPDATE alerts SET active = ? WHERE id = ? AND user_id = ?'),
    active: db.prepare('SELECT a.*, t.token_enc, t.chat_id FROM alerts a JOIN tg t ON t.user_id = a.user_id WHERE a.active = 1'), fired: db.prepare('UPDATE alerts SET last_fired = ? WHERE id = ?')
  };
  const M = { at: 0, err: '', coins: new Map(), oi: new Map() }; /* coin -> {px, funding, chg, oi}; oi -> [[t, oi]] */
  const KINDS = { price: 'price', funding: 'funding rate (% per hour)', chg24: '24h move (%)', oi1h: 'open interest change in 1h (%)' };

  async function poll() {
    try {
      const c = new AbortController(), t = setTimeout(() => c.abort(), 15000);
      const r = await fetch('https://api.hyperliquid.xyz/info', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'metaAndAssetCtxs' }), signal: c.signal }); clearTimeout(t);
      if (!r.ok) throw new Error('Hyperliquid HTTP ' + r.status);
      const [meta, ctx] = await r.json(), now = Date.now(), seen = new Map();
      meta.universe.forEach((u, i) => { const x = ctx[i]; if (!x || u.isDelisted) return; const px = +x.markPx, prev = +x.prevDayPx, oi = +x.openInterest * px; if (!isFinite(px) || px <= 0) return;
        seen.set(u.name.toUpperCase(), { px, funding: +x.funding * 100, chg: prev > 0 ? (px / prev - 1) * 100 : 0, oi });
        const h = M.oi.get(u.name.toUpperCase()) || []; h.push([now, oi]); while (h.length && now - h[0][0] > 75 * 60000) h.shift(); M.oi.set(u.name.toUpperCase(), h); });
      M.coins = seen; M.at = now; M.err = '';
      await evaluate(now);
    } catch (e) { M.err = (e && e.message) || 'error'; }
  }
  function oiChg(coin) { const h = M.oi.get(coin); if (!h || h.length < 2) return null; const now = h[h.length - 1][0]; let base = h[0]; for (const p of h) if (now - p[0] >= 3600e3 - 90e3) base = p; if (now - base[0] < 20 * 60000 || !base[1]) return null; return (h[h.length - 1][1] / base[1] - 1) * 100; }
  function value(coin, kind) { const c = M.coins.get(coin); if (!c) return null; return kind === 'price' ? c.px : kind === 'funding' ? c.funding : kind === 'chg24' ? c.chg : oiChg(coin); }
  const fmt = (k, v) => k === 'price' ? String(+v.toPrecision(6)) : v.toFixed(k === 'funding' ? 4 : 2) + '%';
  async function send(row, text) {
    const tok = dec(row.token_enc); if (!tok) return false;
    try { const r = await fetch('https://api.telegram.org/bot' + encodeURIComponent(tok) + '/sendMessage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: row.chat_id, text }) }); return r.ok; } catch (e) { return false; }
  }
  async function evaluate(now) {
    for (const a of q.active.all()) {
      if (a.last_fired && now - a.last_fired < a.cooldown_min * 60000) continue;
      const v = value(a.coin, a.kind); if (v === null) continue;
      const hit = a.kind === 'chg24' || a.kind === 'oi1h' ? Math.abs(v) >= a.value : a.op === 'above' ? v >= a.value : v <= a.value;
      if (!hit) continue;
      q.fired.run(now, a.id);
      await send(a, 'ELPP alert\n' + a.coin + ' ' + KINDS[a.kind] + ' is ' + fmt(a.kind, v) + ' (your trigger: ' + a.op + ' ' + fmt(a.kind, a.value) + ')\nChecked on the ELPP server, which runs around the clock.');
    }
  }
  setTimeout(poll, 3000); setInterval(poll, 60000);

  const r = express.Router();
  r.get('/api/alerts', auth, (req, res) => { const t = q.tgGet.get(req.user.id); res.json({ alerts: q.list.all(req.user.id), telegram: { set: !!t, chat: t ? t.chat_id : '' }, kinds: KINDS, server: { lastCheck: M.at, error: M.err, coins: M.coins.size } }); });
  r.get('/api/alerts/coins', auth, (req, res) => res.json({ coins: [...M.coins.keys()].sort() }));
  r.post('/api/telegram', authLimit, auth, (req, res) => {
    const token = String((req.body || {}).token || '').trim(), chat = String((req.body || {}).chat || '').trim();
    if (!/^\d{5,12}:[A-Za-z0-9_-]{30,60}$/.test(token)) return res.status(400).json({ error: 'That does not look like a Telegram bot token (format 123456:ABC...).' });
    if (!/^-?\d{4,18}$/.test(chat)) return res.status(400).json({ error: 'Chat id must be a number.' });
    q.tgSet.run(req.user.id, enc(token), chat); res.json({ ok: true });
  });
  r.delete('/api/telegram', auth, (req, res) => { q.tgDel.run(req.user.id); res.json({ ok: true }); });
  r.post('/api/telegram/test', authLimit, auth, async (req, res) => { const t = q.tgGet.get(req.user.id); if (!t) return res.status(400).json({ error: 'Save your Telegram bot first.' }); const ok = await send(t, 'ELPP test: your 24/7 server alerts are connected.'); res.status(ok ? 200 : 502).json(ok ? { ok: true } : { error: 'Telegram refused the message. Check the token, and press Start in your bot chat first.' }); });
  r.post('/api/alerts', auth, (req, res) => {
    const b = req.body || {}, coin = String(b.coin || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20), kind = String(b.kind || ''), op = b.op === 'below' && (b.kind === 'price' || b.kind === 'funding') ? 'below' : 'above', value = +b.value, cd = Math.max(5, Math.min(1440, Math.round(+b.cooldown || 30)));
    if (!coin) return res.status(400).json({ error: 'Pick a coin.' }); if (!KINDS[kind]) return res.status(400).json({ error: 'Pick what to watch.' }); if (!isFinite(value)) return res.status(400).json({ error: 'Enter a number for the trigger.' });
    if (M.coins.size && !M.coins.has(coin)) return res.status(400).json({ error: coin + ' is not listed on Hyperliquid, so the server cannot watch it.' });
    if (q.count.get(req.user.id).n >= 50) return res.status(400).json({ error: 'Limit is 50 alerts per account.' });
    q.ins.run(req.user.id, coin, kind, op, value, cd); res.status(201).json({ ok: true });
  });
  r.post('/api/alerts/:id/toggle', auth, (req, res) => { q.tog.run(req.body && req.body.active ? 1 : 0, +req.params.id, req.user.id); res.json({ ok: true }); });
  r.delete('/api/alerts/:id', auth, (req, res) => { q.del.run(+req.params.id, req.user.id); res.json({ ok: true }); });
  return r;
};
