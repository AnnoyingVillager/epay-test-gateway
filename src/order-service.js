const crypto = require('node:crypto');
const {
  normalizeParams,
  verifySign,
  parseMoneyToMinor,
  formatMinor
} = require('./epay');
const { getSetting, merchantByPid, cardById, orderByTradeNo } = require('./db');

class EpayError extends Error {
  constructor(message, code = 'INVALID_REQUEST', statusCode = 400, terminal = false) {
    super(message);
    this.name = 'EpayError';
    this.code = code;
    this.statusCode = statusCode;
    this.terminal = terminal;
  }
}

function createTradeNo() {
  const now = new Date();
  const stamp = [
    now.getUTCFullYear(),
    String(now.getUTCMonth() + 1).padStart(2, '0'),
    String(now.getUTCDate()).padStart(2, '0'),
    String(now.getUTCHours()).padStart(2, '0'),
    String(now.getUTCMinutes()).padStart(2, '0'),
    String(now.getUTCSeconds()).padStart(2, '0')
  ].join('');
  return `T${stamp}${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
}

function isValidWebUrl(value) {
  try {
    const parsed = new URL(String(value));
    return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

function baseUrlFor(req, config) {
  return config.baseUrl || `${req.protocol}://${req.get('host')}`;
}

function parseTimeoutSeconds(params, db, config) {
  const defaultSeconds = Number.parseInt(getSetting(db, 'order_timeout_seconds', String(config.defaultTimeoutSeconds)), 10);
  const requested = Number.parseInt(params.timeout || params.expires_in || '', 10);
  if (!Number.isFinite(requested)) return defaultSeconds;
  return Math.min(86400, Math.max(60, requested));
}

function validateOrderParams(params) {
  const required = ['pid', 'type', 'out_trade_no', 'notify_url', 'return_url', 'name', 'money', 'sign'];
  for (const key of required) {
    if (!params[key] || !String(params[key]).trim()) {
      throw new EpayError(`Missing required parameter: ${key}`, 'MISSING_PARAMETER');
    }
  }
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(params.out_trade_no)) {
    throw new EpayError('out_trade_no must be 1-128 characters using letters, numbers, underscore or hyphen', 'INVALID_OUT_TRADE_NO');
  }
  if (params.name.length > 128) throw new EpayError('name is too long', 'INVALID_NAME');
  if (!isValidWebUrl(params.notify_url)) throw new EpayError('notify_url must be an HTTP or HTTPS URL', 'INVALID_NOTIFY_URL');
  if (!isValidWebUrl(params.return_url)) throw new EpayError('return_url must be an HTTP or HTTPS URL', 'INVALID_RETURN_URL');
  if (params.sign_type && String(params.sign_type).toUpperCase() !== 'MD5') {
    throw new EpayError('Only MD5 signatures are supported', 'UNSUPPORTED_SIGN_TYPE');
  }
}

function checkMerchant(req, db, config, params) {
  const merchant = merchantByPid(db, config.appSecret, params.pid);
  if (!merchant || !merchant.isActive) throw new EpayError('Merchant not found or disabled', 'INVALID_PID', 401);
  if (!verifySign(params, merchant.key)) throw new EpayError('Invalid signature', 'SIGN_ERROR', 401);
  return merchant;
}

function createOrder({ req, db, config, input, merchant, createdVia }) {
  const params = normalizeParams(input);
  validateOrderParams(params);
  const moneyMinor = parseMoneyToMinor(params.money);
  if (!moneyMinor) throw new EpayError('money must be a positive amount with at most 2 decimals', 'INVALID_MONEY');

  const supported = getSetting(db, 'supported_types', 'alipay,wxpay,qqpay')
    .split(',').map((item) => item.trim()).filter(Boolean);
  if (supported.length && !supported.includes(params.type)) {
    throw new EpayError(`Unsupported payment type: ${params.type}`, 'UNSUPPORTED_PAY_TYPE');
  }

  const existing = db.prepare('SELECT trade_no FROM orders WHERE merchant_id = ? AND out_trade_no = ?')
    .get(merchant.id, params.out_trade_no);
  if (existing) {
    const order = orderByTradeNo(db, existing.trade_no);
    if (order.status !== 'EXPIRED') return { order, reused: true };
    throw new EpayError('out_trade_no already exists for an expired order', 'DUPLICATE_OUT_TRADE_NO', 409);
  }

  const bindCard = String(params.bind_card || params.card_id || '').trim();
  const autoSuccess = getSetting(db, 'auto_success_payments', '0') === '1';
  if (bindCard && !autoSuccess) {
    const card = cardById(db, config.appSecret, bindCard, false);
    if (!card) throw new EpayError('Bound card was not found', 'CARD_NOT_FOUND');
  }

  const now = Date.now();
  const timeoutSeconds = parseTimeoutSeconds(params, db, config);
  const tradeNo = createTradeNo();
  const currency = getSetting(db, 'default_currency', 'CNY').toUpperCase();

  db.prepare(`
    INSERT INTO orders (
      trade_no, out_trade_no, merchant_id, type, name, money_minor, currency, status,
      card_id, notify_url, return_url, sitename, param, client_ip, created_via,
      created_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    tradeNo,
    params.out_trade_no,
    merchant.id,
    params.type,
    params.name,
    moneyMinor,
    currency,
    autoSuccess ? null : (bindCard || null),
    params.notify_url,
    params.return_url,
    params.sitename || null,
    params.param || null,
    req.ip || null,
    createdVia,
    now,
    now + timeoutSeconds * 1000
  );

  return { order: orderByTradeNo(db, tradeNo), reused: false };
}

function paymentUrl(req, config, tradeNo) {
  return `${baseUrlFor(req, config)}/pay/${encodeURIComponent(tradeNo)}`;
}

function markOrderPaid({ db, config, tradeNo, pin }) {
  const paid = db.transaction(() => {
    const row = db.prepare('SELECT * FROM orders WHERE trade_no = ?').get(tradeNo);
    if (!row) throw new EpayError('Order not found', 'ORDER_NOT_FOUND', 404, true);
    if (row.status === 'PAID') return { alreadyPaid: true, order: orderByTradeNo(db, tradeNo) };
    if (row.status !== 'PENDING') throw new EpayError('Order is no longer payable', 'ORDER_CLOSED', 409, true);
    if (row.expires_at <= Date.now()) {
      db.prepare("UPDATE orders SET status = 'EXPIRED', closed_at = ?, callback_event = 'ORDER_EXPIRED' WHERE id = ? AND status = 'PENDING'")
        .run(Date.now(), row.id);
      return { terminal: true, code: 'ORDER_EXPIRED', message: 'Order expired', order: orderByTradeNo(db, tradeNo) };
    }

    if (!row.card_id) throw new EpayError('Bind a virtual card before payment', 'CARD_BINDING_REQUIRED', 409);
    const card = cardById(db, config.appSecret, row.card_id, true);
    if (!card) throw new EpayError('Bound card not found', 'CARD_NOT_FOUND', 409);

    if (card.status !== 'active') {
      db.prepare("UPDATE orders SET status = 'FAILED', closed_at = ?, callback_event = 'CARD_DECLINED' WHERE id = ? AND status = 'PENDING'")
        .run(Date.now(), row.id);
      return { terminal: true, code: 'CARD_DECLINED', message: card.declineReason || 'Card payment declined', order: orderByTradeNo(db, tradeNo) };
    }

    const now = new Date();
    if (card.expiresYear < now.getFullYear() || (card.expiresYear === now.getFullYear() && card.expiresMonth < now.getMonth() + 1)) {
      db.prepare("UPDATE orders SET status = 'FAILED', closed_at = ?, callback_event = 'CARD_EXPIRED' WHERE id = ? AND status = 'PENDING'")
        .run(Date.now(), row.id);
      return { terminal: true, code: 'CARD_EXPIRED', message: 'Card has expired', order: orderByTradeNo(db, tradeNo) };
    }

    const require3ds = getSetting(db, 'require_3ds', '1') === '1';
    if (require3ds && (!pin || pin !== card.pin)) {
      return { wrongPin: true, message: '3DS 密码错误', order: orderByTradeNo(db, tradeNo) };
    }

    if (card.balanceMinor < row.money_minor) {
      db.prepare("UPDATE orders SET status = 'FAILED', closed_at = ?, callback_event = 'INSUFFICIENT_FUNDS' WHERE id = ? AND status = 'PENDING'")
        .run(Date.now(), row.id);
      return { terminal: true, code: 'INSUFFICIENT_FUNDS', message: 'Insufficient card balance', order: orderByTradeNo(db, tradeNo) };
    }

    const newBalance = card.balanceMinor - row.money_minor;
    db.prepare('UPDATE cards SET balance_minor = ?, last_used_at = ?, updated_at = ? WHERE id = ?')
      .run(newBalance, Date.now(), Date.now(), card.id);
    db.prepare(`
      INSERT INTO card_transactions (card_id, order_id, type, amount_minor, balance_after_minor, note, created_at)
      VALUES (?, ?, 'DEBIT', ?, ?, ?, ?)
    `).run(card.id, row.id, row.money_minor, newBalance, `Payment ${row.trade_no}`, Date.now());
    db.prepare(`
      UPDATE orders SET status = 'PAID', paid_at = ?, callback_event = 'PAYMENT_SUCCESS' WHERE id = ? AND status = 'PENDING'
    `).run(Date.now(), row.id);

    return { paid: true, order: orderByTradeNo(db, tradeNo) };
  });

  return paid();
}

function markOrderPaidWithoutCard({ db, tradeNo }) {
  return db.transaction(() => {
    const row = db.prepare('SELECT * FROM orders WHERE trade_no = ?').get(tradeNo);
    if (!row) throw new EpayError('Order not found', 'ORDER_NOT_FOUND', 404, true);
    if (row.status === 'PAID') return { changed: false, order: orderByTradeNo(db, tradeNo) };
    if (row.status !== 'PENDING') return { changed: false, order: orderByTradeNo(db, tradeNo) };
    db.prepare(`
      UPDATE orders SET status = 'PAID', paid_at = ?, callback_event = 'PAYMENT_SUCCESS'
      WHERE id = ? AND status = 'PENDING'
    `).run(Date.now(), row.id);
    return { changed: true, order: orderByTradeNo(db, tradeNo) };
  })();
}

function expireOrder({ db, tradeNo }) {
  return db.transaction(() => {
    const row = db.prepare('SELECT * FROM orders WHERE trade_no = ?').get(tradeNo);
    if (!row || row.status !== 'PENDING' || row.expires_at > Date.now()) return false;
    db.prepare("UPDATE orders SET status = 'EXPIRED', closed_at = ?, callback_event = 'ORDER_EXPIRED' WHERE id = ? AND status = 'PENDING'")
      .run(Date.now(), row.id);
    return true;
  })();
}

function sweepExpiredOrders({ db, notification }) {
  const expired = db.prepare("SELECT id FROM orders WHERE status = 'PENDING' AND expires_at <= ? LIMIT 100").all(Date.now());
  if (!expired.length) return 0;
  const update = db.prepare(`
    UPDATE orders SET status = 'EXPIRED', closed_at = ?, callback_event = 'ORDER_EXPIRED'
    WHERE id = ? AND status = 'PENDING'
  `);
  const transaction = db.transaction((rows) => {
    let changed = 0;
    for (const row of rows) changed += update.run(Date.now(), row.id).changes;
    return changed;
  });
  const changed = transaction(expired);
  if (changed) {
    for (const row of expired) notification.enqueue(row.id);
  }
  return changed;
}

function simulateChargeback({ db, orderId }) {
  return db.transaction(() => {
    const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(Number(orderId));
    if (!row) throw new EpayError('Order not found', 'ORDER_NOT_FOUND', 404);
    if (row.status !== 'PAID') throw new EpayError('Only paid orders can be charged back', 'INVALID_ORDER_STATE', 409);
    if (row.card_id) {
      const card = db.prepare('SELECT balance_minor FROM cards WHERE id = ?').get(row.card_id);
      if (card) {
        const newBalance = card.balance_minor + row.money_minor;
        db.prepare('UPDATE cards SET balance_minor = ?, updated_at = ? WHERE id = ?').run(newBalance, Date.now(), row.card_id);
        db.prepare(`
          INSERT INTO card_transactions (card_id, order_id, type, amount_minor, balance_after_minor, note, created_at)
          VALUES (?, ?, 'CREDIT', ?, ?, ?, ?)
        `).run(row.card_id, row.id, row.money_minor, newBalance, `Chargeback ${row.trade_no}`, Date.now());
      }
    }
    db.prepare(`
      UPDATE orders SET status = 'CHARGEBACK', closed_at = ?, callback_event = 'CHARGEBACK', notify_state = 'NONE', notify_attempts = 0
      WHERE id = ?
    `).run(Date.now(), row.id);
    return orderByTradeNo(db, row.trade_no);
  })();
}

function renderOrderContext(order, merchant) {
  return {
    ...order,
    money: formatMinor(order.moneyMinor),
    canPay: order.status === 'PENDING' && order.expiresAt > Date.now(),
    merchantName: merchant.name
  };
}

module.exports = {
  EpayError,
  createOrder,
  checkMerchant,
  validateOrderParams,
  baseUrlFor,
  paymentUrl,
  markOrderPaid,
  markOrderPaidWithoutCard,
  expireOrder,
  sweepExpiredOrders,
  simulateChargeback,
  renderOrderContext
};
