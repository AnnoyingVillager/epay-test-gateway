const { md5, timingSafeEqualText } = require('./crypto');

const EXCLUDED_SIGN_KEYS = new Set(['sign', 'sign_type']);

function normalizeParams(input = {}) {
  const result = {};
  for (const [key, rawValue] of Object.entries(input)) {
    if (rawValue === undefined || rawValue === null) continue;
    const value = Array.isArray(rawValue) ? rawValue[rawValue.length - 1] : rawValue;
    if (typeof value === 'object') continue;
    result[key] = String(value);
  }
  return result;
}

function canonicalString(params) {
  return Object.entries(params)
    .filter(([key, value]) => !EXCLUDED_SIGN_KEYS.has(key) && value !== '')
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
}

function makeSign(params, merchantKey) {
  return md5(`${canonicalString(params)}${merchantKey}`).toLowerCase();
}

function verifySign(params, merchantKey) {
  const supplied = String(params.sign || '').toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(supplied)) return false;
  return timingSafeEqualText(supplied, makeSign(params, merchantKey));
}

function parseMoneyToMinor(value) {
  const raw = String(value ?? '').trim();
  if (!/^\d{1,10}(?:\.\d{1,2})?$/.test(raw)) return null;
  const [whole, decimals = ''] = raw.split('.');
  const minor = Number(whole) * 100 + Number(decimals.padEnd(2, '0'));
  if (!Number.isSafeInteger(minor) || minor <= 0) return null;
  return minor;
}

function formatMinor(minor) {
  return (Number(minor) / 100).toFixed(2);
}

function buildCallbackParams(order, merchant, tradeStatus, extras = {}) {
  const params = {
    pid: merchant.pid,
    trade_no: order.tradeNo,
    out_trade_no: order.outTradeNo,
    type: order.type,
    name: order.name,
    money: formatMinor(order.moneyMinor),
    trade_status: tradeStatus,
    ...extras
  };
  if (order.param) params.param = order.param;
  params.sign = makeSign(params, merchant.key);
  params.sign_type = 'MD5';
  return params;
}

function callbackUrl(url, params) {
  const target = new URL(url);
  for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value);
  return target.toString();
}

module.exports = {
  normalizeParams,
  canonicalString,
  makeSign,
  verifySign,
  parseMoneyToMinor,
  formatMinor,
  buildCallbackParams,
  callbackUrl
};
