const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { loadConfig } = require('../src/config');
const { openDatabase, setSetting, getSetting } = require('../src/db');
const { encrypt, decrypt, cardNumberHash } = require('../src/crypto');
const { rotateSecrets } = require('../scripts/rotate-app-secret');

test('APP_SECRET rotation re-encrypts cards, merchants, SMTP and email codes', (t) => {
  const oldSecret = 'old-secret-that-is-long-enough-for-testing';
  const newSecret = 'new-secret-that-is-long-enough-for-testing';
  const config = loadConfig({
    databasePath: ':memory:',
    appSecret: oldSecret,
    defaultMerchantKey: 'merchant-key-before-rotation',
    adminPassword: 'admin-password',
    adminPasswordIsDefault: false
  });
  const db = openDatabase(config);
  t.after(() => db.close());
  const now = Date.now();
  const bin = db.prepare(`
    INSERT INTO bins (name, prefix, brand, card_type, number_length, require_3ds, is_active, created_at, updated_at)
    VALUES ('Test BIN', '424242', 'Visa', 'debit', 16, 0, 1, ?, ?)
  `).run(now, now);
  const cardNumber = '4242424242424242';
  db.prepare(`
    INSERT INTO cards (id, bin_id, card_number_enc, card_number_hash, last4, expires_month, expires_year, cvv_enc, pin_enc, balance_minor, currency, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 12, 2030, ?, ?, 100, 'CNY', 'active', ?, ?)
  `).run(
    'card-1', Number(bin.lastInsertRowid), encrypt(cardNumber, oldSecret), cardNumberHash(cardNumber, oldSecret), '4242',
    encrypt('123', oldSecret), encrypt('654321', oldSecret), now, now
  );
  setSetting(db, 'smtp_password_enc', encrypt('smtp-password', oldSecret));
  const email = 'user@example.com';
  const code = '123456';
  const inserted = db.prepare(`
    INSERT INTO email_verification_codes (email, code_enc, code_hash, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    email,
    encrypt(code, oldSecret),
    crypto.createHmac('sha256', oldSecret).update(`${email}:${code}`).digest('hex'),
    now + 600000,
    now
  );

  const result = rotateSecrets(db, oldSecret, newSecret);
  assert.deepEqual(result, { cards: 1, merchants: 1, smtpPassword: true, emailCodes: 1 });

  const card = db.prepare('SELECT * FROM cards WHERE id = ?').get('card-1');
  assert.equal(decrypt(card.card_number_enc, newSecret), cardNumber);
  assert.equal(decrypt(card.cvv_enc, newSecret), '123');
  assert.equal(decrypt(card.pin_enc, newSecret), '654321');
  assert.equal(card.card_number_hash, cardNumberHash(cardNumber, newSecret));
  const merchant = db.prepare('SELECT key_enc FROM merchants LIMIT 1').get();
  assert.equal(decrypt(merchant.key_enc, newSecret), 'merchant-key-before-rotation');
  assert.equal(decrypt(getSetting(db, 'smtp_password_enc'), newSecret), 'smtp-password');
  const emailCode = db.prepare('SELECT * FROM email_verification_codes WHERE id = ?').get(Number(inserted.lastInsertRowid));
  assert.equal(decrypt(emailCode.code_enc, newSecret), code);
  assert.equal(emailCode.code_hash, crypto.createHmac('sha256', newSecret).update(`${email}:${code}`).digest('hex'));
});
