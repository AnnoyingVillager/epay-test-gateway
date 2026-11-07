const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { encrypt, decrypt, hashPassword, cardNumberHash } = require('./crypto');

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

const DEFAULT_SETTINGS = {
  site_name: 'Epay Test Gateway',
  order_timeout_seconds: '900',
  require_card_binding: '1',
  require_3ds: '1',
  auto_success_payments: '0',
  default_currency: 'CNY',
  notify_retry_count: '3',
  supported_types: 'alipay,wxpay,qqpay',
  registration_enabled: '0',
  registration_require_invite: '0',
  user_invites_enabled: '1',
  registration_require_email: '0',
  email_list_mode: 'blacklist',
  email_whitelist: '',
  email_blacklist: '',
  username_regex: '^[A-Za-z][A-Za-z0-9]{3,19}$',
  password_regex: '^(?=.*[A-Za-z])(?=.*\\d).{8,24}$',
  email_regex: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$',
  email_code_ttl_seconds: '600',
  email_code_resend_seconds: '60',
  smtp_host: '',
  smtp_port: '587',
  smtp_secure: '0',
  smtp_user: '',
  smtp_password_enc: '',
  mail_from: '',
  invite_default_limit: '10',
  invite_random_length: '8',
  invite_custom_fee_minor: '10000',
  invite_slot_purchase_enabled: '0',
  invite_slot_price_minor: '1000',
  card_withdraw_enabled: '1',
  card_deposit_fee_bps: '0',
  card_min_deposit_minor: '0',
  card_min_deposit_fee_minor: '0',
  card_withdraw_fee_bps: '0',
  card_min_withdraw_minor: '0',
  card_min_withdraw_fee_minor: '0',
  merchant_guarantee_seconds: '300'
};

const GROUP_DEFAULTS = [
  { name: 'Default', cardLimit: 5, cardBonusMinor: 70000, spendLimitMinor: null },
  { name: 'VIP', cardLimit: 10, cardBonusMinor: 700000, spendLimitMinor: null },
  { name: 'SVIP', cardLimit: 50, cardBonusMinor: 7000000, spendLimitMinor: null }
];

function tableColumns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
}

function ensureColumn(db, table, name, definition) {
  if (tableColumns(db, table).has(name)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  return true;
}

function inviteCode(length = 8) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let index = 0; index < length; index += 1) result += alphabet[crypto.randomInt(alphabet.length)];
  return result;
}

function uniqueInviteCode(db, length = 8) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = inviteCode(length);
    if (!db.prepare('SELECT id FROM users WHERE invite_code = ?').get(candidate)
      && !db.prepare('SELECT id FROM deleted_users WHERE former_invite_code = ?').get(candidate)
      && !db.prepare('SELECT code FROM retired_invite_codes WHERE code = ?').get(candidate)) return candidate;
  }
  throw new Error('Unable to generate a unique invite code');
}

function nextUid(db) {
  const maxActive = Number(db.prepare('SELECT COALESCE(MAX(uid), 0) AS value FROM users').get().value || 0);
  const maxDeleted = Number(db.prepare('SELECT COALESCE(MAX(uid), 0) AS value FROM deleted_users').get().value || 0);
  let value = Math.max(1, maxActive + 1, maxDeleted + 1);
  while (db.prepare('SELECT id FROM users WHERE uid = ?').get(value)
    || db.prepare('SELECT id FROM deleted_users WHERE uid = ?').get(value)) value += 1;
  return value;
}

function isUsernameReserved(db, username) {
  return Boolean(db.prepare('SELECT id FROM deleted_users WHERE username = ? COLLATE NOCASE').get(String(username)));
}

function migrate(db, config) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      card_limit INTEGER NOT NULL DEFAULT 5 CHECK(card_limit >= 0),
      card_bonus_minor INTEGER NOT NULL DEFAULT 0 CHECK(card_bonus_minor >= 0),
      spend_limit_minor INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uid INTEGER UNIQUE,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('admin', 'user')),
      email TEXT,
      group_id INTEGER REFERENCES user_groups(id),
      account_balance_minor INTEGER NOT NULL DEFAULT 0 CHECK(account_balance_minor >= 0),
      invite_code TEXT UNIQUE,
      invited_by_uid INTEGER,
      invite_limit INTEGER NOT NULL DEFAULT 10 CHECK(invite_limit >= 0),
      invited_count INTEGER NOT NULL DEFAULT 0 CHECK(invited_count >= 0),
      can_invite INTEGER NOT NULL DEFAULT 1,
      invite_permission_mode TEXT NOT NULL DEFAULT 'inherit' CHECK(invite_permission_mode IN ('inherit', 'custom')),
      is_active INTEGER NOT NULL DEFAULT 1,
      disabled_reason TEXT,
      account_risk TEXT NOT NULL DEFAULT 'normal' CHECK(account_risk IN ('normal', 'watch', 'blocked')),
      card_risk TEXT NOT NULL DEFAULT 'normal' CHECK(card_risk IN ('normal', 'frozen')),
      card_balance_limit_minor INTEGER,
      spend_limit_minor INTEGER,
      super_risk_at INTEGER,
      deleted_at INTEGER,
      deleted_by_uid INTEGER,
      deletion_reason TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      prefix TEXT NOT NULL UNIQUE,
      brand TEXT NOT NULL DEFAULT 'Visa',
      card_type TEXT NOT NULL DEFAULT 'debit' CHECK(card_type IN ('debit', 'credit')),
      country TEXT NOT NULL DEFAULT 'CN',
      number_length INTEGER NOT NULL DEFAULT 16 CHECK(number_length BETWEEN 12 AND 19),
      require_3ds INTEGER NOT NULL DEFAULT 1,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bin_groups (
      bin_id INTEGER NOT NULL REFERENCES bins(id) ON DELETE CASCADE,
      group_id INTEGER NOT NULL REFERENCES user_groups(id) ON DELETE CASCADE,
      PRIMARY KEY (bin_id, group_id)
    );

    CREATE TABLE IF NOT EXISTS cards (
      id TEXT PRIMARY KEY,
      owner_user_id INTEGER REFERENCES users(id),
      bin_id INTEGER NOT NULL REFERENCES bins(id),
      card_number_enc TEXT NOT NULL,
      card_number_hash TEXT,
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
      balance_minor INTEGER NOT NULL DEFAULT 0,
      commission_bps INTEGER NOT NULL DEFAULT 0 CHECK(commission_bps BETWEEN 0 AND 10000),
      is_default INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      deleted_at INTEGER,
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
      payment_method TEXT NOT NULL DEFAULT 'card',
      payer_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      card_type_snapshot TEXT,
      settlement_mode TEXT NOT NULL DEFAULT 'legacy',
      settlement_due_at INTEGER,
      settled_at INTEGER,
      commission_bps INTEGER NOT NULL DEFAULT 0,
      commission_minor INTEGER NOT NULL DEFAULT 0,
      merchant_net_minor INTEGER NOT NULL DEFAULT 0,
      refunded_minor INTEGER NOT NULL DEFAULT 0,
      refunded_at INTEGER,
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
      type TEXT NOT NULL CHECK(type IN ('DEBIT', 'CREDIT', 'ADJUSTMENT', 'INITIAL', 'DEPOSIT', 'WITHDRAW')),
      amount_minor INTEGER NOT NULL,
      balance_after_minor INTEGER NOT NULL,
      note TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS account_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      user_uid INTEGER,
      order_id INTEGER REFERENCES orders(id),
      type TEXT NOT NULL,
      amount_minor INTEGER NOT NULL,
      balance_after_minor INTEGER NOT NULL,
      note TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS merchant_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      merchant_id INTEGER NOT NULL REFERENCES merchants(id),
      order_id INTEGER REFERENCES orders(id),
      type TEXT NOT NULL,
      amount_minor INTEGER NOT NULL,
      balance_after_minor INTEGER NOT NULL,
      reference TEXT,
      note TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS refunds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      refund_no TEXT NOT NULL UNIQUE,
      order_id INTEGER NOT NULL REFERENCES orders(id),
      merchant_id INTEGER NOT NULL REFERENCES merchants(id),
      out_refund_no TEXT,
      amount_minor INTEGER NOT NULL CHECK(amount_minor > 0),
      channel TEXT NOT NULL,
      reason TEXT,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS retired_invite_codes (
      code TEXT PRIMARY KEY,
      user_id INTEGER,
      user_uid INTEGER,
      retired_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS email_verification_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL,
      code_enc TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      consumed_at INTEGER,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS deleted_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      uid INTEGER NOT NULL,
      username TEXT NOT NULL,
      email TEXT,
      group_name TEXT,
      former_invite_code TEXT,
      invited_by_uid INTEGER,
      inviter_username TEXT,
      invitee_uids TEXT,
      invitee_usernames TEXT,
      disabled_reason TEXT,
      deleted_by_uid INTEGER,
      deleted_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS risk_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      user_uid INTEGER,
      actor_uid INTEGER,
      event TEXT NOT NULL,
      details TEXT,
      created_at INTEGER NOT NULL
    );
  `);

  const addedUid = ensureColumn(db, 'users', 'uid', 'INTEGER');
  ensureColumn(db, 'users', 'email', 'TEXT');
  ensureColumn(db, 'users', 'group_id', 'INTEGER REFERENCES user_groups(id)');
  ensureColumn(db, 'users', 'account_balance_minor', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'users', 'invite_code', 'TEXT');
  ensureColumn(db, 'users', 'invited_by_uid', 'INTEGER');
  ensureColumn(db, 'users', 'invite_limit', 'INTEGER NOT NULL DEFAULT 10');
  ensureColumn(db, 'users', 'invited_count', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'users', 'can_invite', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn(db, 'users', 'invite_permission_mode', "TEXT NOT NULL DEFAULT 'inherit' CHECK(invite_permission_mode IN ('inherit', 'custom'))");
  ensureColumn(db, 'users', 'disabled_reason', 'TEXT');
  ensureColumn(db, 'users', 'account_risk', "TEXT NOT NULL DEFAULT 'normal'");
  ensureColumn(db, 'users', 'card_risk', "TEXT NOT NULL DEFAULT 'normal'");
  ensureColumn(db, 'users', 'card_balance_limit_minor', 'INTEGER');
  ensureColumn(db, 'users', 'spend_limit_minor', 'INTEGER');
  ensureColumn(db, 'users', 'super_risk_at', 'INTEGER');
  ensureColumn(db, 'users', 'deleted_at', 'INTEGER');
  ensureColumn(db, 'users', 'deleted_by_uid', 'INTEGER');
  ensureColumn(db, 'users', 'deletion_reason', 'TEXT');

  const addedBin3ds = ensureColumn(db, 'bins', 'require_3ds', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn(db, 'merchants', 'balance_minor', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'merchants', 'commission_bps', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'merchants', 'is_default', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'merchants', 'deleted_at', 'INTEGER');

  ensureColumn(db, 'orders', 'payment_method', "TEXT NOT NULL DEFAULT 'card'");
  ensureColumn(db, 'orders', 'card_type_snapshot', 'TEXT');
  ensureColumn(db, 'orders', 'payer_user_id', 'INTEGER REFERENCES users(id) ON DELETE SET NULL');
  ensureColumn(db, 'orders', 'settlement_mode', "TEXT NOT NULL DEFAULT 'legacy'");
  ensureColumn(db, 'orders', 'settlement_due_at', 'INTEGER');
  ensureColumn(db, 'orders', 'settled_at', 'INTEGER');
  ensureColumn(db, 'orders', 'commission_bps', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'orders', 'commission_minor', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'orders', 'merchant_net_minor', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'orders', 'refunded_minor', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'orders', 'refunded_at', 'INTEGER');
  ensureColumn(db, 'refunds', 'out_refund_no', 'TEXT');
  ensureColumn(db, 'merchant_transactions', 'reference', 'TEXT');

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_uid ON users(uid);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_nocase ON users(email COLLATE NOCASE) WHERE email IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_invite_code ON users(invite_code) WHERE invite_code IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_users_group ON users(group_id);
    CREATE INDEX IF NOT EXISTS idx_users_inviter ON users(invited_by_uid);
    CREATE INDEX IF NOT EXISTS idx_orders_status_expiry ON orders(status, expires_at);
    CREATE INDEX IF NOT EXISTS idx_orders_card ON orders(card_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_orders_merchant ON orders(merchant_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_orders_payer ON orders(payer_user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_orders_settlement ON orders(settlement_mode, settled_at, settlement_due_at);
    CREATE INDEX IF NOT EXISTS idx_cards_status ON cards(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_cards_owner ON cards(owner_user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_callback_logs_order ON callback_logs(order_id, attempted_at DESC);
    CREATE INDEX IF NOT EXISTS idx_card_transactions_card ON card_transactions(card_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_account_transactions_user ON account_transactions(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_merchant_transactions_merchant ON merchant_transactions(merchant_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_refunds_order ON refunds(order_id, created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_refunds_merchant_out_no ON refunds(merchant_id, out_refund_no) WHERE out_refund_no IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_merchant_tx_reference ON merchant_transactions(reference) WHERE reference IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_email_codes_email ON email_verification_codes(email, created_at DESC);
  `);

  if (addedBin3ds) {
    const legacy3ds = db.prepare("SELECT value FROM settings WHERE key = 'require_3ds'").get()?.value;
    if (legacy3ds !== undefined) db.prepare('UPDATE bins SET require_3ds = ?').run(legacy3ds === '1' ? 1 : 0);
  }

  const cardColumns = tableColumns(db, 'cards');
  if (!cardColumns.has('owner_user_id')) db.exec('ALTER TABLE cards ADD COLUMN owner_user_id INTEGER REFERENCES users(id)');
  if (!cardColumns.has('card_number_hash')) db.exec('ALTER TABLE cards ADD COLUMN card_number_hash TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_cards_number_hash ON cards(card_number_hash)');

  const missingHashes = db.prepare("SELECT id, card_number_enc FROM cards WHERE card_number_hash IS NULL OR card_number_hash = ''").all();
  if (missingHashes.length) {
    const update = db.prepare('UPDATE cards SET card_number_hash = ? WHERE id = ?');
    db.transaction(() => {
      for (const card of missingHashes) update.run(cardNumberHash(decrypt(card.card_number_enc, config.appSecret), config.appSecret), card.id);
    })();
  }

  return { addedUid };
}

function seed(db, config) {
  const now = Date.now();
  const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  const defaults = {
    ...DEFAULT_SETTINGS,
    order_timeout_seconds: String(config.defaultTimeoutSeconds),
    notify_retry_count: String(config.notifyRetryCount)
  };
  db.transaction(() => {
    for (const [key, value] of Object.entries(defaults)) insertSetting.run(key, value);

    const insertGroup = db.prepare(`
      INSERT OR IGNORE INTO user_groups (name, card_limit, card_bonus_minor, spend_limit_minor, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const group of GROUP_DEFAULTS) insertGroup.run(group.name, group.cardLimit, group.cardBonusMinor, group.spendLimitMinor, now, now);

    const merchantCount = db.prepare('SELECT COUNT(*) AS count FROM merchants').get().count;
    if (merchantCount === 0) {
      db.prepare(`
        INSERT INTO merchants (pid, name, key_enc, balance_minor, commission_bps, is_default, is_active, created_at, updated_at)
        VALUES (?, ?, ?, 0, 0, 1, 1, ?, ?)
      `).run(config.defaultMerchantPid, config.defaultMerchantName, encrypt(config.defaultMerchantKey, config.appSecret), now, now);
    } else {
      db.prepare('UPDATE merchants SET is_default = 0').run();
      const configuredMerchant = db.prepare('SELECT id FROM merchants WHERE pid = ?').get(config.defaultMerchantPid);
      if (configuredMerchant) db.prepare('UPDATE merchants SET is_default = 1 WHERE id = ?').run(configuredMerchant.id);
      else db.prepare('UPDATE merchants SET is_default = 1 WHERE id = (SELECT MIN(id) FROM merchants)').run();
    }

    const defaultGroup = db.prepare("SELECT id FROM user_groups WHERE name = 'Default'").get();
    const activeAdmin = db.prepare("SELECT id FROM users WHERE role = 'admin' AND is_active = 1 LIMIT 1").get();
    if (!activeAdmin) {
      const configuredUser = db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(config.adminUsername);
      if (configuredUser) {
        db.prepare("UPDATE users SET password_hash = ?, role = 'admin', is_active = 1, group_id = COALESCE(group_id, ?), updated_at = ? WHERE id = ?")
          .run(hashPassword(config.adminPassword), defaultGroup.id, now, configuredUser.id);
      } else {
        const uidTaken = db.prepare('SELECT id FROM users WHERE uid = 0').get();
        db.prepare(`
          INSERT INTO users (uid, username, password_hash, role, group_id, invite_limit, can_invite, is_active, created_at, updated_at)
          VALUES (?, ?, ?, 'admin', ?, 2147483647, 1, 1, ?, ?)
        `).run(uidTaken ? null : 0, config.adminUsername, hashPassword(config.adminPassword), defaultGroup.id, now, now);
      }
    }

    const configuredAdmin = db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(config.adminUsername)
      || db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get();
    if (configuredAdmin && !db.prepare('SELECT id FROM users WHERE uid = 0 AND id <> ?').get(configuredAdmin.id)) {
      db.prepare('UPDATE users SET uid = NULL WHERE uid = 0 AND id <> ?').run(configuredAdmin.id);
      db.prepare('UPDATE users SET uid = 0 WHERE id = ?').run(configuredAdmin.id);
    }

    const inviteLength = Math.min(20, Math.max(6, Number.parseInt(db.prepare("SELECT value FROM settings WHERE key = 'invite_random_length'").get().value, 10) || 8));
    const inviteLimit = Math.max(0, Number.parseInt(db.prepare("SELECT value FROM settings WHERE key = 'invite_default_limit'").get().value, 10) || 0);
    const usersNeedingIdentity = db.prepare('SELECT id, role, group_id, uid, invite_code, invite_limit FROM users').all();
    for (const user of usersNeedingIdentity) {
      if (!user.group_id) db.prepare('UPDATE users SET group_id = ? WHERE id = ?').run(defaultGroup.id, user.id);
      if (user.uid === null || user.uid === undefined) db.prepare('UPDATE users SET uid = ? WHERE id = ?').run(nextUid(db), user.id);
      if (!user.invite_code) db.prepare('UPDATE users SET invite_code = ? WHERE id = ?').run(uniqueInviteCode(db, inviteLength), user.id);
      if (user.role === 'admin') db.prepare('UPDATE users SET invite_limit = 2147483647 WHERE id = ?').run(user.id);
      else if (user.invite_limit === null || user.invite_limit === undefined) db.prepare('UPDATE users SET invite_limit = ? WHERE id = ?').run(inviteLimit, user.id);
    }

    db.prepare(`
      UPDATE users SET invited_count = (
        SELECT COUNT(*) FROM users invitee WHERE invitee.invited_by_uid = users.uid
      )
    `).run();

    const binsNeedingGroups = db.prepare(`
      SELECT b.id FROM bins b
      WHERE NOT EXISTS (SELECT 1 FROM bin_groups bg WHERE bg.bin_id = b.id)
    `).all();
    const groups = db.prepare('SELECT id FROM user_groups').all();
    const insertBinGroup = db.prepare('INSERT OR IGNORE INTO bin_groups (bin_id, group_id) VALUES (?, ?)');
    for (const bin of binsNeedingGroups) {
      for (const group of groups) insertBinGroup.run(bin.id, group.id);
    }
  })();
}

function openDatabase(config) {
  if (config.databasePath !== ':memory:') fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });
  const db = new Database(config.databasePath);
  if (config.databasePath !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db, config);
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
    uid: row.uid,
    username: row.username,
    role: row.role,
    email: row.email || null,
    groupId: row.group_id,
    groupName: row.group_name || null,
    accountBalanceMinor: row.account_balance_minor || 0,
    inviteCode: row.invite_code || null,
    invitedByUid: row.invited_by_uid ?? null,
    inviteLimit: row.invite_limit ?? 0,
    invitedCount: row.invited_count || 0,
    canInvite: Boolean(row.can_invite),
    invitePermissionMode: row.invite_permission_mode || 'inherit',
    isActive: Boolean(row.is_active),
    disabledReason: row.disabled_reason || null,
    accountRisk: row.account_risk || 'normal',
    cardRisk: row.card_risk || 'normal',
    cardBalanceLimitMinor: row.card_balance_limit_minor ?? null,
    spendLimitMinor: row.spend_limit_minor ?? null,
    superRiskAt: row.super_risk_at || null,
    deletedAt: row.deleted_at || null,
    deletedByUid: row.deleted_by_uid ?? null,
    deletionReason: row.deletion_reason || null,
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
    balanceMinor: row.balance_minor || 0,
    commissionBps: row.commission_bps || 0,
    isDefault: Boolean(row.is_default),
    isActive: Boolean(row.is_active),
    deletedAt: row.deleted_at || null,
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
    ownerUid: row.owner_uid,
    ownerUsername: row.owner_username,
    binId: row.bin_id,
    binName: row.bin_name,
    binPrefix: row.bin_prefix,
    binRequire3ds: Boolean(row.bin_require_3ds ?? row.require_3ds),
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
    cardTypeSnapshot: row.card_type_snapshot || null,
    paymentMethod: row.payment_method || 'card',
    payerUserId: row.payer_user_id || null,
    payerUid: row.payer_uid || null,
    payerUsername: row.payer_username || null,
    settlementMode: row.settlement_mode || 'legacy',
    settlementDueAt: row.settlement_due_at || null,
    settledAt: row.settled_at || null,
    commissionBps: row.commission_bps || 0,
    commissionMinor: row.commission_minor || 0,
    merchantNetMinor: row.merchant_net_minor || 0,
    refundedMinor: row.refunded_minor || 0,
    refundedAt: row.refunded_at || null,
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
  return mapUser(db.prepare(`
    SELECT u.*, g.name AS group_name FROM users u
    LEFT JOIN user_groups g ON g.id = u.group_id
    WHERE u.username = ? COLLATE NOCASE
  `).get(String(username)));
}

function userById(db, id) {
  return mapUser(db.prepare(`
    SELECT u.*, g.name AS group_name FROM users u
    LEFT JOIN user_groups g ON g.id = u.group_id
    WHERE u.id = ?
  `).get(Number(id)));
}

function userByUid(db, uid) {
  return mapUser(db.prepare(`
    SELECT u.*, g.name AS group_name FROM users u
    LEFT JOIN user_groups g ON g.id = u.group_id
    WHERE u.uid = ?
  `).get(Number(uid)));
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
    SELECT c.*, b.name AS bin_name, b.prefix AS bin_prefix, b.brand, b.card_type, b.require_3ds AS bin_require_3ds,
      u.username AS owner_username, u.uid AS owner_uid
    FROM cards c
    JOIN bins b ON b.id = c.bin_id
    LEFT JOIN users u ON u.id = c.owner_user_id
    WHERE c.id = ?
  `).get(String(id));
  return mapCard(row, secret, includeSecrets);
}

function cardByNumberHash(db, secret, cardNumber) {
  const row = db.prepare(`
    SELECT c.*, b.name AS bin_name, b.prefix AS bin_prefix, b.brand, b.card_type, b.require_3ds AS bin_require_3ds,
      u.username AS owner_username, u.uid AS owner_uid
    FROM cards c
    JOIN bins b ON b.id = c.bin_id
    LEFT JOIN users u ON u.id = c.owner_user_id
    WHERE c.card_number_hash = ?
  `).get(cardNumberHash(cardNumber, secret));
  return mapCard(row, secret, true);
}

function orderByTradeNo(db, tradeNo) {
  const row = db.prepare(`
    SELECT o.*, m.pid AS merchant_pid, m.name AS merchant_name, c.last4 AS card_last4,
      u.uid AS payer_uid, u.username AS payer_username
    FROM orders o
    JOIN merchants m ON m.id = o.merchant_id
    LEFT JOIN cards c ON c.id = o.card_id
    LEFT JOIN users u ON u.id = o.payer_user_id
    WHERE o.trade_no = ?
  `).get(String(tradeNo));
  return mapOrder(row);
}

module.exports = {
  DEFAULT_SETTINGS,
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
  userByUid,
  merchantByPid,
  merchantById,
  cardById,
  cardByNumberHash,
  orderByTradeNo,
  inviteCode,
  uniqueInviteCode,
  nextUid,
  isUsernameReserved
};
