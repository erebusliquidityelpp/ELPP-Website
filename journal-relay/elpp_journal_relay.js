#!/usr/bin/env node
/*
  ELPP JOURNAL RELAY
  Reads your trade history from your own exchange accounts and gives it to the scanner's Journal page.
  Your API keys stay HERE (on your PC or your own server). They never go into the web page.

  Needs Node 18 or newer. No packages to install.
  Run:   node elpp_journal_relay.js
  Test:  open  http://localhost:8787/health?token=YOUR_TOKEN   in a browser.

  SETTINGS (environment variables, or a file named .env next to this script, one NAME=value per line):
    JOURNAL_TOKEN     a long random password you invent. The Journal page must send the same one. REQUIRED.
    PORT              default 8787
    ALLOW_ORIGIN      comma list of web addresses allowed to call this. Default: your GitHub Pages site and localhost.
    BINANCE_KEY  BINANCE_SECRET                         (USD-M futures)
    BYBIT_KEY    BYBIT_SECRET                           (linear perpetuals)
    OKX_KEY      OKX_SECRET      OKX_PASSPHRASE         (swaps and futures)
    GATE_KEY     GATE_SECRET                            (USDT futures)
    BITGET_KEY   BITGET_SECRET   BITGET_PASSPHRASE      (USDT futures)
    KRAKEN_KEY   KRAKEN_SECRET                          (spot)

  CREATE EVERY API KEY AS READ-ONLY. Never tick Trade or Withdraw. Anything that can only read history cannot move your money.
  Hyperliquid and dYdX need no keys here: the Journal page reads them directly from your wallet address.
*/
'use strict';
const http = require('http'), crypto = require('crypto'), fs = require('fs'), path = require('path');
try { for (const l of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)){ const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(l); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch(e){}
const env = k => process.env[k] || '';
const PORT = +env('PORT') || 8787, TOKEN = env('JOURNAL_TOKEN');
const ORIGINS = (env('ALLOW_ORIGIN') || 'https://erebusliquidityelpp.github.io,http://localhost,http://127.0.0.1,null').split(',').map(s => s.trim()).filter(Boolean);
const BASE = {binance:env('BINANCE_BASE') || 'https://fapi.binance.com', bybit:env('BYBIT_BASE') || 'https://api.bybit.com', okx:env('OKX_BASE') || 'https://www.okx.com', gate:env('GATE_BASE') || 'https://api.gateio.ws', bitget:env('BITGET_BASE') || 'https://api.bitget.com', kraken:env('KRAKEN_BASE') || 'https://api.kraken.com'};
const DAY = 864e5, sleep = ms => new Promise(r => setTimeout(r, ms));
const hmac = (alg, key, data, enc) => crypto.createHmac(alg, key).update(data).digest(enc);
const sha = (alg, data, enc) => crypto.createHash(alg).update(data).digest(enc);
const num = v => { const x = parseFloat(v); return isFinite(x) ? x : null; };
async function jf(url, opt){
  const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 30000);
  try { const r = await fetch(url, Object.assign({signal:ctl.signal}, opt || {})), t = await r.text(); let j = null; try { j = JSON.parse(t); } catch(e){}
    if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + String(t).replace(/\s+/g, ' ').slice(0, 160)); if (j === null) throw new Error('not JSON: ' + t.slice(0, 80)); return j; }
  finally { clearTimeout(to); }
}
const coinOf = s => { let c = String(s).toUpperCase().replace(/[-_\/]?(USDT|USDC|BUSD|USD|PERP|SWAP)$/g, '').replace(/[-_](USDT|USDC|USD)[-_]?(SWAP|PERP)?$/, ''); c = c.replace(/-SWAP$|-PERP$/, ''); const m = /^1000(?!0)(.+)$/.exec(c); if (m) c = 'k' + m[1]; return c; };

/* flat to flat grouping of fills into trades. fill = {t, side:'B'|'A', px, sz, fee, pnl?} */
function group(src, coin, fills, mkt){
  fills = fills.slice().sort((a, b) => a.t - b.t); const out = []; let cur = null, pos = 0;
  const wavg = a => { const d = a.reduce((s, f) => s + f.sz, 0); return d > 0 ? a.reduce((s, f) => s + f.px * f.sz, 0) / d : null; };
  const fin = () => { if (!cur) return; const en = wavg(cur.open), ex = wavg(cur.close), sz = cur.open.reduce((s, f) => s + f.sz, 0), cs = cur.close.reduce((s, f) => s + f.sz, 0), dir = cur.side === 'long' ? 1 : -1;
    const pnl = cur.hasPnl ? cur.pnl - cur.fees : (ex - en) * cs * dir - cur.fees;
    if (en && ex) out.push({id:src + ':' + coin + ':' + cur.t0, src, coin, side:cur.side, entry:en, exit:ex, size:sz, open:cur.t0, close:cur.t1, fees:cur.fees, pnl, liq:false, mkt:mkt || 'perp'}); cur = null; };
  for (const f0 of fills){
    const f = Object.assign({}, f0), sp = pos; if (mkt === 'spot' && f.side === 'A') f.sz = Math.min(f.sz, Math.max(sp, 0)); if (!(f.sz > 0)) continue;
    const d = f.side === 'B' ? f.sz : -f.sz, next = sp + d, tiny = 1e-9 * Math.max(1, Math.abs(sp) + f.sz);
    if (!cur){ if (f.pnl !== undefined && f.pnl !== 0 && Math.abs(sp) <= tiny) continue; cur = {side:d > 0 ? 'long' : 'short', t0:f.t, t1:f.t, open:[], close:[], fees:0, pnl:0, hasPnl:false}; }
    const isOpen = (cur.side === 'long') === (f.side === 'B'), crossing = !isOpen && Math.abs(next) > tiny && sp * next < 0, part = crossing ? Math.abs(sp) : f.sz;
    (isOpen ? cur.open : cur.close).push({px:f.px, sz:part}); cur.fees += f.fee || 0; if (f.pnl !== undefined){ cur.pnl += f.pnl; cur.hasPnl = true; } cur.t1 = f.t; pos = next;
    if (Math.abs(next) <= tiny){ pos = 0; fin(); }
    else if (crossing){ fin(); cur = {side:next > 0 ? 'long' : 'short', t0:f.t, t1:f.t, open:[{px:f.px, sz:Math.abs(next)}], close:[], fees:0, pnl:0, hasPnl:false}; }
  }
  return out;
}
const groupAll = (src, fills, mkt) => { const by = new Map(); for (const f of fills){ if (!by.has(f.k)) by.set(f.k, {coin:f.coin, a:[]}); by.get(f.k).a.push(f); } let o = []; for (const {coin, a} of by.values()) o = o.concat(group(src, coin, a, mkt)); return o; };

/* ---------- Binance USD-M futures ---------- */
async function binSigned(p, q){ const qs = new URLSearchParams(Object.assign({timestamp:Date.now(), recvWindow:20000}, q)).toString(), sig = hmac('sha256', env('BINANCE_SECRET'), qs, 'hex'); return jf(BASE.binance + p + '?' + qs + '&signature=' + sig, {headers:{'X-MBX-APIKEY':env('BINANCE_KEY')}}); }
async function binance(days){
  const now = Date.now(), syms = new Set();
  for (let t = now - days * DAY; t < now; t += 7 * DAY){ let from = t; for (let k = 0; k < 5; k++){ const inc = await binSigned('/fapi/v1/income', {incomeType:'REALIZED_PNL', startTime:from, endTime:Math.min(now, t + 7 * DAY - 1), limit:1000}); for (const r of inc) if (r.symbol) syms.add(r.symbol); if (inc.length < 1000) break; from = inc[inc.length - 1].time + 1; } }
  const fills = [], seen = new Set();
  for (const s of syms){ for (let t = now - days * DAY; t < now; t += 7 * DAY){ let from = t; for (let k = 0; k < 8; k++){ const L = await binSigned('/fapi/v1/userTrades', {symbol:s, startTime:from, endTime:Math.min(now, t + 7 * DAY - 1), limit:1000});
        for (const r of L){ const uk = s + ':' + r.id; if (r.id !== undefined){ if (seen.has(uk)) continue; seen.add(uk); } const ca = String(r.commissionAsset || '').toUpperCase(), fee = ['USDT', 'USDC', 'BUSD', 'FDUSD'].includes(ca) ? +r.commission : 0; fills.push({k:s + (r.positionSide && r.positionSide !== 'BOTH' ? ':' + r.positionSide : ''), coin:coinOf(s), t:+r.time, side:r.side === 'BUY' ? 'B' : 'A', px:+r.price, sz:+r.qty, fee, pnl:+r.realizedPnl || 0}); }
        if (L.length < 1000) break; from = L[L.length - 1].time + 1; } await sleep(120); } }
  return groupAll('binance', fills);
}
/* ---------- Bybit linear: closed positions straight from the exchange ---------- */
async function bybit(days){
  const out = [], now = Date.now();
  for (let t = now - days * DAY; t < now; t += 7 * DAY){ let cursor = '';
    for (let k = 0; k < 10; k++){ const q = 'category=linear&limit=100&startTime=' + t + '&endTime=' + Math.min(now, t + 7 * DAY - 1) + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''), ts = String(Date.now()), rw = '20000';
      const j = await jf(BASE.bybit + '/v5/position/closed-pnl?' + q, {headers:{'X-BAPI-API-KEY':env('BYBIT_KEY'), 'X-BAPI-TIMESTAMP':ts, 'X-BAPI-RECV-WINDOW':rw, 'X-BAPI-SIGN':hmac('sha256', env('BYBIT_SECRET'), ts + env('BYBIT_KEY') + rw + q, 'hex')}});
      if (j.retCode !== 0) throw new Error('Bybit: ' + j.retMsg); const L = (j.result || {}).list || [];
      for (const r of L){ const c = +r.updatedTime || +r.createdTime; out.push({id:'bybit:' + (r.orderId || r.symbol + c), src:'bybit', coin:coinOf(r.symbol), side:r.side === 'Sell' ? 'long' : 'short', entry:+r.avgEntryPrice, exit:+r.avgExitPrice, size:+r.qty, lev:num(r.leverage), open:null, close:c, fees:(+r.openFee || 0) + (+r.closeFee || 0), pnl:+r.closedPnl, liq:/Liquidat/i.test(r.execType || r.orderType || ''), mkt:'perp'}); }
      cursor = (j.result || {}).nextPageCursor; if (!cursor || !L.length) break; await sleep(150); } }
  return out;
}
/* ---------- OKX swaps and futures: closed positions straight from the exchange ---------- */
async function okxGet(p){ const ts = new Date().toISOString(); return jf(BASE.okx + p, {headers:{'OK-ACCESS-KEY':env('OKX_KEY'), 'OK-ACCESS-SIGN':hmac('sha256', env('OKX_SECRET'), ts + 'GET' + p, 'base64'), 'OK-ACCESS-TIMESTAMP':ts, 'OK-ACCESS-PASSPHRASE':env('OKX_PASSPHRASE')}}); }
async function okx(days){
  const out = [], cut = Date.now() - days * DAY;
  for (const type of ['SWAP', 'FUTURES']){
    const ins = new Map(); try { const j = await jf(BASE.okx + '/api/v5/public/instruments?instType=' + type); for (const r of j.data || []) ins.set(r.instId, r); } catch(e){}
    let after = '';
    for (let k = 0; k < 20; k++){ const j = await okxGet('/api/v5/account/positions-history?instType=' + type + '&limit=100' + (after ? '&after=' + after : '')); if (j.code !== '0') throw new Error('OKX: ' + j.msg + ' (' + j.code + ')'); const L = j.data || []; if (!L.length) break;
      for (const r of L){ const c = +r.uTime; if (c < cut) { after = ''; break; } const i = ins.get(r.instId) || {}, en = +r.openAvgPx, ex = +r.closeAvgPx, pos = +r.closeTotalPos || +r.openMaxPos, mult = (+i.ctVal || 1) * (+i.ctMult || 1), sz = i.ctValCcy === 'USD' ? pos * (+i.ctVal || 1) / en : pos * mult, pnl = +r.realizedPnl;
        const side = r.direction === 'long' || r.direction === 'short' ? r.direction : (ex > en) === (pnl > 0) ? 'long' : 'short';
        out.push({id:'okx:' + r.instId + ':' + r.cTime, src:'okx', coin:coinOf(r.instId.split('-')[0]), side, entry:en, exit:ex, size:sz, lev:num(r.lever), open:+r.cTime, close:c, fees:Math.abs(+r.fee || 0), pnl, liq:r.type === '3' || r.type === '4', mkt:'perp'}); after = r.uTime; }
      if (!after || L.length < 100) break; await sleep(250); } }
  return out;
}
/* ---------- Gate USDT futures ---------- */
async function gateGet(p, q){ const ts = String(Math.floor(Date.now() / 1000)), sig = hmac('sha512', env('GATE_SECRET'), ['GET', '/api/v4' + p, q, sha('sha512', '', 'hex'), ts].join('\n'), 'hex'); return jf(BASE.gate + '/api/v4' + p + (q ? '?' + q : ''), {headers:{KEY:env('GATE_KEY'), Timestamp:ts, SIGN:sig, Accept:'application/json'}}); }
async function gate(days){
  const mult = new Map(); try { for (const c of await jf(BASE.gate + '/api/v4/futures/usdt/contracts')) mult.set(c.name, +c.quanto_multiplier || 1); } catch(e){}
  const out = [], from = Math.floor((Date.now() - days * DAY) / 1000);
  for (let off = 0; off < 1000; off += 100){ const L = await gateGet('/futures/usdt/position_close', 'limit=100&offset=' + off + '&from=' + from); if (!Array.isArray(L)) throw new Error('Gate: ' + JSON.stringify(L).slice(0, 120)); if (!L.length) break;
    for (const r of L){ let en = +r.long_price, ex = +r.short_price; const pnl = +r.pnl, side = r.side === 'short' ? 'short' : 'long', dir = side === 'long' ? 1 : -1;
      if (((ex - en) * dir >= 0) !== (pnl >= 0)){ const t = en; en = ex; ex = t; }
      out.push({id:'gate:' + r.contract + ':' + r.time + ':' + (r.first_open_time || ''), src:'gate', coin:coinOf(r.contract), side, entry:en, exit:ex, size:Math.abs(+r.max_size || +r.accum_size) * (mult.get(r.contract) || 1), open:r.first_open_time ? +r.first_open_time * 1000 : null, close:+r.time * 1000, fees:Math.abs(+r.pnl_fee || 0), pnl, liq:/liq/i.test(r.text || ''), mkt:'perp'}); }
    if (L.length < 100) break; await sleep(150); }
  return out;
}
/* ---------- Bitget USDT futures ---------- */
async function bitget(days){
  const out = [], now = Date.now();
  for (let t = now - days * DAY; t < now; t += 90 * DAY){ let last = '';
    for (let k = 0; k < 10; k++){ const q = 'productType=USDT-FUTURES&limit=100&startTime=' + t + '&endTime=' + Math.min(now, t + 90 * DAY) + (last ? '&idLessThan=' + last : ''), p = '/api/v2/mix/position/history-position', ts = String(Date.now());
      const j = await jf(BASE.bitget + p + '?' + q, {headers:{'ACCESS-KEY':env('BITGET_KEY'), 'ACCESS-SIGN':hmac('sha256', env('BITGET_SECRET'), ts + 'GET' + p + '?' + q, 'base64'), 'ACCESS-TIMESTAMP':ts, 'ACCESS-PASSPHRASE':env('BITGET_PASSPHRASE'), 'Content-Type':'application/json'}});
      if (j.code !== '00000') throw new Error('Bitget: ' + j.msg); const L = (j.data || {}).list || [];
      for (const r of L) out.push({id:'bitget:' + r.symbol + ':' + r.ctime, src:'bitget', coin:coinOf(r.symbol), side:r.holdSide === 'short' ? 'short' : 'long', entry:+r.openAvgPrice, exit:+r.closeAvgPrice, size:+r.closeTotalPos || +r.openTotalPos, open:+r.ctime, close:+r.utime, fees:Math.abs((+r.openFee || 0) + (+r.closeFee || 0)), pnl:+(r.netProfit !== undefined ? r.netProfit : r.pnl), liq:false, mkt:'perp'});
      last = (j.data || {}).endId; if (!last || L.length < 100) break; await sleep(200); } }
  return out;
}
/* ---------- Kraken spot ---------- */
async function kraken(days){
  const p = '/0/private/TradesHistory', all = [], cut = Date.now() - days * DAY; let ofs = 0, count = Infinity;
  while (ofs < count && ofs < 2000){ const nonce = String(Date.now() * 1000 + ofs), body = 'nonce=' + nonce + '&ofs=' + ofs, sig = hmac('sha512', Buffer.concat([Buffer.from(p), sha('sha256', nonce + body)]), Buffer.from(env('KRAKEN_SECRET'), 'base64'), 'base64');
    const j = await jf(BASE.kraken + p, {method:'POST', headers:{'API-Key':env('KRAKEN_KEY'), 'API-Sign':sig, 'Content-Type':'application/x-www-form-urlencoded'}, body});
    if (j.error && j.error.length) throw new Error('Kraken: ' + j.error.join(', ')); const T = (j.result || {}).trades || {}; count = +(j.result || {}).count || 0; const ks = Object.keys(T); if (!ks.length) break;
    for (const id of ks){ const r = T[id], t = Math.round(+r.time * 1000), m = /^(?:X|Z)?([A-Z0-9]{2,6}?)(?:Z?USD[TC]?)$/.exec(String(r.pair).toUpperCase()); if (!m || t < cut) continue; const c = m[1] === 'XBT' ? 'BTC' : m[1] === 'XDG' ? 'DOGE' : m[1]; all.push({k:c, coin:c, t, side:r.type === 'buy' ? 'B' : 'A', px:+r.price, sz:+r.vol, fee:+r.fee || 0}); }
    ofs += ks.length; await sleep(1200); }
  return groupAll('kraken', all, 'spot');
}
const ADAPTERS = {binance:{f:binance, need:['BINANCE_KEY', 'BINANCE_SECRET']}, bybit:{f:bybit, need:['BYBIT_KEY', 'BYBIT_SECRET']}, okx:{f:okx, need:['OKX_KEY', 'OKX_SECRET', 'OKX_PASSPHRASE']}, gate:{f:gate, need:['GATE_KEY', 'GATE_SECRET']}, bitget:{f:bitget, need:['BITGET_KEY', 'BITGET_SECRET', 'BITGET_PASSPHRASE']}, kraken:{f:kraken, need:['KRAKEN_KEY', 'KRAKEN_SECRET']}};
const configured = () => Object.keys(ADAPTERS).filter(k => ADAPTERS[k].need.every(n => env(n)));
const cache = new Map();
async function collect(days){
  const ck = String(days), c = cache.get(ck); if (c && Date.now() - c.at < 45000) return c.v;
  const ex = configured(), status = {}, trades = [];
  await Promise.all(ex.map(async k => { try { const L = (await ADAPTERS[k].f(days)).filter(t => t && isFinite(t.entry) && isFinite(t.exit) && isFinite(t.pnl) && t.size > 0); status[k] = {ok:true, n:L.length}; for (const t of L) trades.push(t); } catch(e){ status[k] = {ok:false, err:String(e.message || e).slice(0, 220)}; } }));
  const ids = new Set(), uniq = trades.filter(t => !ids.has(t.id) && ids.add(t.id)); trades.length = 0; for (const t of uniq) trades.push(t);
  for (const k of Object.keys(status)) if (status[k].ok) status[k].n = trades.filter(t => t.src === k).length;
  trades.sort((a, b) => (b.close || 0) - (a.close || 0)); const v = {ok:true, at:Date.now(), days, status, trades}; cache.set(ck, {at:Date.now(), v}); return v;
}
function main(){
  if (!TOKEN || TOKEN.length < 12){ console.error('Set JOURNAL_TOKEN to a long random password (at least 12 characters), then start again.'); process.exit(1); }
  http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x'), og = req.headers.origin || '', ok = ORIGINS.includes('*') || ORIGINS.includes(og) || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(og);
    const cors = {'Access-Control-Allow-Origin':ok ? og || '*' : 'null', 'Access-Control-Allow-Headers':'Authorization, Content-Type', 'Access-Control-Allow-Methods':'GET, OPTIONS', 'Vary':'Origin'};
    if (req.method === 'OPTIONS'){ res.writeHead(204, cors); return res.end(); }
    const given = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '') || u.searchParams.get('token') || '';
    const a = Buffer.from(given), b = Buffer.from(TOKEN); if (a.length !== b.length || !crypto.timingSafeEqual(a, b)){ res.writeHead(401, cors); return res.end('{"ok":false,"err":"wrong or missing token"}'); }
    const J = (c, o) => { res.writeHead(c, Object.assign({'Content-Type':'application/json'}, cors)); res.end(JSON.stringify(o)); };
    try {
      if (u.pathname === '/health') return J(200, {ok:true, exchanges:configured(), time:Date.now()});
      if (u.pathname === '/journal/trades'){ const days = Math.max(1, Math.min(180, +u.searchParams.get('days') || 60)); return J(200, await collect(days)); }
      J(404, {ok:false, err:'not found'});
    } catch(e){ J(500, {ok:false, err:String(e.message || e)}); }
  }).listen(PORT, () => console.log('ELPP journal relay on port ' + PORT + ' · exchanges: ' + (configured().join(', ') || 'none configured yet')));
}
if (require.main === module) main(); else module.exports = {group, groupAll, collect, configured, coinOf, main};
