const { getSetting, uniqueInviteCode, userByUid } = require('./db');

function validateCustomInviteCode(code) {
  const value = String(code || '').trim();
  if (!/^[A-Za-z0-9]{6,20}$/.test(value)) return { error: '自定义邀请码必须为 6-20 位字母或数字。' };
  if (value.length <= 7 && /\d/.test(value)) return { error: '7 位及以下的自定义邀请码不能包含数字。' };
  return { value };
}

function canUseInvites(user, db) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  return getSetting(db, 'user_invites_enabled', '1') === '1' && user.canInvite && user.isActive;
}

function replaceInviteCode(db, user, requestedCode) {
  const validated = requestedCode ? validateCustomInviteCode(requestedCode) : {};
  if (validated.error) return { error: validated.error };
  const length = Math.min(20, Math.max(6, Number.parseInt(getSetting(db, 'invite_random_length', '8'), 10) || 8));
  const nextCode = validated.value || uniqueInviteCode(db, length);
  if (nextCode === user.inviteCode) return { code: nextCode, unchanged: true };
  if (db.prepare('SELECT id FROM users WHERE invite_code = ? AND id <> ?').get(nextCode, user.id)
    || db.prepare('SELECT id FROM deleted_users WHERE former_invite_code = ?').get(nextCode)
    || db.prepare('SELECT code FROM retired_invite_codes WHERE code = ?').get(nextCode)) return { error: '该邀请码已被使用或保留。' };
  if (user.inviteCode) db.prepare('INSERT OR IGNORE INTO retired_invite_codes (code, user_id, user_uid, retired_at) VALUES (?, ?, ?, ?)').run(user.inviteCode, user.id, user.uid, Date.now());
  db.prepare('UPDATE users SET invite_code = ?, updated_at = ? WHERE id = ?').run(nextCode, Date.now(), user.id);
  return { code: nextCode, unchanged: false };
}

function inviteTopology(db, user) {
  const invitees = db.prepare('SELECT uid, username, created_at, is_active FROM users WHERE invited_by_uid = ? AND deleted_at IS NULL ORDER BY created_at').all(user.uid);
  const deletedInvitees = db.prepare('SELECT uid, username, deleted_at FROM deleted_users WHERE invited_by_uid = ? ORDER BY deleted_at').all(user.uid);
  const inviter = user.invitedByUid === null || user.invitedByUid === undefined ? null : userByUid(db, user.invitedByUid);
  return { inviter, invitees, deletedInvitees };
}

module.exports = { validateCustomInviteCode, canUseInvites, replaceInviteCode, inviteTopology };