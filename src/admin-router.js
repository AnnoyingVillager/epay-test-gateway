const express = require('express');
const crypto = require('node:crypto');
const { formatMinor } = require('./epay');
const {
  encrypt,
  generateCardNumber,
  luhnValid,
  randomToken
} = require('./crypto');
const {
  getSetting,
  setSetting,
  getAllSettings,
  mapCard,
  mapMerchant,
  mapOrder
} = require('./db');
const {
  requireAdmin,
  verifyCsrf,
  validAdminCredentials,
  createSession,
  setAdminCookie,
  clearAdminCookie,
  adminSessionFromRequest
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

  route.get('/login', (req, res) => {
    if (adminSessionFromRequest(req, config)) return res.redirect('/admin');
    res.render('admin/login', { title: '管理后台登录', error: null });
  });

  route.post('/login', (req, res) => {
    const username = String(req.body.username || '');
    const password = String(req.body.password || '');
    if (!validAdminCredentials(config, username, password)) {
      return res.status(401).render('admin/login', { title: '管理后台登录', error: '用户名或密码错误。' });
    }
    const session = createSession(config);
    setAdminCookie(res, config, session.token);
    res.redirect('/admin');
  });

  route.use(requireAdmin);
  route.use((req, res, next) => {
    if (req.method !== 'POST') return next();
    return verifyCsrf(req, res, next);
  });

  route.get('/logout', (req, res) => {
    clearAdminCookie(res);
    res.redirect('/admin/login');
  });

  route.get('/', (req, res) => {
    const stats = {
      cards: db.prepare('SELECT COUNT(*) AS count FROM cards').get().count,
      activeCards: db.prepare("SELECT COUNT(*) AS count FROM cards WHERE status = 'active'").get().count,
      balance: db.prepare('SELECT COALESCE(SUM(balance_minor), 0) AS amount FROM cards').get().amount,
      orders: db.prepare('SELECT COUNT(*) AS count FROM orders').get().count,
      pending: db.prepare("SELECT COUNT(*) AS count FROM orders WHERE status = 'PENDING'").get().count,
      paid: db.prepare("SELECT COUNT(*) AS count FROM orders WHERE status = 'PAID'").get().count,
      failed: db.prepare("SELECT COUNT(*) AS count FROM orders WHERE status IN ('FAILED', 'EXPIRED')").get().count,
      paidVolume: db.prepare("SELECT COALESCE(SUM(money_minor), 0) AS amount FROM orders WHERE status = 'PAID'").get().amount
    };
    const recentSql = orderQuery('', [], 8);
    const recentOrders = db.prepare(recentSql.sql).all(...recentSql.params).map(mapOrder);
    res.render('admin/dashboard', { title: '仪表盘', stats, recentOrders });
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
      SELECT c.*, b.name AS bin_name, b.prefix AS bin_prefix, b.brand, b.card_type
      FROM cards c JOIN bins b ON b.id = c.bin_id
      ${where}
      ORDER BY c.created_at DESC LIMIT 300
    `).all(...params).map((row) => mapCard(row, config.appSecret, false));
    res.render('admin/cards', { title: '虚拟卡管理', cards, status, search });
  });

  route.get('/cards/new', (req, res) => {
    const bins = db.prepare('SELECT * FROM bins WHERE is_active = 1 ORDER BY name').all();
    res.render('admin/card-new', { title: '创建虚拟卡', bins, error: null, form: {} });
  });

  route.post('/cards', (req, res) => {
    const bins = db.prepare('SELECT * FROM bins WHERE is_active = 1 ORDER BY name').all();
    const binId = integer(req.body.bin_id, 1, Number.MAX_SAFE_INTEGER);
    const bin = bins.find((item) => item.id === binId);
    const expiresMonth = integer(req.body.expires_month, 1, 12);
    const expiresYear = normalizeYear(req.body.expires_year);
    const cvv = String(req.body.cvv || '').trim();
    const pin = String(req.body.pin || '').trim();
    const balanceMinor = moneyInput(req.body.balance, { allowZero: true });
    const status = String(req.body.status || 'active');
    const declineReason = String(req.body.decline_reason || '').trim();
    const currentYear = new Date().getFullYear();
    if (!bin || expiresMonth === null || expiresYear === null || expiresYear < currentYear || expiresYear > currentYear + 30 || !/^\d{3,4}$/.test(cvv) || pin.length < 4 || pin.length > 64 || balanceMinor === null || !allowedCardStatuses.has(status)) {
      return res.status(400).render('admin/card-new', {
        title: '创建虚拟卡',
        bins,
        error: '请检查卡片参数。3DS 密码长度需为 4-64 位，CVV 为 3-4 位数字。',
        form: req.body
      });
    }
    const cardNumber = generateCardNumber(bin.prefix, bin.number_length);
    if (!luhnValid(cardNumber)) throw new Error('Generated invalid card number');
    const cardId = `CARD-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
    const now = Date.now();
    db.transaction(() => {
      db.prepare(`
        INSERT INTO cards (
          id, bin_id, card_number_enc, last4, expires_month, expires_year, cvv_enc, pin_enc,
          balance_minor, currency, status, decline_reason, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        cardId, bin.id, encrypt(cardNumber, config.appSecret), cardNumber.slice(-4), expiresMonth, expiresYear,
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
    const row = db.prepare(`
      SELECT c.*, b.name AS bin_name, b.prefix AS bin_prefix, b.brand, b.card_type
      FROM cards c JOIN bins b ON b.id = c.bin_id WHERE c.id = ?
    `).get(req.params.id);
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
    res.render('admin/card-detail', { title: `虚拟卡 ${card.id}`, card, transactions, orders });
  });

  route.post('/cards/:id/update', (req, res) => {
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
    if (!allowedCardStatuses.has(status) || balanceMinor === null || expiresMonth === null || expiresYear === null || (newPin && (newPin.length < 4 || newPin.length > 64)) || (newCvv && !/^\d{3,4}$/.test(newCvv))) {
      return redirectMessage(res, `/admin/cards/${card.id}`, 'error', '卡片参数无效。');
    }
    db.transaction(() => {
      db.prepare(`
        UPDATE cards SET status = ?, decline_reason = ?, balance_minor = ?, expires_month = ?, expires_year = ?,
          pin_enc = ?, cvv_enc = ?, updated_at = ? WHERE id = ?
      `).run(
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

  route.post('/cards/:id/decline', (req, res) => {
    const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(req.params.id);
    if (!card) return redirectMessage(res, '/admin/cards', 'error', '虚拟卡不存在。');
    const nextStatus = card.status === 'declined' ? 'active' : 'declined';
    const reason = String(req.body.reason || '模拟拒付').trim() || '模拟拒付';
    db.prepare('UPDATE cards SET status = ?, decline_reason = ?, updated_at = ? WHERE id = ?')
      .run(nextStatus, nextStatus === 'declined' ? reason : null, Date.now(), card.id);
    const message = nextStatus === 'declined' ? '已开启模拟拒付。' : '已恢复为可支付状态。';
    redirectMessage(res, `/admin/cards/${card.id}`, 'ok', message);
  });

  route.get('/orders', (req, res) => {
    const status = String(req.query.status || '').trim().toUpperCase();
    const search = String(req.query.q || '').trim();
    const allowedStatuses = new Set(['PENDING', 'PAID', 'EXPIRED', 'FAILED', 'CHARGEBACK']);
    const conditions = [];
    const params = [];
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
    res.render('admin/orders', { title: '订单管理', orders, status, search });
  });

  route.get('/orders/:id', (req, res) => {
    const id = integer(req.params.id, 1, Number.MAX_SAFE_INTEGER);
    const row = id ? db.prepare(`
      SELECT o.*, m.pid AS merchant_pid, m.name AS merchant_name, c.last4 AS card_last4
      FROM orders o JOIN merchants m ON m.id = o.merchant_id LEFT JOIN cards c ON c.id = o.card_id
      WHERE o.id = ?
    `).get(id) : null;
    if (!row) return res.status(404).render('error', { title: '订单不存在', message: '未找到该订单。', statusCode: 404 });
    const logs = db.prepare('SELECT * FROM callback_logs WHERE order_id = ? ORDER BY attempted_at DESC').all(id);
    const order = mapOrder(row);
    const merchant = db.prepare('SELECT * FROM merchants WHERE id = ?').get(order.merchantId);
    res.render('admin/order-detail', { title: `订单 ${order.tradeNo}`, order, logs, merchant: mapMerchant(merchant, config.appSecret) });
  });

  route.post('/orders/:id/resend', (req, res) => {
    const id = integer(req.params.id, 1, Number.MAX_SAFE_INTEGER);
    if (!id) return redirectMessage(res, '/admin/orders', 'error', '订单不存在。');
    notification.enqueue(id, { force: true });
    redirectMessage(res, `/admin/orders/${id}`, 'ok', '已提交异步回调，结果会在回调记录中显示。');
  });

  route.post('/orders/:id/chargeback', (req, res) => {
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
