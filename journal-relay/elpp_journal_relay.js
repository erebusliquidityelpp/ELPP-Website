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
    ASTER_KEY    ASTER_SECRET                           (futures, Binance-style keys)
    MEXC_KEY     MEXC_SECRET                            (USDT futures)
    BINGX_KEY    BINGX_SECRET                           (perpetual swaps)
    KUCOIN_KEY   KUCOIN_SECRET   KUCOIN_PASSPHRASE      (futures)
    KRAKENF_KEY  KRAKENF_SECRET                         (Kraken Futures, PF_ linear contracts)
    BITMEX_KEY   BITMEX_SECRET                          (inverse and linear perpetuals)
    DERIBIT_KEY  DERIBIT_SECRET                         (client id and client secret; BTC, ETH and USDC futures)
    PHEMEX_KEY   PHEMEX_SECRET   PHEMEX_SYMBOLS        (USDT perpetuals; SYMBOLS = comma list to read history for, default BTCUSDT,ETHUSDT,SOLUSDT)
    LIGHTER_ADDRESS                                     (your 0x wallet address; no key. Open positions and balance only)
    COINBASE_KEY COINBASE_SECRET                        (spot; Advanced Trade key name + PEM private key, write the PEM on one line with \n)
  The Aster, MEXC, BingX, KuCoin and Coinbase adapters were written from the exchanges' public documentation and have not been run against live accounts. Check /journal/trades?token=... and the Journal's status table after you connect.

  CREATE EVERY API KEY AS READ-ONLY. Never tick Trade or Withdraw. Anything that can only read history cannot move your money.
  Hyperliquid and dYdX need no keys here: the Journal page reads them directly from your wallet address.
*/
'use strict';
const http = require('http'), crypto = require('crypto'), fs = require('fs'), path = require('path');
try { for (const l of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)){ const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(l); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch(e){}
const env = k => process.env[k] || '';
const PORT = +env('PORT') || 8787, TOKEN = env('JOURNAL_TOKEN');
const ORIGINS = (env('ALLOW_ORIGIN') || 'https://erebusliquidityelpp.github.io,http://localhost,http://127.0.0.1,null').split(',').map(s => s.trim()).filter(Boolean);
const BASE = {binance:env('BINANCE_BASE') || 'https://fapi.binance.com', bybit:env('BYBIT_BASE') || 'https://api.bybit.com', okx:env('OKX_BASE') || 'https://www.okx.com', gate:env('GATE_BASE') || 'https://api.gateio.ws', bitget:env('BITGET_BASE') || 'https://api.bitget.com', kraken:env('KRAKEN_BASE') || 'https://api.kraken.com', aster:env('ASTER_BASE') || 'https://fapi.asterdex.com', mexc:env('MEXC_BASE') || 'https://contract.mexc.com', bingx:env('BINGX_BASE') || 'https://open-api.bingx.com', kucoin:env('KUCOIN_BASE') || 'https://api-futures.kucoin.com', coinbase:env('COINBASE_BASE') || 'https://api.coinbase.com', krakenf:env('KRAKENF_BASE') || 'https://futures.kraken.com', bitmex:env('BITMEX_BASE') || 'https://www.bitmex.com', deribit:env('DERIBIT_BASE') || 'https://www.deribit.com', phemex:env('PHEMEX_BASE') || 'https://api.phemex.com', lighter:env('LIGHTER_BASE') || 'https://mainnet.zklighter.elliot.ai'};
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
let GROUP_OPEN = [];
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
  if (cur && cur.open.length && Math.abs(pos) > 1e-9){ const en = wavg(cur.open); if (en && (mkt !== 'spot' || Math.abs(pos) * en >= 20)) GROUP_OPEN.push({id:src + ':' + coin + ':' + cur.side + ':open', src, coin, side:cur.side, entry:en, size:Math.abs(pos), pnl:null, lev:null, open:cur.t0, mkt:mkt || 'perp'}); }
  return out;
}
const groupAll = (src, fills, mkt) => { const by = new Map(); for (const f of fills){ if (!by.has(f.k)) by.set(f.k, {coin:f.coin, a:[]}); by.get(f.k).a.push(f); } let o = []; for (const {coin, a} of by.values()) o = o.concat(group(src, coin, a, mkt)); return o; };

/* ---------- Binance USD-M futures ---------- */
const BINX = {binance:{base:'binance', k:'BINANCE'}, aster:{base:'aster', k:'ASTER'}};
async function binSigned(p, q, X){ X = X || BINX.binance; const qs = new URLSearchParams(Object.assign({timestamp:Date.now(), recvWindow:20000}, q)).toString(), sig = hmac('sha256', env(X.k + '_SECRET'), qs, 'hex'); return jf(BASE[X.base] + p + '?' + qs + '&signature=' + sig, {headers:{'X-MBX-APIKEY':env(X.k + '_KEY')}}); }
async function binLike(X, days){
  const now = Date.now(), syms = new Set();
  for (let t = now - days * DAY; t < now; t += 7 * DAY){ let from = t; for (let k = 0; k < 5; k++){ const inc = await binSigned('/fapi/v1/income', {incomeType:'REALIZED_PNL', startTime:from, endTime:Math.min(now, t + 7 * DAY - 1), limit:1000}, X); for (const r of inc) if (r.symbol) syms.add(r.symbol); if (inc.length < 1000) break; from = inc[inc.length - 1].time + 1; } }
  const fills = [], seen = new Set();
  for (const s of syms){ for (let t = now - days * DAY; t < now; t += 7 * DAY){ let from = t; for (let k = 0; k < 8; k++){ const L = await binSigned('/fapi/v1/userTrades', {symbol:s, startTime:from, endTime:Math.min(now, t + 7 * DAY - 1), limit:1000}, X);
        for (const r of L){ const uk = s + ':' + r.id; if (r.id !== undefined){ if (seen.has(uk)) continue; seen.add(uk); } const ca = String(r.commissionAsset || '').toUpperCase(), fee = ['USDT', 'USDC', 'BUSD', 'FDUSD'].includes(ca) ? +r.commission : 0; fills.push({k:s + (r.positionSide && r.positionSide !== 'BOTH' ? ':' + r.positionSide : ''), coin:coinOf(s), t:+r.time, side:r.side === 'BUY' ? 'B' : 'A', px:+r.price, sz:+r.qty, fee, pnl:+r.realizedPnl || 0}); }
        if (L.length < 1000) break; from = L[L.length - 1].time + 1; } await sleep(120); } }
  return groupAll(X === BINX.aster ? 'aster' : 'binance', fills);
}
const binance = d => binLike(BINX.binance, d), aster = d => binLike(BINX.aster, d);
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
  GROUP_OPEN = []; const g = groupAll('kraken', all, 'spot'); KRAKEN_OPEN = GROUP_OPEN.slice(); return g;
}

/* ---------- MEXC USDT futures (untested) ---------- */
async function mexcGet(p, q){ const ts = String(Date.now()), qs = new URLSearchParams(q || {}).toString(); const j = await jf(BASE.mexc + p + (qs ? '?' + qs : ''), {headers:{ApiKey:env('MEXC_KEY'), 'Request-Time':ts, Signature:hmac('sha256', env('MEXC_SECRET'), env('MEXC_KEY') + ts + qs, 'hex'), 'Content-Type':'application/json'}}); if (j.success === false || (j.code !== undefined && j.code !== 0)) throw new Error('MEXC: ' + (j.message || j.code)); return j.data; }
async function mexcSizes(){ const m = new Map(); try { const j = await jf(BASE.mexc + '/api/v1/contract/detail'); for (const c of j.data || []) m.set(c.symbol, +c.contractSize || 1); } catch(e){} return m; }
async function mexc(days){
  const sz = await mexcSizes(), out = [], cut = Date.now() - days * DAY;
  for (let pg = 1; pg <= 20; pg++){ const L = await mexcGet('/api/v1/private/position/list/history_positions', {page_num:pg, page_size:100}); if (!Array.isArray(L) || !L.length) break; let old = 0;
    for (const r of L){ const c = +r.updateTime || +r.createTime; if (c < cut){ old++; continue; } const m = sz.get(r.symbol) || 1, vol = (+r.closeVol || +r.holdVol) * m, en = +r.openAvgPrice, ex = +r.closeAvgPrice; if (!(vol > 0 && en > 0 && ex > 0)) continue;
      out.push({id:'mexc:' + (r.positionId || r.symbol + c), src:'mexc', coin:coinOf(r.symbol), side:+r.positionType === 2 ? 'short' : 'long', entry:en, exit:ex, size:vol, lev:num(r.leverage), open:+r.createTime || null, close:c, fees:Math.abs(+r.totalFee || 0), pnl:+r.realised, liq:+r.state === 4 && /liq/i.test(String(r.closeType || '')), mkt:'perp'}); }
    if (L.length < 100 || old === L.length) break; await sleep(250); }
  return out;
}
/* ---------- BingX perpetual swaps (untested) ---------- */
async function bingxGet(p, q){ const qs = new URLSearchParams(Object.assign({timestamp:Date.now(), recvWindow:20000}, q)).toString(), j = await jf(BASE.bingx + p + '?' + qs + '&signature=' + hmac('sha256', env('BINGX_SECRET'), qs, 'hex'), {headers:{'X-BX-APIKEY':env('BINGX_KEY')}}); if (j.code !== 0 && j.code !== undefined) throw new Error('BingX: ' + (j.msg || j.code)); return j.data; }
async function bingx(days){
  const now = Date.now(), syms = new Set(), fills = [], seen = new Set();
  for (let t = now - days * DAY; t < now; t += 7 * DAY){ const inc = await bingxGet('/openApi/swap/v2/user/income', {incomeType:'REALIZED_PNL', startTime:t, endTime:Math.min(now, t + 7 * DAY - 1), limit:1000}); for (const r of Array.isArray(inc) ? inc : []) if (r.symbol) syms.add(r.symbol); await sleep(150); }
  for (const s of syms){ for (let t = now - days * DAY; t < now; t += 7 * DAY){ const d = await bingxGet('/openApi/swap/v2/trade/allFillOrders', {symbol:s, tradingUnit:'COIN', startTs:t, endTs:Math.min(now, t + 7 * DAY - 1)}), L = (d && d.fill_orders) || [];
      for (const r of L){ const tm = typeof r.filledTime === 'number' ? r.filledTime : Date.parse(r.filledTime) || +r.time, uk = s + ':' + (r.filledTm || r.orderId) + ':' + tm + ':' + r.qty; if (seen.has(uk)) continue; seen.add(uk);
        fills.push({k:s + ':' + (r.positionSide || ''), coin:coinOf(s), t:tm, side:/BUY/i.test(r.side) ? 'B' : 'A', px:+r.price, sz:Math.abs(+r.qty), fee:Math.abs(+r.commission || 0)}); } await sleep(150); } }
  return groupAll('bingx', fills);
}
/* ---------- KuCoin Futures (untested) ---------- */
async function kuGet(p){ const ts = String(Date.now()); const j = await jf(BASE.kucoin + p, {headers:{'KC-API-KEY':env('KUCOIN_KEY'), 'KC-API-SIGN':hmac('sha256', env('KUCOIN_SECRET'), ts + 'GET' + p, 'base64'), 'KC-API-TIMESTAMP':ts, 'KC-API-PASSPHRASE':hmac('sha256', env('KUCOIN_SECRET'), env('KUCOIN_PASSPHRASE'), 'base64'), 'KC-API-KEY-VERSION':'2'}}); if (j.code !== '200000') throw new Error('KuCoin: ' + (j.msg || j.code)); return j.data; }
async function kuMult(){ const m = new Map(); try { const j = await jf(BASE.kucoin + '/api/v1/contracts/active'); for (const c of j.data || []) m.set(c.symbol, Math.abs(+c.multiplier) || 1); } catch(e){} return m; }
const kuCoin = s => coinOf(String(s).replace(/USDTM$|USDM$/, '').replace(/^XBT$/, 'BTC'));
async function kucoin(days){
  const mu = await kuMult(), fills = [], cut = Date.now() - days * DAY;
  for (let pg = 1; pg <= 30; pg++){ const d = await kuGet('/api/v1/fills?pageSize=100&currentPage=' + pg + '&startAt=' + cut), L = (d && d.items) || []; if (!L.length) break;
    for (const r of L){ if (!/USDT/.test(r.symbol)) continue; const t = Math.round(+r.tradeTime / 1e6) || +r.createdAt; fills.push({k:r.symbol, coin:kuCoin(r.symbol), t, side:/buy/i.test(r.side) ? 'B' : 'A', px:+r.price, sz:Math.abs(+r.size) * (mu.get(r.symbol) || 1), fee:Math.abs(+r.fee || 0)}); }
    if (pg >= (d.totalPage || 1)) break; await sleep(200); }
  return groupAll('kucoin', fills);
}
/* ---------- Coinbase Advanced Trade spot (untested) ---------- */
const b64u = b => Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
function cbJwt(method, host, p){ const now = Math.floor(Date.now() / 1000), hd = {alg:'ES256', kid:env('COINBASE_KEY'), nonce:crypto.randomBytes(8).toString('hex'), typ:'JWT'}, pl = {sub:env('COINBASE_KEY'), iss:'cdp', nbf:now, exp:now + 110, uri:method + ' ' + host + p}, data = b64u(JSON.stringify(hd)) + '.' + b64u(JSON.stringify(pl));
  return data + '.' + b64u(crypto.sign('sha256', Buffer.from(data), {key:env('COINBASE_SECRET').replace(/\\n/g, '\n'), dsaEncoding:'ieee-p1363'})); }
let COINBASE_OPEN = [];
async function coinbase(days){
  const host = new URL(BASE.coinbase).host, p = '/api/v3/brokerage/orders/historical/fills', all = [], cut = Date.now() - days * DAY; let cursor = '';
  for (let k = 0; k < 40; k++){ const q = '?limit=250&start_sequence_timestamp=' + encodeURIComponent(new Date(cut).toISOString()) + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''), j = await jf(BASE.coinbase + p + q, {headers:{Authorization:'Bearer ' + cbJwt('GET', host, p)}}); if (j.error || j.message && !j.fills) throw new Error('Coinbase: ' + (j.message || j.error));
    for (const r of j.fills || []){ const m = /^([A-Z0-9]+)-(USD|USDC)$/.exec(r.product_id || ''); if (!m) continue; const px = +r.price, size = r.size_in_quote === true || r.size_in_quote === 'true' ? +r.size / px : +r.size; all.push({k:m[1], coin:m[1], t:Date.parse(r.trade_time), side:r.side === 'BUY' ? 'B' : 'A', px, sz:size, fee:Math.abs(+r.commission || 0)}); }
    cursor = j.cursor; if (!cursor || !(j.fills || []).length) break; await sleep(150); }
  GROUP_OPEN = []; const g = groupAll('coinbase', all, 'spot'); COINBASE_OPEN = GROUP_OPEN.slice(); return g;
}

/* ---------- account balances (total equity in USD terms; untested on live accounts) ---------- */
async function bybGet(path, q){ const ts = String(Date.now()), rw = '20000'; return jf(BASE.bybit + path + '?' + q, {headers:{'X-BAPI-API-KEY':env('BYBIT_KEY'), 'X-BAPI-TIMESTAMP':ts, 'X-BAPI-RECV-WINDOW':rw, 'X-BAPI-SIGN':hmac('sha256', env('BYBIT_SECRET'), ts + env('BYBIT_KEY') + rw + q, 'hex')}}); }
const BAL = {
  async binance(X){ X = X || BINX.binance; const a = await binSigned('/fapi/v2/account', {}, X); return {total:num(a.totalMarginBalance), free:num(a.availableBalance)}; },
  async aster(){ return BAL.binance(BINX.aster); },
  async bybit(){ const j = await bybGet('/v5/account/wallet-balance', 'accountType=UNIFIED'); if (j.retCode !== 0) throw new Error('Bybit: ' + j.retMsg); const a = ((j.result || {}).list || [])[0] || {}; return {total:num(a.totalEquity), free:num(a.totalAvailableBalance)}; },
  async okx(){ const j = await okxGet('/api/v5/account/balance'); if (j.code !== '0') throw new Error('OKX: ' + j.msg); const a = (j.data || [])[0] || {}; return {total:num(a.totalEq), free:num(a.adjEq)}; },
  async gate(){ const a = await gateGet('/futures/usdt/accounts', ''); if (a.label) throw new Error('Gate: ' + a.message); return {total:(+a.total || 0) + (+a.unrealised_pnl || 0), free:num(a.available)}; },
  async bitget(){ const p = '/api/v2/mix/account/accounts', q = 'productType=USDT-FUTURES', ts = String(Date.now()), j = await jf(BASE.bitget + p + '?' + q, {headers:{'ACCESS-KEY':env('BITGET_KEY'), 'ACCESS-SIGN':hmac('sha256', env('BITGET_SECRET'), ts + 'GET' + p + '?' + q, 'base64'), 'ACCESS-TIMESTAMP':ts, 'ACCESS-PASSPHRASE':env('BITGET_PASSPHRASE'), 'Content-Type':'application/json'}}); if (j.code !== '00000') throw new Error('Bitget: ' + j.msg); const a = (j.data || [])[0] || {}; return {total:num(a.accountEquity || a.usdtEquity), free:num(a.available)}; },
  async mexc(){ const L = await mexcGet('/api/v1/private/account/assets', {}), a = (Array.isArray(L) ? L : []).find(x => x.currency === 'USDT') || {}; return {total:num(a.equity), free:num(a.availableBalance)}; },
  async bingx(){ const d = await bingxGet('/openApi/swap/v2/user/balance', {}), a = (d && d.balance) || {}; return {total:num(a.equity || a.balance), free:num(a.availableMargin)}; },
  async krakenf(){ const j = await kfGet('/api/v3/accounts', ''), f = (j.accounts || {}).flex || {}; return {total:num(f.portfolioValue || f.balanceValue), free:num(f.availableMargin)}; },
  async bitmex(){ const L = await bmxGet('/api/v1/user/margin?currency=all'); let tot = 0; for (const r of Array.isArray(L) ? L : []){ if (r.currency === 'XBt'){ const i = await jf(BASE.bitmex + '/api/v1/instrument?symbol=XBTUSD&columns=lastPrice'); tot += (+r.marginBalance || 0) / 1e8 * ((i[0] || {}).lastPrice || 0); } else if (r.currency === 'USDt') tot += (+r.marginBalance || 0) / 1e6; } return {total:tot, free:null}; },
  async deribit(){ const R = await dbGet('private/get_account_summaries', ''); let tot = 0; for (const a of (R && R.summaries) || []){ if (!(+a.equity)) continue; if (/^USD/.test(a.currency)) tot += +a.equity; else { const i = await jf(BASE.deribit + '/api/v2/public/get_index_price?index_name=' + a.currency.toLowerCase() + '_usd'); tot += +a.equity * (+(i.result || {}).index_price || 0); } } return {total:tot, free:null}; },
  async phemex(){ const d = await phxGet('/g-accounts/accountPositions', 'currency=USDT'), a = (d && d.account) || {}; return {total:num(a.accountBalanceRv), free:null}; },
  async lighter(){ const a = await lighterAcct(); return {total:num(a.total_asset_value || a.collateral), free:num(a.available_balance)}; },
  async kucoin(){ const a = await kuGet('/api/v1/account-overview?currency=USDT'); return {total:num(a.accountEquity), free:num(a.availableBalance)}; }
};

/* ---------- Kraken Futures (untested) ---------- */
async function kfGet(p, q){ const nonce = String(Date.now()), sig = hmac('sha512', Buffer.from(env('KRAKENF_SECRET'), 'base64'), sha('sha256', (q || '') + nonce + p), 'base64'); const j = await jf(BASE.krakenf + '/derivatives' + p + (q ? '?' + q : ''), {headers:{APIKey:env('KRAKENF_KEY'), Nonce:nonce, Authent:sig}}); if (j.result && j.result !== 'success') throw new Error('Kraken Futures: ' + (j.error || j.result)); return j; }
const kfCoin = s => { const c = String(s).replace(/^(PF|PI|FI)_/, '').replace(/USD$/, '').replace(/^XBT$/, 'BTC').replace(/^XDG$/, 'DOGE'); return coinOf(c); };
async function krakenf(days){
  const j = await kfGet('/api/v3/fills', ''), cut = Date.now() - days * DAY, fills = [];
  for (const r of j.fills || []){ const t = Date.parse(r.fillTime); if (!/^PF_/.test(r.symbol) || t < cut) continue; fills.push({k:r.symbol, coin:kfCoin(r.symbol), t, side:r.side === 'buy' ? 'B' : 'A', px:+r.price, sz:+r.size, fee:0}); }
  return groupAll('krakenf', fills);
}
/* ---------- BitMEX (untested). Inverse contracts are sized in coin = contracts / price ---------- */
async function bmxGet(path){ const ex = String(Math.floor(Date.now() / 1000) + 60); return jf(BASE.bitmex + path, {headers:{'api-key':env('BITMEX_KEY'), 'api-expires':ex, 'api-signature':hmac('sha256', env('BITMEX_SECRET'), 'GET' + path + ex, 'hex')}}); }
const bmxCoin = s => coinOf(String(s).replace(/^XBT/, 'BTC').replace(/_.*$/, '').replace(/USD[T]?$/, ''));
async function bitmex(days){
  const fills = [], seen = new Set(), st = new Date(Date.now() - days * DAY).toISOString(), flt = encodeURIComponent(JSON.stringify({execType:'Trade'}));
  for (let off = 0; off < 5000; off += 500){ const L = await bmxGet('/api/v1/execution/tradeHistory?count=500&start=' + off + '&reverse=false&startTime=' + encodeURIComponent(st) + '&filter=' + flt); if (!Array.isArray(L)) throw new Error('BitMEX: ' + JSON.stringify(L).slice(0, 120)); if (!L.length) break;
    for (const r of L){ if (seen.has(r.execID)) continue; seen.add(r.execID); const px = +r.lastPx, sz = Math.abs(+r.homeNotional) || (+r.lastQty / px); fills.push({k:r.symbol, coin:bmxCoin(r.symbol), t:Date.parse(r.timestamp), side:r.side === 'Buy' ? 'B' : 'A', px, sz, fee:r.settlCurrency === 'XBt' ? Math.abs(+r.execComm || 0) / 1e8 * px : Math.abs(+r.execComm || 0) / 1e6}); }
    if (L.length < 500) break; await sleep(400); }
  return groupAll('bitmex', fills);
}
/* ---------- Deribit (untested): BTC and ETH inverse, USDC linear ---------- */
let DB_TOK = {t:'', exp:0};
async function dbGet(path, q){ if (Date.now() > DB_TOK.exp){ const a = await jf(BASE.deribit + '/api/v2/public/auth?grant_type=client_credentials&client_id=' + encodeURIComponent(env('DERIBIT_KEY')) + '&client_secret=' + encodeURIComponent(env('DERIBIT_SECRET'))); if (!a.result) throw new Error('Deribit: ' + JSON.stringify(a.error || a).slice(0, 120)); DB_TOK = {t:a.result.access_token, exp:Date.now() + (a.result.expires_in - 60) * 1000}; }
  const j = await jf(BASE.deribit + '/api/v2/' + path + (q ? '?' + q : ''), {headers:{Authorization:'Bearer ' + DB_TOK.t}}); if (j.error) throw new Error('Deribit: ' + (j.error.message || j.error.code)); return j.result; }
const dbCoin = n => coinOf(String(n).split('-')[0].replace(/_(USDC|USDT)$/, ''));
async function deribit(days){
  const fills = [], now = Date.now(); let okAny = false, lastErr = null;
  for (const cur of ['BTC', 'ETH', 'USDC']){ try { for (let t = now - days * DAY; t < now; t += 30 * DAY){ const R = await dbGet('private/get_user_trades_by_currency_and_time', 'currency=' + cur + '&kind=future&count=1000&start_timestamp=' + t + '&end_timestamp=' + Math.min(now, t + 30 * DAY)); okAny = true;
      for (const r of (R && R.trades) || []){ if (!/PERPETUAL/.test(r.instrument_name)) continue; const lin = /_USDC|_USDT/.test(r.instrument_name), px = +r.price, sz = lin ? +r.amount : +r.amount / px, mul = lin ? 1 : (+r.index_price || px);
        fills.push({k:r.instrument_name, coin:dbCoin(r.instrument_name), t:+r.timestamp, side:r.direction === 'buy' ? 'B' : 'A', px, sz, fee:Math.abs(+r.fee || 0) * mul, pnl:(+r.profit_loss || 0) * mul}); } await sleep(200); } } catch(e){ lastErr = e; } }
  if (!okAny && lastErr) throw lastErr; return groupAll('deribit', fills);
}
/* ---------- Phemex USDT perpetuals (untested): history only for the symbols listed in PHEMEX_SYMBOLS ---------- */
async function phxGet(path, q){ const ex = String(Math.floor(Date.now() / 1000) + 60), j = await jf(BASE.phemex + path + (q ? '?' + q : ''), {headers:{'x-phemex-access-token':env('PHEMEX_KEY'), 'x-phemex-request-expiry':ex, 'x-phemex-request-signature':hmac('sha256', env('PHEMEX_SECRET'), path + (q || '') + ex, 'hex')}}); if (j.code !== undefined && j.code !== 0) throw new Error('Phemex: ' + (j.msg || j.code)); return j.data; }
async function phemex(days){
  const syms = new Set((env('PHEMEX_SYMBOLS') || 'BTCUSDT,ETHUSDT,SOLUSDT').split(',').map(x => x.trim().toUpperCase()).filter(Boolean)); try { const P = await phxGet('/g-accounts/accountPositions', 'currency=USDT'); for (const r of (P && P.positions) || []) if (+(r.sizeRq || r.size)) syms.add(r.symbol); } catch(e){}
  const fills = [], cut = Date.now() - days * DAY;
  for (const sy of syms){ const d = await phxGet('/api-data/g-futures/trades', 'symbol=' + sy + '&limit=200&offset=0'), L = (d && (d.rows || d)) || [];
    for (const r of Array.isArray(L) ? L : []){ const t = Math.round(+r.transactTimeNs / 1e6) || +r.transactTime; if (t < cut) continue; fills.push({k:sy, coin:coinOf(sy), t, side:/buy/i.test(r.side) ? 'B' : 'A', px:+(r.execPriceRp || r.price), sz:Math.abs(+(r.execQtyRq || r.execQty)), fee:Math.abs(+(r.execFeeRv || 0))}); } await sleep(300); }
  return groupAll('phemex', fills);
}
/* ---------- Lighter (no key): open positions and balance only, its trade history needs a login token ---------- */
async function lighterAcct(){ const j = await jf(BASE.lighter + '/api/v1/account?by=l1_address&value=' + encodeURIComponent(env('LIGHTER_ADDRESS'))); const a = (j.accounts || [])[0]; if (!a) throw new Error('Lighter: no account found for this address'); return a; }
async function lighter(){ await lighterAcct(); return []; }

/* ---------- running (open) positions ---------- */
const oid = (src, coin, side) => src + ':' + coin + ':' + side + ':open';
const OPEN = {
  async binance(X){ X = X || BINX.binance; const src = X === BINX.aster ? 'aster' : 'binance', L = await binSigned('/fapi/v2/positionRisk', {}, X); return L.filter(r => +r.positionAmt).map(r => { const a = +r.positionAmt, side = r.positionSide === 'SHORT' || (r.positionSide !== 'LONG' && a < 0) ? 'short' : 'long', coin = coinOf(r.symbol); return {id:oid(src, coin, side), src, coin, side, entry:+r.entryPrice, size:Math.abs(a), pnl:+r.unRealizedProfit, lev:num(r.leverage), liqPx:num(r.liquidationPrice) || null, open:null, mkt:'perp'}; }); },
  async aster(){ return OPEN.binance(BINX.aster); },
  async bybit(){ const q = 'category=linear&settleCoin=USDT&limit=200', ts = String(Date.now()), rw = '20000', j = await jf(BASE.bybit + '/v5/position/list?' + q, {headers:{'X-BAPI-API-KEY':env('BYBIT_KEY'), 'X-BAPI-TIMESTAMP':ts, 'X-BAPI-RECV-WINDOW':rw, 'X-BAPI-SIGN':hmac('sha256', env('BYBIT_SECRET'), ts + env('BYBIT_KEY') + rw + q, 'hex')}}); if (j.retCode !== 0) throw new Error('Bybit: ' + j.retMsg);
    return ((j.result || {}).list || []).filter(r => +r.size).map(r => { const side = r.side === 'Sell' ? 'short' : 'long', coin = coinOf(r.symbol); return {id:oid('bybit', coin, side), src:'bybit', coin, side, entry:+r.avgPrice, size:+r.size, pnl:+r.unrealisedPnl, lev:num(r.leverage), liqPx:num(r.liqPrice) || null, open:+r.createdTime || null, mkt:'perp'}; }); },
  async okx(){ const ins = new Map(); try { const i = await jf(BASE.okx + '/api/v5/public/instruments?instType=SWAP'); for (const r of i.data || []) ins.set(r.instId, r); } catch(e){}
    const j = await okxGet('/api/v5/account/positions?instType=SWAP'); if (j.code !== '0') throw new Error('OKX: ' + j.msg + ' (' + j.code + ')');
    return (j.data || []).filter(r => +r.pos).map(r => { const p = +r.pos, side = r.posSide === 'long' || r.posSide === 'short' ? r.posSide : p > 0 ? 'long' : 'short', i = ins.get(r.instId) || {}, en = +r.avgPx, sz = i.ctValCcy === 'USD' ? Math.abs(p) * (+i.ctVal || 1) / en : Math.abs(p) * (+i.ctVal || 1) * (+i.ctMult || 1), coin = coinOf(r.instId.split('-')[0]); return {id:oid('okx', coin, side), src:'okx', coin, side, entry:en, size:sz, pnl:+r.upl, lev:num(r.lever), liqPx:num(r.liqPx) || null, open:+r.cTime || null, mkt:'perp'}; }); },
  async gate(){ const mult = new Map(); try { for (const c of await jf(BASE.gate + '/api/v4/futures/usdt/contracts')) mult.set(c.name, +c.quanto_multiplier || 1); } catch(e){}
    const L = await gateGet('/futures/usdt/positions', ''); if (!Array.isArray(L)) throw new Error('Gate: ' + JSON.stringify(L).slice(0, 120));
    return L.filter(r => +r.size).map(r => { const a = +r.size, side = a > 0 ? 'long' : 'short', coin = coinOf(r.contract); return {id:oid('gate', coin, side), src:'gate', coin, side, entry:+r.entry_price, size:Math.abs(a) * (mult.get(r.contract) || 1), pnl:+r.unrealised_pnl, lev:num(r.leverage), liqPx:num(r.liq_price) || null, open:r.open_time ? +r.open_time * 1000 : null, mkt:'perp'}; }); },
  async bitget(){ const q = 'productType=USDT-FUTURES&marginCoin=USDT', p = '/api/v2/mix/position/all-position', ts = String(Date.now()), j = await jf(BASE.bitget + p + '?' + q, {headers:{'ACCESS-KEY':env('BITGET_KEY'), 'ACCESS-SIGN':hmac('sha256', env('BITGET_SECRET'), ts + 'GET' + p + '?' + q, 'base64'), 'ACCESS-TIMESTAMP':ts, 'ACCESS-PASSPHRASE':env('BITGET_PASSPHRASE'), 'Content-Type':'application/json'}}); if (j.code !== '00000') throw new Error('Bitget: ' + j.msg);
    return (j.data || []).filter(r => +r.total).map(r => { const side = r.holdSide === 'short' ? 'short' : 'long', coin = coinOf(r.symbol); return {id:oid('bitget', coin, side), src:'bitget', coin, side, entry:+r.openPriceAvg, size:+r.total, pnl:+r.unrealizedPL, lev:num(r.leverage), liqPx:num(r.liquidationPrice) || null, open:+r.cTime || null, mkt:'perp'}; }); },
  async kraken(){ return KRAKEN_OPEN; },
  async mexc(){ const sz = await mexcSizes(), L = await mexcGet('/api/v1/private/position/open_positions', {}); return (Array.isArray(L) ? L : []).filter(r => +r.holdVol).map(r => { const side = +r.positionType === 2 ? 'short' : 'long', coin = coinOf(r.symbol); return {id:oid('mexc', coin, side), src:'mexc', coin, side, entry:+r.holdAvgPrice, size:+r.holdVol * (sz.get(r.symbol) || 1), pnl:num(r.realised), lev:num(r.leverage), liqPx:num(r.liquidatePrice) || null, open:+r.createTime || null, mkt:'perp'}; }); },
  async bingx(){ const L = await bingxGet('/openApi/swap/v2/user/positions', {}); return (Array.isArray(L) ? L : []).filter(r => +r.positionAmt).map(r => { const side = String(r.positionSide).toUpperCase() === 'SHORT' ? 'short' : 'long', coin = coinOf(r.symbol); return {id:oid('bingx', coin, side), src:'bingx', coin, side, entry:+r.avgPrice, size:Math.abs(+r.positionAmt), pnl:num(r.unrealizedProfit), lev:num(r.leverage), liqPx:num(r.liquidationPrice) || null, open:+r.createTime || null, mkt:'perp'}; }); },
  async kucoin(){ const mu = await kuMult(), L = await kuGet('/api/v1/positions'); return (Array.isArray(L) ? L : []).filter(r => r.isOpen !== false && +r.currentQty).map(r => { const q = +r.currentQty, side = q < 0 ? 'short' : 'long', coin = kuCoin(r.symbol); return {id:oid('kucoin', coin, side), src:'kucoin', coin, side, entry:+r.avgEntryPrice, size:Math.abs(q) * (mu.get(r.symbol) || 1), pnl:num(r.unrealisedPnl), lev:num(r.realLeverage), liqPx:num(r.liquidationPrice) || null, open:+r.openingTimestamp || null, mkt:'perp'}; }); },
  async krakenf(){ const j = await kfGet('/api/v3/openpositions', ''); return (j.openPositions || []).filter(r => /^PF_/.test(r.symbol) && +r.size).map(r => { const side = r.side === 'short' ? 'short' : 'long', coin = kfCoin(r.symbol); return {id:oid('krakenf', coin, side), src:'krakenf', coin, side, entry:+r.price, size:Math.abs(+r.size), pnl:null, lev:null, liqPx:null, open:Date.parse(r.fillTime) || null, mkt:'perp'}; }); },
  async bitmex(){ const L = await bmxGet('/api/v1/position?filter=' + encodeURIComponent(JSON.stringify({isOpen:true}))); return (Array.isArray(L) ? L : []).filter(r => +r.currentQty).map(r => { const side = r.currentQty < 0 ? 'short' : 'long', coin = bmxCoin(r.symbol), px = +r.markPrice || +r.avgEntryPrice; return {id:oid('bitmex', coin, side), src:'bitmex', coin, side, entry:+r.avgEntryPrice, size:Math.abs(+r.homeNotional) || Math.abs(+r.currentQty) / px, pnl:(+r.unrealisedPnl || 0) / (r.currency === 'XBt' ? 1e8 / px : 1e6), lev:num(r.leverage), liqPx:num(r.liquidationPrice) || null, open:Date.parse(r.openingTimestamp) || null, mkt:'perp'}; }); },
  async deribit(){ const R = await dbGet('private/get_positions', 'currency=any&kind=future'); return (R || []).filter(r => +r.size && /PERPETUAL/.test(r.instrument_name)).map(r => { const lin = /_USDC|_USDT/.test(r.instrument_name), coin = dbCoin(r.instrument_name), side = r.direction === 'sell' ? 'short' : 'long', en = +r.average_price; return {id:oid('deribit', coin, side), src:'deribit', coin, side, entry:en, size:lin ? Math.abs(+r.size) : Math.abs(+r.size) / en, pnl:(+r.floating_profit_loss || 0) * (lin ? 1 : (+r.mark_price || en)), lev:num(r.leverage), liqPx:num(r.estimated_liquidation_price) || null, open:null, mkt:'perp'}; }); },
  async phemex(){ const d = await phxGet('/g-accounts/accountPositions', 'currency=USDT'); return ((d && d.positions) || []).filter(r => +(r.sizeRq || r.size)).map(r => { const side = /sell|short/i.test(r.side) || +(r.sizeRq || r.size) < 0 ? 'short' : 'long', coin = coinOf(r.symbol); return {id:oid('phemex', coin, side), src:'phemex', coin, side, entry:+(r.avgEntryPriceRp || r.avgEntryPrice), size:Math.abs(+(r.sizeRq || r.size)), pnl:num(r.unrealisedPnlRv), lev:num(r.leverageRr) ? Math.abs(num(r.leverageRr)) : null, liqPx:num(r.liquidationPriceRp) || null, open:null, mkt:'perp'}; }); },
  async lighter(){ const a = await lighterAcct(); return (a.positions || []).filter(r => +r.position).map(r => { const side = +r.sign === -1 ? 'short' : 'long', coin = coinOf(r.symbol || r.market_id); return {id:oid('lighter', coin, side), src:'lighter', coin, side, entry:+r.avg_entry_price, size:Math.abs(+r.position), pnl:num(r.unrealized_pnl), lev:null, liqPx:num(r.liquidation_price) || null, open:null, mkt:'perp'}; }); },
  async coinbase(){ return COINBASE_OPEN; }
};
let KRAKEN_OPEN = [];
const ADAPTERS = {binance:{f:binance, need:['BINANCE_KEY', 'BINANCE_SECRET']}, bybit:{f:bybit, need:['BYBIT_KEY', 'BYBIT_SECRET']}, okx:{f:okx, need:['OKX_KEY', 'OKX_SECRET', 'OKX_PASSPHRASE']}, gate:{f:gate, need:['GATE_KEY', 'GATE_SECRET']}, bitget:{f:bitget, need:['BITGET_KEY', 'BITGET_SECRET', 'BITGET_PASSPHRASE']}, kraken:{f:kraken, need:['KRAKEN_KEY', 'KRAKEN_SECRET']}, aster:{f:aster, need:['ASTER_KEY', 'ASTER_SECRET']}, mexc:{f:mexc, need:['MEXC_KEY', 'MEXC_SECRET']}, bingx:{f:bingx, need:['BINGX_KEY', 'BINGX_SECRET']}, kucoin:{f:kucoin, need:['KUCOIN_KEY', 'KUCOIN_SECRET', 'KUCOIN_PASSPHRASE']}, coinbase:{f:coinbase, need:['COINBASE_KEY', 'COINBASE_SECRET']}, krakenf:{f:krakenf, need:['KRAKENF_KEY', 'KRAKENF_SECRET']}, bitmex:{f:bitmex, need:['BITMEX_KEY', 'BITMEX_SECRET']}, deribit:{f:deribit, need:['DERIBIT_KEY', 'DERIBIT_SECRET']}, phemex:{f:phemex, need:['PHEMEX_KEY', 'PHEMEX_SECRET']}, lighter:{f:lighter, need:['LIGHTER_ADDRESS']}};
const configured = () => Object.keys(ADAPTERS).filter(k => ADAPTERS[k].need.every(n => env(n)));
const cache = new Map();
async function collect(days){
  const ck = String(days), c = cache.get(ck); if (c && Date.now() - c.at < 45000) return c.v;
  const ex = configured(), status = {}, trades = [], openTrades = [], balances = {};
  await Promise.all(ex.map(async k => { try { const L = (await ADAPTERS[k].f(days)).filter(t => t && isFinite(t.entry) && isFinite(t.exit) && isFinite(t.pnl) && t.size > 0); status[k] = {ok:true, n:L.length, openOk:false, open:0}; for (const t of L) trades.push(t); } catch(e){ status[k] = {ok:false, err:String(e.message || e).slice(0, 220)}; return; }
    try { const O = (await OPEN[k]()).filter(t => t && isFinite(t.entry) && t.entry > 0 && t.size > 0); status[k].openOk = true; status[k].open = O.length; for (const t of O) openTrades.push(t); } catch(e){ status[k].openErr = String(e.message || e).slice(0, 160); }
    if (BAL[k]){ try { const b = await BAL[k](); if (b && isFinite(b.total)) balances[k] = {total:b.total, free:isFinite(b.free) ? b.free : null}; } catch(e){ status[k].balErr = String(e.message || e).slice(0, 160); } } }));
  const ids = new Set(), uniq = trades.filter(t => !ids.has(t.id) && ids.add(t.id)); trades.length = 0; for (const t of uniq) trades.push(t);
  for (const k of Object.keys(status)) if (status[k].ok) status[k].n = trades.filter(t => t.src === k).length;
  trades.sort((a, b) => (b.close || 0) - (a.close || 0)); const v = {ok:true, at:Date.now(), days, status, trades, openTrades, balances}; cache.set(ck, {at:Date.now(), v}); return v;
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
