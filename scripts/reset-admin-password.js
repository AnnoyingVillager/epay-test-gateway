#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { hashPassword } = require('../src/crypto');

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function tableColumns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
}

function generatePassword(length = 16) {
  const uppercase = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lowercase = 'abcdefghijkmnopqrstuvwxyz';
  const digits = '23456789';
  const all = `${uppercase}${lowercase}${digits}`;
  const chars = [
    uppercase[crypto.randomInt(uppercase.length)],
    lowercase[crypto.randomInt(lowercase.length)],
    digits[crypto.randomInt(digits.length)]
  ];
  while (chars.length < length) chars.push(all[crypto.randomInt(all.length)]);
  for (let index = chars.length - 1; index > 0; index -= 1) {
    const swapIndex = crypto.randomInt(index + 1);
    [chars[index], chars[swapIndex]] = [chars[swapIndex], chars[index]];
  }
  return chars.join('');
}

function validatePassword(password) {
  const value = String(password || '');
  if (value.length < 8 || value.length > 128 || !/[A-Za-z]/.test(value) || !/\d/.test(value)) {
    throw new Error('管理员密码必须为 8-128 位，并同时包含字母和数字。');
  }
  return value;
}

function findAdmin(db, { uid = 0, username = null } = {}) {
  if (username) {
    return db.prepare(`
      SELECT id, uid, username, is_active, account_risk
      FROM users
      WHERE username = ? COLLATE NOCASE AND role = 'admin' AND deleted_at IS NULL
    `).get(String(username));
  }
  return db.prepare(`
    SELECT id, uid, username, is_active, account_risk
    FROM users
    WHERE uid = ? AND role = 'admin' AND deleted_at IS NULL
  `).get(Number(uid));
}

function resetAdminPassword(db, { uid = 0, username = null, password = null, now = Date.now() } = {}) {
  if (!tableExists(db, 'users')) throw new Error('数据库中不存在 users 表。');
  const admin = findAdmin(db, { uid, username });
  if (!admin) throw new Error(username ? `未找到管理员账号：${username}` : `未找到 UID ${uid} 的管理员账号。`);

  const generated = !password;
  const newPassword = validatePassword(password || generatePassword(16));
  const columns = tableColumns(db, 'users');
  const currentVersion = columns.has('password_changed_at')
    ? db.prepare('SELECT password_changed_at FROM users WHERE id = ?').get(admin.id)?.password_changed_at
    : 0;
  const passwordVersion = Math.max(Number(now), Date.now(), Number(currentVersion || 0) + 1);
  const fields = ['password_hash = ?', 'updated_at = ?'];
  const values = [hashPassword(newPassword), passwordVersion];
  if (columns.has('password_changed_at')) {
    fields.splice(1, 0, 'password_changed_at = ?');
    values.splice(1, 0, passwordVersion);
  }
  values.push(admin.id);

  db.exec('BEGIN IMMEDIATE');
  try {
    const result = db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    if (Number(result.changes) !== 1) throw new Error(`管理员密码更新失败，预期更新 1 行，实际 ${result.changes} 行。`);
    if (tableExists(db, 'risk_events')) {
      db.prepare(`
        INSERT INTO risk_events (user_id, user_uid, actor_uid, event, details, created_at)
        VALUES (?, ?, NULL, 'CLI_PASSWORD_RESET', ?, ?)
      `).run(admin.id, admin.uid, '通过服务端维护命令重置管理员密码', passwordVersion);
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }

  return {
    uid: admin.uid,
    username: admin.username,
    isActive: Boolean(admin.is_active),
    accountRisk: admin.account_risk,
    generated,
    password: generated ? newPassword : null,
    sessionsInvalidated: columns.has('password_changed_at')
  };
}

function parseArgs(argv) {
  const options = {
    uid: Number.parseInt(process.env.ADMIN_RESET_UID || '0', 10),
    username: process.env.ADMIN_RESET_USERNAME || null,
    json: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--json') {
      options.json = true;
    } else if (argument === '--username') {
      options.username = argv[++index] || '';
      if (!options.username) throw new Error('--username 不能为空。');
    } else if (argument.startsWith('--username=')) {
      options.username = argument.slice('--username='.length);
      if (!options.username) throw new Error('--username 不能为空。');
    } else if (argument === '--uid') {
      options.uid = Number.parseInt(argv[++index], 10);
    } else if (argument.startsWith('--uid=')) {
      options.uid = Number.parseInt(argument.slice('--uid='.length), 10);
    } else {
      throw new Error(`未知参数：${argument}`);
    }
  }
  if (!options.username && (!Number.isSafeInteger(options.uid) || options.uid < 0)) {
    throw new Error('--uid 必须是非负整数。');
  }
  return options;
}

function main() {
  const databasePath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'epay.db');
  if (!fs.existsSync(databasePath)) throw new Error(`数据库不存在：${databasePath}`);
  const db = new DatabaseSync(databasePath);
  try {
    db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    const options = parseArgs(process.argv.slice(2));
    const result = resetAdminPassword(db, {
      uid: options.uid,
      username: options.username,
      password: process.env.ADMIN_RESET_PASSWORD || null
    });
    if (options.json) {
      console.log(JSON.stringify({ ok: true, databasePath, ...result }, null, 2));
      return;
    }
    console.log('管理员密码已重置。');
    console.log(`账号：${result.username}（UID ${result.uid}）`);
    if (result.generated) console.log(`新密码：${result.password}`);
    console.log(result.sessionsInvalidated ? '该管理员已有登录会话已失效。' : '当前数据库版本不支持主动撤销已有登录会话。');
    if (!result.isActive) console.log('注意：该管理员当前处于禁用状态，重置密码后仍需先启用账号。');
    if (result.accountRisk === 'blocked') console.log('注意：该管理员处于阻断风控状态，重置密码后仍无法登录。');
    console.log('请立即使用新密码登录，并在账户页面再次修改密码。');
  } finally {
    db.close();
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`管理员密码重置失败：${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { generatePassword, resetAdminPassword, parseArgs };
