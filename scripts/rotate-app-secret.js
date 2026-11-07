#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { encrypt, decrypt, cardNumberHash } = require('../src/crypto');

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function emailCodeHash(email, code, secret) {
  return crypto.createHmac('sha256', secret).update(`${String(email).toLowerCase()}:${String(code)}`).digest('hex');
}

function rotateSecrets(db, oldSecret, newSecret) {
  if (!oldSecret || !newSecret) throw new Error('OLD_APP_SECRET and NEW_APP_SECRET are required.');
  if (oldSecret === newSecret) throw new Error('The new APP_SECRET must differ from the old APP_SECRET.');
  if (newSecret.length < 32) throw new Error('The new APP_SECRET must contain at least 32 characters; 64 random hex characters are recommended.');
  if (!tableExists(db, 'settings') || !tableExists(db, 'cards') || !tableExists(db, 'merchants')) {
    throw new Error('The database is not an initialized Epay Test Gateway database.');
  }

  const cards = db.prepare('SELECT id, card_number_enc, cvv_enc, pin_enc FROM cards').all().map((card) => {
    const cardNumber = decrypt(card.card_number_enc, oldSecret);
    return {
      id: card.id,
      cardNumber,
      cvv: decrypt(card.cvv_enc, oldSecret),
      pin: decrypt(card.pin_enc, oldSecret)
    };
  });

  const merchants = db.prepare('SELECT id, key_enc FROM merchants').all().map((merchant) => ({
    id: merchant.id,
    key: decrypt(merchant.key_enc, oldSecret)
  }));

  const smtpRow = db.prepare("SELECT value FROM settings WHERE key = 'smtp_password_enc'").get();
  const smtpPassword = smtpRow?.value ? decrypt(smtpRow.value, oldSecret) : null;

  const emailCodes = tableExists(db, 'email_verification_codes')
    ? db.prepare('SELECT id, email, code_enc FROM email_verification_codes').all().map((row) => ({
      id: row.id,
      email: row.email,
      code: decrypt(row.code_enc, oldSecret)
    }))
    : [];

  db.exec('BEGIN IMMEDIATE');
  try {
    const updateCard = db.prepare(`
      UPDATE cards
      SET card_number_enc = ?, card_number_hash = ?, cvv_enc = ?, pin_enc = ?, updated_at = ?
      WHERE id = ?
    `);
    const now = Date.now();
    for (const card of cards) {
      updateCard.run(
        encrypt(card.cardNumber, newSecret),
        cardNumberHash(card.cardNumber, newSecret),
        encrypt(card.cvv, newSecret),
        encrypt(card.pin, newSecret),
        now,
        card.id
      );
    }

    const updateMerchant = db.prepare('UPDATE merchants SET key_enc = ?, updated_at = ? WHERE id = ?');
    for (const merchant of merchants) updateMerchant.run(encrypt(merchant.key, newSecret), now, merchant.id);

    if (smtpPassword !== null) {
      db.prepare("UPDATE settings SET value = ? WHERE key = 'smtp_password_enc'").run(encrypt(smtpPassword, newSecret));
    }

    const updateEmailCode = db.prepare('UPDATE email_verification_codes SET code_enc = ?, code_hash = ? WHERE id = ?');
    for (const row of emailCodes) {
      updateEmailCode.run(encrypt(row.code, newSecret), emailCodeHash(row.email, row.code, newSecret), row.id);
    }

    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }

  return {
    cards: cards.length,
    merchants: merchants.length,
    smtpPassword: smtpPassword !== null,
    emailCodes: emailCodes.length
  };
}

function main() {
  const databasePath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'epay.db');
  if (!fs.existsSync(databasePath)) throw new Error(`Database not found: ${databasePath}`);
  const db = new DatabaseSync(databasePath);
  try {
    db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    const result = rotateSecrets(db, process.env.OLD_APP_SECRET, process.env.NEW_APP_SECRET);
    console.log(JSON.stringify({ ok: true, databasePath, rotated: result }, null, 2));
  } finally {
    db.close();
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`APP_SECRET rotation failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { rotateSecrets };