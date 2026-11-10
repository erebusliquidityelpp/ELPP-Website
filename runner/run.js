/* ELPP 24/7 runner: keeps the real scanner open in a headless browser so alerts, signals and briefs run with every tab closed.
   Settings (Railway Variables of THIS service):
     API            your backend address, e.g. https://elpp-website-production.up.railway.app
     RUNNER_TOKEN   the same long secret you set on the backend service
     SITE           optional, default https://erebusliquidityelpp.github.io/ELPP-Website/
*/
'use strict';
const { chromium } = require('playwright');
const http = require('http');
const API = String(process.env.API || '').replace(/\/+$/, ''), TOKEN = process.env.RUNNER_TOKEN || '', SITE = String(process.env.SITE || 'https://erebusliquidityelpp.github.io/ELPP-Website/').replace(/\/?$/, '/');
const PORT = +process.env.PORT || 8080;
if (!API || TOKEN.length < 20) { console.error('Set API and RUNNER_TOKEN (20+ characters) in this service\'s Variables.'); }
const log = (...a) => console.log(new Date().toISOString(), ...a);
let status = { phase: 'starting', since: Date.now(), pageOk: false, coins: 0, restarts: 0, lastError: '' };
http.createServer((q, s) => { s.writeHead(200, { 'Content-Type': 'application/json' }); s.end(JSON.stringify(status)); }).listen(PORT, () => log('health on', PORT));

async function cfg() {
  const r = await fetch(API + '/api/runner/config', { headers: { 'X-Runner-Token': TOKEN } });
  if (!r.ok) throw new Error('config HTTP ' + r.status + ' ' + (await r.text()).slice(0, 120));
  return r.json();
}
async function beat(info) { try { await fetch(API + '/api/runner/heartbeat', { method: 'POST', headers: { 'X-Runner-Token': TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(info) }); } catch (e) {} }
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function session(c) {
  status.phase = 'launching'; status.pageOk = false;
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--js-flags=--max-old-space-size=1536'] });
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  await ctx.addInitScript(({ token, user, state, api }) => {
    try { localStorage.setItem('elpp_token', token); localStorage.setItem('elpp_user', JSON.stringify(user)); localStorage.setItem('elpp_user_at', String(Date.now())); localStorage.setItem('elpp_scan_state_v1', JSON.stringify(state)); localStorage.setItem('elpp_px', JSON.stringify(api)); } catch (e) {}
    window.__ELPP_RUNNER = true;
  }, { token: c.token, user: c.user, state: c.state, api: API });
  await ctx.route(/\.(png|jpe?g|gif|webp|svg|woff2?|ttf|mp4)(\?|$)/i, r => r.abort());
  const page = await ctx.newPage();
  page.on('pageerror', e => { status.lastError = String(e.message).slice(0, 200); });
  page.on('crash', () => { status.lastError = 'page crashed'; });
  let closed = false; browser.on('disconnected', () => { closed = true; });
  await page.goto(SITE + 'index.html', { waitUntil: 'domcontentloaded', timeout: 90000 });
  status.phase = 'running'; log('scanner page opened');
  let lastCoins = -1, lastChange = Date.now(), started = Date.now(), cfgAt = c.updatedAt;
  for (;;) {
    await sleep(60000);
    if (closed) throw new Error('browser closed');
    let h = null;
    try { h = await page.evaluate(() => { try { const hh = window.__elppHealth ? window.__elppHealth() : { coins: 0 }; return { coins: hh.coins || 0, view: hh.view, hidden: document.hidden, url: location.pathname, title: document.title.slice(0, 60), mem: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : 0 }; } catch (e) { return { err: String(e.message) }; } }); } catch (e) { throw new Error('page not responding: ' + e.message); }
    if (/welcome/.test(h.url || '')) throw new Error('login gate sent the runner to the landing page (token rejected)');
    status.coins = h.coins || 0; status.pageOk = true; status.lastError = status.lastError;
    if (h.coins !== lastCoins) { lastCoins = h.coins; lastChange = Date.now(); }
    await beat({ phase: 'running', coins: h.coins, memMB: h.mem, uptimeMin: Math.round((Date.now() - started) / 60000), title: h.title, restarts: status.restarts, lastError: status.lastError });
    if (Date.now() - started > 12 * 3600e3) { log('planned 12h restart'); break; }
    if (h.mem > 1400) { log('memory high, restarting'); break; }
    if (Date.now() - lastChange > 20 * 60000 && h.coins === 0) throw new Error('no coins loaded for 20 minutes');
    try { const n = await cfg(); if (n.ready && n.updatedAt !== cfgAt) { log('settings changed, restarting with the new settings'); break; } } catch (e) {}
  }
  await browser.close().catch(() => {});
}

(async function main() {
  for (;;) {
    try {
      if (!API || TOKEN.length < 20) { await sleep(30000); continue; }
      const c = await cfg();
      if (!c.ready) { status.phase = 'waiting for settings (use "Send settings to server" in the app)'; log(status.phase); await sleep(60000); continue; }
      await session(c);
    } catch (e) { status.restarts++; status.phase = 'error'; status.lastError = String(e.message).slice(0, 200); log('error:', e.message); await beat({ phase: 'error', lastError: status.lastError, restarts: status.restarts }); await sleep(30000); }
  }
})();
