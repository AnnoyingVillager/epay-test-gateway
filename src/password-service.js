const crypto = require('node:crypto');
const { getSetting, userByUsername } = require('./db');
const { hashPassword, verifyPassword, timingSafeEqualText } = require('./crypto');

function settingInt(db, key, fallback = 0) {
  const value = Number.parseInt(getSetting(db, key, String(fallback)), 10);
  return Number.isFinite(value) ? value : fallback;
}

function passwordValidationError(db, password) {
  const value = String(password || '');
  let pattern;
  try {
    pattern = new RegExp(getSetting(db, 'password_regex', '^(?=.*[A-Za-z])(?=.*\\d).{8,24}$'));
  } catch {
    return '密码正则表达式配置无效，请联系管理员。';
  }
  if (!value || value.length > 128 || !pattern.test(value)) return '密码不符合当前安全规则。';
  return null;
}

function validateNewPassword(db, password, confirmation, currentHash = null) {
  const validationError = passwordValidationError(db, password);
  if (validationError) return validationError;
  if (String(password) !== String(confirmation)) return '两次输入的新密码不一致。';
  if (currentHash && verifyPassword(password, currentHash)) return '新密码不能与原密码相同。';
  return null;
}

function emailVerificationConfigured(db) {
  const host = getSetting(db, 'smtp_host', '').trim();
  const from = getSetting(db, 'mail_from', '').trim() || getSetting(db, 'smtp_user', '').trim();
  return Boolean(host && from);
}

function resetCodeHash(userId, email, code, secret) {
  return crypto.createHmac('sha256', secret)
    .update(`${Number(userId)}:${String(email).toLowerCase()}:${String(code)}`)
    .digest('hex');
}

function resetUserForInput(db, username, email) {
  const user = userByUsername(db, String(username || '').trim());
  if (!user || user.deletedAt || !user.isActive || user.accountRisk === 'blocked') {
    return { error: '账号不存在或已停用，请联系管理员修改密码。' };
  }
  const boundEmail = String(user.email || '').trim().toLowerCase();
  if (!boundEmail) return { error: '该账号未绑定邮箱，请联系管理员修改密码。' };
  if (boundEmail !== String(email || '').trim().toLowerCase()) {
    return { error: '账号与绑定邮箱不匹配，请联系管理员修改密码。' };
  }
  return { user, email: boundEmail };
}

async function sendPasswordResetCode({ db, config, mailer, username, email }) {
  if (!emailVerificationConfigured(db)) {
    return { ok: false, message: '管理员尚未配置验证码发件邮箱，请联系管理员修改密码。' };
  }
  const resolved = resetUserForInput(db, username, email);
  if (resolved.error) return { ok: false, message: resolved.error };

  const cooldown = Math.max(0, settingInt(db, 'email_code_resend_seconds', 60));
  const recent = db.prepare(`SELECT created_at FROM password_reset_codes WHERE user_id = ? AND created_at > ? ORDER BY created_at DESC LIMIT 1`)
    .get(resolved.user.id, Date.now() - cooldown * 1000);
  if (recent) return { ok: false, message: `验证码发送过于频繁，请 ${cooldown} 秒后再试。` };

  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const ttl = Math.max(60, settingInt(db, 'email_code_ttl_seconds', 600));
  const now = Date.now();
  db.prepare('UPDATE password_reset_codes SET consumed_at = ? WHERE user_id = ? AND consumed_at IS NULL').run(now, resolved.user.id);
  const inserted = db.prepare(`
    INSERT INTO password_reset_codes (user_id, email, code_hash, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    resolved.user.id,
    resolved.email,
    resetCodeHash(resolved.user.id, resolved.email, code, config.appSecret),
    now + ttl * 1000,
    now
  );

  try {
    await mailer.sendVerificationCode(resolved.email, code, ttl);
  } catch (error) {
    db.prepare('DELETE FROM password_reset_codes WHERE id = ?').run(Number(inserted.lastInsertRowid));
    throw error;
  }
  return { ok: true, message: '验证码已发送到账号绑定的邮箱。' };
}

function resetPassword({ db, config, username, email, code, password, confirmation }) {
  if (!emailVerificationConfigured(db)) {
    return { error: '管理员尚未配置验证码发件邮箱，请联系管理员修改密码。' };
  }
  const resolved = resetUserForInput(db, username, email);
  if (resolved.error) return { error: resolved.error };
  const current = db.prepare('SELECT password_hash, password_changed_at FROM users WHERE id = ?').get(resolved.user.id);
  const passwordError = validateNewPassword(db, password, confirmation, current?.password_hash);
  if (passwordError) return { error: passwordError };

  const row = db.prepare(`
    SELECT * FROM password_reset_codes
    WHERE user_id = ? AND email = ? AND consumed_at IS NULL
    ORDER BY created_at DESC LIMIT 1
  `).get(resolved.user.id, resolved.email);
  if (!row || row.expires_at <= Date.now() || row.attempts >= 5) {
    return { error: '邮箱验证码无效或已过期，请重新获取。' };
  }
  const expected = resetCodeHash(resolved.user.id, resolved.email, String(code || '').trim(), config.appSecret);
  if (!timingSafeEqualText(row.code_hash, expected)) {
    db.prepare('UPDATE password_reset_codes SET attempts = attempts + 1 WHERE id = ?').run(row.id);
    return { error: '邮箱验证码无效或已过期，请重新获取。' };
  }

  const now = Math.max(Date.now(), Number(current?.password_changed_at || 0) + 1);
  db.transaction(() => {
    const consumed = db.prepare('UPDATE password_reset_codes SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL').run(now, row.id);
    if (consumed.changes !== 1) throw new Error('邮箱验证码已被使用。');
    db.prepare('UPDATE users SET password_hash = ?, password_changed_at = ?, updated_at = ? WHERE id = ?')
      .run(hashPassword(password), now, now, resolved.user.id);
  })();
  return { ok: true };
}

module.exports = {
  passwordValidationError,
  validateNewPassword,
  emailVerificationConfigured,
  sendPasswordResetCode,
  resetPassword
};
