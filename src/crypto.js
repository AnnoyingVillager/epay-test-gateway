const crypto = require('node:crypto');

function md5(value) {
  return crypto.createHash('md5').update(String(value), 'utf8').digest('hex');
}

function randomToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function randomDigits(length) {
  let result = '';
  while (result.length < length) result += crypto.randomInt(0, 10).toString();
  return result;
}

function encryptionKey(secret) {
  return crypto.createHash('sha256').update(`epay-card-v1:${secret}`).digest();
}

function encrypt(plaintext, secret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(secret), iv);
  const body = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64url')}:${tag.toString('base64url')}:${body.toString('base64url')}`;
}

function decrypt(payload, secret) {
  if (!payload) return '';
  const [version, ivPart, tagPart, bodyPart] = String(payload).split(':');
  if (version !== 'v1' || !ivPart || !tagPart || !bodyPart) throw new Error('Unsupported encrypted value');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(secret), Buffer.from(ivPart, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(bodyPart, 'base64url')), decipher.final()]).toString('utf8');
}

function cardNumberHash(cardNumber, secret) {
  const normalized = String(cardNumber || '').replace(/\D/g, '');
  return crypto.createHmac('sha256', encryptionKey(secret)).update(normalized).digest('hex');
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('base64url');
  const derived = crypto.scryptSync(String(password), salt, 64).toString('base64url');
  return `scrypt$${salt}$${derived}`;
}

function verifyPassword(password, encoded) {
  try {
    const [scheme, salt, expectedPart] = String(encoded || '').split('$');
    if (scheme !== 'scrypt' || !salt || !expectedPart) return false;
    const expected = Buffer.from(expectedPart, 'base64url');
    const actual = crypto.scryptSync(String(password), salt, expected.length);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function luhnCheckDigit(numberWithoutCheck) {
  let sum = 0;
  let doubleDigit = true;
  for (let index = numberWithoutCheck.length - 1; index >= 0; index -= 1) {
    let digit = Number(numberWithoutCheck[index]);
    if (doubleDigit) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    doubleDigit = !doubleDigit;
  }
  return String((10 - (sum % 10)) % 10);
}

function generateCardNumber(prefix, length = 16) {
  const cleanPrefix = String(prefix).replace(/\D/g, '');
  if (cleanPrefix.length < 4 || cleanPrefix.length >= length) {
    throw new Error('BIN prefix must be shorter than card length and contain at least 4 digits');
  }
  const partial = cleanPrefix + randomDigits(length - cleanPrefix.length - 1);
  return partial + luhnCheckDigit(partial);
}

function luhnValid(number) {
  const value = String(number).replace(/\D/g, '');
  if (value.length < 12) return false;
  let sum = 0;
  let doubleDigit = false;
  for (let index = value.length - 1; index >= 0; index -= 1) {
    let digit = Number(value[index]);
    if (doubleDigit) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    doubleDigit = !doubleDigit;
  }
  return sum % 10 === 0;
}

function maskCardNumber(number, visible = 4) {
  const value = String(number || '').replace(/\s+/g, '');
  if (value.length <= visible) return value;
  return `${'*'.repeat(Math.max(0, value.length - visible))}${value.slice(-visible)}`;
}

function timingSafeEqualText(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function createUserSession(user, secret, ttlSeconds) {
  const payload = {
    uid: Number(user.id),
    u: user.username,
    r: user.role,
    sa: Boolean(user.isSuperAdmin),
    pv: Number(user.passwordVersion || 0),
    csrf: randomToken(24),
    exp: Math.floor(Date.now() / 1000) + ttlSeconds
  };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return { token: `${body}.${signature}`, payload };
}

function verifyUserSession(token, secret) {
  if (!token || !token.includes('.')) return null;
  const [body, signature] = token.split('.');
  const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  if (!timingSafeEqualText(signature, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!Number.isSafeInteger(payload.uid) || payload.uid < 1 || !payload.u || !['admin', 'user'].includes(payload.r) || !payload.csrf || Number(payload.exp) <= Math.floor(Date.now() / 1000)) return null;
    if (payload.pv !== undefined && (!Number.isSafeInteger(payload.pv) || payload.pv < 0)) return null;
    return payload;
  } catch {
    return null;
  }
}

function parseCookies(header = '') {
  return header.split(';').reduce((result, part) => {
    const index = part.indexOf('=');
    if (index < 0) return result;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!key) return result;
    try {
      result[key] = decodeURIComponent(value);
    } catch {
      result[key] = value;
    }
    return result;
  }, {});
}

module.exports = {
  md5,
  randomToken,
  randomDigits,
  encrypt,
  decrypt,
  cardNumberHash,
  hashPassword,
  verifyPassword,
  luhnCheckDigit,
  luhnValid,
  generateCardNumber,
  maskCardNumber,
  timingSafeEqualText,
  createUserSession,
  verifyUserSession,
  parseCookies
};
