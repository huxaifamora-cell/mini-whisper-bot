# Whisper Personal Bot

A completely standalone, single-user Telegram bot. No accounts, no
database, no dashboard, no connection to the main Whisper project at all -
just this folder. Set price alerts, get pinged when they trigger.

## Setup

1. **Create a new Telegram bot** — message @BotFather, `/newbot`, get a
   token. This must be a DIFFERENT bot from your main Whisper bot.

2. **Find your Telegram chat ID** — message @userinfobot, it replies with
   your numeric ID. (Or: run this bot once with `AUTHORIZED_CHAT_ID` left
   blank, message it anything, and it'll tell you your chat ID directly.)

3. **Configure:**
   ```bash
   cp .env.example .env
   ```
   Fill in `TELEGRAM_BOT_TOKEN` and `AUTHORIZED_CHAT_ID`.

4. **Run locally:**
   ```bash
   npm install
   npm start
   ```

5. **Message your bot** on Telegram: `/start`

## Commands

- `/app` — open the Mini App (same look as the main Whisper bot's app)
- `/setalert SYMBOL TIMEFRAME PRICE buy|sell` — e.g. `/setalert R_75 M15 250000 buy`
- `/myalerts` — list everything
- `/delete ID` — remove one
- `/symbols` — see valid symbol codes

## Mini App

Same visual style as the main Whisper bot's Mini App, but no login screen —
since there's only ever one authorized user, Telegram's own signed request
data is enough to prove who's asking. Tabs: Alerts, Create, History.

To get the "Open Whisper" button working, set `PUBLIC_BASE_URL` (your
deployed URL) and `TELEGRAM_BOT_USERNAME` in `.env`, then restart. It'll
appear both as a persistent button next to the message box and via `/app`.

## Deploying so it runs 24/7

This needs to stay running continuously (it holds a live price feed
connection). Simplest options:

**Render (same account as the main project, as a second service):**
1. Render dashboard → New → Web Service → same GitHub repo
2. Root Directory: `personal-bot`
3. Build Command: `npm install`
4. Start Command: `npm start`
5. Add the env vars from `.env.example` in the Environment tab
6. Free tier sleeps after 15 min of no HTTP traffic — since this bot has no
   incoming web traffic at all (just Telegram polling), set up a free
   pinger like cron-job.org hitting your service's URL every 10 minutes to
   keep it awake (same trick used for the main backend).

**Anywhere else:** any machine that can run Node.js continuously (a VPS,
a Raspberry Pi, etc.) works too — just `npm install && npm start` and
leave it running, e.g. under `pm2` or a systemd service so it restarts
if it crashes.

## Data

Alerts are stored in `alerts.json` in this folder (auto-created on first
alert). Back this file up if you care about not losing your alert list —
there's no cloud backup since there's no database.
