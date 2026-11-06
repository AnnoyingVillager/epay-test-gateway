const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

class Database {
  constructor(filename) {
    this.raw = new DatabaseSync(filename);
  }
  exec(sql) {
    return this.raw.exec(sql);
  }
  prepare(sql) {
    return this.raw.prepare(sql);
  }
  close() {
    return this.raw.close();
  }
  transaction(callback) {
    return (...args) => {
      this.exec('BEGIN IMMEDIATE');
      try {
        const result = callback(...args);
        this.exec('COMMIT');
        return result;
      } catch (error) {
        try { this.exec('ROLLBACK'); } catch {}
        throw error;
      }
    };
  }
}
const { encrypt, decrypt, hashPassword } = require('./crypto');

const DEFAULT_SETTINGS = {
  site_name: 'Epay Test Gateway',
  order_timeout_seconds: '900',
  require_card_binding: '1',
  default_currency: 'CNY',
  notify_retry_count: '3',
  supported_types: 'alipay,wxpay,qqpay'
};

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('admin', 'user')),
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      prefix TEXT NOT NULL UNIQUE,
      brand TEXT NOT NULL DEFAULT 'Visa',
      card_type TEXT NOT NULL DEFAULT 'debit',
      country TEXT NOT NULL DEFAULT 'CN',
      number_length INTEGER NOT NULL DEFAULT 16 CHECK(number_length BETWEEN 12 AND 19),
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cards (
      id TEXT PRIMARY KEY,
      owner_user_id INTEGER REFERENCES users(id),
      bin_id INTEGER NOT NULL REFERENCES bins(id),
      card_number_enc TEXT NOT NULL,
      last4 TEXT NOT NULL,
      expires_month INTEGER NOT NULL CHECK(expires_month BETWEEN 1 AND 12),
      expires_year INTEGER NOT NULL,
      cvv_enc TEXT NOT NULL,
      pin_enc TEXT NOT NULL,
      balance_minor INTEGER NOT NULL DEFAULT 0 CHECK(balance_minor >= 0),
      currency TEXT NOT NULL DEFAULT 'CNY',
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'declined', 'frozen')),
      decline_reason TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_used_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS merchants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pid TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      key_enc TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trade_no TEXT NOT NULL UNIQUE,
      out_trade_no TEXT NOT NULL,
      merchant_id INTEGER NOT NULL REFERENCES merchants(id),
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      money_minor INTEGER NOT NULL CHECK(money_minor > 0),
      currency TEXT NOT NULL DEFAULT 'CNY',
      status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING', 'PAID', 'EXPIRED', 'FAILED', 'CHARGEBACK')),
      card_id TEXT REFERENCES cards(id),
      notify_url TEXT NOT NULL,
      return_url TEXT NOT NULL,
      sitename TEXT,
      param TEXT,
      client_ip TEXT,
      created_via TEXT NOT NULL DEFAULT 'submit',
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      paid_at INTEGER,
      closed_at INTEGER,
      notify_state TEXT NOT NULL DEFAULT 'NONE',
      notify_attempts INTEGER NOT NULL DEFAULT 0,
      notify_last_error TEXT,
      notified_at INTEGER,
      callback_event TEXT,
      UNIQUE(merchant_id, out_trade_no)
    );

    CREATE TABLE IF NOT EXISTS callback_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      event TEXT NOT NULL,
      url TEXT NOT NULL,
      success INTEGER NOT NULL DEFAULT 0,
      status_code INTEGER,
      response_body TEXT,
      error TEXT,
      attempted_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS card_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      card_id TEXT NOT NULL REFERENCES cards(id),
      order_id INTEGER REFERENCES orders(id),
      type TEXT NOT NULL CHECK(type IN ('DEBIT', 'CREDIT', 'ADJUSTMENT', 'INITIAL')),
      amount_minor INTEGER NOT NULL,
      balance_after_minor INTEGER NOT NULL,
      note TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_orders_status_expiry ON orders(status, expires_at);
    CREATE INDEX IF NOT EXISTS idx_orders_card ON orders(card_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_orders_merchant ON orders(merchant_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_cards_status ON cards(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_callback_logs_order ON callback_logs(order_id, attempted_at DESC);
    CREATE INDEX IF NOT EXISTS idx_card_transactions_card ON card_transactions(card_id, created_at DESC);
  `);

  const cardColumns = db.prepare('PRAGMA table_info(cards)').all();
  if (!cardColumns.some((column) => column.name === 'owner_user_id')) {
    db.exec('ALTER TABLE cards ADD COLUMN owner_user_id INTEGER REFERENCES users(id)');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_cards_owner ON cards(owner_user_id, created_at DESC)');
}

function seed(db, config) {
  const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  const defaults = {
    ...DEFAULT_SETTINGS,
    order_timeout_seconds: String(config.defaultTimeoutSeconds),
    notify_retry_count: String(config.notifyRetryCount)
  };
  const transaction = db.transaction(() => {
    for (const [key, value] of Object.entries(defaults)) insertSetting.run(key, value);

    const merchantCount = db.prepare('SELECT COUNT(*) AS count FROM merchants').get().count;
    if (merchantCount === 0) {
      const now = Date.now();
      db.prepare(`
        INSERT INTO merchants (pid, name, key_enc, is_active, created_at, updated_at)
        VALUES (?, ?, ?, 1, ?, ?)
      `).run(config.defaultMerchantPid, config.defaultMerchantName, encrypt(config.defaultMerchantKey, config.appSecret), now, now);
    }

    const activeAdmin = db.prepare("SELECT id FROM users WHERE role = 'admin' AND is_active = 1 LIMIT 1").get();
    if (!activeAdmin) {
      const now = Date.now();
      const configuredUser = db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(config.adminUsername);
      if (configuredUser) {
        db.prepare("UPDATE users SET password_hash = ?, role = 'admin', is_active = 1, updated_at = ? WHERE id = ?")
          .run(hashPassword(config.adminPassword), now, configuredUser.id);
      } else {
        db.prepare(`
          INSERT INTO users (username, password_hash, role, is_active, created_at, updated_at)
          VALUES (?, ?, 'admin', 1, ?, ?)
        `).run(config.adminUsername, hashPassword(config.adminPassword), now, now);
      }
    }
  });
  transaction();
}

function openDatabase(config) {
  if (config.databasePath !== ':memory:') {
    fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });
  }
  const db = new Database(config.databasePath);
  if (config.databasePath !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  seed(db, config);
  return db;
}

function getSetting(db, key, fallback = '') {
  return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? fallback;
}

function getAllSettings(db) {
  return Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map((row) => [row.key, row.value]));
}

function setSetting(db, key, value) {
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, String(value));
}

function mapUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    isActive: Boolean(row.is_active),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapMerchant(row, secret, includeKey = true) {
  if (!row) return null;
  return {
    id: row.id,
    pid: row.pid,
    name: row.name,
    isActive: Boolean(row.is_active),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    key: includeKey ? decrypt(row.key_enc, secret) : null
  };
}

function mapCard(row, secret, includeSecrets = false) {
  if (!row) return null;
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    ownerUsername: row.owner_username,
    binId: row.bin_id,
    binName: row.bin_name,
    binPrefix: row.bin_prefix,
    brand: row.brand,
    cardType: row.card_type,
    cardNumber: includeSecrets ? decrypt(row.card_number_enc, secret) : null,
    last4: row.last4,
    expiresMonth: row.expires_month,
    expiresYear: row.expires_year,
    cvv: includeSecrets ? decrypt(row.cvv_enc, secret) : null,
    pin: includeSecrets ? decrypt(row.pin_enc, secret) : null,
    balanceMinor: row.balance_minor,
    currency: row.currency,
    status: row.status,
    declineReason: row.decline_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at
  };
}

function mapOrder(row) {
  if (!row) return null;
  return {
    id: row.id,
    tradeNo: row.trade_no,
    outTradeNo: row.out_trade_no,
    merchantId: row.merchant_id,
    merchantPid: row.merchant_pid,
    merchantName: row.merchant_name,
    type: row.type,
    name: row.name,
    moneyMinor: row.money_minor,
    currency: row.currency,
    status: row.status,
    cardId: row.card_id,
    cardLast4: row.card_last4,
    notifyUrl: row.notify_url,
    returnUrl: row.return_url,
    sitename: row.sitename,
    param: row.param,
    clientIp: row.client_ip,
    createdVia: row.created_via,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    paidAt: row.paid_at,
    closedAt: row.closed_at,
    notifyState: row.notify_state,
    notifyAttempts: row.notify_attempts,
    notifyLastError: row.notify_last_error,
    notifiedAt: row.notified_at,
    callbackEvent: row.callback_event
  };
}

function userByUsername(db, username) {
  return mapUser(db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(String(username)));
}

function userById(db, id) {
  return mapUser(db.prepare('SELECT * FROM users WHERE id = ?').get(Number(id)));
}

function merchantByPid(db, secret, pid) {
  const row = db.prepare('SELECT * FROM merchants WHERE pid = ?').get(String(pid));
  return mapMerchant(row, secret);
}

function merchantById(db, secret, id) {
  const row = db.prepare('SELECT * FROM merchants WHERE id = ?').get(Number(id));
  return mapMerchant(row, secret);
}

function cardById(db, secret, id, includeSecrets = true) {
  const row = db.prepare(`
    SELECT c.*, b.name AS bin_name, b.prefix AS bin_prefix, b.brand, b.card_type, u.username AS owner_username
    FROM cards c
    JOIN bins b ON b.id = c.bin_id
    LEFT JOIN users u ON u.id = c.owner_user_id
    WHERE c.id = ?
  `).get(String(id));
  return mapCard(row, secret, includeSecrets);
}

function orderByTradeNo(db, tradeNo) {
  const row = db.prepare(`
    SELECT o.*, m.pid AS merchant_pid, m.name AS merchant_name, c.last4 AS card_last4
    FROM orders o
    JOIN merchants m ON m.id = o.merchant_id
    LEFT JOIN cards c ON c.id = o.card_id
    WHERE o.trade_no = ?
  `).get(String(tradeNo));
  return mapOrder(row);
}

module.exports = {
  openDatabase,
  getSetting,
  getAllSettings,
  setSetting,
  mapUser,
  mapMerchant,
  mapCard,
  mapOrder,
  userByUsername,
  userById,
  merchantByPid,
  merchantById,
  cardById,
  orderByTradeNo
};
