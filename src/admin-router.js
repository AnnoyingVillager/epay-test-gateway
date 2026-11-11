const express = require('express');
const crypto = require('node:crypto');
const { formatMinor } = require('./epay');
const {
  encrypt,
  cardNumberHash,
  generateCardNumber,
  luhnValid,
  randomToken,
  randomDigits
} = require('./crypto');
const {
  getSetting,
  setSetting,
  getAllSettings,
  mapCard,
  mapMerchant,
  mapOrder,
  mapUser,
  cardById,
  userById
} = require('./db');
const {
  requireUser,
  requireRole,
  verifyCsrf,
  validUserCredentials,
  createSession,
  setSessionCookie,
  clearSessionCookie,
  userSessionFromRequest
} = require('./admin-auth');
const { simulateChargeback, refundOrder, renderOrderContext, EpayError } = require('./order-service');
const { internalTransfer, cancelOwnCard, unfreezeCard } = require('./account-service');
const { cardSpendLimit, resolvedOverdraft, applyCardDebit, recordInsufficientFailure, maybeFreezeForOverdraftWarning } = require('./card-service');
const { emailVerificationConfigured, sendPasswordResetCode, resetPassword } = require('./password-service');
const { isSuperAdmin, canManageCardOwner, canRefundOrder, requireSuperAdmin } = require('./permissions');
const userAdminRouter = require('./user-admin-router');

function moneyInput(value, { allowZero = true } = {}) {
  const raw = String(value ?? '').trim();
  if (!/^\d{1,10}(?:\.\d{1,2})?$/.test(raw)) return null;
  const [whole, decimals = ''] = raw.split('.');
  const minor = Number(whole) * 100 + Number(decimals.padEnd(2, '0'));
  if (!Number.isSafeInteger(minor) || (!allowZero && minor === 0)) return null;
  return minor;
}

function signedMoneyInput(value) {
  const raw = String(value ?? '').trim();
  if (!/^-?\d{1,10}(?:\.\d{1,2})?$/.test(raw)) return null;
  const negative = raw.startsWith('-');
  const unsigned = negative ? raw.slice(1) : raw;
  const minor = moneyInput(unsigned, { allowZero: true });
  if (minor === null) return null;
  return negative ? -minor : minor;
}

function integer(value, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return null;
  return parsed;
}

function normalizeYear(value) {
  const year = integer(value, 0, 9999);
  if (year === null) return null;
  if (year >= 0 && year < 100) return 2000 + year;
  return year;
}

function redirectMessage(res, path, key, message) {
  const separator = path.includes('?') ? '&' : '?';
  res.redirect(`${path}${separator}${key}=${encodeURIComponent(message)}`);
}

function numericIds(value) {
  return [...new Set([].concat(value || []).map((item) => Number.parseInt(item, 10)).filter((item) => Number.isSafeInteger(item) && item > 0))];
}

function safeNext(value) {
  const target = String(value || '');
  return target.startsWith('/') && !target.startsWith('//') ? target : '/admin';
}

function orderQuery(where = '', params = [], limit = 200) {
  return {
    sql: `
      SELECT o.*, m.pid AS merchant_pid, m.name AS merchant_name, c.last4 AS card_last4
      FROM orders o
      JOIN merchants m ON m.id = o.merchant_id
      LEFT JOIN cards c ON c.id = o.card_id
      ${where}
      ORDER BY o.created_at DESC
      LIMIT ?
    `,
    params: [...params, limit]
  };
}

function router({ db, config, notification, logger }) {
  const route = express.Router();
  const allowedCardStatuses = new Set(['active', 'declined', 'frozen']);
  const adminOnly = requireRole('admin');
  const superAdminOnly = requireSuperAdmin;

  function orderScope(req) {
    if (req.user.role !== 'admin') {
      return { condition: '(o.payer_user_id = ? OR o.card_id IN (SELECT id FROM cards WHERE owner_user_id = ?))', params: [req.user.id, req.user.id] };
    }
    if (isSuperAdmin(req.user)) return { condition: '', params: [] };
    return {
      condition: `(o.card_id IS NULL OR o.card_id IN (SELECT id FROM cards WHERE owner_user_id = ?)
        OR o.card_id IN (SELECT c.id FROM cards c JOIN users u ON u.id = c.owner_user_id WHERE u.role <> 'admin'))`,
      params: [req.user.id]
    };
  }

  function cardAccessCondition(req) {
    if (isSuperAdmin(req.user)) return { condition: '', params: [] };
    if (req.user.role === 'admin') {
      return {
        condition: 'AND (c.owner_user_id = ? OR c.owner_user_id IN (SELECT id FROM users WHERE role <> \'admin\'))',
        params: [req.user.id]
      };
    }
    return { condition: 'AND c.owner_user_id = ?', params: [req.user.id] };
  }

  function manageableCardOwners(actor) {
    if (isSuperAdmin(actor)) {
      return db.prepare('SELECT * FROM users WHERE is_active = 1 ORDER BY role DESC, username').all().map(mapUser);
    }
    return db.prepare(`
      SELECT * FROM users
      WHERE is_active = 1 AND (role <> 'admin' OR id = ?)
      ORDER BY role DESC, username
    `).all(actor.id).map(mapUser);
  }

  function denyCardManagement(res) {
    return res.status(403).render('error', {
      title: '没有访问权限',
      message: '管理员不能查看或修改其他管理员名下的卡片。',
      statusCode: 403
    });
  }

  function orderFingerprint(req) {
    const scope = orderScope(req);
    const where = scope.condition ? `WHERE ${scope.condition}` : '';
    const snapshot = db.prepare(`
      SELECT
        COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN o.status = 'PENDING' THEN 1 ELSE 0 END), 0) AS pending,
        COALESCE(SUM(CASE WHEN o.status = 'PAID' THEN 1 ELSE 0 END), 0) AS paid,
        COALESCE(SUM(CASE WHEN o.status IN ('FAILED', 'EXPIRED') THEN 1 ELSE 0 END), 0) AS failed,
        COALESCE(SUM(CASE WHEN o.status = 'CHARGEBACK' THEN 1 ELSE 0 END), 0) AS chargeback,
        COALESCE(MAX(o.paid_at), 0) AS last_paid,
        COALESCE(MAX(o.closed_at), 0) AS last_closed,
        COALESCE(MAX(o.notified_at), 0) AS last_notified,
        COALESCE(MAX(o.notify_attempts), 0) AS max_notify_attempts,
        COALESCE(SUM(CASE WHEN o.notify_state = 'SENT' THEN 1 ELSE 0 END), 0) AS sent_notifications,
        COALESCE(MAX(o.settled_at), 0) AS last_settled,
        COALESCE(MAX(o.settlement_due_at), 0) AS last_settlement_due,
        COALESCE(MAX(o.refunded_at), 0) AS last_refunded,
        COALESCE(SUM(o.refunded_minor), 0) AS refunded,
        COALESCE(SUM(o.commission_minor), 0) AS commission,
        COALESCE(SUM(o.merchant_net_minor), 0) AS merchant_net
      FROM orders o
      ${where}
    `).get(...scope.params);
    return crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
  }

  route.get('/login', (req, res) => {
    const next = safeNext(req.query.next);
    if (userSessionFromRequest(req, db, config)) return res.redirect(next);
    const message = req.query.password_changed
      ? '密码已修改，请使用新密码重新登录。'
      : (req.query.reset ? '密码已重置，请使用新密码登录。' : null);
    res.render('admin/login', { title: '账户登录', error: null, message, next, registrationEnabled: getSetting(db, 'registration_enabled', '0') === '1' });
  });

  route.post('/login', (req, res) => {
    const username = String(req.body.username || '');
    const password = String(req.body.password || '');
    const user = validUserCredentials(db, username, password);
    if (!user) {
      return res.status(401).render('admin/login', {
        title: '账户登录',
        error: '用户名或密码错误，或账号已被停用。',
        message: null,
        next: safeNext(req.body.next),
        registrationEnabled: getSetting(db, 'registration_enabled', '0') === '1'
      });
    }
    const session = createSession(user, config);
    setSessionCookie(res, config, session.token);
    res.redirect(safeNext(req.body.next || '/admin'));
  });

  function renderForgotPassword(req, res, { statusCode = 200, error = null, message = null, form = {} } = {}) {
    return res.status(statusCode).render('admin/forgot-password', {
      title: '找回密码',
      emailConfigured: emailVerificationConfigured(db),
      error,
      message,
      form
    });
  }

  route.get('/forgot-password', (req, res) => renderForgotPassword(req, res));

  route.post('/forgot-password/send-code', async (req, res) => {
    if (!emailVerificationConfigured(db)) {
      return res.status(503).json({ ok: false, message: '管理员尚未配置验证码发件邮箱，请联系管理员修改密码。' });
    }
    try {
      const result = await sendPasswordResetCode({ db, config, mailer: req.app.locals.mailer, username: req.body.username, email: req.body.email });
      return res.status(result.ok ? 200 : 400).json(result);
    } catch (error) {
      logger.error?.('Password reset email delivery failed', error);
      return res.status(500).json({ ok: false, message: '验证码发送失败，请联系管理员修改密码。' });
    }
  });

  route.post('/forgot-password', (req, res) => {
    if (!emailVerificationConfigured(db)) {
      return renderForgotPassword(req, res, { statusCode: 503, error: '管理员尚未配置验证码发件邮箱，请联系管理员修改密码。', form: req.body });
    }
    try {
      const result = resetPassword({ db, config, username: req.body.username, email: req.body.email, code: req.body.email_code, password: req.body.new_password, confirmation: req.body.confirm_password });
      if (result.error) return renderForgotPassword(req, res, { statusCode: 400, error: result.error, form: req.body });
      return res.redirect('/admin/login?reset=1');
    } catch (error) {
      logger.error?.('Password reset failed', error);
      return renderForgotPassword(req, res, { statusCode: 500, error: '密码重置失败，请联系管理员修改密码。', form: req.body });
    }
  });

  route.use(requireUser);
  route.use((req, res, next) => {
    if (req.method !== 'POST') return next();
    return verifyCsrf(req, res, next);
  });

  route.get('/logout', (req, res) => {
    clearSessionCookie(res);
    res.redirect('/admin/login');
  });

  route.use('/bins', superAdminOnly);
  route.use('/merchants', superAdminOnly);
  route.use('/settings', superAdminOnly);
  route.use('/users', adminOnly);
  route.use(userAdminRouter({ db, config, adminOnly, superAdminOnly }));

  route.get('/', (req, res) => {
    const isAdmin = req.user.role === 'admin';
    const cardAccess = cardAccessCondition(req);
    const cardWhere = cardAccess.condition ? `WHERE ${cardAccess.condition.replace(/^AND\s+/, '')}` : '';
    const cardParams = cardAccess.params;
    const orderScopeValue = orderScope(req);
    const orderWhere = orderScopeValue.condition ? `WHERE ${orderScopeValue.condition}` : '';
    const orderParams = orderScopeValue.params;
    const stats = {
      cards: db.prepare(`SELECT COUNT(*) AS count FROM cards c ${cardWhere}`).get(...cardParams).count,
      activeCards: db.prepare(`SELECT COUNT(*) AS count FROM cards c ${cardWhere ? `${cardWhere} AND` : 'WHERE'} c.status = 'active'`).get(...cardParams).count,
      balance: db.prepare(`SELECT COALESCE(SUM(c.balance_minor), 0) AS amount FROM cards c ${cardWhere}`).get(...cardParams).amount,
      orders: db.prepare(`SELECT COUNT(*) AS count FROM orders o ${orderWhere}`).get(...orderParams).count,
      pending: db.prepare(`SELECT COUNT(*) AS count FROM orders o ${orderWhere ? `${orderWhere} AND` : 'WHERE'} o.status = 'PENDING'`).get(...orderParams).count,
      paid: db.prepare(`SELECT COUNT(*) AS count FROM orders o ${orderWhere ? `${orderWhere} AND` : 'WHERE'} o.status = 'PAID'`).get(...orderParams).count,
      failed: db.prepare(`SELECT COUNT(*) AS count FROM orders o ${orderWhere ? `${orderWhere} AND` : 'WHERE'} o.status IN ('FAILED', 'EXPIRED')`).get(...orderParams).count,
      paidVolume: db.prepare(`SELECT COALESCE(SUM(o.money_minor), 0) AS amount FROM orders o ${orderWhere ? `${orderWhere} AND` : 'WHERE'} o.status = 'PAID'`).get(...orderParams).amount
    };
    const recentSql = orderQuery(orderWhere, orderParams, 8);
    const recentOrders = db.prepare(recentSql.sql).all(...recentSql.params).map(mapOrder);
    res.render('admin/dashboard', {
      title: isAdmin ? '仪表盘' : '我的仪表盘',
      stats,
      recentOrders,
      isAdmin,
      isSuperAdmin: isSuperAdmin(req.user),
      ordersLiveFingerprint: orderFingerprint(req),
      autoRefreshSeconds: stats.pending > 0 ? 5 : null
    });
  });

  route.get('/bins', (req, res) => {
    const bins = db.prepare(`
      SELECT b.*, COUNT(DISTINCT c.id) AS card_count, GROUP_CONCAT(DISTINCT bg.group_id) AS group_ids
      FROM bins b LEFT JOIN cards c ON c.bin_id = b.id LEFT JOIN bin_groups bg ON bg.bin_id = b.id
      GROUP BY b.id ORDER BY b.created_at DESC
    `).all();
    res.render('admin/bins', { title: '卡 BIN 管理', bins, groups: db.prepare('SELECT * FROM user_groups ORDER BY id').all() });
  });

  route.post('/bins', (req, res) => {
    const name = String(req.body.name || '').trim();
    const prefix = String(req.body.prefix || '').replace(/\D/g, '');
    const brand = String(req.body.brand || 'Visa').trim();
    const cardType = String(req.body.card_type || 'debit').trim();
    const country = String(req.body.country || 'CN').trim().toUpperCase();
    const numberLength = integer(req.body.number_length, 12, 19);
    const require3ds = req.body.require_3ds === undefined ? 1 : (req.body.require_3ds === '1' ? 1 : 0);
    const overdraftLimit = moneyInput(req.body.overdraft_limit ?? '5000', { allowZero: true });
    const overdraftFeeBps = integer(req.body.overdraft_fee_bps ?? 500, 0, 10000);
    const overdraftMinFee = moneyInput(req.body.overdraft_min_fee ?? '1', { allowZero: true });
    const overdraftWarningBps = integer(req.body.overdraft_warning_bps ?? 9500, 1, 10000);
    const unfreezeFee = String(req.body.unfreeze_fee ?? '').trim() === '' ? null : moneyInput(req.body.unfreeze_fee, { allowZero: true });
    const groupSelectionProvided = req.body.group_ids_present === '1' || Object.prototype.hasOwnProperty.call(req.body, 'group_ids');
    const groupIds = Object.prototype.hasOwnProperty.call(req.body, 'group_ids')
      ? numericIds(req.body.group_ids)
      : (groupSelectionProvided ? [] : db.prepare('SELECT id FROM user_groups ORDER BY id').all().map((group) => group.id));
    const validGroupIds = new Set(db.prepare('SELECT id FROM user_groups').all().map((group) => group.id));
    if (!name || prefix.length < 4 || prefix.length > 8 || numberLength === null || prefix.length >= numberLength || !['debit', 'credit'].includes(cardType) || !groupIds.length || !groupIds.every((id) => validGroupIds.has(id)) || overdraftLimit === null || overdraftFeeBps === null || overdraftMinFee === null || overdraftWarningBps === null || (String(req.body.unfreeze_fee ?? '').trim() !== '' && unfreezeFee === null)) {
      return redirectMessage(res, '/admin/bins', 'error', '请填写有效 BIN、卡类型并至少选择一个可用分组。');
    }
    try {
      const now = Date.now();
      db.transaction(() => {
        const result = db.prepare(`
          INSERT INTO bins (name, prefix, brand, card_type, country, number_length, require_3ds,
            overdraft_limit_minor, overdraft_fee_bps, overdraft_min_fee_minor, overdraft_warning_bps, unfreeze_fee_minor,
            is_active, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
        `).run(name, prefix, brand || 'Visa', cardType, country || 'CN', numberLength, require3ds,
          overdraftLimit, overdraftFeeBps, overdraftMinFee, overdraftWarningBps, unfreezeFee, now, now);
        const insert = db.prepare('INSERT INTO bin_groups (bin_id, group_id) VALUES (?, ?)');
        for (const groupId of groupIds) insert.run(Number(result.lastInsertRowid), groupId);
      })();
      return redirectMessage(res, '/admin/bins', 'ok', `BIN ${prefix} 已创建。`);
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) return redirectMessage(res, '/admin/bins', 'error', '该 BIN 前缀已存在。');
      throw error;
    }
  });

  route.post('/bins/:id/update', (req, res) => {
    const id = integer(req.params.id, 1, Number.MAX_SAFE_INTEGER);
    const name = String(req.body.name || '').trim();
    const prefix = String(req.body.prefix || '').replace(/\D/g, '');
    const brand = String(req.body.brand || 'Visa').trim();
    const cardType = String(req.body.card_type || 'debit').trim();
    const country = String(req.body.country || 'CN').trim().toUpperCase();
    const numberLength = integer(req.body.number_length, 12, 19);
    const isActive = req.body.is_active === undefined ? 1 : (req.body.is_active === '1' ? 1 : 0);
    const require3ds = req.body.require_3ds === undefined ? 1 : (req.body.require_3ds === '1' ? 1 : 0);
    const overdraftLimit = moneyInput(req.body.overdraft_limit ?? '5000', { allowZero: true });
    const overdraftFeeBps = integer(req.body.overdraft_fee_bps ?? 500, 0, 10000);
    const overdraftMinFee = moneyInput(req.body.overdraft_min_fee ?? '1', { allowZero: true });
    const overdraftWarningBps = integer(req.body.overdraft_warning_bps ?? 9500, 1, 10000);
    const unfreezeFee = String(req.body.unfreeze_fee ?? '').trim() === '' ? null : moneyInput(req.body.unfreeze_fee, { allowZero: true });
    const groupSelectionProvided = req.body.group_ids_present === '1' || Object.prototype.hasOwnProperty.call(req.body, 'group_ids');
    const groupIds = Object.prototype.hasOwnProperty.call(req.body, 'group_ids')
      ? numericIds(req.body.group_ids)
      : (groupSelectionProvided ? [] : db.prepare('SELECT group_id FROM bin_groups WHERE bin_id = ?').all(id).map((row) => row.group_id));
    const validGroupIds = new Set(db.prepare('SELECT id FROM user_groups').all().map((group) => group.id));
    const existingBin = db.prepare('SELECT card_type FROM bins WHERE id = ?').get(id);
    const existingCardCount = db.prepare('SELECT COUNT(*) AS count FROM cards WHERE bin_id = ?').get(id).count;
    if (!id || !name || prefix.length < 4 || prefix.length > 8 || numberLength === null || prefix.length >= numberLength || !['debit', 'credit'].includes(cardType) || !groupIds.length || !groupIds.every((groupId) => validGroupIds.has(groupId)) || overdraftLimit === null || overdraftFeeBps === null || overdraftMinFee === null || overdraftWarningBps === null || (String(req.body.unfreeze_fee ?? '').trim() !== '' && unfreezeFee === null)) {
      return redirectMessage(res, '/admin/bins', 'error', 'BIN 参数无效。');
    }
    if (existingBin && existingBin.card_type !== cardType && existingCardCount > 0) {
      return redirectMessage(res, '/admin/bins', 'error', '该 BIN 已有虚拟卡，不能直接更改借记卡/信用卡类型。请先清空该 BIN 下的卡。');
    }
    try {
      db.transaction(() => {
        db.prepare(`
          UPDATE bins SET name = ?, prefix = ?, brand = ?, card_type = ?, country = ?, number_length = ?, require_3ds = ?,
            overdraft_limit_minor = ?, overdraft_fee_bps = ?, overdraft_min_fee_minor = ?, overdraft_warning_bps = ?, unfreeze_fee_minor = ?,
            is_active = ?, updated_at = ?
          WHERE id = ?
        `).run(name, prefix, brand || 'Visa', cardType, country || 'CN', numberLength, require3ds,
          overdraftLimit, overdraftFeeBps, overdraftMinFee, overdraftWarningBps, unfreezeFee, isActive, Date.now(), id);
        db.prepare('DELETE FROM bin_groups WHERE bin_id = ?').run(id);
        const insert = db.prepare('INSERT INTO bin_groups (bin_id, group_id) VALUES (?, ?)');
        for (const groupId of groupIds) insert.run(id, groupId);
      })();
      return redirectMessage(res, '/admin/bins', 'ok', 'BIN 已更新。');
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) return redirectMessage(res, '/admin/bins', 'error', '该 BIN 前缀已存在。');
      throw error;
    }
  });

  route.post('/bins/:id/delete', (req, res) => {
    const id = integer(req.params.id, 1, Number.MAX_SAFE_INTEGER);
    if (!id) return redirectMessage(res, '/admin/bins', 'error', 'BIN 不存在。');
    const result = db.transaction(() => {
      const bin = db.prepare('SELECT id, prefix FROM bins WHERE id = ?').get(id);
      if (!bin) return { status: 'missing' };
      const cardCount = db.prepare('SELECT COUNT(*) AS count FROM cards WHERE bin_id = ?').get(id).count;
      if (cardCount > 0) return { status: 'in-use', prefix: bin.prefix, cardCount };
      db.prepare('DELETE FROM bins WHERE id = ?').run(id);
      return { status: 'deleted', prefix: bin.prefix };
    })();
    if (result.status === 'missing') return redirectMessage(res, '/admin/bins', 'error', 'BIN 不存在。');
    if (result.status === 'in-use') {
      return redirectMessage(res, '/admin/bins', 'error', `BIN ${result.prefix} 仍有 ${result.cardCount} 张卡，清空卡片后才能删除。`);
    }
    return redirectMessage(res, '/admin/bins', 'ok', `BIN ${result.prefix} 已删除。`);
  });

  route.get('/cards', (req, res) => {
    const status = String(req.query.status || '');
    const search = String(req.query.q || '').trim();
    const scope = req.user.role === 'admin' ? String(req.query.scope || 'all') : 'own';
    const binId = integer(req.query.bin_id || '', 1, Number.MAX_SAFE_INTEGER);
    const conditions = [];
    const params = [];
    if (req.user.role !== 'admin') {
      conditions.push('c.owner_user_id = ?');
      params.push(req.user.id);
    } else if (scope === 'own') {
      conditions.push('c.owner_user_id = ?');
      params.push(req.user.id);
    } else {
      const access = cardAccessCondition(req);
      if (access.condition) {
        conditions.push(access.condition.replace(/^AND\s+/, ''));
        params.push(...access.params);
      }
    }
    if (allowedCardStatuses.has(status)) { conditions.push('c.status = ?'); params.push(status); }
    if (binId) { conditions.push('c.bin_id = ?'); params.push(binId); }
    if (search) { conditions.push('u.username LIKE ?'); params.push(`%${search}%`); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const cards = db.prepare(`
      SELECT c.*, b.name AS bin_name, b.prefix AS bin_prefix, b.brand, b.card_type, b.require_3ds AS bin_require_3ds,
        b.overdraft_limit_minor AS bin_overdraft_limit_minor, b.overdraft_fee_bps AS bin_overdraft_fee_bps,
        b.overdraft_min_fee_minor AS bin_overdraft_min_fee_minor, b.overdraft_warning_bps AS bin_overdraft_warning_bps,
        b.unfreeze_fee_minor AS bin_unfreeze_fee_minor,
        u.username AS owner_username, u.uid AS owner_uid
      FROM cards c JOIN bins b ON b.id = c.bin_id LEFT JOIN users u ON u.id = c.owner_user_id
      ${where} ORDER BY c.created_at DESC LIMIT 300
    `).all(...params).map((row) => mapCard(row, config.appSecret, false));
    res.render('admin/cards', {
      title: '虚拟卡管理', cards, status, search, scope, binId,
      bins: db.prepare('SELECT id, name, prefix, card_type FROM bins ORDER BY name').all(),
      isAdmin: req.user.role === 'admin'
    });
  });

  route.post('/cards/batch', adminOnly, (req, res) => {
    const cardIds = [...new Set([].concat(req.body.card_ids || []).map((id) => String(id || '').trim()).filter(Boolean))];
    const action = String(req.body.action || '');
    if (!cardIds.length || !['decline', 'freeze', 'unfreeze', 'add_balance', 'subtract_balance', 'set_limit', 'delete'].includes(action)) {
      return redirectMessage(res, '/admin/cards', 'error', '请选择虚拟卡和有效的批量操作。');
    }
    const rows = db.prepare(`
      SELECT c.*, b.name AS bin_name, b.prefix AS bin_prefix, b.brand, b.card_type, b.require_3ds AS bin_require_3ds,
        b.overdraft_limit_minor AS bin_overdraft_limit_minor, b.overdraft_fee_bps AS bin_overdraft_fee_bps,
        b.overdraft_min_fee_minor AS bin_overdraft_min_fee_minor, b.overdraft_warning_bps AS bin_overdraft_warning_bps,
        b.unfreeze_fee_minor AS bin_unfreeze_fee_minor,
        u.username AS owner_username, u.uid AS owner_uid, u.role AS owner_role
      FROM cards c JOIN bins b ON b.id = c.bin_id LEFT JOIN users u ON u.id = c.owner_user_id
      WHERE c.id IN (${cardIds.map(() => '?').join(',')})
    `).all(...cardIds);
    const eligible = rows.filter((row) => canManageCardOwner(req.user, db.prepare('SELECT * FROM users WHERE id = ?').get(Number(row.owner_user_id))));
    if (!eligible.length) return redirectMessage(res, '/admin/cards', 'error', '所选卡片均无权由当前管理员管理。');
    const amount = ['add_balance', 'subtract_balance'].includes(action) ? moneyInput(req.body.amount, { allowZero: false }) : null;
    if (['add_balance', 'subtract_balance'].includes(action) && amount === null) return redirectMessage(res, '/admin/cards', 'error', '请输入有效的批量金额。');
    const limitMode = req.body.limit_mode === 'custom' ? 'custom' : 'inherit';
    const limitMinor = limitMode === 'custom' ? moneyInput(req.body.limit_amount, { allowZero: true }) : null;
    if (action === 'set_limit' && limitMode === 'custom' && limitMinor === null) return redirectMessage(res, '/admin/cards', 'error', '请输入有效的卡片单笔消费限额。');
    const reason = String(req.body.reason || (action === 'decline' ? '批量模拟拒付' : '批量风控冻结')).trim().slice(0, 200);
    let skipped = rows.length - eligible.length;
    const failedPendingOrderIds = [];
    db.transaction(() => {
      for (const row of eligible) {
        const card = mapCard(row, config.appSecret, false);
        if (action === 'decline') {
          db.prepare("UPDATE cards SET status = 'declined', decline_reason = ?, freeze_source = 'none', freeze_code = NULL, updated_at = ? WHERE id = ?").run(reason || '批量模拟拒付', Date.now(), card.id);
        } else if (action === 'freeze') {
          db.prepare("UPDATE cards SET status = 'frozen', decline_reason = ?, freeze_source = 'admin', freeze_code = 'ADMIN', updated_at = ? WHERE id = ?").run(reason || '批量风控冻结', Date.now(), card.id);
        } else if (action === 'unfreeze') {
          db.prepare("UPDATE cards SET status = 'active', decline_reason = NULL, freeze_source = 'none', freeze_code = NULL, consecutive_failures = 0, updated_at = ? WHERE id = ?").run(Date.now(), card.id);
        } else if (action === 'set_limit') {
          db.prepare('UPDATE cards SET spend_limit_mode = ?, spend_limit_minor = ?, updated_at = ? WHERE id = ?').run(limitMode, limitMinor, Date.now(), card.id);
        } else if (action === 'add_balance' || action === 'subtract_balance') {
          const delta = action === 'add_balance' ? amount : -amount;
          const next = Number(row.balance_minor) + delta;
          const overdraft = resolvedOverdraft(row);
          if (next < (overdraft.enabled ? -overdraft.limitMinor : 0)) { skipped += 1; continue; }
          db.prepare('UPDATE cards SET balance_minor = ?, updated_at = ? WHERE id = ?').run(next, Date.now(), card.id);
          db.prepare(`INSERT INTO card_transactions (card_id, order_id, type, amount_minor, balance_after_minor, note, created_at)
            VALUES (?, NULL, 'ADJUSTMENT', ?, ?, ?, ?)`).run(card.id, delta, next, `管理员批量${delta >= 0 ? '增加' : '减少'}余额`, Date.now());
        } else if (action === 'delete') {
          const unsettledPaid = db.prepare("SELECT COUNT(*) AS count FROM orders WHERE card_id = ? AND status = 'PAID' AND settled_at IS NULL").get(card.id).count;
          if (unsettledPaid) { skipped += 1; continue; }
          failedPendingOrderIds.push(...db.prepare("SELECT id FROM orders WHERE card_id = ? AND status = 'PENDING'").all(card.id).map((order) => order.id));
          db.prepare("UPDATE orders SET status = 'FAILED', card_id = NULL, closed_at = ?, callback_event = 'CARD_DELETED_BY_ADMIN' WHERE card_id = ? AND status = 'PENDING'").run(Date.now(), card.id);
          db.prepare('UPDATE orders SET card_id = NULL WHERE card_id = ?').run(card.id);
          db.prepare('DELETE FROM card_transactions WHERE card_id = ?').run(card.id);
          db.prepare('DELETE FROM cards WHERE id = ?').run(card.id);
        }
      }
    })();
    for (const orderId of failedPendingOrderIds) notification.enqueue(orderId);
    return redirectMessage(res, '/admin/cards', 'ok', `批量操作已处理 ${eligible.length - Math.max(0, skipped - (rows.length - eligible.length))} 张卡${skipped ? `，跳过 ${skipped} 张无权限或不符合条件的卡` : ''}。`);
  });

  route.get('/cards/new', (req, res) => {
    const bins = req.user.role === 'admin'
      ? db.prepare('SELECT * FROM bins WHERE is_active = 1 ORDER BY name').all()
      : db.prepare(`SELECT DISTINCT b.* FROM bins b JOIN bin_groups bg ON bg.bin_id = b.id WHERE b.is_active = 1 AND bg.group_id = ? ORDER BY b.name`).all(req.user.groupId);
    const users = req.user.role === 'admin' ? manageableCardOwners(req.user) : [];
    const group = db.prepare('SELECT * FROM user_groups WHERE id = ?').get(req.user.groupId);
    res.render('admin/card-new', { title: '创建虚拟卡', bins, users, group, error: null, form: {}, isAdmin: req.user.role === 'admin', currentUser: req.user });
  });

  route.post('/cards', (req, res) => {
    const isAdmin = req.user.role === 'admin';
    const users = isAdmin ? manageableCardOwners(req.user) : [];
    let ownerId = req.user.id;
    if (isAdmin && req.body.owner_user_id) {
      const requestedOwnerId = integer(req.body.owner_user_id, 1, Number.MAX_SAFE_INTEGER);
      if (!requestedOwnerId || !users.some((user) => user.id === requestedOwnerId)) return denyCardManagement(res);
      ownerId = requestedOwnerId;
    }
    const owner = db.prepare(`SELECT u.*, g.card_limit, g.card_bonus_minor FROM users u LEFT JOIN user_groups g ON g.id = u.group_id WHERE u.id = ?`).get(ownerId);
    const bins = owner?.role === 'admin'
      ? db.prepare('SELECT * FROM bins WHERE is_active = 1 ORDER BY name').all()
      : db.prepare(`SELECT DISTINCT b.* FROM bins b JOIN bin_groups bg ON bg.bin_id = b.id WHERE b.is_active = 1 AND bg.group_id = ? ORDER BY b.name`).all(owner?.group_id);
    const binId = integer(req.body.bin_id, 1, Number.MAX_SAFE_INTEGER);
    const bin = bins.find((item) => item.id === binId);
    const expiresMonth = integer(req.body.expires_month, 1, 12);
    const expiresYear = normalizeYear(req.body.expires_year);
    const cvv = String(req.body.cvv || '').trim();
    let pin = String(req.body.pin || '').trim();
    const status = isAdmin ? String(req.body.status || 'active') : 'active';
    const declineReason = isAdmin ? String(req.body.decline_reason || '').trim() : '';
    const balanceMinor = isAdmin ? signedMoneyInput(req.body.balance ?? '0') : 0;
    const spendLimitMode = req.body.spend_limit_mode === 'custom' ? 'custom' : 'inherit';
    const spendLimitMinor = spendLimitMode === 'custom' ? moneyInput(req.body.spend_limit, { allowZero: true }) : null;
    const overdraftMode = req.body.overdraft_mode === 'custom' ? 'custom' : 'inherit';
    const overdraftLimitMinor = overdraftMode === 'custom' ? moneyInput(req.body.overdraft_limit ?? '5000', { allowZero: true }) : null;
    const overdraftFeeBps = overdraftMode === 'custom' ? integer(req.body.overdraft_fee_bps ?? '500', 0, 10000) : null;
    const overdraftMinFeeMinor = overdraftMode === 'custom' ? moneyInput(req.body.overdraft_min_fee ?? '0.01', { allowZero: true }) : null;
    const overdraftWarningBps = overdraftMode === 'custom' ? integer(req.body.overdraft_warning_bps ?? '9500', 1, 10000) : null;
    if (!pin && bin && !bin.require_3ds) pin = randomDigits(6);
    const cardCount = db.prepare('SELECT COUNT(*) AS count FROM cards WHERE owner_user_id = ?').get(ownerId).count;
    const overCardLimit = owner?.role !== 'admin' && cardCount >= Number(owner?.card_limit || 0);
    const overBalanceLimit = owner?.card_balance_limit_minor !== null && owner?.card_balance_limit_minor !== undefined && balanceMinor > owner.card_balance_limit_minor;
    const plannedCard = {
      cardType: bin?.card_type, balanceMinor, overdraftMode, overdraftLimitMinor, overdraftFeeBps,
      overdraftMinFeeMinor, overdraftWarningBps, binOverdraftLimitMinor: bin?.overdraft_limit_minor,
      binOverdraftFeeBps: bin?.overdraft_fee_bps, binOverdraftMinFeeMinor: bin?.overdraft_min_fee_minor,
      binOverdraftWarningBps: bin?.overdraft_warning_bps
    };
    const plannedOverdraft = resolvedOverdraft(plannedCard);
    const invalidNegativeBalance = balanceMinor < (plannedOverdraft.enabled ? -plannedOverdraft.limitMinor : 0);
    const currentYear = new Date().getFullYear();
    if (!owner || !bin || overCardLimit || overBalanceLimit || expiresMonth === null || expiresYear === null || expiresYear < currentYear || expiresYear > currentYear + 30 || !/^\d{3,4}$/.test(cvv) || (bin.require_3ds && (pin.length < 4 || pin.length > 64)) || (pin && (pin.length < 4 || pin.length > 64)) || balanceMinor === null || invalidNegativeBalance || (spendLimitMode === 'custom' && spendLimitMinor === null) || (overdraftMode === 'custom' && (overdraftLimitMinor === null || overdraftFeeBps === null || overdraftMinFeeMinor === null || overdraftWarningBps === null)) || !allowedCardStatuses.has(status)) {
      return res.status(400).render('admin/card-new', {
        title: '创建虚拟卡', bins, users,
        group: db.prepare('SELECT * FROM user_groups WHERE id = ?').get(owner?.group_id),
        error: overCardLimit ? '已达到当前分组的开卡数量上限。' : (overBalanceLimit ? '初始余额超过账号卡面额度。' : (invalidNegativeBalance ? '负余额超过该卡可用透支额度。' : '请检查卡片参数、限额、BIN 分组权限和 3DS 配置。')),
        form: req.body, isAdmin, currentUser: req.user
      });
    }
    const cardNumber = generateCardNumber(bin.prefix, bin.number_length);
    if (!luhnValid(cardNumber)) throw new Error('Generated invalid card number');
    const cardId = `CARD-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
    const now = Date.now();
    db.transaction(() => {
      db.prepare(`
        INSERT INTO cards (
          id, owner_user_id, bin_id, card_number_enc, card_number_hash, last4, expires_month, expires_year, cvv_enc, pin_enc,
          balance_minor, currency, status, decline_reason, freeze_source, freeze_code, spend_limit_mode, spend_limit_minor, overdraft_mode,
          overdraft_limit_minor, overdraft_fee_bps, overdraft_min_fee_minor, overdraft_warning_bps, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        cardId, ownerId, bin.id, encrypt(cardNumber, config.appSecret), cardNumberHash(cardNumber, config.appSecret),
        cardNumber.slice(-4), expiresMonth, expiresYear, encrypt(cvv, config.appSecret), encrypt(pin, config.appSecret), balanceMinor,
        getSetting(db, 'default_currency', 'CNY'), status, status === 'declined' ? declineReason || '测试拒付' : null,
        status === 'frozen' ? 'admin' : 'none', status === 'frozen' ? 'ADMIN' : null,
        spendLimitMode, spendLimitMinor, overdraftMode, overdraftLimitMinor, overdraftFeeBps, overdraftMinFeeMinor,
        overdraftWarningBps, now, now
      );
      db.prepare(`
        INSERT INTO card_transactions (card_id, order_id, type, amount_minor, balance_after_minor, note, created_at)
        VALUES (?, NULL, 'INITIAL', ?, ?, 'Initial balance', ?)
      `).run(cardId, balanceMinor, balanceMinor, now);
    })();
    res.redirect(`/admin/cards/${cardId}?ok=${encodeURIComponent('虚拟卡已创建。')}`);
  });

  route.get('/cards/:id', (req, res) => {
    const access = cardAccessCondition(req);
    const row = db.prepare(`
      SELECT c.*, b.name AS bin_name, b.prefix AS bin_prefix, b.brand, b.card_type, b.require_3ds AS bin_require_3ds,
        b.overdraft_limit_minor AS bin_overdraft_limit_minor, b.overdraft_fee_bps AS bin_overdraft_fee_bps,
        b.overdraft_min_fee_minor AS bin_overdraft_min_fee_minor, b.overdraft_warning_bps AS bin_overdraft_warning_bps,
        b.unfreeze_fee_minor AS bin_unfreeze_fee_minor,
        u.username AS owner_username, u.uid AS owner_uid
      FROM cards c
      JOIN bins b ON b.id = c.bin_id
      LEFT JOIN users u ON u.id = c.owner_user_id
      WHERE c.id = ? ${access.condition}
    `).get(req.params.id, ...access.params);
    if (!row) return res.status(404).render('error', { title: '卡片不存在', message: '未找到该虚拟卡。', statusCode: 404 });
    const card = mapCard(row, config.appSecret, true);
    const transactions = db.prepare(`
      SELECT t.*, o.trade_no FROM card_transactions t
      LEFT JOIN orders o ON o.id = t.order_id
      WHERE t.card_id = ? ORDER BY t.created_at DESC LIMIT 50
    `).all(card.id);
    const orders = db.prepare(`
      SELECT o.*, m.pid AS merchant_pid, m.name AS merchant_name, c.last4 AS card_last4
      FROM orders o JOIN merchants m ON m.id = o.merchant_id LEFT JOIN cards c ON c.id = o.card_id
      WHERE o.card_id = ? ORDER BY o.created_at DESC LIMIT 20
    `).all(card.id).map(mapOrder);
    const users = req.user.role === 'admin' ? manageableCardOwners(req.user) : [];
    res.render('admin/card-detail', {
      title: `虚拟卡 ${card.id}`,
      card,
      transactions,
      orders,
      users,
      isAdmin: req.user.role === 'admin',
      isSuperAdmin: isSuperAdmin(req.user),
      cardSpendLimitMinor: cardSpendLimit(db, card),
      overdraft: resolvedOverdraft(card)
    });
  });

  route.post('/cards/:id/update', adminOnly, (req, res) => {
    const card = cardById(db, config.appSecret, req.params.id, false);
    if (!card) return redirectMessage(res, '/admin/cards', 'error', '虚拟卡不存在。');
    if (!canManageCardOwner(req.user, userById(db, card.ownerUserId))) return denyCardManagement(res);
    const rawCard = db.prepare('SELECT * FROM cards WHERE id = ?').get(card.id);
    const status = String(req.body.status || card.status);
    const declineReason = String(req.body.decline_reason || '').trim();
    const balanceMinor = signedMoneyInput(req.body.balance);
    const expiresMonth = integer(req.body.expires_month, 1, 12);
    const expiresYear = normalizeYear(req.body.expires_year);
    const newPin = String(req.body.pin || '').trim();
    const newCvv = String(req.body.cvv || '').trim();
    const spendLimitMode = req.body.spend_limit_mode === 'custom' ? 'custom' : 'inherit';
    const spendLimitMinor = spendLimitMode === 'custom' ? moneyInput(req.body.spend_limit, { allowZero: true }) : null;
    const overdraftMode = req.body.overdraft_mode === 'custom' ? 'custom' : 'inherit';
    const overdraftLimitMinor = overdraftMode === 'custom' ? moneyInput(req.body.overdraft_limit ?? '5000', { allowZero: true }) : null;
    const overdraftFeeBps = overdraftMode === 'custom' ? integer(req.body.overdraft_fee_bps ?? '500', 0, 10000) : null;
    const overdraftMinFeeMinor = overdraftMode === 'custom' ? moneyInput(req.body.overdraft_min_fee ?? '0.01', { allowZero: true }) : null;
    const overdraftWarningBps = overdraftMode === 'custom' ? integer(req.body.overdraft_warning_bps ?? '9500', 1, 10000) : null;
    let ownerId = card.ownerUserId;
    if (req.body.owner_user_id) {
      const requestedOwnerId = integer(req.body.owner_user_id, 1, Number.MAX_SAFE_INTEGER);
      const requestedOwner = requestedOwnerId ? db.prepare('SELECT * FROM users WHERE id = ? AND is_active = 1').get(requestedOwnerId) : null;
      if (!requestedOwner) return redirectMessage(res, `/admin/cards/${card.id}`, 'error', '目标用户不存在或已停用。');
      if (!canManageCardOwner(req.user, mapUser(requestedOwner))) return denyCardManagement(res);
      ownerId = requestedOwnerId;
    }
    const planned = {
      ...card, balanceMinor, overdraftMode, overdraftLimitMinor, overdraftFeeBps,
      overdraftMinFeeMinor, overdraftWarningBps
    };
    const overdraft = resolvedOverdraft(planned);
    const invalidNegativeBalance = balanceMinor !== null && balanceMinor < (overdraft.enabled ? -overdraft.limitMinor : 0);
    if (!allowedCardStatuses.has(status) || balanceMinor === null || invalidNegativeBalance || expiresMonth === null || expiresYear === null || (newPin && (newPin.length < 4 || newPin.length > 64)) || (newCvv && !/^\d{3,4}$/.test(newCvv)) || (spendLimitMode === 'custom' && spendLimitMinor === null) || (overdraftMode === 'custom' && (overdraftLimitMinor === null || overdraftFeeBps === null || overdraftMinFeeMinor === null || overdraftWarningBps === null))) {
      return redirectMessage(res, `/admin/cards/${card.id}`, 'error', '卡片参数无效。');
    }
    const freezeSource = status === 'frozen' ? (card.status === 'frozen' ? card.freezeSource : 'admin') : 'none';
    const freezeCode = status === 'frozen' ? (card.status === 'frozen' ? card.freezeCode : 'ADMIN') : null;
    db.transaction(() => {
      db.prepare(`
        UPDATE cards SET owner_user_id = ?, status = ?, decline_reason = ?, balance_minor = ?, expires_month = ?, expires_year = ?,
          pin_enc = ?, cvv_enc = ?, freeze_source = ?, freeze_code = ?, consecutive_failures = CASE WHEN ? = 'active' THEN 0 ELSE consecutive_failures END,
          spend_limit_mode = ?, spend_limit_minor = ?, overdraft_mode = ?, overdraft_limit_minor = ?, overdraft_fee_bps = ?,
          overdraft_min_fee_minor = ?, overdraft_warning_bps = ?, updated_at = ? WHERE id = ?
      `).run(
        ownerId,
        status,
        status === 'declined' ? declineReason || '测试拒付' : null,
        balanceMinor,
        expiresMonth,
        expiresYear,
        newPin ? encrypt(newPin, config.appSecret) : rawCard.pin_enc,
        newCvv ? encrypt(newCvv, config.appSecret) : rawCard.cvv_enc,
        freezeSource,
        freezeCode,
        status,
        spendLimitMode,
        spendLimitMinor,
        overdraftMode,
        overdraftLimitMinor,
        overdraftFeeBps,
        overdraftMinFeeMinor,
        overdraftWarningBps,
        Date.now(),
        card.id
      );
      if (balanceMinor !== card.balanceMinor) {
        db.prepare(`
          INSERT INTO card_transactions (card_id, order_id, type, amount_minor, balance_after_minor, note, created_at)
          VALUES (?, NULL, 'ADJUSTMENT', ?, ?, 'Admin balance adjustment', ?)
        `).run(card.id, balanceMinor - card.balanceMinor, balanceMinor, Date.now());
      }
    })();
    redirectMessage(res, `/admin/cards/${card.id}`, 'ok', '卡片信息已更新。');
  });

  route.post('/cards/:id/decline', adminOnly, (req, res) => {
    const card = cardById(db, config.appSecret, req.params.id, false);
    if (!card) return redirectMessage(res, '/admin/cards', 'error', '虚拟卡不存在。');
    if (!canManageCardOwner(req.user, userById(db, card.ownerUserId))) return denyCardManagement(res);
    const nextStatus = card.status === 'declined' ? 'active' : 'declined';
    const reason = String(req.body.reason || '模拟拒付').trim() || '模拟拒付';
    db.prepare("UPDATE cards SET status = ?, decline_reason = ?, freeze_source = 'none', freeze_code = NULL, consecutive_failures = CASE WHEN ? = 'active' THEN 0 ELSE consecutive_failures END, updated_at = ? WHERE id = ?")
      .run(nextStatus, nextStatus === 'declined' ? reason : null, nextStatus, Date.now(), card.id);
    const message = nextStatus === 'declined' ? '已开启模拟拒付。' : '已恢复为可支付状态。';
    redirectMessage(res, `/admin/cards/${card.id}`, 'ok', message);
  });

  route.post('/cards/:id/unfreeze', adminOnly, (req, res) => {
    const card = cardById(db, config.appSecret, req.params.id, false);
    if (!card) return redirectMessage(res, '/admin/cards', 'error', '虚拟卡不存在。');
    if (!canManageCardOwner(req.user, userById(db, card.ownerUserId))) return denyCardManagement(res);
    try {
      unfreezeCard({ db, card, actor: req.user, selfService: false });
      return redirectMessage(res, `/admin/cards/${card.id}`, 'ok', '虚拟卡已解冻，管理员操作不收取解冻费。');
    } catch (error) {
      return redirectMessage(res, `/admin/cards/${card.id}`, 'error', error.message);
    }
  });

  route.post('/cards/:id/consume', adminOnly, (req, res) => {
    const amountMinor = moneyInput(req.body.amount, { allowZero: false });
    const note = String(req.body.note || '管理员手工消费').trim().slice(0, 120) || '管理员手工消费';
    if (amountMinor === null) return redirectMessage(res, `/admin/cards/${req.params.id}`, 'error', '消费金额必须大于 0。');
    const existingCard = cardById(db, config.appSecret, req.params.id, false);
    if (!existingCard) return redirectMessage(res, '/admin/cards', 'error', '虚拟卡不存在。');
    if (!canManageCardOwner(req.user, userById(db, existingCard.ownerUserId))) return denyCardManagement(res);
    try {
      let debit;
      let failure = null;
      db.transaction(() => {
        const card = cardById(db, config.appSecret, req.params.id, false);
        if (!card) throw new EpayError('虚拟卡不存在。', 'CARD_NOT_FOUND', 404);
        const limit = cardSpendLimit(db, card);
        if (limit !== null && amountMinor > limit) {
          throw new EpayError(`单笔消费超过该卡限额 CNY ${(limit / 100).toFixed(2)}。`, 'SPEND_LIMIT_EXCEEDED', 409);
        }
        debit = applyCardDebit(db, card, amountMinor, { note });
        if (!debit.ok) {
          failure = recordInsufficientFailure(db, card, debit.code);
          return;
        }
        maybeFreezeForOverdraftWarning(db, card, debit.nextBalanceMinor, debit.config);
      })();
      if (failure) throw new EpayError(`${debit.message}${failure.frozen ? '；连续 5 次失败，卡片已自动冻结' : ''}`, 'INSUFFICIENT_FUNDS', 409);
      redirectMessage(res, `/admin/cards/${req.params.id}`, 'ok', '手工消费已记录。');
    } catch (error) {
      if (error instanceof EpayError) return redirectMessage(res, `/admin/cards/${req.params.id}`, 'error', error.message);
      throw error;
    }
  });

  route.post('/cards/:id/delete', adminOnly, (req, res) => {
    const ownedCard = cardById(db, config.appSecret, req.params.id, false);
    if (!ownedCard) return redirectMessage(res, '/admin/cards', 'error', '虚拟卡不存在。');
    if (!canManageCardOwner(req.user, userById(db, ownedCard.ownerUserId))) return denyCardManagement(res);
    const result = db.transaction(() => {
      const card = db.prepare('SELECT id, balance_minor, status FROM cards WHERE id = ?').get(req.params.id);
      if (!card) return { status: 'missing' };
      const unsettledPaid = db.prepare("SELECT COUNT(*) AS count FROM orders WHERE card_id = ? AND status = 'PAID' AND settled_at IS NULL").get(card.id).count;
      if (unsettledPaid > 0) return { status: 'in-use', cardId: card.id, pendingOrderCount: unsettledPaid };
      const pendingOrderCount = db.prepare("SELECT COUNT(*) AS count FROM orders WHERE card_id = ? AND status = 'PENDING'").get(card.id).count;
      const pendingOrderIds = db.prepare("SELECT id FROM orders WHERE card_id = ? AND status = 'PENDING'").all(card.id).map((order) => order.id);
      db.prepare("UPDATE orders SET status = 'FAILED', card_id = NULL, closed_at = ?, callback_event = 'CARD_DELETED_BY_ADMIN' WHERE card_id = ? AND status = 'PENDING'").run(Date.now(), card.id);
      db.prepare('UPDATE orders SET card_id = NULL WHERE card_id = ?').run(card.id);
      db.prepare('DELETE FROM card_transactions WHERE card_id = ?').run(card.id);
      db.prepare('DELETE FROM cards WHERE id = ?').run(card.id);
      return { status: 'deleted', cardId: card.id, pendingOrderCount, pendingOrderIds };
    })();
    if (result.status === 'missing') return redirectMessage(res, '/admin/cards', 'error', '虚拟卡不存在。');
    if (result.status === 'in-use') {
      return redirectMessage(res, `/admin/cards/${result.cardId}`, 'error', `该卡仍有 ${result.pendingOrderCount} 个待结算订单，必须先处理退款窗口后才能删除。`);
    }
    for (const orderId of result.pendingOrderIds) notification.enqueue(orderId);
    return redirectMessage(res, '/admin/cards', 'ok', result.pendingOrderCount ? '虚拟卡已删除，未完成支付订单已置为失败。' : '虚拟卡已强制删除。');
  });

  route.get('/orders', (req, res) => {
    const status = String(req.query.status || '').trim().toUpperCase();
    const search = String(req.query.q || '').trim();
    const allowedStatuses = new Set(['PENDING', 'PAID', 'EXPIRED', 'FAILED', 'CHARGEBACK']);
    const scope = orderScope(req);
    const conditions = [];
    const params = [];
    if (scope.condition) {
      conditions.push(scope.condition);
      params.push(...scope.params);
    }
    if (allowedStatuses.has(status)) {
      conditions.push('o.status = ?');
      params.push(status);
    }
    if (search) {
      conditions.push('(o.trade_no LIKE ? OR o.out_trade_no LIKE ? OR m.pid LIKE ?)');
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    const query = orderQuery(conditions.length ? `WHERE ${conditions.join(' AND ')}` : '', params, 500);
    const orders = db.prepare(query.sql).all(...query.params).map(mapOrder);
    res.render('admin/orders', {
      title: req.user.role === 'admin' ? '订单管理' : '我的订单',
      orders,
      status,
      search,
      isAdmin: req.user.role === 'admin',
      ordersLiveFingerprint: orderFingerprint(req),
      autoRefreshSeconds: orders.some((order) => order.status === 'PENDING') ? 5 : null
    });
  });

  route.get('/orders/live', (req, res) => {
    res.set('Cache-Control', 'no-store').json({ fingerprint: orderFingerprint(req) });
  });

  route.get('/orders/:id', (req, res) => {
    const id = integer(req.params.id, 1, Number.MAX_SAFE_INTEGER);
    const scope = orderScope(req);
    const extraCondition = scope.condition ? `AND ${scope.condition}` : '';
    const row = id ? db.prepare(`
      SELECT o.*, m.pid AS merchant_pid, m.name AS merchant_name, c.last4 AS card_last4,
        u.uid AS payer_uid, u.username AS payer_username
      FROM orders o JOIN merchants m ON m.id = o.merchant_id LEFT JOIN cards c ON c.id = o.card_id
      LEFT JOIN users u ON u.id = o.payer_user_id
      WHERE o.id = ? ${extraCondition}
    `).get(id, ...scope.params) : null;
    if (!row) return res.status(404).render('error', { title: '订单不存在', message: '未找到该订单。', statusCode: 404 });
    const logs = db.prepare('SELECT * FROM callback_logs WHERE order_id = ? ORDER BY attempted_at DESC').all(id);
    const order = mapOrder(row);
    const merchantRow = db.prepare('SELECT * FROM merchants WHERE id = ?').get(order.merchantId);
    const merchant = mapMerchant(merchantRow, config.appSecret, isSuperAdmin(req.user));
    const orderContext = renderOrderContext(order, merchant);
    res.render('admin/order-detail', {
      title: `订单 ${order.tradeNo}`,
      order: orderContext,
      logs,
      merchant,
      isAdmin: req.user.role === 'admin',
      isSuperAdmin: isSuperAdmin(req.user),
      canRefund: canRefundOrder(req.user, orderContext),
      ordersLiveFingerprint: orderFingerprint(req),
      autoRefreshSeconds: order.status === 'PENDING' ? 3 : null
    });
  });

  route.post('/orders/:id/resend', adminOnly, (req, res) => {
    const id = integer(req.params.id, 1, Number.MAX_SAFE_INTEGER);
    const scope = orderScope(req);
    const allowed = id ? db.prepare(`SELECT o.id FROM orders o WHERE o.id = ? ${scope.condition ? `AND ${scope.condition}` : ''}`).get(id, ...scope.params) : null;
    if (!allowed) return redirectMessage(res, '/admin/orders', 'error', '订单不存在或无权操作。');
    notification.enqueue(id, { force: true });
    redirectMessage(res, `/admin/orders/${id}`, 'ok', '已提交异步回调，结果会在回调记录中显示。');
  });

  route.post('/orders/:id/chargeback', adminOnly, (req, res) => {
    const id = integer(req.params.id, 1, Number.MAX_SAFE_INTEGER);
    const scope = orderScope(req);
    const row = id ? db.prepare(`SELECT o.* FROM orders o WHERE o.id = ? ${scope.condition ? `AND ${scope.condition}` : ''}`).get(id, ...scope.params) : null;
    if (!row) return res.status(404).render('error', { title: '订单不存在', message: '未找到该订单。', statusCode: 404 });
    const order = mapOrder(row);
    if (!canRefundOrder(req.user, order)) {
      return res.status(403).render('error', {
        title: '没有退款权限',
        message: '管理员只能拒付/退款信用卡支付订单。',
        statusCode: 403
      });
    }
    try {
      const refundedOrder = simulateChargeback({ db, orderId: id });
      notification.enqueue(refundedOrder.id, { force: true });
      return redirectMessage(res, `/admin/orders/${id}`, 'ok', '退款已完成，金额已按原支付渠道退回。');
    } catch (error) {
      if (error instanceof EpayError) return redirectMessage(res, `/admin/orders/${id}`, 'error', error.message);
      throw error;
    }
  });


  route.get('/merchants', (req, res) => {
    const rows = db.prepare('SELECT * FROM merchants WHERE deleted_at IS NULL ORDER BY created_at DESC').all();
    const merchants = rows.map((row) => mapMerchant(row, config.appSecret));
    res.render('admin/merchants', { title: '商户管理', merchants });
  });

  route.post('/merchants', (req, res) => {
    const pid = String(req.body.pid || '').trim();
    const name = String(req.body.name || '').trim();
    const key = String(req.body.key || '').trim() || randomToken(24);
    if (!/^[A-Za-z0-9_-]{2,32}$/.test(pid) || !name || key.length < 8) {
      return redirectMessage(res, '/admin/merchants', 'error', '商户 PID 需为 2-32 位字母数字，密钥至少 8 位。');
    }
    try {
      const now = Date.now();
      db.prepare(`
        INSERT INTO merchants (pid, name, key_enc, is_active, created_at, updated_at)
        VALUES (?, ?, ?, 1, ?, ?)
      `).run(pid, name, encrypt(key, config.appSecret), now, now);
      redirectMessage(res, '/admin/merchants', 'ok', `商户 ${pid} 已创建。`);
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) return redirectMessage(res, '/admin/merchants', 'error', '该商户 PID 已存在。');
      throw error;
    }
  });

  route.post('/merchants/:id/update', (req, res) => {
    const id = integer(req.params.id, 1, Number.MAX_SAFE_INTEGER);
    const name = String(req.body.name || '').trim();
    const isActive = req.body.is_active === '1' ? 1 : 0;
    const commissionBps = integer(req.body.commission_bps, 0, 10000);
    if (!id || !name || commissionBps === null) return redirectMessage(res, '/admin/merchants', 'error', '商户参数无效。');
    db.prepare('UPDATE merchants SET name = ?, is_active = ?, commission_bps = ?, updated_at = ? WHERE id = ?').run(name, isActive, commissionBps, Date.now(), id);
    redirectMessage(res, '/admin/merchants', 'ok', '商户信息已更新。');
  });

  route.post('/merchants/:id/rotate', (req, res) => {
    const id = integer(req.params.id, 1, Number.MAX_SAFE_INTEGER);
    if (!id) return redirectMessage(res, '/admin/merchants', 'error', '商户不存在。');
    const key = randomToken(24);
    db.prepare('UPDATE merchants SET key_enc = ?, updated_at = ? WHERE id = ?').run(encrypt(key, config.appSecret), Date.now(), id);
    redirectMessage(res, '/admin/merchants', 'ok', `商户密钥已轮换，新密钥：${key}`);
  });

  route.get('/merchants/:id', (req, res) => {
    const merchantRow = db.prepare('SELECT * FROM merchants WHERE id = ?').get(Number(req.params.id));
    if (!merchantRow) return res.status(404).render('error', { title: '商户不存在', message: '未找到该商户。', statusCode: 404 });
    const merchant = mapMerchant(merchantRow, config.appSecret);
    const transactions = db.prepare('SELECT * FROM merchant_transactions WHERE merchant_id = ? ORDER BY created_at DESC LIMIT 200').all(merchant.id);
    const orders = db.prepare(`
      SELECT o.*, m.pid AS merchant_pid, m.name AS merchant_name, c.last4 AS card_last4,
        u.uid AS payer_uid, u.username AS payer_username
      FROM orders o JOIN merchants m ON m.id = o.merchant_id LEFT JOIN cards c ON c.id = o.card_id
      LEFT JOIN users u ON u.id = o.payer_user_id WHERE o.merchant_id = ? ORDER BY o.created_at DESC LIMIT 200
    `).all(merchant.id).map(mapOrder);
    const refunds = db.prepare('SELECT r.*, o.trade_no FROM refunds r JOIN orders o ON o.id = r.order_id WHERE r.merchant_id = ? ORDER BY r.created_at DESC LIMIT 100').all(merchant.id);
    res.render('admin/merchant-detail', { title: `商户 ${merchant.pid}`, merchant, transactions, orders, refunds, currentTime: Date.now() });
  });

  route.post('/merchants/:id/balance', (req, res) => {
    const id = integer(req.params.id, 1, Number.MAX_SAFE_INTEGER);
    const merchant = id ? db.prepare('SELECT * FROM merchants WHERE id = ?').get(id) : null;
    const operation = String(req.body.operation || 'add');
    const amount = moneyInput(req.body.amount, operation === 'set');
    if (!merchant || merchant.deleted_at || amount === null || !['add', 'subtract', 'set'].includes(operation)) return redirectMessage(res, '/admin/merchants', 'error', '商户余额参数无效。');
    const delta = operation === 'add' ? amount : (operation === 'subtract' ? -amount : amount - merchant.balance_minor);
    const nextBalance = merchant.balance_minor + delta;
    if (nextBalance < 0) return redirectMessage(res, `/admin/merchants/${id}`, 'error', '商户余额不能为负数。');
    db.transaction(() => {
      db.prepare('UPDATE merchants SET balance_minor = ?, updated_at = ? WHERE id = ?').run(nextBalance, Date.now(), id);
      db.prepare(`INSERT INTO merchant_transactions (merchant_id, order_id, type, amount_minor, balance_after_minor, reference, note, created_at)
        VALUES (?, NULL, 'ADMIN_ADJUSTMENT', ?, ?, ?, '管理员调整商户余额', ?)`)
        .run(id, delta, nextBalance, `ADJ:${Date.now()}:${randomToken(8)}`, Date.now());
    })();
    return redirectMessage(res, `/admin/merchants/${id}`, 'ok', '商户余额已调整。');
  });

  route.post('/merchants/:id/delete', (req, res) => {
    const id = integer(req.params.id, 1, Number.MAX_SAFE_INTEGER);
    const merchant = id ? db.prepare('SELECT * FROM merchants WHERE id = ?').get(id) : null;
    if (!merchant) return redirectMessage(res, '/admin/merchants', 'error', '商户不存在。');
    if (merchant.is_default) return redirectMessage(res, '/admin/merchants', 'error', '默认商户不可删除。');
    if (merchant.balance_minor !== 0) return redirectMessage(res, '/admin/merchants', 'error', '商户余额必须为 0 才能删除。');
    const activeOrders = db.prepare("SELECT COUNT(*) AS count FROM orders WHERE merchant_id = ? AND (status = 'PENDING' OR (status = 'PAID' AND settled_at IS NULL))").get(id).count;
    if (activeOrders > 0) return redirectMessage(res, '/admin/merchants', 'error', '商户仍有进行中或待结算订单，不能删除。');
    db.prepare('UPDATE merchants SET is_active = 0, deleted_at = ?, updated_at = ? WHERE id = ?').run(Date.now(), Date.now(), id);
    return redirectMessage(res, '/admin/merchants', 'ok', '商户已删除，历史订单仍保留。');
  });

  route.post('/merchants/:merchantId/orders/:orderId/refund', (req, res) => {
    const merchantId = integer(req.params.merchantId, 1, Number.MAX_SAFE_INTEGER);
    const orderId = integer(req.params.orderId, 1, Number.MAX_SAFE_INTEGER);
    if (!merchantId || !orderId) return redirectMessage(res, '/admin/merchants', 'error', '退款参数无效。');
    try {
      const rawAmount = String(req.body.amount || '').trim();
      const amountMinor = rawAmount ? moneyInput(rawAmount, { allowZero: false }) : null;
      if (rawAmount && amountMinor === null) throw new EpayError('退款金额无效', 'INVALID_REFUND_AMOUNT', 400);
      const result = refundOrder({ db, orderId, merchantId, amountMinor, reason: String(req.body.reason || '商户后台退款'), createdBy: 'admin-merchant-panel' });
      notification.enqueue(result.order.id);
      return redirectMessage(res, `/admin/merchants/${merchantId}`, 'ok', `退款成功：${result.refundNo}。`);
    } catch (error) {
      return redirectMessage(res, `/admin/merchants/${merchantId}`, 'error', error.message);
    }
  });

  route.get('/settings', (req, res) => {
    const settings = getAllSettings(db);
    res.render('admin/settings', { title: '系统设置', settings });
  });

  route.post('/settings', (req, res) => {
    const siteName = String(req.body.site_name || '').trim().slice(0, 80) || 'Epay Test Gateway';
    const timeout = integer(req.body.order_timeout_seconds, 60, 86400);
    const currency = String(req.body.default_currency || 'CNY').trim().toUpperCase();
    const supportedTypes = String(req.body.supported_types || '').split(',').map((item) => item.trim()).filter(Boolean).join(',');
    const smtpPort = integer(req.body.smtp_port, 1, 65535);
    const inviteLimit = integer(req.body.invite_default_limit, 0, 1000000);
    const inviteRandomLength = integer(req.body.invite_random_length, 6, 20);
    const inviteCustomFee = moneyInput(req.body.invite_custom_fee, { allowZero: true });
    const inviteSlotPrice = moneyInput(req.body.invite_slot_price, { allowZero: true });
    const depositBps = integer(req.body.card_deposit_fee_bps, 0, 10000);
    const withdrawBps = integer(req.body.card_withdraw_fee_bps, 0, 10000);
    const minDeposit = moneyInput(req.body.card_min_deposit, { allowZero: true });
    const minDepositFee = moneyInput(req.body.card_min_deposit_fee, { allowZero: true });
    const minWithdraw = moneyInput(req.body.card_min_withdraw, { allowZero: true });
    const minWithdrawFee = moneyInput(req.body.card_min_withdraw_fee, { allowZero: true });
    const unfreezeFee = req.body.card_unfreeze_fee === undefined
      ? Number.parseInt(getSetting(db, 'card_unfreeze_fee_minor', '10000'), 10)
      : moneyInput(req.body.card_unfreeze_fee, { allowZero: true });
    const transferBps = req.body.internal_transfer_fee_bps === undefined
      ? Number.parseInt(getSetting(db, 'internal_transfer_fee_bps', '0'), 10)
      : integer(req.body.internal_transfer_fee_bps, 0, 10000);
    const transferMinFee = req.body.internal_transfer_min_fee === undefined
      ? Number.parseInt(getSetting(db, 'internal_transfer_min_fee_minor', '0'), 10)
      : moneyInput(req.body.internal_transfer_min_fee, { allowZero: true });
    const guaranteeSeconds = integer(req.body.merchant_guarantee_seconds, 60, 86400);
    const emailTtl = integer(req.body.email_code_ttl_seconds, 60, 86400);
    const emailResend = integer(req.body.email_code_resend_seconds, 0, 86400);
    const usernameRegex = String(req.body.username_regex || '').trim();
    const passwordRegex = String(req.body.password_regex || '').trim();
    const emailRegex = String(req.body.email_regex || '').trim();
    const smtpHost = String(req.body.smtp_host || '').trim();
    const smtpUser = String(req.body.smtp_user || '').trim();
    const mailFrom = String(req.body.mail_from || '').trim();
    const registrationRequiresEmail = req.body.registration_require_email === '1';
    const smtpPasswordProvided = Boolean(String(req.body.smtp_password || '').trim());
    const smtpPasswordConfigured = Boolean(getSetting(db, 'smtp_password_enc', ''));
    if (registrationRequiresEmail && (!smtpHost || (!mailFrom && !smtpUser) || (smtpUser && !smtpPasswordProvided && !smtpPasswordConfigured))) {
      return redirectMessage(res, '/admin/settings', 'error', '开启邮箱注册验证前，请先完整配置 SMTP 主机、发件地址和认证信息。');
    }
    for (const [label, pattern] of [['用户名', usernameRegex], ['密码', passwordRegex], ['邮箱', emailRegex]]) {
      if (!pattern || pattern.length > 500) return redirectMessage(res, '/admin/settings', 'error', `${label}正则不能为空且不能超过 500 个字符。`);
      try { new RegExp(pattern); } catch { return redirectMessage(res, '/admin/settings', 'error', `${label}正则表达式无效。`); }
    }
    if (timeout === null || !/^[A-Z]{3}$/.test(currency) || !supportedTypes || smtpPort === null || inviteLimit === null || inviteRandomLength === null || inviteCustomFee === null || inviteSlotPrice === null || depositBps === null || withdrawBps === null || minDeposit === null || minDepositFee === null || minWithdraw === null || minWithdrawFee === null || unfreezeFee === null || transferBps === null || transferMinFee === null || guaranteeSeconds === null || emailTtl === null || emailResend === null) {
      return redirectMessage(res, '/admin/settings', 'error', '设置参数无效，请检查金额、比例和数值范围。');
    }
    const currentCurrency = getSetting(db, 'default_currency', 'CNY');
    if (currency !== currentCurrency) {
      const financialRows = db.prepare(`
        SELECT (SELECT COUNT(*) FROM cards) + (SELECT COUNT(*) FROM orders) + (SELECT COUNT(*) FROM merchant_transactions) AS count
      `).get().count;
      if (financialRows > 0) return redirectMessage(res, '/admin/settings', 'error', '已有卡片或交易数据，不能直接切换结算币种。');
    }
    const emailMode = ['blacklist', 'whitelist'].includes(req.body.email_list_mode) ? req.body.email_list_mode : 'blacklist';
    db.transaction(() => {
      setSetting(db, 'site_name', siteName);
      setSetting(db, 'order_timeout_seconds', timeout);
      setSetting(db, 'default_currency', currency);
      setSetting(db, 'supported_types', supportedTypes);
      setSetting(db, 'require_card_binding', req.body.require_card_binding === '1' ? '1' : '0');
      setSetting(db, 'auto_success_payments', req.body.auto_success_payments === '1' ? '1' : '0');
      setSetting(db, 'registration_enabled', req.body.registration_enabled === '1' ? '1' : '0');
      setSetting(db, 'registration_require_invite', req.body.registration_require_invite === '1' ? '1' : '0');
      setSetting(db, 'user_invites_enabled', req.body.user_invites_enabled === '1' ? '1' : '0');
      setSetting(db, 'registration_require_email', req.body.registration_require_email === '1' ? '1' : '0');
      setSetting(db, 'email_list_mode', emailMode);
      setSetting(db, 'email_whitelist', String(req.body.email_whitelist || '').trim());
      setSetting(db, 'email_blacklist', String(req.body.email_blacklist || '').trim());
      setSetting(db, 'username_regex', usernameRegex);
      setSetting(db, 'password_regex', passwordRegex);
      setSetting(db, 'email_regex', emailRegex);
      setSetting(db, 'email_code_ttl_seconds', emailTtl);
      setSetting(db, 'email_code_resend_seconds', emailResend);
      setSetting(db, 'smtp_host', smtpHost);
      setSetting(db, 'smtp_port', smtpPort);
      setSetting(db, 'smtp_secure', req.body.smtp_secure === '1' ? '1' : '0');
      setSetting(db, 'smtp_user', smtpUser);
      if (String(req.body.smtp_password || '').trim()) setSetting(db, 'smtp_password_enc', encrypt(String(req.body.smtp_password).trim(), config.appSecret));
      setSetting(db, 'mail_from', mailFrom);
      setSetting(db, 'invite_default_limit', inviteLimit);
      setSetting(db, 'invite_random_length', inviteRandomLength);
      setSetting(db, 'invite_custom_fee_minor', inviteCustomFee);
      setSetting(db, 'invite_slot_purchase_enabled', req.body.invite_slot_purchase_enabled === '1' ? '1' : '0');
      setSetting(db, 'invite_slot_price_minor', inviteSlotPrice);
      setSetting(db, 'card_withdraw_enabled', req.body.card_withdraw_enabled === '1' ? '1' : '0');
      setSetting(db, 'card_deposit_fee_bps', depositBps);
      setSetting(db, 'card_min_deposit_minor', minDeposit);
      setSetting(db, 'card_min_deposit_fee_minor', minDepositFee);
      setSetting(db, 'card_withdraw_fee_bps', withdrawBps);
      setSetting(db, 'card_min_withdraw_minor', minWithdraw);
      setSetting(db, 'card_min_withdraw_fee_minor', minWithdrawFee);
      setSetting(db, 'card_unfreeze_fee_minor', unfreezeFee);
      setSetting(db, 'internal_transfer_fee_bps', transferBps);
      setSetting(db, 'internal_transfer_min_fee_minor', transferMinFee);
      setSetting(db, 'merchant_guarantee_seconds', guaranteeSeconds);
    })();
    res.app.locals.siteName = siteName;
    redirectMessage(res, '/admin/settings', 'ok', '系统设置已保存。');
  });

  return route;
}

module.exports = router;
