const { app, BrowserWindow, shell, Menu } = require('electron');
const path = require('path'), fs = require('fs');
const SITE = 'https://erebusliquidityelpp.github.io/ELPP-Website/';
if (!app.requestSingleInstanceLock()) app.quit();
let win;
const stateFile = () => path.join(app.getPath('userData'), 'window.json');
function loadBounds() { try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch (e) { return { width: 1440, height: 900 }; } }
function create() {
  const b = loadBounds();
  win = new BrowserWindow({ width: b.width || 1440, height: b.height || 900, x: b.x, y: b.y, minWidth: 900, minHeight: 600, backgroundColor: '#0b0f14', title: 'ELPP Scanner', autoHideMenuBar: true, icon: path.join(__dirname, 'build', 'icon.png'), webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  if (b.max) win.maximize();
  win.loadURL(SITE);
  win.webContents.on('did-fail-load', (e, code, desc, url, isMain) => { if (isMain && code !== -3) win.loadFile(path.join(__dirname, 'offline.html')); });
  win.webContents.setWindowOpenHandler(({ url }) => { if (url.startsWith(SITE)) return { action: 'allow' }; shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(SITE) && !url.startsWith('file:')) { e.preventDefault(); shell.openExternal(url); } });
  const save = () => { try { const m = win.isMaximized(); const r = m ? (loadBounds()) : win.getBounds(); fs.writeFileSync(stateFile(), JSON.stringify(Object.assign({}, r, { max: m }))); } catch (e) {} };
  win.on('close', save); win.on('closed', () => { win = null; });
}
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.whenReady().then(() => { Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'ELPP', submenu: [{ label: 'Reload (get the latest update)', accelerator: 'F5', click: () => win && win.loadURL(SITE) }, { label: 'Hard reload', accelerator: 'CmdOrCtrl+Shift+R', click: () => win && win.webContents.reloadIgnoringCache() }, { role: 'togglefullscreen' }, { role: 'quit' }] }])); create(); app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) create(); }); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
