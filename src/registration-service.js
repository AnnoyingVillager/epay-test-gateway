const crypto = require('node:crypto');
const { getSetting, userByUsername, nextUid, uniqueInviteCode, isUsernameReserved } = require('./db');
const { encrypt, hashPassword, timingSafeEqualText } = require('./crypto');

function settingInt(db, key, fallback = 0) {
  const value = Number.parseInt(getSetting(db, key, String(fallback)), 10);
  return Number.isFinite(value) ? value : fallback;
}

function compileRegex(pattern, label) {
  try { return new RegExp(String(pattern)); }
  catch { throw Object.assign(new Error(`${label}正则表达式配置无效，请联系管理员。`), { statusCode: 400 }); }
}

function splitEmailEntries(value) {
  return String(value || '').split(/[\s,;]+/).map((item) => item.trim().toLowerCase()).filter(Boolean);
}

function emailListMatches(email, entries) {
  const normalized = String(email || '').toLowerCase();
  const domain = normalized.split('@')[1] || '';
  return entries.some((entry) => {
    if (entry.startsWith('@')) return domain === entry.slice(1);
    if (entry.startsWith('*@')) return domain === entry.slice(2);
    return normalized === entry;
  });
}

function validateEmailField(db, email, requireEmail) {
  if (requireEmail && !email) return '当前注册要求填写邮箱地址。';
  if (!email) return null;
  const emailRegex = compileRegex(getSetting(db, 'email_regex', '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$'), '邮箱');
  if (email.length > 255 || !emailRegex.test(email)) return '邮箱格式无效或长度超过 255 个字符。';
  const mode = getSetting(db, 'email_list_mode', 'blacklist');
  const whitelist = splitEmailEntries(getSetting(db, 'email_whitelist', ''));
  const blacklist = splitEmailEntries(getSetting(db, 'email_blacklist', ''));
  if (mode === 'whitelist' && !emailListMatches(email, whitelist)) return '该邮箱不在注册白名单中。';
  if (mode === 'blacklist' && emailListMatches(email, blacklist)) return '该邮箱位于注册黑名单中。';
  if (db.prepare('SELECT id FROM users WHERE email = ? COLLATE NOCASE').get(email)) return '该邮箱已被其他账号使用。';
  return null;
}

function validateRegistrationFields(db, input) {
  const username = String(input.username || '').trim();
  const password = String(input.password || '');
  const email = String(input.email || '').trim().toLowerCase();
  const requireEmail = getSetting(db, 'registration_require_email', '0') === '1';
  const usernameRegex = compileRegex(getSetting(db, 'username_regex', '^[A-Za-z][A-Za-z0-9]{3,19}$'), '用户名');
  const passwordRegex = compileRegex(getSetting(db, 'password_regex', '^(?=.*[A-Za-z])(?=.*\\d).{8,24}$'), '密码');
  if (!usernameRegex.test(username)) return { error: '用户名不符合当前注册规则。' };
  if (userByUsername(db, username) || isUsernameReserved(db, username)) return { error: '该用户名已被使用或保留。' };
  if (!passwordRegex.test(password) || password.length > 128) return { error: '密码不符合当前注册规则。' };
  const emailError = validateEmailField(db, email, requireEmail);
  if (emailError) return { error: emailError };
  return { username, password, email, requireEmail };
}

function codeHash(email, code, secret) {
  return crypto.createHmac('sha256', secret).update(`${String(email).toLowerCase()}:${String(code)}`).digest('hex');
}

async function sendVerificationCode({ db, config, mailer, email }) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) return { ok: false, message: '请先填写邮箱地址。' };
  const emailError = validateEmailField(db, normalized, true);
  if (emailError) return { ok: false, message: emailError };
  const cooldown = Math.max(0, settingInt(db, 'email_code_resend_seconds', 60));
  const recent = db.prepare(`SELECT created_at FROM email_verification_codes WHERE email = ? AND created_at > ? ORDER BY created_at DESC LIMIT 1`).get(normalized, Date.now() - cooldown * 1000);
  if (recent) return { ok: false, message: `验证码发送过于频繁，请 ${cooldown} 秒后再试。` };
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const ttl = Math.max(60, settingInt(db, 'email_code_ttl_seconds', 600));
  const now = Date.now();
  const inserted = db.prepare(`INSERT INTO email_verification_codes (email, code_enc, code_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(normalized, encrypt(code, config.appSecret), codeHash(normalized, code, config.appSecret), now + ttl * 1000, now);
  try {
    await mailer.sendVerificationCode(normalized, code, ttl);
  } catch (error) {
    db.prepare('DELETE FROM email_verification_codes WHERE id = ?').run(Number(inserted.lastInsertRowid));
    throw error;
  }
  return { ok: true, message: '验证码已发送，请检查邮箱。' };
}

function verifyEmailCode(db, config, email, code) {
  const normalized = String(email || '').trim().toLowerCase();
  const row = db.prepare(`SELECT * FROM email_verification_codes WHERE email = ? AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1`).get(normalized);
  if (!row || row.expires_at <= Date.now() || row.attempts >= 5) return false;
  if (!timingSafeEqualText(row.code_hash, codeHash(normalized, String(code || '').trim(), config.appSecret))) {
    db.prepare('UPDATE email_verification_codes SET attempts = attempts + 1 WHERE id = ?').run(row.id);
    return false;
  }
  db.prepare('UPDATE email_verification_codes SET consumed_at = ? WHERE id = ?').run(Date.now(), row.id);
  return true;
}

function resolveInviter(db, inviteCode, required) {
  const code = String(inviteCode || '').trim();
  if (!code) return required ? { error: '当前注册需要邀请码。' } : { inviter: null };
  const row = db.prepare(`SELECT u.*, g.name AS group_name FROM users u LEFT JOIN user_groups g ON g.id = u.group_id WHERE u.invite_code = ?`).get(code);
  if (!row) return { error: '邀请码不存在。' };
  if (!row.is_active) return { error: '邀请账号已被停用。' };
  if (row.role !== 'admin') {
    if (getSetting(db, 'user_invites_enabled', '1') !== '1' || !row.can_invite) return { error: '该用户当前没有邀请权限。' };
    if (row.invited_count >= row.invite_limit) return { error: '该邀请码的邀请名额已用完。' };
  }
  return { inviter: row };
}

function registerUser({ db, config, input }) {
  if (getSetting(db, 'registration_enabled', '0') !== '1') return { error: '当前未开放注册。' };
  const fields = validateRegistrationFields(db, input);
  if (fields.error) return { error: fields.error };
  const requireInvite = getSetting(db, 'registration_require_invite', '0') === '1';
  const inviteResult = resolveInviter(db, input.invite_code, requireInvite);
  if (inviteResult.error) return { error: inviteResult.error };
  if (fields.requireEmail && !verifyEmailCode(db, config, fields.email, input.email_code)) return { error: '邮箱验证码无效或已过期。' };
  const now = Date.now();
  const defaultGroup = db.prepare("SELECT id FROM user_groups WHERE name = 'Default'").get();
  const uid = nextUid(db);
  const inviteLength = Math.min(20, Math.max(6, settingInt(db, 'invite_random_length', 8)));
  const inviteCode = uniqueInviteCode(db, inviteLength);
  const inviteLimit = Math.max(0, settingInt(db, 'invite_default_limit', 10));
  db.transaction(() => {
    db.prepare(`INSERT INTO users (uid, username, password_hash, role, email, group_id, account_balance_minor, invite_code, invited_by_uid, invite_limit, can_invite, is_active, created_at, updated_at) VALUES (?, ?, ?, 'user', ?, ?, 0, ?, ?, ?, 1, 1, ?, ?)`)
      .run(uid, fields.username, hashPassword(fields.password), fields.email || null, defaultGroup.id, inviteCode, inviteResult.inviter?.uid ?? null, inviteLimit, now, now);
    if (inviteResult.inviter) db.prepare('UPDATE users SET invited_count = invited_count + 1 WHERE id = ?').run(inviteResult.inviter.id);
  })();
  return { user: userByUsername(db, fields.username) };
}

module.exports = { validateRegistrationFields, validateEmailField, sendVerificationCode, verifyEmailCode, resolveInviter, registerUser, emailListMatches };