/* ELPP accounts backend: signup, login, sessions. Node + Express + SQLite.
   Run: npm install && npm start   (settings come from environment variables, see README.md) */
const express = require('express'), cors = require('cors'), helmet = require('helmet'), rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs'), jwt = require('jsonwebtoken'), Database = require('better-sqlite3');
const fs = require('fs'), path = require('path'), crypto = require('crypto');

const PORT = +process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'elpp.db');
const ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://erebusliquidityelpp.github.io').split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean);
const ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const SIGNUP_OPEN = String(process.env.SIGNUP_OPEN || 'true') !== 'false';
let SECRET = process.env.JWT_SECRET;
if (!SECRET || SECRET.length < 24) { SECRET = crypto.randomBytes(32).toString('hex'); console.warn('WARNING: JWT_SECRET is not set (or shorter than 24 characters). A temporary one is used, so everyone is logged out on every restart. Set JWT_SECRET in your environment.'); }

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  pass_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  token_version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login TEXT
)`);
const q = {
  byEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  byId: db.prepare('SELECT * FROM users WHERE id = ?'),
  insert: db.prepare('INSERT INTO users(email, name, pass_hash, role) VALUES (?, ?, ?, ?)'),
  touch: db.prepare("UPDATE users SET last_login = datetime('now') WHERE id = ?"),
  bump: db.prepare('UPDATE users SET token_version = token_version + 1 WHERE id = ?'),
  setPass: db.prepare('UPDATE users SET pass_hash = ?, token_version = token_version + 1 WHERE id = ?'),
  list: db.prepare('SELECT id, email, name, role, created_at, last_login FROM users ORDER BY id DESC LIMIT 500'),
  count: db.prepare('SELECT COUNT(*) AS n FROM users')
};
const DUMMY = bcrypt.hashSync('not-a-real-password', 11);

const app = express();
app.set('trust proxy', 1);
app.use(helmet());
app.use(cors({ origin: (o, cb) => cb(null, !o || ORIGINS.includes(o) || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o) && process.env.ALLOW_LOCALHOST === 'true'), methods: ['GET', 'POST', 'DELETE'], allowedHeaders: ['Content-Type', 'Authorization'], exposedHeaders: ['X-ELPP-Proxy'], maxAge: 600 }));
app.use(express.json({ limit: '10kb' }));
app.use(rateLimit({ windowMs: 15 * 60e3, limit: 300, standardHeaders: true, legacyHeaders: false }));
const authLimit = rateLimit({ windowMs: 15 * 60e3, limit: 15, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many attempts. Wait 15 minutes and try again.' } });

const pub = u => ({ id: u.id, email: u.email, name: u.name, role: u.role });
const sign = u => jwt.sign({ sub: u.id, tv: u.token_version }, SECRET, { expiresIn: '30d' });
const okEmail = e => typeof e === 'string' && e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);
const okPass = p => typeof p === 'string' && p.length >= 8 && p.length <= 200;

function auth(req, res, next) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  if (!m) return res.status(401).json({ error: 'Please log in.' });
  try {
    const p = jwt.verify(m[1], SECRET), u = q.byId.get(p.sub);
    if (!u || u.token_version !== p.tv) throw new Error('revoked');
    req.user = u; next();
  } catch (e) { res.status(401).json({ error: 'Your session ended. Please log in again.' }); }
}

app.get('/api/health', (req, res) => res.json({ ok: true, users: q.count.get().n }));

app.post('/api/signup', authLimit, async (req, res) => {
  if (!SIGNUP_OPEN) return res.status(403).json({ error: 'Sign-ups are closed right now.' });
  const name = String((req.body || {}).name || '').trim().slice(0, 60), email = String((req.body || {}).email || '').trim().toLowerCase(), password = (req.body || {}).password;
  if (name.length < 2) return res.status(400).json({ error: 'Please enter your name.' });
  if (!okEmail(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });
  if (!okPass(password)) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  if (q.byEmail.get(email)) return res.status(409).json({ error: 'That email already has an account. Try logging in.' });
  const hash = await bcrypt.hash(password, 11);
  try { const r = q.insert.run(email, name, hash, email === ADMIN_EMAIL ? 'admin' : 'user'); const u = q.byId.get(r.lastInsertRowid); q.touch.run(u.id); res.status(201).json({ token: sign(u), user: pub(u) }); }
  catch (e) { res.status(409).json({ error: 'That email already has an account. Try logging in.' }); }
});

app.post('/api/login', authLimit, async (req, res) => {
  const email = String((req.body || {}).email || '').trim().toLowerCase(), password = (req.body || {}).password;
  const u = okEmail(email) ? q.byEmail.get(email) : null;
  const good = await bcrypt.compare(typeof password === 'string' ? password.slice(0, 200) : '', u ? u.pass_hash : DUMMY);
  if (!u || !good) return res.status(401).json({ error: 'Wrong email or password.' });
  if (email === ADMIN_EMAIL && u.role !== 'admin') db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(u.id);
  q.touch.run(u.id);
  const f = q.byId.get(u.id); res.json({ token: sign(f), user: pub(f) });
});

app.get('/api/me', auth, (req, res) => res.json({ user: pub(req.user) }));

/* log out on every device: bumps the version so all older tokens stop working */
app.post('/api/logout', auth, (req, res) => { q.bump.run(req.user.id); res.json({ ok: true }); });

app.post('/api/password', authLimit, auth, async (req, res) => {
  const { current, next } = req.body || {};
  if (!okPass(next)) return res.status(400).json({ error: 'New password must be at least 8 characters.' });
  if (!(await bcrypt.compare(String(current || '').slice(0, 200), req.user.pass_hash))) return res.status(401).json({ error: 'Current password is wrong.' });
  q.setPass.run(await bcrypt.hash(next, 11), req.user.id);
  const f = q.byId.get(req.user.id); res.json({ token: sign(f), user: pub(f) });
});

app.get('/api/admin/users', auth, (req, res) => req.user.role === 'admin' ? res.json({ users: q.list.all() }) : res.status(403).json({ error: 'Admin only.' }));

app.use(require('./proxy').router);
app.use(require('./alerts')(db, auth, SECRET, authLimit));

app.use((req, res) => res.status(404).json({ error: 'Not found.' }));
app.use((err, req, res, next) => { if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Bad request.' }); console.error(err); res.status(500).json({ error: 'Server error.' }); });

app.listen(PORT, () => console.log('ELPP backend listening on ' + PORT + ' | allowed origins: ' + ORIGINS.join(', ')));
