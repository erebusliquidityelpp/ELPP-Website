/* Exchange market-data relay: lets a browser that cannot reach an exchange (network block, ISP, VPN, extension) read PUBLIC market data through this server.
   Read-only on purpose: Hyperliquid only the /info endpoint with a list of read types (never /exchange, so it cannot trade), and other exchanges only GET on a host allow-list.
   No keys, no cookies, nothing is forwarded from the visitor except the JSON body or URL they asked for. */
const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const HL = 'https://api.hyperliquid.xyz/info';
const HL_TYPES = new Set(['meta', 'metaAndAssetCtxs', 'allMids', 'candleSnapshot', 'l2Book', 'recentTrades', 'predictedFundings', 'fundingHistory', 'clearinghouseState', 'userFills', 'userFillsByTime', 'openOrders', 'frontendOpenOrders', 'spotMeta', 'spotMetaAndAssetCtxs', 'perpDexs', 'outcomeMeta', 'userFunding', 'portfolio', 'leaderboard', 'vaultDetails', 'userRole']);
const HOSTS = new Set(['fapi.binance.com', 'api.binance.com', 'api.bybit.com', 'www.okx.com', 'api.bitget.com', 'api.gateio.ws', 'indexer.dydx.trade', 'fapi.asterdex.com', 'api.prod.paradex.trade', 'data.api.drift.trade', 'mainnet.zklighter.elliot.ai', 'api.mexc.com', 'contract.mexc.com', 'api-contract.weex.com', 'www.deribit.com', 'api.coingecko.com']);
const lim = rateLimit({ windowMs: 60e3, limit: 900, standardHeaders: true, legacyHeaders: false, message: { error: 'Relay busy, retry shortly.' } });
const cache = new Map(); /* key -> {at, body, type}; a few seconds only, so many visitors do not multiply upstream calls */
const TTL = 3000, MAX = 600;
function keep(k, v) { if (cache.size >= MAX) cache.delete(cache.keys().next().value); cache.set(k, Object.assign({ at: Date.now() }, v)); }
async function up(url, opt, ms) {
  const c = new AbortController(), t = setTimeout(() => c.abort(), ms || 15000);
  try { const r = await fetch(url, Object.assign({ signal: c.signal, redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ELPP-Scanner/1.0)', Accept: 'application/json' } }, opt || {})); const body = await r.text(); return { status: r.status, body, type: r.headers.get('content-type') || 'application/json' }; }
  finally { clearTimeout(t); }
}
router.post('/api/hl', lim, async (req, res) => {
  res.set('X-ELPP-Relay', '1').set('Cache-Control', 'no-store');
  const b = req.body; if (!b || typeof b !== 'object' || !HL_TYPES.has(b.type)) return res.status(403).json({ error: 'request type not allowed' });
  const key = 'hl|' + JSON.stringify(b), hit = cache.get(key); if (hit && Date.now() - hit.at < TTL) return res.status(hit.status).type('application/json').send(hit.body);
  try { const r = await up(HL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'ELPP-Scanner/1.0' }, body: JSON.stringify(b) }); if (r.status === 200) keep(key, { status: 200, body: r.body }); res.status(r.status).type('application/json').send(r.body); }
  catch (e) { res.status(502).json({ error: 'upstream failed' }); }
});
router.get('/api/rx', lim, async (req, res) => {
  res.set('X-ELPP-Relay', '1').set('Cache-Control', 'no-store');
  let u; try { u = new URL(String(req.query.u || '')); } catch (e) { return res.status(400).json({ error: 'bad url' }); }
  if (u.protocol !== 'https:' || u.username || u.password || u.port || String(req.query.u).length > 900 || !HOSTS.has(u.hostname.toLowerCase()) || !/^\/[A-Za-z0-9/_.\-]*$/.test(u.pathname)) return res.status(403).json({ error: 'host or path not allowed' });
  const key = 'rx|' + u.toString(), hit = cache.get(key); if (hit && Date.now() - hit.at < TTL) return res.status(200).type(hit.type).send(hit.body);
  try { const r = await up(u.toString()); if (r.status === 200) keep(key, { status: 200, body: r.body, type: r.type }); res.status(r.status).type(r.type).send(r.body); }
  catch (e) { res.status(502).json({ error: 'upstream failed' }); }
});
module.exports = { router };
