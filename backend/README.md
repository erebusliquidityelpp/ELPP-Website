# ELPP backend (accounts)

Signup, login and sessions for the ELPP scanner. Node.js, Express, SQLite.

## Deploy on Railway (about 10 minutes)

1. In Railway: **New Project → Deploy from GitHub repo → ELPP-Website**.
2. Open the new service → **Settings → Root Directory** → type `backend`.
3. **Settings → Networking → Generate Domain**. Copy the address (looks like `https://something.up.railway.app`).
4. **Volumes → New Volume**, mount path `/data`. Without it, accounts are erased on every redeploy.
5. **Variables** tab, add:
   - `JWT_SECRET` = any long random text (40+ characters). Keep it private.
   - `DB_PATH` = `/data/elpp.db`
   - `ALLOWED_ORIGINS` = `https://erebusliquidityelpp.github.io`
   - `ADMIN_EMAIL` = your own email (the account with this email becomes admin)
   - optional: `SIGNUP_OPEN` = `false` to close new sign-ups
6. Open `https://YOUR-ADDRESS/api/health`. You should see `{"ok":true,"users":0}`.
7. Put the address in `auth-config.js` (`window.ELPP_API = 'https://YOUR-ADDRESS';`) and push. Login switches on.

## Endpoints

| Method | Path | What |
|---|---|---|
| POST | /api/signup | `{name,email,password}` creates an account, returns a token |
| POST | /api/login | `{email,password}` returns a token |
| GET | /api/me | who am I (Bearer token) |
| POST | /api/logout | ends the session on every device |
| POST | /api/password | `{current,next}` change password |
| GET | /api/admin/users | admin only: list of accounts |

Passwords are stored as bcrypt hashes. Attempts are rate-limited. Tokens last 30 days.

## Always-on features (run on the server, no browser needed)
- **Data proxy** (`/proxy.php?u=...`): fetches public data that browsers or GitHub block (FRED, the economic calendar, Farside ETF flows, DefiLlama, CFTC and more) from an allow-list. Add `FRED_API_KEY` in Railway Variables so FRED goes through the official API.
- **24/7 alerts** (`/api/alerts`, `/api/telegram`): price, funding, 24h move and open-interest alerts for Hyperliquid coins, checked every minute and sent to your Telegram bot. Telegram tokens are stored encrypted.

## Not included yet
Email verification and "forgot password" (they need an email service). Payments.

## Run locally
`npm install`, then `JWT_SECRET=some-long-secret ALLOW_LOCALHOST=true npm start`.
