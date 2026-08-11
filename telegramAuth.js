// Verifies a Telegram Mini App's initData is genuine and unmodified, per
// Telegram's official algorithm. Since this bot has no accounts, this check
// IS the entire security model for the Mini App's API - it also confirms
// the requesting Telegram user is the one AUTHORIZED_CHAT_ID.

const crypto = require('crypto');

const MAX_AGE_SECONDS = 24 * 60 * 60;

function validateInitData(initDataRaw, botToken) {
  if (!initDataRaw || !botToken) throw new Error('Missing initData or bot token');

  const params = new URLSearchParams(initDataRaw);
  const receivedHash = params.get('hash');
  if (!receivedHash) throw new Error('initData missing hash');
  params.delete('hash');

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  const validSignature =
    computedHash.length === receivedHash.length &&
    crypto.timingSafeEqual(Buffer.from(computedHash), Buffer.from(receivedHash));

  if (!validSignature) throw new Error('Invalid initData signature');

  const authDate = Number(params.get('auth_date'));
  if (!authDate || Date.now() / 1000 - authDate > MAX_AGE_SECONDS) {
    throw new Error('initData has expired - reopen the app from Telegram');
  }

  const userRaw = params.get('user');
  if (!userRaw) throw new Error('initData missing user');

  return JSON.parse(userRaw);
}

module.exports = { validateInitData };
