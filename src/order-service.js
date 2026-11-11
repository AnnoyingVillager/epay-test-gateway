const crypto = require('node:crypto');
const { normalizeParams, verifySign, parseMoneyToMinor, formatMinor } = require('./epay');
const { getSetting, merchantByPid, cardById, orderByTradeNo } = require('./db');
const { accountTransaction } = require('./account-service');
const {
  userSpendLimit,
  cardSpendLimit,
  applyCardDebit,
  recordInsufficientFailure,
  maybeFreezeForOverdraftWarning
} = require('./card-service');

class EpayError extends Error {
  constructor(message, code = 'INVALID_REQUEST', statusCode = 400, terminal = false) {
    super(message); this.name = 'EpayError'; this.code = code; this.statusCode = statusCode; this.terminal = terminal;
  }
}

function createTradeNo(prefix = 'T') {
  const now = new Date();
  const stamp = [now.getUTCFullYear(), String(now.getUTCMonth() + 1).padStart(2, '0'), String(now.getUTCDate()).padStart(2, '0'), String(now.getUTCHours()).padStart(2, '0'), String(now.getUTCMinutes()).padStart(2, '0'), String(now.getUTCSeconds()).padStart(2, '0')].join('');
  return `${prefix}${stamp}${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
}

function isValidWebUrl(value) {
  try { const parsed = new URL(String(value)); return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password; } catch { return false; }
}

function baseUrlFor(req, config) { return config.baseUrl || `${req.protocol}://${req.get('host')}`; }

function parseTimeoutSeconds(params, db, config) {
  const defaultSeconds = Number.parseInt(getSetting(db, 'order_timeout_seconds', String(config.defaultTimeoutSeconds)), 10);
  const requested = Number.parseInt(params.timeout || params.expires_in || '', 10);
  if (!Number.isFinite(requested)) return defaultSeconds;
  return Math.min(86400, Math.max(60, requested));
}

function validateOrderParams(params) {
  for (const key of ['pid', 'type', 'out_trade_no', 'notify_url', 'return_url', 'name', 'money', 'sign']) {
    if (!params[key] || !String(params[key]).trim()) throw new EpayError(`Missing required parameter: ${key}`, 'MISSING_PARAMETER');
  }
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(params.out_trade_no)) throw new EpayError('out_trade_no must be 1-128 characters using letters, numbers, underscore or hyphen', 'INVALID_OUT_TRADE_NO');
  if (params.name.length > 128) throw new EpayError('name is too long', 'INVALID_NAME');
  if (!isValidWebUrl(params.notify_url)) throw new EpayError('notify_url must be an HTTP or HTTPS URL', 'INVALID_NOTIFY_URL');
  if (!isValidWebUrl(params.return_url)) throw new EpayError('return_url must be an HTTP or HTTPS URL', 'INVALID_RETURN_URL');
  if (params.sign_type && String(params.sign_type).toUpperCase() !== 'MD5') throw new EpayError('Only MD5 signatures are supported', 'UNSUPPORTED_SIGN_TYPE');
}

function checkMerchant(req, db, config, params) {
  const merchant = merchantByPid(db, config.appSecret, params.pid);
  if (!merchant || !merchant.isActive || merchant.deletedAt) throw new EpayError('Merchant not found or disabled', 'INVALID_PID', 401);
  if (!verifySign(params, merchant.key)) throw new EpayError('Invalid signature', 'SIGN_ERROR', 401);
  return merchant;
}

function createOrder({ req, db, config, input, merchant, createdVia }) {
  const params = normalizeParams(input);
  validateOrderParams(params);
  const moneyMinor = parseMoneyToMinor(params.money);
  if (!moneyMinor) throw new EpayError('money must be a positive amount with at most 2 decimals', 'INVALID_MONEY');
  const supported = getSetting(db, 'supported_types', 'alipay,wxpay,qqpay').split(',').map((item) => item.trim()).filter(Boolean);
  if (supported.length && !supported.includes(params.type)) throw new EpayError(`Unsupported payment type: ${params.type}`, 'UNSUPPORTED_PAY_TYPE');
  const existing = db.prepare('SELECT trade_no FROM orders WHERE merchant_id = ? AND out_trade_no = ?').get(merchant.id, params.out_trade_no);
  if (existing) {
    const order = orderByTradeNo(db, existing.trade_no);
    if (order.status !== 'EXPIRED') return { order, reused: true };
    throw new EpayError('out_trade_no already exists for an expired order', 'DUPLICATE_OUT_TRADE_NO', 409);
  }
  const bindCard = String(params.bind_card || params.card_id || '').trim();
  const autoSuccess = getSetting(db, 'auto_success_payments', '0') === '1';
  if (bindCard && !autoSuccess && !cardById(db, config.appSecret, bindCard, false)) throw new EpayError('Bound card was not found', 'CARD_NOT_FOUND');
  const now = Date.now();
  const tradeNo = createTradeNo();
  db.prepare(`
    INSERT INTO orders (trade_no, out_trade_no, merchant_id, type, name, money_minor, currency, status, card_id,
      payment_method, settlement_mode, notify_url, return_url, sitename, param, client_ip, created_via, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, 'card', 'legacy', ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(tradeNo, params.out_trade_no, merchant.id, params.type, params.name, moneyMinor,
    getSetting(db, 'default_currency', 'CNY').toUpperCase(), autoSuccess ? null : (bindCard || null),
    params.notify_url, params.return_url, params.sitename || null, params.param || null, req.ip || null, createdVia, now,
    now + parseTimeoutSeconds(params, db, config) * 1000);
  return { order: orderByTradeNo(db, tradeNo), reused: false };
}

function paymentUrl(req, config, tradeNo) { return `${baseUrlFor(req, config)}/pay/${encodeURIComponent(tradeNo)}`; }
function rawOrder(db, tradeNo) { return db.prepare('SELECT * FROM orders WHERE trade_no = ?').get(String(tradeNo)); }
function settlementWindowSeconds(db) { return Math.max(60, Math.min(86400, Number.parseInt(getSetting(db, 'merchant_guarantee_seconds', '300'), 10) || 300)); }

function effectiveSpendLimit(db, userId) {
  return userSpendLimit(db, userId);
}

function spentMinor(db, userId) {
  if (!userId) return 0;
  return Number(db.prepare(`SELECT COALESCE(SUM(CASE WHEN o.status IN ('PAID', 'CHARGEBACK') AND o.money_minor > o.refunded_minor THEN o.money_minor - o.refunded_minor ELSE 0 END), 0) AS total FROM orders o WHERE o.payer_user_id = ? OR o.card_id IN (SELECT id FROM cards WHERE owner_user_id = ?)`).get(Number(userId), Number(userId)).total);
}

function ensureTransactionLimit(limit, amountMinor, message = 'Transaction spending limit exceeded') {
  if (limit !== null && limit !== undefined && Number(amountMinor) > Number(limit)) throw new EpayError(message, 'SPEND_LIMIT_EXCEEDED', 409, true);
}

function settleMerchantBalance(db, order, grossMinor) {
  const reference = `SETTLE:${order.id}`;
  if (db.prepare('SELECT id FROM merchant_transactions WHERE reference = ?').get(reference)) return null;
  const commissionMinor = Math.floor(Number(grossMinor) * Number(order.commission_bps || 0) / 10000);
  const netMinor = Number(grossMinor) - commissionMinor;
  const merchant = db.prepare('SELECT balance_minor FROM merchants WHERE id = ?').get(order.merchant_id);
  const nextBalance = Number(merchant.balance_minor) + netMinor;
  db.prepare('UPDATE merchants SET balance_minor = ?, updated_at = ? WHERE id = ?').run(nextBalance, Date.now(), order.merchant_id);
  db.prepare(`INSERT INTO merchant_transactions (merchant_id, order_id, type, amount_minor, balance_after_minor, reference, note, created_at) VALUES (?, ?, 'SALE_SETTLEMENT', ?, ?, ?, ?, ?)`)
    .run(order.merchant_id, order.id, netMinor, nextBalance, reference, `订单 ${order.trade_no} 结算，佣金 ${formatMinor(commissionMinor)}`, Date.now());
  db.prepare('UPDATE orders SET settled_at = ?, commission_minor = ?, merchant_net_minor = ? WHERE id = ?').run(Date.now(), commissionMinor, netMinor, order.id);
  return { commissionMinor, netMinor };
}

function settleOneMaturedOrder({ db, orderId }) {
  return db.transaction(() => {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(Number(orderId));
    if (!order || order.status !== 'PAID' || order.settled_at || order.settlement_mode !== 'guarantee' || !order.settlement_due_at || order.settlement_due_at > Date.now()) return false;
    settleMerchantBalance(db, order, Math.max(0, order.money_minor - order.refunded_minor));
    return true;
  })();
}

function settleMaturedOrders({ db }) {
  const rows = db.prepare(`SELECT id FROM orders WHERE status = 'PAID' AND settled_at IS NULL AND settlement_mode = 'guarantee' AND settlement_due_at IS NOT NULL AND settlement_due_at <= ? ORDER BY settlement_due_at LIMIT 100`).all(Date.now());
  let changed = 0;
  for (const row of rows) if (settleOneMaturedOrder({ db, orderId: row.id })) changed += 1;
  return changed;
}

function merchantCommissionBps(db, merchantId) { return Number(db.prepare('SELECT commission_bps FROM merchants WHERE id = ?').get(Number(merchantId))?.commission_bps || 0); }

function markOrderPaid({ db, config, tradeNo, pin }) {
  return db.transaction(() => {
    const row = rawOrder(db, tradeNo);
    if (!row) throw new EpayError('Order not found', 'ORDER_NOT_FOUND', 404, true);
    if (row.status === 'PAID') return { alreadyPaid: true, order: orderByTradeNo(db, tradeNo) };
    if (row.status !== 'PENDING') throw new EpayError('Order is no longer payable', 'ORDER_CLOSED', 409, true);
    if (row.expires_at <= Date.now()) {
      db.prepare("UPDATE orders SET status = 'EXPIRED', closed_at = ?, callback_event = 'ORDER_EXPIRED' WHERE id = ? AND status = 'PENDING'").run(Date.now(), row.id);
      return { terminal: true, code: 'ORDER_EXPIRED', message: 'Order expired', order: orderByTradeNo(db, tradeNo) };
    }
    if (!row.card_id) throw new EpayError('Bind a virtual card before payment', 'CARD_BINDING_REQUIRED', 409);
    const card = cardById(db, config.appSecret, row.card_id, true);
    if (!card) throw new EpayError('Bound card not found', 'CARD_NOT_FOUND', 409);
    const owner = card.ownerUserId ? db.prepare('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL').get(card.ownerUserId) : null;
    if (owner && (!owner.is_active || owner.account_risk === 'blocked')) {
      db.prepare("UPDATE orders SET status = 'FAILED', closed_at = ?, callback_event = 'ACCOUNT_RISK_BLOCKED' WHERE id = ? AND status = 'PENDING'").run(Date.now(), row.id);
      return { terminal: true, code: 'ACCOUNT_RISK_BLOCKED', message: 'Card owner account is disabled or blocked', order: orderByTradeNo(db, tradeNo) };
    }
    const binAccess = db.prepare(`
      SELECT b.is_active AS bin_active, bg.group_id AS allowed_group_id
      FROM bins b
      LEFT JOIN bin_groups bg ON bg.bin_id = b.id AND bg.group_id = ?
      WHERE b.id = ?
    `).get(owner?.group_id ?? null, card.binId);
    if (!binAccess?.bin_active) {
      db.prepare("UPDATE orders SET status = 'FAILED', closed_at = ?, callback_event = 'BIN_DISABLED' WHERE id = ? AND status = 'PENDING'").run(Date.now(), row.id);
      return { terminal: true, code: 'BIN_DISABLED', message: 'Card BIN is disabled', order: orderByTradeNo(db, tradeNo) };
    }
    if (owner && owner.role !== 'admin' && !binAccess.allowed_group_id) {
      db.prepare("UPDATE orders SET status = 'FAILED', closed_at = ?, callback_event = 'CARD_BIN_ACCESS_REVOKED' WHERE id = ? AND status = 'PENDING'").run(Date.now(), row.id);
      return { terminal: true, code: 'CARD_BIN_ACCESS_REVOKED', message: 'Card BIN is no longer available to the owner group', order: orderByTradeNo(db, tradeNo) };
    }
    if (owner?.card_risk === 'frozen') {
      db.prepare("UPDATE orders SET status = 'FAILED', closed_at = ?, callback_event = 'CARD_RISK_FROZEN' WHERE id = ? AND status = 'PENDING'").run(Date.now(), row.id);
      return { terminal: true, code: 'CARD_RISK_FROZEN', message: 'Card payments are frozen for this account', order: orderByTradeNo(db, tradeNo) };
    }
    if (card.status !== 'active') {
      db.prepare("UPDATE orders SET status = 'FAILED', closed_at = ?, callback_event = 'CARD_DECLINED' WHERE id = ? AND status = 'PENDING'").run(Date.now(), row.id);
      return { terminal: true, code: 'CARD_DECLINED', message: card.declineReason || 'Card payment declined', order: orderByTradeNo(db, tradeNo) };
    }
    const current = new Date();
    if (card.expiresYear < current.getFullYear() || (card.expiresYear === current.getFullYear() && card.expiresMonth < current.getMonth() + 1)) {
      db.prepare("UPDATE orders SET status = 'FAILED', closed_at = ?, callback_event = 'CARD_EXPIRED' WHERE id = ? AND status = 'PENDING'").run(Date.now(), row.id);
      return { terminal: true, code: 'CARD_EXPIRED', message: 'Card has expired', order: orderByTradeNo(db, tradeNo) };
    }
    if (card.currency !== row.currency) {
      db.prepare("UPDATE orders SET status = 'FAILED', closed_at = ?, callback_event = 'CURRENCY_MISMATCH' WHERE id = ? AND status = 'PENDING'").run(Date.now(), row.id);
      return { terminal: true, code: 'CURRENCY_MISMATCH', message: 'Card currency does not match order currency', order: orderByTradeNo(db, tradeNo) };
    }
    if (card.binRequire3ds && (!pin || pin !== card.pin)) return { wrongPin: true, message: '3DS 密码错误', order: orderByTradeNo(db, tradeNo) };
    try {
      ensureTransactionLimit(cardSpendLimit(db, card), row.money_minor, 'Card transaction spending limit exceeded');
    } catch (error) {
      if (error instanceof EpayError && error.terminal) {
        db.prepare("UPDATE orders SET status = 'FAILED', closed_at = ?, callback_event = ? WHERE id = ? AND status = 'PENDING'").run(Date.now(), error.code, row.id);
        return { terminal: true, code: error.code, message: error.message, order: orderByTradeNo(db, tradeNo) };
      }
      throw error;
    }
    const debit = applyCardDebit(db, card, row.money_minor, { note: `Payment ${row.trade_no}`, orderId: row.id });
    if (!debit.ok) {
      const failure = recordInsufficientFailure(db, card, debit.code);
      db.prepare("UPDATE orders SET status = 'FAILED', closed_at = ?, callback_event = 'INSUFFICIENT_FUNDS' WHERE id = ? AND status = 'PENDING'").run(Date.now(), row.id);
      return {
        terminal: true,
        code: 'INSUFFICIENT_FUNDS',
        message: failure.frozen ? `${debit.message}；连续 5 次失败，卡片已自动冻结` : debit.message,
        order: orderByTradeNo(db, tradeNo)
      };
    }
    const now = Date.now();
    const settlementMode = card.cardType === 'credit' ? 'guarantee' : 'immediate';
    const commissionBps = merchantCommissionBps(db, row.merchant_id);
    const due = settlementMode === 'guarantee' ? now + settlementWindowSeconds(db) * 1000 : null;
    db.prepare(`UPDATE orders SET status = 'PAID', paid_at = ?, callback_event = 'PAYMENT_SUCCESS', payment_method = 'card', card_type_snapshot = ?, payer_user_id = ?, settlement_mode = ?, settlement_due_at = ?, commission_bps = ?, overdraft_fee_minor = ? WHERE id = ? AND status = 'PENDING'`)
      .run(now, card.cardType, card.ownerUserId || null, settlementMode, due, commissionBps, debit.feeMinor, row.id);
    const paidRow = rawOrder(db, tradeNo);
    if (settlementMode === 'immediate') settleMerchantBalance(db, paidRow, paidRow.money_minor);
    maybeFreezeForOverdraftWarning(db, card, debit.nextBalanceMinor, debit.config);
    return { paid: true, order: orderByTradeNo(db, tradeNo) };
  })();
}

function markOrderPaidWithoutCard({ db, tradeNo }) {
  return db.transaction(() => {
    const row = rawOrder(db, tradeNo);
    if (!row) throw new EpayError('Order not found', 'ORDER_NOT_FOUND', 404, true);
    if (row.status === 'PAID') return { changed: false, order: orderByTradeNo(db, tradeNo) };
    if (row.status !== 'PENDING') return { changed: false, order: orderByTradeNo(db, tradeNo) };
    const now = Date.now();
    db.prepare(`UPDATE orders SET status = 'PAID', paid_at = ?, callback_event = 'PAYMENT_SUCCESS', payment_method = 'auto', card_type_snapshot = 'auto', payer_user_id = NULL, settlement_mode = 'immediate', commission_bps = ? WHERE id = ? AND status = 'PENDING'`)
      .run(now, merchantCommissionBps(db, row.merchant_id), row.id);
    settleMerchantBalance(db, rawOrder(db, tradeNo), row.money_minor);
    return { changed: true, order: orderByTradeNo(db, tradeNo) };
  })();
}

function payOrderWithAccount({ db, tradeNo, user }) {
  return db.transaction(() => {
    const row = rawOrder(db, tradeNo);
    if (!row) throw new EpayError('Order not found', 'ORDER_NOT_FOUND', 404);
    if (row.status !== 'PENDING') throw new EpayError('Order is no longer payable', 'ORDER_CLOSED', 409, true);
    if (row.expires_at <= Date.now()) throw new EpayError('Order expired', 'ORDER_EXPIRED', 409, true);
    if (row.card_id) throw new EpayError('Bound-card orders cannot use account balance', 'CARD_ALREADY_BOUND', 409);
    if (row.currency !== 'CNY') {
      db.prepare("UPDATE orders SET status = 'FAILED', closed_at = ?, callback_event = 'CURRENCY_MISMATCH' WHERE id = ? AND status = 'PENDING'").run(Date.now(), row.id);
      return { paid: false, terminal: true, code: 'CURRENCY_MISMATCH', message: 'Account balance only supports CNY orders', order: orderByTradeNo(db, tradeNo) };
    }
    const account = db.prepare('SELECT * FROM users WHERE id = ? AND is_active = 1').get(Number(user.id));
    if (!account) throw new EpayError('User not found or disabled', 'USER_DISABLED', 403);
    if (account.account_risk === 'blocked') throw new EpayError('Account payment is blocked by risk control', 'ACCOUNT_RISK_BLOCKED', 403);
    try {
      ensureTransactionLimit(userSpendLimit(db, account.id), row.money_minor, 'Account transaction spending limit exceeded');
    } catch (error) {
      if (error instanceof EpayError && error.terminal) {
        db.prepare("UPDATE orders SET status = 'FAILED', closed_at = ?, callback_event = ? WHERE id = ? AND status = 'PENDING'").run(Date.now(), error.code, row.id);
        return { paid: false, terminal: true, code: error.code, message: error.message, order: orderByTradeNo(db, tradeNo) };
      }
      throw error;
    }
    if (account.account_balance_minor < row.money_minor) {
      db.prepare("UPDATE orders SET status = 'FAILED', closed_at = ?, callback_event = 'INSUFFICIENT_ACCOUNT_BALANCE' WHERE id = ? AND status = 'PENDING'").run(Date.now(), row.id);
      return { paid: false, terminal: true, code: 'INSUFFICIENT_ACCOUNT_BALANCE', message: 'Insufficient account balance', order: orderByTradeNo(db, tradeNo) };
    }
    const now = Date.now();
    accountTransaction(db, account.id, 'ORDER_PAYMENT', -row.money_minor, `支付订单 ${row.trade_no}`, row.id);
    db.prepare(`UPDATE orders SET status = 'PAID', paid_at = ?, callback_event = 'PAYMENT_SUCCESS', payment_method = 'account', card_type_snapshot = 'account', payer_user_id = ?, settlement_mode = 'guarantee', settlement_due_at = ?, commission_bps = ? WHERE id = ? AND status = 'PENDING'`)
      .run(now, account.id, now + settlementWindowSeconds(db) * 1000, merchantCommissionBps(db, row.merchant_id), row.id);
    return { paid: true, order: orderByTradeNo(db, tradeNo) };
  })();
}

function expireOrder({ db, tradeNo }) {
  return db.transaction(() => {
    const row = rawOrder(db, tradeNo);
    if (!row || row.status !== 'PENDING' || row.expires_at > Date.now()) return false;
    db.prepare("UPDATE orders SET status = 'EXPIRED', closed_at = ?, callback_event = 'ORDER_EXPIRED' WHERE id = ? AND status = 'PENDING'").run(Date.now(), row.id);
    return true;
  })();
}

function sweepExpiredOrders({ db, notification }) {
  const expired = db.prepare("SELECT id FROM orders WHERE status = 'PENDING' AND expires_at <= ? LIMIT 100").all(Date.now());
  if (!expired.length) return 0;
  const update = db.prepare("UPDATE orders SET status = 'EXPIRED', closed_at = ?, callback_event = 'ORDER_EXPIRED' WHERE id = ? AND status = 'PENDING'");
  const changed = db.transaction((rows) => { let count = 0; for (const row of rows) count += update.run(Date.now(), row.id).changes; return count; })(expired);
  if (changed) for (const row of expired) notification.enqueue(row.id);
  return changed;
}

function refundOrder({ db, tradeNo, orderId, merchantId = null, amountMinor = null, reason = '', createdBy = 'merchant', outRefundNo = null }) {
  return db.transaction(() => {
    const row = orderId ? db.prepare('SELECT * FROM orders WHERE id = ?').get(Number(orderId)) : rawOrder(db, tradeNo);
    if (!row || (merchantId && row.merchant_id !== Number(merchantId))) throw new EpayError('Order not found', 'ORDER_NOT_FOUND', 404);
    if (outRefundNo) {
      const existing = db.prepare('SELECT * FROM refunds WHERE merchant_id = ? AND out_refund_no = ?').get(row.merchant_id, String(outRefundNo));
      if (existing) {
        if (existing.order_id !== row.id || (amountMinor !== null && existing.amount_minor !== Number(amountMinor))) {
          throw new EpayError('out_refund_no was already used for a different refund request', 'IDEMPOTENCY_CONFLICT', 409);
        }
        return { refundNo: existing.refund_no, amountMinor: existing.amount_minor, order: orderByTradeNo(db, row.trade_no), reused: true };
      }
    }
    if (row.status !== 'PAID') throw new EpayError('Only paid orders can be refunded', 'INVALID_ORDER_STATE', 409);
    if (row.settlement_mode !== 'guarantee' || row.settled_at || !row.settlement_due_at || Date.now() >= row.settlement_due_at) throw new EpayError('Order is already settled and can no longer be refunded', 'REFUND_WINDOW_CLOSED', 409);
    const remaining = Number(row.money_minor) - Number(row.refunded_minor || 0);
    const refundMinor = amountMinor === null ? remaining : Number(amountMinor);
    if (!Number.isSafeInteger(refundMinor) || refundMinor <= 0 || refundMinor > remaining) throw new EpayError('Invalid refund amount', 'INVALID_REFUND_AMOUNT', 400);
    const refundNo = createTradeNo('R');
    const now = Date.now();
    let channel = 'none';
    let overdraftFeeRefundMinor = 0;
    if (row.card_id) {
      const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(row.card_id);
      if (!card) throw new EpayError('Original card no longer exists', 'REFUND_SOURCE_MISSING', 409);
      const feeTotal = Number(row.overdraft_fee_minor || 0);
      const feeAlreadyRefunded = Number(row.refunded_overdraft_fee_minor || 0);
      const feeRemaining = Math.max(0, feeTotal - feeAlreadyRefunded);
      overdraftFeeRefundMinor = refundMinor === remaining
        ? feeRemaining
        : Math.min(feeRemaining, Math.floor(feeTotal * refundMinor / Number(row.money_minor)));
      const creditMinor = refundMinor + overdraftFeeRefundMinor;
      const nextBalance = Number(card.balance_minor) + creditMinor;
      db.prepare('UPDATE cards SET balance_minor = ?, updated_at = ? WHERE id = ?').run(nextBalance, now, card.id);
      db.prepare(`INSERT INTO card_transactions (card_id, order_id, type, amount_minor, balance_after_minor, note, created_at) VALUES (?, ?, 'CREDIT', ?, ?, ?, ?)`).run(card.id, row.id, creditMinor, nextBalance, overdraftFeeRefundMinor ? `Refund ${row.trade_no}，含透支手续费冲正` : `Refund ${row.trade_no}`, now);
      channel = 'card';
    } else if (row.payer_user_id) {
      if (!db.prepare('SELECT id FROM users WHERE id = ?').get(row.payer_user_id)) throw new EpayError('Original account no longer exists', 'REFUND_SOURCE_MISSING', 409);
      accountTransaction(db, row.payer_user_id, 'ORDER_REFUND', refundMinor, `订单 ${row.trade_no} 退款`, row.id);
      channel = 'account';
    }
    db.prepare(`INSERT INTO refunds (refund_no, order_id, merchant_id, out_refund_no, amount_minor, channel, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(refundNo, row.id, row.merchant_id, outRefundNo || null, refundMinor, channel, String(reason || '').slice(0, 200), createdBy, now);
    const refundedMinor = Number(row.refunded_minor || 0) + refundMinor;
    const full = refundedMinor >= row.money_minor;
    db.prepare(`UPDATE orders SET refunded_minor = ?, refunded_overdraft_fee_minor = ?,
      refunded_at = ?, callback_event = 'REFUND', status = CASE WHEN ? = 1 THEN 'CHARGEBACK' ELSE status END,
      closed_at = CASE WHEN ? = 1 THEN ? ELSE closed_at END, notify_state = 'NONE', notify_attempts = 0 WHERE id = ?`)
      .run(refundedMinor, Number(row.refunded_overdraft_fee_minor || 0) + overdraftFeeRefundMinor, now, full ? 1 : 0, full ? 1 : 0, now, row.id);
    return { refundNo, amountMinor: refundMinor, order: orderByTradeNo(db, row.trade_no), reused: false };
  })();
}

function simulateChargeback({ db, orderId, reason = 'Admin refund' }) { return refundOrder({ db, orderId, reason, createdBy: 'admin' }); }
function renderOrderContext(order, merchant) {
  const now = Date.now();
  return { ...order, money: formatMinor(order.moneyMinor), canPay: order.status === 'PENDING' && order.expiresAt > now,
    refundable: order.status === 'PAID' && order.settlementMode === 'guarantee' && !order.settledAt && order.settlementDueAt > now && order.refundedMinor < order.moneyMinor,
    merchantName: merchant.name };
}

module.exports = { EpayError, createOrder, checkMerchant, validateOrderParams, baseUrlFor, paymentUrl, markOrderPaid, markOrderPaidWithoutCard, payOrderWithAccount, refundOrder, expireOrder, sweepExpiredOrders, settleMaturedOrders, simulateChargeback, renderOrderContext, effectiveSpendLimit, spentMinor };
