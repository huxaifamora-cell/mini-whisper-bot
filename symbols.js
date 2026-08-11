// Single source of truth for which symbol codes we accept, and how to show
// them to a human. Every entry below is CONFIRMED, not guessed:
//   - WS-direct codes were confirmed via /admin/discover-symbols (Deriv's
//     own active_symbols response).
//   - MT5-bridge codes were confirmed via mt5-ea/WhisperListSymbols.mq5
//     (the exact symbol list your broker offers), cross-checked against
//     the WS list above - anything present on the broker but absent from
//     Deriv's WS stream gets an MT5_ code and must go through the EA.
// Standalone (non-1s) Volatility 150/250 Index don't exist at all - not on
// WS, not on the broker's symbol list - so they're intentionally omitted.

const SYMBOL_LABELS = {
  // --- Direct from Deriv's WS ticks API (confirmed via /admin/discover-symbols) ---
  R_10: 'Volatility 10 Index',
  R_25: 'Volatility 25 Index',
  R_50: 'Volatility 50 Index',
  R_75: 'Volatility 75 Index',
  R_100: 'Volatility 100 Index',
  '1HZ10V': 'Volatility 10 (1s) Index',
  '1HZ15V': 'Volatility 15 (1s) Index',
  '1HZ25V': 'Volatility 25 (1s) Index',
  '1HZ30V': 'Volatility 30 (1s) Index',
  '1HZ50V': 'Volatility 50 (1s) Index',
  '1HZ75V': 'Volatility 75 (1s) Index',
  '1HZ90V': 'Volatility 90 (1s) Index',
  '1HZ100V': 'Volatility 100 (1s) Index',

  // --- MT5-bridge only (confirmed on the broker's symbol list, absent from Deriv WS) ---
  MT5_VOL5: 'Volatility 5 Index',
  MT5_VOL15: 'Volatility 15 Index',
  MT5_VOL30: 'Volatility 30 Index',
  MT5_VOL90: 'Volatility 90 Index',
  MT5_VOL5_1S: 'Volatility 5 (1s) Index',
  MT5_VOL150_1S: 'Volatility 150 (1s) Index',
  MT5_VOL250_1S: 'Volatility 250 (1s) Index',

  // --- Forex / commodities / crypto (confirmed via /admin/discover-symbols) ---
  // NOTE: CADJPY was searched for and does not exist on Deriv's WS API at
  // all (not under any code) - omitted rather than guessed. If it turns out
  // to exist on your MT5 broker, it can be added as an MT5-bridge symbol
  // the same way Volatility 150/250 were.
  frxXAUUSD: 'XAUUSD',
  cryBTCUSD: 'Bitcoin/USD (BTCUSD)',
  frxGBPUSD: 'GBP/USD',
  frxAUDUSD: 'AUD/USD',
  frxEURUSD: 'EUR/USD',
  frxGBPJPY: 'GBP/JPY',
  frxUSDCAD: 'USD/CAD',
  frxUSDJPY: 'USD/JPY',
  frxEURAUD: 'EUR/AUD',
  frxAUDCHF: 'AUD/CHF',
  frxUSDCHF: 'USD/CHF',
};

// Which symbols require the MT5 EA bridge rather than the Deriv WS client.
const MT5_BRIDGE_ONLY = new Set([
  'MT5_VOL5', 'MT5_VOL15', 'MT5_VOL30', 'MT5_VOL90',
  'MT5_VOL5_1S', 'MT5_VOL150_1S', 'MT5_VOL250_1S',
]);

const VALID_SYMBOLS = new Set(Object.keys(SYMBOL_LABELS));

// Case-insensitive lookup: user-typed-lowercase -> canonical correctly-cased key.
// Needed because some codes are genuinely mixed-case (frxUSDJPY, cryBTCUSD),
// so a naive toUpperCase() comparison breaks them.
const CANONICAL_BY_LOWERCASE = new Map(
  Object.keys(SYMBOL_LABELS).map((key) => [key.toLowerCase(), key])
);

// Strict check: does this EXACT string match a known symbol code? Used
// wherever the value came from our own dropdown/API (which always sends the
// correct casing already), so no normalization should be needed.
function isValidSymbol(symbol) {
  return typeof symbol === 'string' && VALID_SYMBOLS.has(symbol);
}

// Case-insensitive lookup that returns the canonical correctly-cased code,
// or null if nothing matches. Used for free-text input (e.g. Telegram's
// /setalert command) where a person might type frxusdjpy or FRXUSDJPY.
function normalizeSymbol(symbol) {
  if (typeof symbol !== 'string') return null;
  if (VALID_SYMBOLS.has(symbol)) return symbol;
  return CANONICAL_BY_LOWERCASE.get(symbol.toLowerCase()) || null;
}

function labelForSymbol(symbol) {
  return SYMBOL_LABELS[symbol] || SYMBOL_LABELS[normalizeSymbol(symbol)] || symbol;
}

module.exports = {
  VALID_SYMBOLS,
  SYMBOL_LABELS,
  MT5_BRIDGE_ONLY,
  isValidSymbol,
  normalizeSymbol,
  labelForSymbol,
};

