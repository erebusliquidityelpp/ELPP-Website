// Tiny static server for the ELPP app. No dependencies. Railway sets PORT and gives you HTTPS.
const http = require('http'), fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, 'public');
const TYPES = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.webmanifest':'application/manifest+json', '.png':'image/png', '.json':'application/json', '.ico':'image/x-icon' };
http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/' || p === '') p = '/index.html';
  const f = path.normalize(path.join(ROOT, p));
  if (!f.startsWith(ROOT)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(f, (err, data) => {
    if (err) { res.writeHead(404, {'Content-Type':'text/plain'}); return res.end('Not found'); }
    const ext = path.extname(f).toLowerCase();
    res.writeHead(200, {
      'Content-Type': TYPES[ext] || 'application/octet-stream',
      // always re-check the page, so a new GitHub push reaches the phone quickly
      'Cache-Control': (ext === '.html' || ext === '.js' || ext === '.webmanifest') ? 'no-cache' : 'public, max-age=86400'
    });
    res.end(data);
  });
}).listen(process.env.PORT || 3000, '0.0.0.0', () => console.log('ELPP app up on port ' + (process.env.PORT || 3000)));
