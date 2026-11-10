# ELPP runner (scanner that never sleeps)
Opens the real scanner page in a headless browser on Railway, so alerts, signals, watchlist and morning-brief messages keep going with every tab closed.

Railway: New service from the same GitHub repo, Root Directory `runner`. Variables:
- `API` = your backend address (https://elpp-website-production.up.railway.app)
- `RUNNER_TOKEN` = the same long secret you put on the backend service

Then in the scanner open "24/7 alerts" and press "Send my scanner settings to the server".
