const express = require('express');
const crypto = require('node:crypto');
const { formatMinor } = require('./epay');
const {
  encrypt,
  generateCardNumber,
  luhnValid,
  randomToken,
  hashPassword
} = require('./crypto');
const {
  getSetting,
  setSetting,
  getAllSettings,
  mapCard,
  mapMerchant,
  mapOrder,
  mapUser
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
const { simulateChargeback, EpayError } = require('./order-service');

function moneyInput(value, { allowZero = true } = {}) {
  const raw = String(value ?? '').trim();
  if (!/^\d{1,10}(?:\.\d{1,2})?$/.test(raw)) return null;
  const [whole, decimals = ''] = raw.split('.');
  const minor = Number(whole) * 100 + Number(decimals.padEnd(2, '0'));
  if (!Number.isSafeInteger(minor) || (!allowZero && minor === 0)) return null;
  return minor;
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

  function orderScope(req) {
    return req.user.role === 'admin'
      ? { condition: '', params: [] }
      : { condition: 'o.card_id IN (SELECT id FROM cards WHERE owner_user_id = ?)', params: [req.user.id] };
  }

  function cardAccessCondition(req) {
    return req.user.role === 'admin'
      ? { condition: '', params: [] }
      : { condition: 'AND c.owner_user_id = ?', params: [req.user.id] };
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
        COALESCE(SUM(CASE WHEN o.notify_state = 'SENT' THEN 1 ELSE 0 END), 0) AS sent_notifications
      FROM orders o
      ${where}
    `).get(...scope.params);
    return crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
  }

  route.get('/login', (req, res) => {
    const next = safeNext(req.query.next);
    if (userSessionFromRequest(req, db, config)) return res.redirect(next);
    res.render('admin/login', { title: '账户登录', error: null, next });
  });

  route.post('/login', (req, res) => {
    const username = String(req.body.username || '');
    const password = String(req.body.password || '');
    const user = validUserCredentials(db, username, password);
    if (!user) {
      return res.status(401).render('admin/login', {
        title: '账户登录',
        error: '用户名或密码错误，或账号已被停用。',
        next: safeNext(req.body.next)
      });
    }
    const session = createSession(user, config);
    setSessionCookie(res, config, session.token);
    res.redirect(safeNext(req.body.next || '/admin'));
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

  route.use('/bins', adminOnly);
  route.use('/merchants', adminOnly);
  route.use('/settings', adminOnly);
  route.use('/users', adminOnly);

  route.get('/', (req, res) => {
    const isAdmin = req.user.role === 'admin';
    const cardWhere = isAdmin ? '' : 'WHERE owner_user_id = ?';
    const cardParams = isAdmin ? [] : [req.user.id];
    const orderWhere = isAdmin ? '' : "WHERE card_id IN (SELECT id FROM cards WHERE owner_user_id = ?)";
    const orderParams = isAdmin ? [] : [req.user.id];
    const stats = {
      cards: db.prepare(`SELECT COUNT(*) AS count FROM cards ${cardWhere}`).get(...cardParams).count,
      activeCards: db.prepare(`SELECT COUNT(*) AS count FROM cards ${cardWhere ? `${cardWhere} AND` : 'WHERE'} status = 'active'`).get(...cardParams).count,
      balance: db.prepare(`SELECT COALESCE(SUM(balance_minor), 0) AS amount FROM cards ${cardWhere}`).get(...cardParams).amount,
      orders: db.prepare(`SELECT COUNT(*) AS count FROM orders ${orderWhere}`).get(...orderParams).count,
      pending: db.prepare(`SELECT COUNT(*) AS count FROM orders ${orderWhere ? `${orderWhere} AND` : 'WHERE'} status = 'PENDING'`).get(...orderParams).count,
      paid: db.prepare(`SELECT COUNT(*) AS count FROM orders ${orderWhere ? `${orderWhere} AND` : 'WHERE'} status = 'PAID'`).get(...orderParams).count,
      failed: db.prepare(`SELECT COUNT(*) AS count FROM orders ${orderWhere ? `${orderWhere} AND` : 'WHERE'} status IN ('FAILED', 'EXPIRED')`).get(...orderParams).count,
      paidVolume: db.prepare(`SELECT COALESCE(SUM(money_minor), 0) AS amount FROM orders ${orderWhere ? `${orderWhere} AND` : 'WHERE'} status = 'PAID'`).get(...orderParams).amount
    };
    const recentSql = orderQuery(orderWhere, orderParams, 8);
    const recentOrders = db.prepare(recentSql.sql).all(...recentSql.params).map(mapOrder);
    res.render('admin/dashboard', {
      title: isAdmin ? '仪表盘' : '我的仪表盘',
      stats,
      recentOrders,
      isAdmin,
      ordersLiveFingerprint: orderFingerprint(req)
    });
  });

  route.get('/bins', (req, res) => {
    const bins = db.prepare(`
      SELECT b.*, COUNT(c.id) AS card_count
      FROM bins b LEFT JOIN cards c ON c.bin_id = b.id
      GROUP BY b.id ORDER BY b.created_at DESC
    `).all();
    res.render('admin/bins', { title: '卡 BIN 管理', bins });
  });

  route.post('/bins', (req, res) => {
    const name = String(req.body.name || '').trim();
    const prefix = String(req.body.prefix || '').replace(/\D/g, '');
    const brand = String(req.body.brand || 'Visa').trim();
    const cardType = String(req.body.card_type || 'debit').trim();
    const country = String(req.body.country || 'CN').trim().toUpperCase();
    const numberLength = integer(req.body.number_length, 12, 19);
    if (!name || prefix.length < 4 || prefix.length > 8 || numberLength === null || prefix.length >= numberLength) {
      return redirectMessage(res, '/admin/bins', 'error', '请填写有效名称、4-8 位 BIN 前缀和 12-19 位卡号长度。');
    }
    try {
      const now = Date.now();
      db.prepare(`
        INSERT INTO bins (name, prefix, brand, card_type, country, number_length, is_active, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
      `).run(name, prefix, brand || 'Visa', cardType, country || 'CN', numberLength, now, now);
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
    const isActive = req.body.is_active === '1' ? 1 : 0;
    if (!id || !name || prefix.length < 4 || prefix.length > 8 || numberLength === null || prefix.length >= numberLength) {
      return redirectMessage(res, '/admin/bins', 'error', 'BIN 参数无效。');
    }
    try {
      db.prepare(`
        UPDATE bins SET name = ?, prefix = ?, brand = ?, card_type = ?, country = ?, number_length = ?, is_active = ?, updated_at = ?
        WHERE id = ?
      `).run(name, prefix, brand || 'Visa', cardType, country || 'CN', numberLength, isActive, Date.now(), id);
      return redirectMessage(res, '/admin/bins', 'ok', 'BIN 已更新。');
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) return redirectMessage(res, '/admin/bins', 'error', '该 BIN 前缀已存在。');
      throw error;
    }
  });

  route.get('/cards', (req, res) => {
    const status = String(req.query.status || '');
    const search = String(req.query.q || '').trim();
    const conditions = [];
    const params = [];
    if (req.user.role !== 'admin') {
      conditions.push('c.owner_user_id = ?');
      params.push(req.user.id);
    }
    if (allowedCardStatuses.has(status)) {
      conditions.push('c.status = ?');
      params.push(status);
    }
    if (search) {
      conditions.push('(c.id LIKE ? OR c.last4 LIKE ?)');
      params.push(`%${search}%`, `%${search}%`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const cards = db.prepare(`
      SELECT c.*, b.name AS bin_name, b.prefix AS bin_prefix, b.brand, b.card_type, u.username AS owner_username
      FROM cards c
      JOIN bins b ON b.id = c.bin_id
      LEFT JOIN users u ON u.id = c.owner_user_id
      ${where}
      ORDER BY c.created_at DESC LIMIT 300
    `).all(...params).map((row) => mapCard(row, config.appSecret, false));
    res.render('admin/cards', { title: req.user.role === 'admin' ? '虚拟卡管理' : '我的虚拟卡', cards, status, search, isAdmin: req.user.role === 'admin' });
  });

  route.get('/cards/new', (req, res) => {
    const bins = db.prepare('SELECT * FROM bins WHERE is_active = 1 ORDER BY name').all();
    const users = req.user.role === 'admin'
      ? db.prepare('SELECT * FROM users WHERE is_active = 1 ORDER BY role DESC, username').all().map(mapUser)
      : [];
    res.render('admin/card-new', {
      title: '创建虚拟卡',
      bins,
      users,
      error: null,
      form: {},
      isAdmin: req.user.role === 'admin',
      currentUser: req.user
    });
  });

  route.post('/cards', (req, res) => {
    const isAdmin = req.user.role === 'admin';
    const bins = db.prepare('SELECT * FROM bins WHERE is_active = 1 ORDER BY name').all();
    const users = isAdmin
      ? db.prepare('SELECT * FROM users WHERE is_active = 1 ORDER BY role DESC, username').all().map(mapUser)
      : [];
    const binId = integer(req.body.bin_id, 1, Number.MAX_SAFE_INTEGER);
    const bin = bins.find((item) => item.id === binId);
    const expiresMonth = integer(req.body.expires_month, 1, 12);
    const expiresYear = normalizeYear(req.body.expires_year);
    const cvv = String(req.body.cvv || '').trim();
    const pin = String(req.body.pin || '').trim();
    const balanceMinor = moneyInput(req.body.balance, { allowZero: true });
    const status = isAdmin ? String(req.body.status || 'active') : 'active';
    const declineReason = isAdmin ? String(req.body.decline_reason || '').trim() : '';
    let ownerId = req.user.id;
    if (isAdmin && req.body.owner_user_id) {
      const requestedOwnerId = integer(req.body.owner_user_id, 1, Number.MAX_SAFE_INTEGER);
      if (requestedOwnerId && users.some((user) => user.id === requestedOwnerId)) ownerId = requestedOwnerId;
    }
    const currentYear = new Date().getFullYear();
    if (!bin || expiresMonth === null || expiresYear === null || expiresYear < currentYear || expiresYear > currentYear + 30 || !/^\d{3,4}$/.test(cvv) || pin.length < 4 || pin.length > 64 || balanceMinor === null || !allowedCardStatuses.has(status)) {
      return res.status(400).render('admin/card-new', {
        title: '创建虚拟卡',
        bins,
        users,
        error: '请检查卡片参数。3DS 密码长度需为 4-64 位，CVV 为 3-4 位数字。',
        form: req.body,
        isAdmin,
        currentUser: req.user
      });
    }
    const cardNumber = generateCardNumber(bin.prefix, bin.number_length);
    if (!luhnValid(cardNumber)) throw new Error('Generated invalid card number');
    const cardId = `CARD-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
    const now = Date.now();
    db.transaction(() => {
      db.prepare(`
        INSERT INTO cards (
          id, owner_user_id, bin_id, card_number_enc, last4, expires_month, expires_year, cvv_enc, pin_enc,
          balance_minor, currency, status, decline_reason, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        cardId, ownerId, bin.id, encrypt(cardNumber, config.appSecret), cardNumber.slice(-4), expiresMonth, expiresYear,
        encrypt(cvv, config.appSecret), encrypt(pin, config.appSecret), balanceMinor,
        getSetting(db, 'default_currency', 'CNY'), status, status === 'declined' ? declineReason || '测试拒付' : null, now, now
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
      SELECT c.*, b.name AS bin_name, b.prefix AS bin_prefix, b.brand, b.card_type, u.username AS owner_username
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
    const users = req.user.role === 'admin'
      ? db.prepare('SELECT * FROM users WHERE is_active = 1 ORDER BY role DESC, username').all().map(mapUser)
      : [];
    res.render('admin/card-detail', {
      title: `虚拟卡 ${card.id}`,
      card,
      transactions,
      orders,
      users,
      isAdmin: req.user.role === 'admin'
    });
  });

  route.post('/cards/:id/update', adminOnly, (req, res) => {
    const card = db.prepare(`
      SELECT c.*, b.name AS bin_name, b.prefix AS bin_prefix, b.brand, b.card_type
      FROM cards c JOIN bins b ON b.id = c.bin_id WHERE c.id = ?
    `).get(req.params.id);
    if (!card) return redirectMessage(res, '/admin/cards', 'error', '虚拟卡不存在。');
    const status = String(req.body.status || card.status);
    const declineReason = String(req.body.decline_reason || '').trim();
    const balanceMinor = moneyInput(req.body.balance, { allowZero: true });
    const expiresMonth = integer(req.body.expires_month, 1, 12);
    const expiresYear = normalizeYear(req.body.expires_year);
    const newPin = String(req.body.pin || '').trim();
    const newCvv = String(req.body.cvv || '').trim();
    let ownerId = card.owner_user_id;
    if (req.body.owner_user_id) {
      const requestedOwnerId = integer(req.body.owner_user_id, 1, Number.MAX_SAFE_INTEGER);
      if (requestedOwnerId && db.prepare('SELECT id FROM users WHERE id = ? AND is_active = 1').get(requestedOwnerId)) ownerId = requestedOwnerId;
    }
    if (!allowedCardStatuses.has(status) || balanceMinor === null || expiresMonth === null || expiresYear === null || (newPin && (newPin.length < 4 || newPin.length > 64)) || (newCvv && !/^\d{3,4}$/.test(newCvv))) {
      return redirectMessage(res, `/admin/cards/${card.id}`, 'error', '卡片参数无效。');
    }
    db.transaction(() => {
      db.prepare(`
        UPDATE cards SET owner_user_id = ?, status = ?, decline_reason = ?, balance_minor = ?, expires_month = ?, expires_year = ?,
          pin_enc = ?, cvv_enc = ?, updated_at = ? WHERE id = ?
      `).run(
        ownerId,
        status,
        status === 'declined' ? declineReason || '测试拒付' : null,
        balanceMinor,
        expiresMonth,
        expiresYear,
        newPin ? encrypt(newPin, config.appSecret) : card.pin_enc,
        newCvv ? encrypt(newCvv, config.appSecret) : card.cvv_enc,
        Date.now(),
        card.id
      );
      if (balanceMinor !== card.balance_minor) {
        db.prepare(`
          INSERT INTO card_transactions (card_id, order_id, type, amount_minor, balance_after_minor, note, created_at)
          VALUES (?, NULL, 'ADJUSTMENT', ?, ?, 'Admin balance adjustment', ?)
        `).run(card.id, Math.abs(balanceMinor - card.balance_minor), balanceMinor, Date.now());
      }
    })();
    redirectMessage(res, `/admin/cards/${card.id}`, 'ok', '卡片信息已更新。');
  });

  route.post('/cards/:id/decline', adminOnly, (req, res) => {
    const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(req.params.id);
    if (!card) return redirectMessage(res, '/admin/cards', 'error', '虚拟卡不存在。');
    const nextStatus = card.status === 'declined' ? 'active' : 'declined';
    const reason = String(req.body.reason || '模拟拒付').trim() || '模拟拒付';
    db.prepare('UPDATE cards SET status = ?, decline_reason = ?, updated_at = ? WHERE id = ?')
      .run(nextStatus, nextStatus === 'declined' ? reason : null, Date.now(), card.id);
    const message = nextStatus === 'declined' ? '已开启模拟拒付。' : '已恢复为可支付状态。';
    redirectMessage(res, `/admin/cards/${card.id}`, 'ok', message);
  });

  route.post('/cards/:id/consume', adminOnly, (req, res) => {
    const amountMinor = moneyInput(req.body.amount, { allowZero: false });
    const note = String(req.body.note || '管理员手工消费').trim().slice(0, 120) || '管理员手工消费';
    if (amountMinor === null) return redirectMessage(res, `/admin/cards/${req.params.id}`, 'error', '消费金额必须大于 0。');
    try {
      db.transaction(() => {
        const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(req.params.id);
        if (!card) throw new EpayError('虚拟卡不存在。', 'CARD_NOT_FOUND', 404);
        if (card.balance_minor < amountMinor) throw new EpayError('卡片余额不足。', 'INSUFFICIENT_FUNDS', 409);
        const nextBalance = card.balance_minor - amountMinor;
        const now = Date.now();
        db.prepare('UPDATE cards SET balance_minor = ?, last_used_at = ?, updated_at = ? WHERE id = ?')
          .run(nextBalance, now, now, card.id);
        db.prepare(`
          INSERT INTO card_transactions (card_id, order_id, type, amount_minor, balance_after_minor, note, created_at)
          VALUES (?, NULL, 'DEBIT', ?, ?, ?, ?)
        `).run(card.id, amountMinor, nextBalance, note, now);
      })();
      redirectMessage(res, `/admin/cards/${req.params.id}`, 'ok', '手工消费已记录。');
    } catch (error) {
      if (error instanceof EpayError) return redirectMessage(res, `/admin/cards/${req.params.id}`, 'error', error.message);
      throw error;
    }
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
      ordersLiveFingerprint: orderFingerprint(req)
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
      SELECT o.*, m.pid AS merchant_pid, m.name AS merchant_name, c.last4 AS card_last4
      FROM orders o JOIN merchants m ON m.id = o.merchant_id LEFT JOIN cards c ON c.id = o.card_id
      WHERE o.id = ? ${extraCondition}
    `).get(id, ...scope.params) : null;
    if (!row) return res.status(404).render('error', { title: '订单不存在', message: '未找到该订单。', statusCode: 404 });
    const logs = db.prepare('SELECT * FROM callback_logs WHERE order_id = ? ORDER BY attempted_at DESC').all(id);
    const order = mapOrder(row);
    const merchant = db.prepare('SELECT * FROM merchants WHERE id = ?').get(order.merchantId);
    res.render('admin/order-detail', {
      title: `订单 ${order.tradeNo}`,
      order,
      logs,
      merchant: mapMerchant(merchant, config.appSecret),
      isAdmin: req.user.role === 'admin',
      ordersLiveFingerprint: orderFingerprint(req)
    });
  });

  route.post('/orders/:id/resend', adminOnly, (req, res) => {
    const id = integer(req.params.id, 1, Number.MAX_SAFE_INTEGER);
    if (!id) return redirectMessage(res, '/admin/orders', 'error', '订单不存在。');
    notification.enqueue(id, { force: true });
    redirectMessage(res, `/admin/orders/${id}`, 'ok', '已提交异步回调，结果会在回调记录中显示。');
  });

  route.post('/orders/:id/chargeback', adminOnly, (req, res) => {
    const id = integer(req.params.id, 1, Number.MAX_SAFE_INTEGER);
    try {
      const order = simulateChargeback({ db, orderId: id });
      notification.enqueue(order.id, { force: true });
      return redirectMessage(res, `/admin/orders/${id}`, 'ok', '已模拟拒付/退单，金额已退回卡片。');
    } catch (error) {
      if (error instanceof EpayError) return redirectMessage(res, `/admin/orders/${id}`, 'error', error.message);
      throw error;
    }
  });

  route.get('/users', (req, res) => {
    const users = db.prepare(`
      SELECT u.*, COUNT(c.id) AS card_count
      FROM users u
      LEFT JOIN cards c ON c.owner_user_id = u.id
      GROUP BY u.id
      ORDER BY CASE u.role WHEN 'admin' THEN 0 ELSE 1 END, u.created_at DESC
    `).all();
    res.render('admin/users', {
      title: '用户管理',
      users,
      currentUserId: req.user.id,
      error: typeof req.query.error === 'string' ? req.query.error : null,
      ok: typeof req.query.ok === 'string' ? req.query.ok : null
    });
  });

  route.post('/users', (req, res) => {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    const role = String(req.body.role || 'user');
    if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username) || password.length < 8 || password.length > 128 || !['admin', 'user'].includes(role)) {
      return redirectMessage(res, '/admin/users', 'error', '用户名需为 3-32 位字母、数字、点、下划线或横线，密码至少 8 位。');
    }
    try {
      const now = Date.now();
      db.prepare(`
        INSERT INTO users (username, password_hash, role, is_active, created_at, updated_at)
        VALUES (?, ?, ?, 1, ?, ?)
      `).run(username, hashPassword(password), role, now, now);
      return redirectMessage(res, '/admin/users', 'ok', `用户 ${username} 已创建。`);
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) return redirectMessage(res, '/admin/users', 'error', '该用户名已存在。');
      throw error;
    }
  });

  route.post('/users/:id/update', (req, res) => {
    const id = integer(req.params.id, 1, Number.MAX_SAFE_INTEGER);
    const target = id ? db.prepare('SELECT * FROM users WHERE id = ?').get(id) : null;
    if (!target) return redirectMessage(res, '/admin/users', 'error', '用户不存在。');
    const role = String(req.body.role || target.role);
    const isActive = req.body.is_active === '1' ? 1 : 0;
    const password = String(req.body.password || '');
    if (!['admin', 'user'].includes(role) || (password && (password.length < 8 || password.length > 128))) {
      return redirectMessage(res, '/admin/users', 'error', '用户参数无效，密码至少需要 8 位。');
    }
    if (target.id === req.user.id && (role !== 'admin' || !isActive)) {
      return redirectMessage(res, '/admin/users', 'error', '不能停用当前登录账号或取消自己的管理员权限。');
    }
    if (target.role === 'admin' && (role !== 'admin' || !isActive)) {
      const otherAdmins = db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND is_active = 1 AND id <> ?").get(target.id).count;
      if (!otherAdmins) return redirectMessage(res, '/admin/users', 'error', '系统至少需要保留一个启用的管理员。');
    }
    db.prepare(`
      UPDATE users SET password_hash = ?, role = ?, is_active = ?, updated_at = ? WHERE id = ?
    `).run(password ? hashPassword(password) : target.password_hash, role, isActive, Date.now(), target.id);
    redirectMessage(res, '/admin/users', 'ok', `用户 ${target.username} 已更新。`);
  });

  route.get('/merchants', (req, res) => {
    const rows = db.prepare('SELECT * FROM merchants ORDER BY created_at DESC').all();
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
    if (!id || !name) return redirectMessage(res, '/admin/merchants', 'error', '商户参数无效。');
    db.prepare('UPDATE merchants SET name = ?, is_active = ?, updated_at = ? WHERE id = ?').run(name, isActive, Date.now(), id);
    redirectMessage(res, '/admin/merchants', 'ok', '商户信息已更新。');
  });

  route.post('/merchants/:id/rotate', (req, res) => {
    const id = integer(req.params.id, 1, Number.MAX_SAFE_INTEGER);
    if (!id) return redirectMessage(res, '/admin/merchants', 'error', '商户不存在。');
    const key = randomToken(24);
    db.prepare('UPDATE merchants SET key_enc = ?, updated_at = ? WHERE id = ?').run(encrypt(key, config.appSecret), Date.now(), id);
    redirectMessage(res, '/admin/merchants', 'ok', `商户密钥已轮换，新密钥：${key}`);
  });

  route.get('/settings', (req, res) => {
    const settings = getAllSettings(db);
    res.render('admin/settings', { title: '系统设置', settings });
  });

  route.post('/settings', (req, res) => {
    const siteName = String(req.body.site_name || '').trim().slice(0, 80) || 'Epay Test Gateway';
    const timeout = integer(req.body.order_timeout_seconds, 60, 86400);
    const currency = String(req.body.default_currency || 'CNY').trim().toUpperCase();
    const requireBinding = req.body.require_card_binding === '1' ? '1' : '0';
    const supportedTypes = String(req.body.supported_types || '').split(',').map((item) => item.trim()).filter(Boolean).join(',');
    if (timeout === null || !/^[A-Z]{3}$/.test(currency) || !supportedTypes) {
      return redirectMessage(res, '/admin/settings', 'error', '设置参数无效。订单超时需为 60-86400 秒。');
    }
    setSetting(db, 'site_name', siteName);
    setSetting(db, 'order_timeout_seconds', timeout);
    setSetting(db, 'default_currency', currency);
    setSetting(db, 'require_card_binding', requireBinding);
    setSetting(db, 'supported_types', supportedTypes);
    res.app.locals.siteName = siteName;
    redirectMessage(res, '/admin/settings', 'ok', '系统设置已保存。');
  });

  return route;
}

module.exports = router;
