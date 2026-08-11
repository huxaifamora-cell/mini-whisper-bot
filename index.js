// Whisper Personal Bot
// A completely standalone, single-user version of Whisper's core alert
// feature: set a price target, get pinged on Telegram when it's crossed -
// available both as chat commands AND a Mini App with the same look as the
// main Whisper bot. No accounts, no Postgres, no dashboard.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const WebSocket = require('ws');
const TelegramBot = require('node-telegram-bot-api');
const { normalizeSymbol, labelForSymbol, SYMBOL_LABELS } = require('./symbols');
const { validateInitData } = require('./telegramAuth');

const AUTHORIZED_CHAT_ID = String(process.env.AUTHORIZED_CHAT_ID || '');
const ALERTS_FILE = path.join(__dirname, 'alerts.json');

if (!process.env.TELEGRAM_BOT_TOKEN) {
  console.error('Missing TELEGRAM_BOT_TOKEN in .env - see .env.example');
  process.exit(1);
}
if (!AUTHORIZED_CHAT_ID) {
  console.warn(
    '[warning] AUTHORIZED_CHAT_ID is not set. The bot will reply to ANY chat that ' +
    'messages it with their chat ID so you can copy it into .env, but will not ' +
    'act on any commands (or Mini App requests) until it is set.'
  );
}

// ---------------------------------------------------------------------------
// Storage: a single JSON file instead of a database.
// ---------------------------------------------------------------------------
let alerts = [];
let nextId = 1;

function loadAlerts() {
  if (fs.existsSync(ALERTS_FILE)) {
    const data = JSON.parse(fs.readFileSync(ALERTS_FILE, 'utf8'));
    alerts = data.alerts || [];
    nextId = data.nextId || alerts.length + 1;
  }
}

function saveAlerts() {
  fs.writeFileSync(ALERTS_FILE, JSON.stringify({ alerts, nextId }, null, 2));
}

loadAlerts();

function createAlert({ symbol, timeframe, target_price, direction }) {
  const alert = {
    id: nextId++,
    symbol,
    timeframe,
    target_price: Number(target_price),
    direction: direction.toLowerCase(),
    status: 'active',
    last_price: null,
    created_at: new Date().toISOString(),
  };
  alerts.push(alert);
  saveAlerts();
  refreshDerivSubscriptions();
  return alert;
}

function deleteAlert(id) {
  const before = alerts.length;
  alerts = alerts.filter((a) => a.id !== id);
  saveAlerts();
  if (alerts.length < before) refreshDerivSubscriptions();
  return alerts.length < before;
}

// ---------------------------------------------------------------------------
// Telegram bot, locked to one chat
// ---------------------------------------------------------------------------
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

function isAuthorized(chatId) {
  return AUTHORIZED_CHAT_ID && String(chatId) === AUTHORIZED_CHAT_ID;
}

function getWebAppUrl() {
  const base = process.env.PUBLIC_BASE_URL;
  return base ? `${base.replace(/\/$/, '')}/` : null;
}

function sendOpenAppButton(chatId, text = 'Tap below to open Whisper Personal.') {
  const webAppUrl = getWebAppUrl();
  if (!webAppUrl) {
    bot.sendMessage(chatId, text + '\n\n(Mini App URL not configured yet - set PUBLIC_BASE_URL.)');
    return;
  }
  bot.sendMessage(chatId, text, {
    reply_markup: { inline_keyboard: [[{ text: '👂 Open Whisper', web_app: { url: webAppUrl } }]] },
  });
}

// Persistent "Open App" button next to the message box.
const webAppUrl = getWebAppUrl();
if (webAppUrl) {
  bot.setChatMenuButton({
    menu_button: { type: 'web_app', text: 'Open Whisper', web_app: { url: webAppUrl } },
  }).catch((err) => console.warn('[telegram] could not set menu button:', err.message));
}

bot.on('message', (msg) => {
  if (isAuthorized(msg.chat.id)) return;
  if (!AUTHORIZED_CHAT_ID) {
    bot.sendMessage(
      msg.chat.id,
      `This bot isn't configured yet. Your chat ID is: ${msg.chat.id}\n\nPut that in AUTHORIZED_CHAT_ID in the bot's .env file and restart it.`
    );
  }
});

bot.onText(/\/start/, (msg) => {
  if (!isAuthorized(msg.chat.id)) return;
  sendOpenAppButton(
    msg.chat.id,
    "Whisper Personal 👂\n\nOpen the app below, or use chat commands:\n" +
    "/setalert SYMBOL TIMEFRAME PRICE buy|sell\n/myalerts\n/delete ID\n/symbols"
  );
});

bot.onText(/\/app/, (msg) => {
  if (!isAuthorized(msg.chat.id)) return;
  sendOpenAppButton(msg.chat.id);
});

bot.onText(/\/setalert (\S+) (\S+) ([\d.]+) (buy|sell)/i, (msg, match) => {
  if (!isAuthorized(msg.chat.id)) return;

  const [, symbolInput, timeframe, priceStr, direction] = match;
  const symbol = normalizeSymbol(symbolInput);
  if (!symbol) {
    return bot.sendMessage(msg.chat.id, `❌ "${symbolInput}" isn't a recognized symbol. Send /symbols to see valid codes.`);
  }

  const alert = createAlert({ symbol, timeframe, target_price: priceStr, direction });
  bot.sendMessage(
    msg.chat.id,
    `✅ Alert #${alert.id} set: ${labelForSymbol(symbol)} ${timeframe} target ${alert.target_price} (${alert.direction})`
  );
});

bot.onText(/\/myalerts/, (msg) => {
  if (!isAuthorized(msg.chat.id)) return;
  if (!alerts.length) return bot.sendMessage(msg.chat.id, 'No alerts yet. Use /setalert to create one.');
  const lines = alerts.slice().reverse().map(
    (a) => `#${a.id} ${labelForSymbol(a.symbol)} ${a.timeframe} → ${a.target_price} (${a.direction}) [${a.status}]`
  );
  bot.sendMessage(msg.chat.id, lines.join('\n'));
});

bot.onText(/\/delete (\d+)/, (msg, match) => {
  if (!isAuthorized(msg.chat.id)) return;
  const ok = deleteAlert(Number(match[1]));
  bot.sendMessage(msg.chat.id, ok ? `🗑️ Deleted alert #${match[1]}` : 'Alert not found.');
});

bot.onText(/\/symbols/, (msg) => {
  if (!isAuthorized(msg.chat.id)) return;
  const lines = Object.entries(SYMBOL_LABELS).map(([code, label]) => `${code} — ${label}`);
  bot.sendMessage(msg.chat.id, lines.join('\n'));
});

// ---------------------------------------------------------------------------
// Deriv WS: crossing detection over the in-memory alert list.
// ---------------------------------------------------------------------------
let ws = null;
let subscribedSymbols = new Set();
let reconnectDelayMs = 1000;

function connectDeriv() {
  const url = `${process.env.DERIV_WS_URL}?app_id=${process.env.DERIV_APP_ID}`;
  ws = new WebSocket(url);

  ws.on('open', () => {
    console.log('[deriv] connected');
    reconnectDelayMs = 1000;
    refreshDerivSubscriptions();
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.msg_type === 'tick' && msg.tick) evaluateTick(msg.tick.symbol, Number(msg.tick.quote));
    if (msg.error) console.error('[deriv] API error:', msg.error.message);
  });

  ws.on('close', () => {
    console.warn('[deriv] disconnected, reconnecting in', reconnectDelayMs, 'ms');
    subscribedSymbols = new Set();
    setTimeout(connectDeriv, reconnectDelayMs);
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, 30000);
  });

  ws.on('error', (err) => console.error('[deriv] socket error:', err.message));
}

function refreshDerivSubscriptions() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const needed = new Set(alerts.filter((a) => a.status === 'active').map((a) => a.symbol));
  for (const symbol of needed) {
    if (!subscribedSymbols.has(symbol)) {
      ws.send(JSON.stringify({ ticks: symbol, subscribe: 1 }));
      subscribedSymbols.add(symbol);
      console.log('[deriv] subscribed to', symbol);
    }
  }
}

function evaluateTick(symbol, price) {
  let changed = false;

  for (const alert of alerts) {
    if (alert.symbol !== symbol || alert.status !== 'active') continue;

    if (alert.last_price === null) {
      alert.last_price = price;
      changed = true;
      continue;
    }

    const target = alert.target_price;
    const crossedUp = alert.direction === 'buy' && alert.last_price < target && price >= target;
    const crossedDown = alert.direction === 'sell' && alert.last_price > target && price <= target;

    if (crossedUp || crossedDown) {
      alert.status = 'triggered';
      alert.last_price = price;
      changed = true;

      const arrow = alert.direction === 'buy' ? '📈' : '📉';
      bot.sendMessage(
        AUTHORIZED_CHAT_ID,
        `${arrow} WHISPER ALERT\n${labelForSymbol(alert.symbol)} (${alert.timeframe})\n` +
        `Target ${target} reached — price now ${price}\nDirection: ${alert.direction.toUpperCase()}\n\nTime to check your chart 👀`
      );
    } else {
      alert.last_price = price;
      changed = true;
    }
  }

  if (changed) saveAlerts();
}

// ---------------------------------------------------------------------------
// Express server: serves the Mini App + its API, and doubles as the
// health-check endpoint Render needs for a Web Service.
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'webapp')));

app.get('/health', (req, res) => res.json({ ok: true }));

// Every /api/* route is gated by validating Telegram's initData AND
// confirming the resulting user is AUTHORIZED_CHAT_ID - this is the entire
// security model, since there's no login system at all.
function requireTelegramAuth(req, res, next) {
  try {
    const initData = req.headers['x-telegram-init-data'];
    const telegramUser = validateInitData(initData, process.env.TELEGRAM_BOT_TOKEN);
    if (!isAuthorized(telegramUser.id)) {
      return res.status(403).json({ error: 'This Mini App is locked to a different Telegram account.' });
    }
    next();
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
}

app.get('/api/symbols', requireTelegramAuth, (req, res) => {
  res.json(SYMBOL_LABELS);
});

app.get('/api/alerts', requireTelegramAuth, (req, res) => {
  res.json(alerts.map((a) => ({ ...a, label: labelForSymbol(a.symbol) })));
});

app.post('/api/alerts', requireTelegramAuth, (req, res) => {
  const { symbol, timeframe, target_price, direction } = req.body;
  const canonicalSymbol = normalizeSymbol(symbol);
  if (!canonicalSymbol || !timeframe || target_price == null || !['buy', 'sell'].includes(direction)) {
    return res.status(400).json({ error: 'symbol, timeframe, target_price, direction (buy|sell) are required' });
  }
  const alert = createAlert({ symbol: canonicalSymbol, timeframe, target_price, direction });
  res.status(201).json({ ...alert, label: labelForSymbol(alert.symbol) });
});

app.delete('/api/alerts/:id', requireTelegramAuth, (req, res) => {
  const ok = deleteAlert(Number(req.params.id));
  if (!ok) return res.status(404).json({ error: 'Alert not found' });
  res.json({ deleted: true });
});

app.listen(process.env.PORT || 3000, () => {
  console.log(`[http] listening on :${process.env.PORT || 3000}`);
});

connectDeriv();
console.log('[bot] Whisper Personal Bot started.');
