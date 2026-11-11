const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { hashPassword, verifyPassword } = require('../src/crypto');
const { generatePassword, resetAdminPassword } = require('../scripts/reset-admin-password');

function createDatabase({ passwordVersion = true, databasePath = ':memory:' } = {}) {
  const db = new DatabaseSync(databasePath);
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uid INTEGER UNIQUE,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      ${passwordVersion ? 'password_changed_at INTEGER,' : ''}
      role TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      account_risk TEXT NOT NULL DEFAULT 'normal',
      deleted_at INTEGER,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE risk_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      user_uid INTEGER,
      actor_uid INTEGER,
      event TEXT NOT NULL,
      details TEXT,
      created_at INTEGER NOT NULL
    );
  `);
  db.prepare(`
    INSERT INTO users (uid, username, password_hash, role, updated_at)
    VALUES (0, 'admin', ?, 'admin', ?)
  `).run(hashPassword('OldAdmin123'), Date.now());
  db.prepare(`
    INSERT INTO users (uid, username, password_hash, role, updated_at)
    VALUES (7, 'SecondAdmin', ?, 'admin', ?)
  `).run(hashPassword('SecondOld123'), Date.now());
  return db;
}

test('generated recovery passwords contain uppercase, lowercase and digits', () => {
  const passwords = Array.from({ length: 20 }, () => generatePassword());
  for (const password of passwords) {
    assert.equal(password.length, 16);
    assert.match(password, /[A-Z]/);
    assert.match(password, /[a-z]/);
    assert.match(password, /\d/);
  }
  assert.ok(new Set(passwords).size > 1);
});

test('resetting UID 0 invalidates its password version and records an audit event', () => {
  const db = createDatabase();
  try {
    const result = resetAdminPassword(db, { now: Date.now() });
    assert.equal(result.uid, 0);
    assert.equal(result.username, 'admin');
    assert.equal(result.generated, true);
    assert.equal(result.sessionsInvalidated, true);
    assert.match(result.password, /^[A-Za-z0-9]{16}$/);

    const row = db.prepare('SELECT password_hash, password_changed_at FROM users WHERE uid = 0').get();
    assert.ok(row.password_changed_at > 0);
    assert.equal(verifyPassword(result.password, row.password_hash), true);
    assert.equal(verifyPassword('OldAdmin123', row.password_hash), false);
    const event = db.prepare("SELECT * FROM risk_events WHERE event = 'CLI_PASSWORD_RESET'").get();
    assert.equal(event.user_uid, 0);
  } finally {
    db.close();
  }
});

test('resetting by username and explicit password works without changing unrelated admins', () => {
  const db = createDatabase();
  try {
    const result = resetAdminPassword(db, { username: 'SecondAdmin', password: 'Recovered456' });
    assert.equal(result.uid, 7);
    assert.equal(result.generated, false);
    assert.equal(result.password, null);
    const second = db.prepare('SELECT password_hash FROM users WHERE uid = 7').get();
    const first = db.prepare('SELECT password_hash FROM users WHERE uid = 0').get();
    assert.equal(verifyPassword('Recovered456', second.password_hash), true);
    assert.equal(verifyPassword('OldAdmin123', first.password_hash), true);
    assert.throws(() => resetAdminPassword(db, { uid: 999 }), /未找到 UID 999/);
    assert.throws(() => resetAdminPassword(db, { uid: 0, password: 'weak' }), /8-128/);
  } finally {
    db.close();
  }
});

test('database migration fallback resets older schemas without a password version column', () => {
  const db = createDatabase({ passwordVersion: false });
  try {
    const result = resetAdminPassword(db, { password: 'LegacyFix123' });
    assert.equal(result.sessionsInvalidated, false);
    const row = db.prepare('SELECT password_hash FROM users WHERE uid = 0').get();
    assert.equal(verifyPassword('LegacyFix123', row.password_hash), true);
  } finally {
    db.close();
  }
});

test('the Docker-compatible CLI prints the generated password once and updates the database', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'epay-admin-reset-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, 'epay.db');
  createDatabase({ databasePath }).close();

  const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'reset-admin-password.js'), '--json'], {
    encoding: 'utf8',
    env: { ...process.env, DB_PATH: databasePath, ADMIN_RESET_PASSWORD: '' }
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.match(output.password, /^[A-Za-z0-9]{16}$/);
  const verifyDb = new DatabaseSync(databasePath);
  const row = verifyDb.prepare('SELECT password_hash FROM users WHERE uid = 0').get();
  verifyDb.close();
  assert.equal(verifyPassword(output.password, row.password_hash), true);
});
