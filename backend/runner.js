/* Always-on scanner runner support.
   A second Railway service (folder /runner) opens the real scanner page in a headless browser 24/7, so signals, watchlist and morning-brief alerts keep running with every tab closed.
   This file stores the scanner settings you send from the app and tells you whether the runner is alive. */
const express = require('express'), crypto = require('crypto');
module.exports = function (db, auth, sign) {
  db.exec("CREATE TABLE IF NOT EXISTS runner(id INTEGER PRIMARY KEY CHECK (id = 1), state_json TEXT NOT NULL, updated_at INTEGER NOT NULL, owner_id INTEGER NOT NULL)");
  const get = db.prepare('SELECT * FROM runner WHERE id = 1'), set = db.prepare('INSERT INTO runner(id, state_json, updated_at, owner_id) VALUES (1,?,?,?) ON CONFLICT(id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at, owner_id = excluded.owner_id'), del = db.prepare('DELETE FROM runner WHERE id = 1');
  const byId = db.prepare('SELECT * FROM users WHERE id = ?');
  const HB = { at: 0, info: null };
  const TOKEN = process.env.RUNNER_TOKEN || '';
  const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
  const runnerAuth = (req, res, next) => (TOKEN.length >= 20 && same(req.headers['x-runner-token'] || '', TOKEN)) ? next() : res.status(401).json({ error: 'Runner token wrong or RUNNER_TOKEN not set on the server.' });
  const admin = (req, res, next) => req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Admin only.' });
  const r = express.Router();
  const big = express.json({ limit: '3mb' });
  /* app -> server: store the scanner settings the runner should use (admin only). Trading vault keys are never part of this. */
  r.post('/api/runner/state', big, auth, admin, (req, res) => {
    const st = (req.body || {}).state; if (!st || typeof st !== 'object' || Array.isArray(st)) return res.status(400).json({ error: 'No settings received.' });
    delete st.trd; delete st.vault; const j = JSON.stringify(st); if (j.length > 2.5e6) return res.status(400).json({ error: 'Settings are too large.' });
    set.run(j, Date.now(), req.user.id); res.json({ ok: true, bytes: j.length });
  });
  r.delete('/api/runner/state', auth, admin, (req, res) => { del.run(); res.json({ ok: true }); });
  r.get('/api/runner/status', auth, admin, (req, res) => { const s = get.get(); res.json({ tokenSet: TOKEN.length >= 20, hasState: !!s, stateAt: s ? s.updated_at : 0, heartbeat: HB.at, info: HB.info, alive: Date.now() - HB.at < 5 * 60000 }); });
  /* runner -> server */
  r.get('/api/runner/config', runnerAuth, (req, res) => { const s = get.get(); if (!s) return res.json({ ready: false }); const u = byId.get(s.owner_id); if (!u) return res.json({ ready: false }); res.json({ ready: true, updatedAt: s.updated_at, state: JSON.parse(s.state_json), token: sign(u), user: { id: u.id, email: u.email, name: u.name, role: u.role } }); });
  r.post('/api/runner/heartbeat', runnerAuth, express.json({ limit: '20kb' }), (req, res) => { HB.at = Date.now(); HB.info = req.body && typeof req.body === 'object' ? req.body : null; res.json({ ok: true }); });
  return r;
};
