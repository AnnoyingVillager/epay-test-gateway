const express = require('express');
const { getSetting, getAllSettings, mapUser, mapCard, userByUid, userById, uniqueInviteCode, nextUid, isUsernameReserved } = require('./db');
const { hashPassword } = require('./crypto');
const { accountTransaction, depositToCard, withdrawFromCard } = require('./account-service');
const { invitePermissionStatus, canUseInvites, replaceInviteCode, inviteTopology, validateCustomInviteCode } = require('./invite-service');
const { effectiveSpendLimit, spentMinor } = require('./order-service');
const { maskCardReferences } = require('./card-format');

function integer(value, min = 0, max = Number.MAX_SAFE_INTEGER) { const parsed = Number.parseInt(value, 10); return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : null; }
function moneyInput(value, allowZero = true) { const raw = String(value ?? '').trim(); if (!/^\d{1,10}(?:\.\d{1,2})?$/.test(raw)) return null; const [whole, decimals = ''] = raw.split('.'); const minor = Number(whole) * 100 + Number(decimals.padEnd(2, '0')); return Number.isSafeInteger(minor) && (allowZero || minor > 0) ? minor : null; }
function redirectMessage(res, path, key, message) { res.redirect(`${path}${path.includes('?') ? '&' : '?'}${key}=${encodeURIComponent(message)}`); }
function settingInt(db, key, fallback = 0) { const value = Number.parseInt(getSetting(db, key, String(fallback)), 10); return Number.isFinite(value) ? value : fallback; }
function postedCheckbox(value, fallback = false) { if (value === undefined) return fallback ? 1 : 0; return (Array.isArray(value) ? value : [value]).includes('1') ? 1 : 0; }

function router({ db, config, adminOnly }) {
  const route = express.Router();

  route.get('/account', (req, res) => {
    const user = userById(db, req.user.id);
    const cards = db.prepare(`SELECT c.*, b.name AS bin_name, b.prefix AS bin_prefix, b.brand, b.card_type, b.require_3ds AS bin_require_3ds, u.username AS owner_username, u.uid AS owner_uid FROM cards c JOIN bins b ON b.id = c.bin_id LEFT JOIN users u ON u.id = c.owner_user_id WHERE c.owner_user_id = ? ORDER BY c.created_at DESC`).all(user.id).map((row) => mapCard(row, config.appSecret, false));
    const transactions = db.prepare('SELECT * FROM account_transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 100').all(user.id)
      .map((transaction) => ({ ...transaction, note: maskCardReferences(transaction.note, cards) }));
    const effectiveLimitMinor = effectiveSpendLimit(db, user.id);
    const spentMinorValue = spentMinor(db, user.id);
    res.render('admin/account', { title: '我的账户', user, cards, transactions, effectiveLimitMinor, spentMinor: spentMinorValue, settings: getAllSettings(db) });
  });

  route.post('/account/deposit', (req, res) => {
    const cardId = String(req.body.card_id || '').trim();
    const amountMinor = moneyInput(req.body.amount, false);
    if (!cardId || amountMinor === null) return redirectMessage(res, '/admin/account', 'error', '请填写有效的卡片和充值金额。');
    try { const result = depositToCard({ db, config, user: userById(db, req.user.id), cardId, amountMinor }); return redirectMessage(res, '/admin/account', 'ok', `充值成功，手续费 ${(result.fee / 100).toFixed(2)}。`); }
    catch (error) { return redirectMessage(res, '/admin/account', 'error', error.message); }
  });

  route.post('/account/withdraw', (req, res) => {
    const cardId = String(req.body.card_id || '').trim();
    const amountMinor = moneyInput(req.body.amount, false);
    if (!cardId || amountMinor === null) return redirectMessage(res, '/admin/account', 'error', '请填写有效的卡片和提现金额。');
    try { const result = withdrawFromCard({ db, config, user: userById(db, req.user.id), cardId, amountMinor }); return redirectMessage(res, '/admin/account', 'ok', `提现成功，到账 ${(result.credited / 100).toFixed(2)}，手续费 ${(result.fee / 100).toFixed(2)}。`); }
    catch (error) { return redirectMessage(res, '/admin/account', 'error', error.message); }
  });

  route.get('/invite', (req, res) => {
    const user = userById(db, req.user.id);
    const topology = inviteTopology(db, user);
    const baseUrl = config.baseUrl || `${req.protocol}://${req.get('host')}`;
    res.render('admin/invite', { title: '邀请管理', user, topology, inviteLink: `${baseUrl}/register?invite=${encodeURIComponent(user.inviteCode || '')}`, enabled: canUseInvites(user, db), settings: getAllSettings(db) });
  });

  route.post('/invite/random', (req, res) => {
    const user = userById(db, req.user.id);
    if (!canUseInvites(user, db)) return redirectMessage(res, '/admin/invite', 'error', '当前账号没有邀请权限。');
    let result;
    db.transaction(() => { result = replaceInviteCode(db, user, null); })();
    return redirectMessage(res, '/admin/invite', result.error ? 'error' : 'ok', result.error || `邀请码已更换为 ${result.code}。`);
  });

  route.post('/invite/custom', (req, res) => {
    const user = userById(db, req.user.id);
    if (!canUseInvites(user, db)) return redirectMessage(res, '/admin/invite', 'error', '当前账号没有邀请权限。');
    const requested = String(req.body.code || '').trim();
    const validated = validateCustomInviteCode(requested);
    if (validated.error) return redirectMessage(res, '/admin/invite', 'error', validated.error);
    if (validated.value === user.inviteCode) return redirectMessage(res, '/admin/invite', 'ok', '邀请码未发生变化，未扣除费用。');
    const fee = user.role === 'admin' ? 0 : Math.max(0, settingInt(db, 'invite_custom_fee_minor', 10000));
    if (fee > user.accountBalanceMinor) return redirectMessage(res, '/admin/invite', 'error', `自定义邀请码需要 ${(fee / 100).toFixed(2)} CNY，账户余额不足。`);
    try {
      db.transaction(() => {
        if (fee > 0) accountTransaction(db, user.id, 'INVITE_CUSTOM_CODE', -fee, `更换自定义邀请码 ${requested}`);
        const result = replaceInviteCode(db, user, requested);
        if (result.error) throw Object.assign(new Error(result.error), { statusCode: 400 });
      })();
      return redirectMessage(res, '/admin/invite', 'ok', '自定义邀请码已生效。');
    } catch (error) { return redirectMessage(res, '/admin/invite', 'error', error.message); }
  });

  route.post('/invite/slots', (req, res) => {
    const user = userById(db, req.user.id);
    if (!canUseInvites(user, db)) return redirectMessage(res, '/admin/invite', 'error', '当前账号没有邀请权限。');
    if (getSetting(db, 'invite_slot_purchase_enabled', '0') !== '1') return redirectMessage(res, '/admin/invite', 'error', '管理员未开启邀请名额购买。');
    const quantity = integer(req.body.quantity, 1, 100);
    if (quantity === null) return redirectMessage(res, '/admin/invite', 'error', '邀请名额数量必须为 1-100 的整数。');
    const total = Math.max(0, settingInt(db, 'invite_slot_price_minor', 1000)) * quantity;
    if (total > user.accountBalanceMinor) return redirectMessage(res, '/admin/invite', 'error', '账户余额不足，无法购买邀请名额。');
    db.transaction(() => {
      if (total > 0) accountTransaction(db, user.id, 'INVITE_SLOT_PURCHASE', -total, `购买 ${quantity} 个邀请名额`);
      db.prepare('UPDATE users SET invite_limit = invite_limit + ?, updated_at = ? WHERE id = ?').run(quantity, Date.now(), user.id);
    })();
    return redirectMessage(res, '/admin/invite', 'ok', `已购买 ${quantity} 个邀请名额。`);
  });

  route.get('/groups', adminOnly, (req, res) => res.render('admin/groups', { title: '用户分组', groups: db.prepare('SELECT * FROM user_groups ORDER BY id').all() }));

  route.post('/groups/:id/update', adminOnly, (req, res) => {
    const id = integer(req.params.id, 1);
    const group = id ? db.prepare('SELECT * FROM user_groups WHERE id = ?').get(id) : null;
    const cardLimit = integer(req.body.card_limit, 0, 100000);
    const cardBonus = moneyInput(req.body.card_bonus, true);
    const unlimited = req.body.spend_limit_unlimited === '1';
    const spendLimit = unlimited ? null : moneyInput(req.body.spend_limit, true);
    if (!group || cardLimit === null || cardBonus === null || (!unlimited && spendLimit === null)) return redirectMessage(res, '/admin/groups', 'error', '分组参数无效。');
    db.prepare('UPDATE user_groups SET card_limit = ?, card_bonus_minor = ?, spend_limit_minor = ?, updated_at = ? WHERE id = ?').run(cardLimit, cardBonus, spendLimit, Date.now(), id);
    return redirectMessage(res, '/admin/groups', 'ok', '分组配置已更新。');
  });

  route.get('/users', adminOnly, (req, res) => {
    const q = String(req.query.q || '').trim();
    const users = db.prepare(`SELECT u.*, g.name AS group_name FROM users u LEFT JOIN user_groups g ON g.id = u.group_id WHERE u.deleted_at IS NULL AND (? = '' OR u.username LIKE ? OR CAST(u.uid AS TEXT) = ?) ORDER BY CASE u.role WHEN 'admin' THEN 0 ELSE 1 END, u.created_at DESC`).all(q, `%${q}%`, q).map((row) => { const user = mapUser(row); return { ...user, invitePermission: invitePermissionStatus(user, db) }; });
    res.render('admin/users-v2', { title: '用户管理', users, groups: db.prepare('SELECT * FROM user_groups ORDER BY id').all(), q, globalInvitesEnabled: getSetting(db, 'user_invites_enabled', '1') === '1' });
  });

  route.post('/users', adminOnly, (req, res) => {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    const role = String(req.body.role || 'user');
    const invitePermissionMode = req.body.invite_permission_mode === 'custom' ? 'custom' : 'inherit';
    const canInvite = postedCheckbox(req.body.can_invite, true);
    const groupId = integer(req.body.group_id, 1) || db.prepare("SELECT id FROM user_groups WHERE name = 'Default'").get().id;
    if (!db.prepare('SELECT id FROM user_groups WHERE id = ?').get(groupId)) return redirectMessage(res, '/admin/users', 'error', '用户分组不存在。');
    if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username) || isUsernameReserved(db, username) || password.length < 8 || password.length > 128 || !['admin', 'user'].includes(role)) return redirectMessage(res, '/admin/users', 'error', '用户名已被占用或是保留名称，密码或角色无效。');
    try {
      const now = Date.now();
      const uid = role === 'admin' && !db.prepare('SELECT id FROM users WHERE uid = 0').get() ? 0 : nextUid(db);
      const code = uniqueInviteCode(db, settingInt(db, 'invite_random_length', 8));
      const inviteLimit = role === 'admin' ? 2147483647 : settingInt(db, 'invite_default_limit', 10);
      db.prepare(`INSERT INTO users (uid, username, password_hash, role, group_id, account_balance_minor, invite_code, invite_limit, invite_permission_mode, can_invite, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 1, ?, ?)`).run(uid, username, hashPassword(password), role, groupId, code, inviteLimit, invitePermissionMode, canInvite, now, now);
      return redirectMessage(res, '/admin/users', 'ok', `用户 ${username} 已创建，UID ${uid}。`);
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) return redirectMessage(res, '/admin/users', 'error', '用户名、UID 或邀请码已存在。');
      throw error;
    }
  });

  route.post('/users/batch', adminOnly, (req, res) => {
    const ids = [...new Set([].concat(req.body.user_ids || []).map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))];
    const action = String(req.body.action || '');
    if (!['group', 'add_balance', 'subtract_balance', 'disable'].includes(action)) return redirectMessage(res, '/admin/users', 'error', '批量操作无效。');
    if (!ids.length) return redirectMessage(res, '/admin/users', 'error', '请至少选择一个用户。');
    const selected = db.prepare(`SELECT id, role, uid FROM users WHERE deleted_at IS NULL AND id IN (${ids.map(() => '?').join(',')})`).all(...ids);
    const amount = ['add_balance', 'subtract_balance'].includes(action) ? moneyInput(req.body.amount, false) : null;
    if (['add_balance', 'subtract_balance'].includes(action) && amount === null) return redirectMessage(res, '/admin/users', 'error', '请输入有效的批量金额。');
    const groupId = action === 'group' ? integer(req.body.group_id, 1) : null;
    if (action === 'group' && (!groupId || !db.prepare('SELECT id FROM user_groups WHERE id = ?').get(groupId))) return redirectMessage(res, '/admin/users', 'error', '请选择有效的用户分组。');
    const reason = String(req.body.disabled_reason || '风险控制').trim().slice(0, 200) || '风险控制';
    try {
      db.transaction(() => {
        for (const user of selected) {
          if (action === 'group') db.prepare('UPDATE users SET group_id = ?, updated_at = ? WHERE id = ?').run(groupId, Date.now(), user.id);
          else if (action === 'add_balance') accountTransaction(db, user.id, 'ADMIN_BATCH_CREDIT', amount, '管理员批量增加账户余额');
          else if (action === 'subtract_balance') accountTransaction(db, user.id, 'ADMIN_BATCH_DEBIT', -amount, '管理员批量减少账户余额');
          else if (action === 'disable' && user.role !== 'admin') db.prepare('UPDATE users SET is_active = 0, disabled_reason = ?, updated_at = ? WHERE id = ?').run(reason, Date.now(), user.id);
        }
      })();
      return redirectMessage(res, '/admin/users', 'ok', `已处理 ${selected.length} 个用户。`);
    } catch (error) { return redirectMessage(res, '/admin/users', 'error', error.message); }
  });

  route.get('/users/:uid', adminOnly, (req, res) => {
    const user = userByUid(db, req.params.uid);
    if (!user || user.deletedAt) return res.status(404).render('error', { title: '用户不存在', message: '未找到该 UID 对应的有效用户。', statusCode: 404 });
    const topology = inviteTopology(db, user);
    const cards = db.prepare(`SELECT c.*, b.name AS bin_name, b.prefix AS bin_prefix, b.brand, b.card_type, b.require_3ds AS bin_require_3ds, u.username AS owner_username, u.uid AS owner_uid FROM cards c JOIN bins b ON b.id = c.bin_id LEFT JOIN users u ON u.id = c.owner_user_id WHERE c.owner_user_id = ? ORDER BY c.created_at DESC`).all(user.id).map((row) => mapCard(row, config.appSecret, false));
    const transactions = db.prepare('SELECT * FROM account_transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 100').all(user.id)
      .map((transaction) => ({ ...transaction, note: maskCardReferences(transaction.note, cards) }));
    const riskEvents = db.prepare('SELECT * FROM risk_events WHERE user_id = ? ORDER BY created_at DESC LIMIT 50').all(user.id);
    const effectiveLimitMinor = effectiveSpendLimit(db, user.id);
    const spentMinorValue = spentMinor(db, user.id);
    res.render('admin/user-detail', { title: `用户 ${user.username}`, user, topology, cards, groups: db.prepare('SELECT * FROM user_groups ORDER BY id').all(), transactions, riskEvents, effectiveLimitMinor, spentMinor: spentMinorValue, invitePermission: invitePermissionStatus(user, db) });
  });

  route.post('/users/:uid/update', adminOnly, (req, res) => {
    const user = userByUid(db, req.params.uid);
    if (!user || user.deletedAt) return redirectMessage(res, '/admin/users', 'error', '用户不存在。');
    if (user.superRiskAt) return redirectMessage(res, `/admin/users/${user.uid}`, 'error', '该账号已执行超级风控，不能恢复或修改。');
    const groupId = integer(req.body.group_id, 1);
    if (!db.prepare('SELECT id FROM user_groups WHERE id = ?').get(groupId)) return redirectMessage(res, `/admin/users/${user.uid}`, 'error', '用户分组不存在。');
    const accountRisk = ['normal', 'watch', 'blocked'].includes(req.body.account_risk) ? req.body.account_risk : 'normal';
    const cardRisk = ['normal', 'frozen'].includes(req.body.card_risk) ? req.body.card_risk : 'normal';
    const spendMode = ['inherit', 'unlimited', 'custom'].includes(req.body.spend_limit_mode)
      ? req.body.spend_limit_mode
      : (req.body.spend_limit_unlimited === '1' ? 'unlimited' : 'custom');
    const spendLimit = spendMode === 'inherit' ? null : (spendMode === 'unlimited' ? -1 : moneyInput(req.body.spend_limit, true));
    const spendLimitInvalid = spendMode === 'custom' && spendLimit === null;
    const cardLimitUnlimited = req.body.card_balance_limit_unlimited === '1';
    const cardBalanceLimit = cardLimitUnlimited ? null : moneyInput(req.body.card_balance_limit, true);
    const inviteLimit = integer(req.body.invite_limit, 0, 1000000);
    const invitePermissionMode = ['inherit', 'custom'].includes(String(req.body.invite_permission_mode)) ? String(req.body.invite_permission_mode) : user.invitePermissionMode;
    const canInvite = postedCheckbox(req.body.can_invite, user.canInvite);
    const isActive = req.body.is_active === '1' ? 1 : 0;
    const disabledReason = String(req.body.disabled_reason || '风险控制').trim().slice(0, 200) || '风险控制';
    if (!groupId || spendLimitInvalid || (!cardLimitUnlimited && cardBalanceLimit === null) || inviteLimit === null) return redirectMessage(res, `/admin/users/${user.uid}`, 'error', '用户参数无效。');
    if (user.role === 'admin' && (!isActive || accountRisk === 'blocked')) return redirectMessage(res, `/admin/users/${user.uid}`, 'error', '不能通过该表单停用管理员账号。');
    db.prepare(`UPDATE users SET group_id = ?, account_risk = ?, card_risk = ?, spend_limit_minor = ?, card_balance_limit_minor = ?, invite_limit = ?, invite_permission_mode = ?, can_invite = ?, is_active = ?, disabled_reason = ?, updated_at = ? WHERE id = ?`).run(groupId, accountRisk, cardRisk, spendLimit, cardBalanceLimit, inviteLimit, invitePermissionMode, canInvite, isActive, isActive ? null : disabledReason, Date.now(), user.id);
    return redirectMessage(res, `/admin/users/${user.uid}`, 'ok', '用户配置已更新。');
  });

  route.post('/users/:uid/invite-permission', adminOnly, (req, res) => {
    const user = userByUid(db, req.params.uid);
    if (!user || user.deletedAt) return redirectMessage(res, '/admin/users', 'error', '用户不存在。');
    if (user.superRiskAt) return redirectMessage(res, `/admin/users/${user.uid}`, 'error', '该账号已执行超级风控，不能修改邀请权限。');
    const invitePermissionMode = ['inherit', 'custom'].includes(String(req.body.invite_permission_mode)) ? String(req.body.invite_permission_mode) : user.invitePermissionMode;
    const canInvite = postedCheckbox(req.body.can_invite, user.canInvite);
    if (!['inherit', 'custom'].includes(invitePermissionMode)) return redirectMessage(res, '/admin/users', 'error', '邀请权限模式无效。');
    db.prepare('UPDATE users SET invite_permission_mode = ?, can_invite = ?, updated_at = ? WHERE id = ?').run(invitePermissionMode, canInvite, Date.now(), user.id);
    return redirectMessage(res, '/admin/users', 'ok', `用户 ${user.username} 的邀请权限已设为${invitePermissionMode === 'custom' ? '单独开关' : '继承全局'}，单独开关${canInvite ? '开启' : '关闭'}。`);
  });

  route.post('/users/:uid/balance', adminOnly, (req, res) => {
    const user = userByUid(db, req.params.uid);
    const operation = String(req.body.operation || 'add');
    const amount = moneyInput(req.body.amount, operation === 'set');
    if (!user || user.deletedAt || user.superRiskAt || amount === null || !['add', 'subtract', 'set'].includes(operation)) return redirectMessage(res, '/admin/users', 'error', '余额调整参数无效。');
    try {
      db.transaction(() => {
        if (operation === 'set') accountTransaction(db, user.id, 'ADMIN_BALANCE_SET', amount - user.accountBalanceMinor, `管理员设置账户余额为 ${(amount / 100).toFixed(2)}`);
        else if (operation === 'add') accountTransaction(db, user.id, 'ADMIN_BALANCE_CREDIT', amount, '管理员增加账户余额');
        else accountTransaction(db, user.id, 'ADMIN_BALANCE_DEBIT', -amount, '管理员减少账户余额');
      })();
      return redirectMessage(res, `/admin/users/${user.uid}`, 'ok', '账户余额已调整。');
    } catch (error) { return redirectMessage(res, `/admin/users/${user.uid}`, 'error', error.message); }
  });

  route.post('/users/:uid/super-risk', adminOnly, (req, res) => {
    const user = userByUid(db, req.params.uid);
    if (!user || user.deletedAt || user.role === 'admin') return redirectMessage(res, '/admin/users', 'error', '不能对该账号执行超级风控。');
    if (user.superRiskAt) return redirectMessage(res, `/admin/users/${user.uid}`, 'error', '该账号已执行过超级风控。');
    const reason = String(req.body.reason || '极端风险控制').trim().slice(0, 200) || '极端风险控制';
    db.transaction(() => {
      if (user.accountBalanceMinor > 0) accountTransaction(db, user.id, 'SUPER_RISK_CLEAR', -user.accountBalanceMinor, reason);
      const cards = db.prepare('SELECT id FROM cards WHERE owner_user_id = ?').all(user.id);
      for (const card of cards) {
        db.prepare(`UPDATE orders SET card_id = NULL, status = CASE WHEN status = 'PENDING' THEN 'FAILED' ELSE status END, callback_event = CASE WHEN status = 'PENDING' THEN 'CARD_REMOVED_BY_RISK' ELSE callback_event END, closed_at = CASE WHEN status = 'PENDING' THEN ? ELSE closed_at END WHERE card_id = ?`).run(Date.now(), card.id);
        db.prepare('DELETE FROM card_transactions WHERE card_id = ?').run(card.id);
      }
      db.prepare('DELETE FROM cards WHERE owner_user_id = ?').run(user.id);
      db.prepare('UPDATE users SET account_balance_minor = 0, is_active = 0, disabled_reason = ?, account_risk = ?, card_risk = ?, super_risk_at = ?, updated_at = ? WHERE id = ?').run(reason, 'blocked', 'frozen', Date.now(), Date.now(), user.id);
      db.prepare('INSERT INTO risk_events (user_id, user_uid, actor_uid, event, details, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(user.id, user.uid, req.user.uid, 'SUPER_RISK', reason, Date.now());
    })();
    return redirectMessage(res, `/admin/users/${user.uid}`, 'ok', '超级风控已完成，账号已禁用且名下卡片与余额已清空。');
  });

  route.post('/users/:uid/delete', adminOnly, (req, res) => {
    const user = userByUid(db, req.params.uid);
    if (!user) return redirectMessage(res, '/admin/users', 'error', '不能删除该账号。');
    if (user.deletedAt) return redirectMessage(res, '/admin/users', 'error', '该账号已经删除。');
    if (user.role === 'admin') return redirectMessage(res, '/admin/users', 'error', '不能删除管理员账号。');
    if (!user.superRiskAt || user.isActive) return redirectMessage(res, `/admin/users/${user.uid}`, 'error', '必须先完成超级风控并禁用账号，才能删除。');
    const invitees = db.prepare('SELECT uid, username FROM users WHERE invited_by_uid = ? ORDER BY uid').all(user.uid);
    const deletedInvitees = db.prepare('SELECT uid, username FROM deleted_users WHERE invited_by_uid = ? ORDER BY uid').all(user.uid);
    const inviter = user.invitedByUid === null ? null : userByUid(db, user.invitedByUid);
    const group = db.prepare('SELECT name FROM user_groups WHERE id = ?').get(user.groupId);
    const allInvitees = [...invitees, ...deletedInvitees];
    const reason = String(req.body.reason || user.disabledReason || '极端风险账号删除').trim().slice(0, 200);
    db.transaction(() => {
      const now = Date.now();
      db.prepare('DELETE FROM cards WHERE owner_user_id = ?').run(user.id);
      db.prepare(`INSERT INTO deleted_users (user_id, uid, username, email, group_name, former_invite_code, invited_by_uid, inviter_username, invitee_uids, invitee_usernames, disabled_reason, deleted_by_uid, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(user.id, user.uid, user.username, user.email, group?.name || null, user.inviteCode, user.invitedByUid, inviter?.username || null, JSON.stringify(allInvitees.map((item) => item.uid)), JSON.stringify(allInvitees.map((item) => item.username)), reason, req.user.uid, now);
      db.prepare(`UPDATE users SET account_balance_minor = 0, is_active = 0, account_risk = 'blocked', card_risk = 'frozen',
        deleted_at = ?, deleted_by_uid = ?, deletion_reason = ?, disabled_reason = ?, updated_at = ? WHERE id = ?`).run(now, req.user.uid, reason, reason, now, user.id);
    })();
    return redirectMessage(res, '/admin/users', 'ok', `用户 ${user.username}（UID ${user.uid}）已删除并归档，拓扑信息已保留。`);
  });

  return route;
}

module.exports = router;
