/* Read-only data proxy (same idea as proxy.php). Only an allow-list of public market-data URLs, so it cannot be used as an open proxy.
   Mounted at GET /proxy.php?u=<https url>  (same address the scanner already knows) and GET /api/px?u=... */
const express = require('express');
const cache = new Map(); /* url -> {at, body, type} */
const MAX = 400;
const A = (re, ttl) => ({ re, ttl });
const ALLOW = {
  'fred.stlouisfed.org': A(/^\/graph\/fredgraph\.csv$/, 3600),
  'www.binance.com': A(/^\/bapi\/composite\/v1\/public\/cms\/article\/list\/query$/, 300),
  'mempool.space': A(/^\/api\/(v1\/)?[a-z/]+$/, 120),
  'query1.finance.yahoo.com': A(/^\/v8\/finance\/chart\/[A-Za-z0-9^.\-=]+$/, 60),
  'cftc.gov': A(/^\/dea\/newcot\//, 21600),
  'www.cftc.gov': A(/^\/dea\/newcot\//, 21600),
  'api-contract.weex.com': A(/^\/capi\/v3\/market\/(exchangeInfo|ticker\/24hr)$/, 300),
  'nfs.faireconomy.media': A(/^\/ff_calendar_(thisweek|nextweek)\.json$/, 600),
  'farside.co.uk': A(/^\/(btc|eth|sol)?\/?$/, 3600),
  'markets.newyorkfed.org': A(/^\/api\//, 3600),
  'api.llama.fi': A(/^\/(protocols|v2\/chains|overview\/[a-z/]+|summary\/[a-z/]+\/[A-Za-z0-9._-]+)$/, 600),
  'stablecoins.llama.fi': A(/^\/(stablecoins|stablecoincharts\/all|stablecoinchains)$/, 600),
  'yields.llama.fi': A(/^\/pools$/, 900),
  'api.frankfurter.app': A(/^\/(latest|[0-9-]+(\.\.[0-9-]*)?)$/, 3600)
};
const UA = 'Mozilla/5.0 (compatible; ELPP-Scanner/1.0)';

async function get(url, ms, headers) {
  const c = new AbortController(), t = setTimeout(() => c.abort(), ms);
  try { const r = await fetch(url, { signal: c.signal, redirect: 'follow', headers: Object.assign({ 'User-Agent': UA, Accept: 'application/json,text/csv,text/html,*/*' }, headers || {}) }); const b = await r.text(); return { ok: r.ok, status: r.status, body: b, type: r.headers.get('content-type') || 'text/plain' }; }
  finally { clearTimeout(t); }
}

/* FRED through the official API (key stays in Railway variables) and returned in the same CSV shape as fredgraph.csv */
async function fredCsv(u) {
  const id = (u.searchParams.get('id') || '').replace(/[^A-Za-z0-9_]/g, '').slice(0, 30), cosd = /^\d{4}-\d{2}-\d{2}$/.test(u.searchParams.get('cosd') || '') ? u.searchParams.get('cosd') : '2023-01-01';
  const key = process.env.FRED_API_KEY;
  if (!id) throw new Error('no series id');
  if (key) {
    const r = await get('https://api.stlouisfed.org/fred/series/observations?series_id=' + id + '&api_key=' + encodeURIComponent(key) + '&file_type=json&observation_start=' + cosd, 20000);
    if (r.ok) { const j = JSON.parse(r.body); const rows = (j.observations || []).filter(o => o.value !== '.' && o.value !== ''); if (rows.length) return { body: 'observation_date,' + id + '\n' + rows.map(o => o.date + ',' + o.value).join('\n') + '\n', type: 'text/csv' }; }
  }
  const r = await get(u.toString(), 20000);
  if (!r.ok) throw new Error('FRED HTTP ' + r.status);
  return { body: r.body, type: 'text/csv' };
}

async function fetchAllowed(raw) {
  let u; try { u = new URL(raw); } catch (e) { return { code: 400, err: 'bad url' }; }
  if (raw.length > 600 || u.protocol !== 'https:' || u.username || u.password || u.port) return { code: 400, err: 'bad url' };
  const rule = ALLOW[u.hostname.toLowerCase()];
  if (!rule || !rule.re.test(u.pathname)) return { code: 403, err: 'host or path not allowed' };
  const key = u.toString(), hit = cache.get(key), now = Date.now();
  if (hit && now - hit.at < rule.ttl * 1000) return { body: hit.body, type: hit.type };
  try {
    const out = u.hostname === 'fred.stlouisfed.org' ? await fredCsv(u) : await (async () => { const r = await get(key, 15000); if (!r.ok) throw new Error('upstream ' + r.status); if (r.body.length > 3e6) throw new Error('too big'); return { body: r.body, type: r.type }; })();
    if (cache.size >= MAX) cache.delete(cache.keys().next().value);
    cache.set(key, { at: now, body: out.body, type: out.type });
    return out;
  } catch (e) {
    if (hit) return { body: hit.body, type: hit.type }; /* serve stale data if the source is down */
    return { code: 502, err: 'upstream failed: ' + (e && e.message || 'error') };
  }
}

const router = express.Router();
async function handle(req, res) {
  res.set('X-ELPP-Proxy', '1').set('Cache-Control', 'no-store');
  const r = await fetchAllowed(String(req.query.u || ''));
  if (r.err) return res.status(r.code).json({ error: r.err });
  res.type(/json/.test(r.type) ? 'application/json' : 'text/plain; charset=utf-8').send(r.body);
}
router.get('/proxy.php', handle);
router.get('/api/px', handle);
module.exports = { router, fetchAllowed };
