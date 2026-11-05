# ELPP Crypto Scanner Pro
`index.html` is the scanner. The Android app loads this page from GitHub Pages every time it opens,
so replacing `index.html` here updates the app (allow about 1-2 minutes after saving).
Keep the file name exactly `index.html`.

## Hostinger deployment (V4.95)

Upload `index.html`, `proxy.php`, `sw.js`, `manifest.webmanifest` and the `eagle-*.png` icons to `public_html` (or a sub-folder). `proxy.php` must sit in the same folder as `index.html`; the scanner finds it automatically. It fetches only a fixed allow-list of public data (FRED US yields, Binance announcements, mempool.space, Yahoo chart, CFTC) and caches answers, so it cannot be used as an open proxy. If the scanner is hosted elsewhere (for example GitHub Pages) but `proxy.php` is on Hostinger, set the address once in the browser console: `localStorage.setItem('elpp_px','"https://yourdomain.com"')`.

### CoinMarketCap on Hostinger
CoinMarketCap blocks browsers, so `proxy.php` calls it for you. Copy `proxy-config.example.php` to `proxy-config.php` (same folder) and paste your free key there: the key stays on the server and is never sent to visitors. Answers are cached for 5 minutes to save your monthly credits. The scanner uses it for market-cap rank, circulating supply, fully diluted value, listing age, number of markets and dominance. If you prefer, you can still paste the key in the scanner's API keys page instead.
