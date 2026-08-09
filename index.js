// Whisper Personal Bot
// A completely standalone, single-user version of Whisper's core alert
// feature: set a price target, get pinged on Telegram when it's crossed.
// No accounts, no Postgres, no dashboard - just this one file, a JSON
// file for storage, and a Telegram bot locked to one chat ID.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');
const TelegramBot = require('node-telegram-bot-api');
const { normalizeSymbol, labelForSymbol, SYMBOL_LABELS } = require('./symbols');

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
    'act on any commands until it is set. This is a single-user bot - leaving ' +
    'this unset means anyone who finds it could see/control your alerts.'
  );
}

// ---------------------------------------------------------------------------
// Storage: a single JSON file instead of a database. Simple, human-readable,
// good enough for one person's alert list. Loaded into memory at startup,
// saved back to disk after every change.
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

// ---------------------------------------------------------------------------
// Telegram bot, locked to one chat
// ---------------------------------------------------------------------------
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

function isAuthorized(chatId) {
  return AUTHORIZED_CHAT_ID && String(chatId) === AUTHORIZED_CHAT_ID;
}

// Applies to every message: if this isn't the one authorized chat, don't
// process any command - just (at most) tell them their chat ID if the
// operator hasn't configured one yet, so setup is a one-time copy-paste.
bot.on('message', (msg) => {
  if (isAuthorized(msg.chat.id)) return; // handled by the specific command listeners below

  if (!AUTHORIZED_CHAT_ID) {
    bot.sendMessage(
      msg.chat.id,
      `This bot isn't configured yet. Your chat ID is: ${msg.chat.id}\n\nPut that in AUTHORIZED_CHAT_ID in the bot's .env file and restart it.`
    );
  }
  // If AUTHORIZED_CHAT_ID IS set and this isn't it, stay silent - don't
  // confirm the bot is even listening to strangers.
});

bot.onText(/\/start/, (msg) => {
  if (!isAuthorized(msg.chat.id)) return;
  bot.sendMessage(
    msg.chat.id,
    "Whisper Personal 👂\n\n" +
    "/setalert SYMBOL TIMEFRAME PRICE buy|sell — create an alert\n" +
    "/myalerts — list your alerts\n" +
    "/delete ID — remove one\n" +
    "/symbols — list valid symbol codes"
  );
});

bot.onText(/\/setalert (\S+) (\S+) ([\d.]+) (buy|sell)/i, (msg, match) => {
  if (!isAuthorized(msg.chat.id)) return;

  const [, symbolInput, timeframe, priceStr, direction] = match;
  const symbol = normalizeSymbol(symbolInput);
  if (!symbol) {
    return bot.sendMessage(
      msg.chat.id,
      `❌ "${symbolInput}" isn't a recognized symbol. Send /symbols to see valid codes.`
    );
  }

  const alert = {
    id: nextId++,
    symbol,
    timeframe,
    target_price: Number(priceStr),
    direction: direction.toLowerCase(),
    status: 'active',
    last_price: null,
    created_at: new Date().toISOString(),
  };
  alerts.push(alert);
  saveAlerts();
  refreshDerivSubscriptions();

  bot.sendMessage(
    msg.chat.id,
    `✅ Alert #${alert.id} set: ${labelForSymbol(symbol)} ${timeframe} target ${alert.target_price} (${alert.direction})`
  );
});

bot.onText(/\/myalerts/, (msg) => {
  if (!isAuthorized(msg.chat.id)) return;

  if (!alerts.length) {
    return bot.sendMessage(msg.chat.id, 'No alerts yet. Use /setalert to create one.');
  }
  const lines = alerts
    .slice()
    .reverse()
    .map((a) => `#${a.id} ${labelForSymbol(a.symbol)} ${a.timeframe} → ${a.target_price} (${a.direction}) [${a.status}]`);
  bot.sendMessage(msg.chat.id, lines.join('\n'));
});

bot.onText(/\/delete (\d+)/, (msg, match) => {
  if (!isAuthorized(msg.chat.id)) return;

  const id = Number(match[1]);
  const before = alerts.length;
  alerts = alerts.filter((a) => a.id !== id);
  saveAlerts();

  if (alerts.length < before) {
    refreshDerivSubscriptions();
    bot.sendMessage(msg.chat.id, `🗑️ Deleted alert #${id}`);
  } else {
    bot.sendMessage(msg.chat.id, 'Alert not found.');
  }
});

bot.onText(/\/symbols/, (msg) => {
  if (!isAuthorized(msg.chat.id)) return;
  const lines = Object.entries(SYMBOL_LABELS).map(([code, label]) => `${code} — ${label}`);
  bot.sendMessage(msg.chat.id, lines.join('\n'));
});

// ---------------------------------------------------------------------------
// Deriv WS: same crossing-detection approach as the main Whisper backend,
// just scoped to this one file's in-memory alert list instead of a
// multi-user database.
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
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.msg_type === 'tick' && msg.tick) {
      evaluateTick(msg.tick.symbol, Number(msg.tick.quote));
    }
    if (msg.error) {
      console.error('[deriv] API error:', msg.error.message);
    }
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
        `Target ${target} reached — price now ${price}\n` +
        `Direction: ${alert.direction.toUpperCase()}\n\nTime to check your chart 👀`
      );
    } else {
      alert.last_price = price;
      changed = true;
    }
  }

  if (changed) saveAlerts();
}

// ---------------------------------------------------------------------------
// Tiny HTTP server, purely so this can be deployed as a Render Web Service
// (which needs something listening on a port) - not used for anything else.
// ---------------------------------------------------------------------------
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Whisper Personal Bot is running.\n');
}).listen(process.env.PORT || 3000, () => {
  console.log(`[http] listening on :${process.env.PORT || 3000}`);
});

connectDeriv();
console.log('[bot] Whisper Personal Bot started.');
