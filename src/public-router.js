const express = require('express');
const { normalizeParams, formatMinor, parseMoneyToMinor } = require('./epay');
const {
  getSetting,
  merchantByPid,
  cardById,
  cardByNumberHash,
  orderByTradeNo,
  mapCard
} = require('./db');
const {
  EpayError,
  checkMerchant,
  createOrder,
  paymentUrl,
  markOrderPaid,
  markOrderPaidWithoutCard,
  payOrderWithAccount,
  refundOrder,
  expireOrder,
  renderOrderContext
} = require('./order-service');
const {
  validUserCredentials,
  createSession,
  setSessionCookie
} = require('./admin-auth');
const { timingSafeEqualText } = require('./crypto');

function normalizeCardNumber(value) {
  return String(value || '').replace(/\D/g, '');
}

function parseCardExpiry(value) {
  const match = String(value || '').trim().match(/^(0[1-9]|1[0-2])\s*\/\s*(\d{2}|\d{4})$/);
  if (!match) return null;
  const year = match[2].length === 2 ? 2000 + Number(match[2]) : Number(match[2]);
  return { month: Number(match[1]), year };
}

function router({ db, config, notification }) {
  const route = express.Router();

  function autoSuccessEnabled() {
    return getSetting(db, 'auto_success_payments', '0') === '1';
  }

  function signedReturnUrl(order, merchant) {
    const params = notification.publicReturnParams(order, merchant);
    const target = new URL(order.returnUrl);
    for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value);
    return target.toString();
  }

  function createPaymentOrder({ req, params, merchant, createdVia }) {
    const result = createOrder({ req, db, config, input: params, merchant, createdVia });
    if (!autoSuccessEnabled()) return { ...result, autoPaid: false };
    const completed = markOrderPaidWithoutCard({ db, tradeNo: result.order.tradeNo });
    if (completed.changed) notification.enqueue(completed.order.id);
    return { ...result, order: completed.order, autoPaid: completed.order.status === 'PAID' };
  }

  route.get('/', (req, res) => {
    res.render('home', {
      title: '测试网关',
      merchantCount: db.prepare('SELECT COUNT(*) AS count FROM merchants WHERE is_active = 1').get().count
    });
  });

  route.get('/healthz', (req, res) => {
    try {
      db.prepare('SELECT 1 AS ok').get();
      res.json({ ok: true, service: 'epay-test-gateway', time: new Date().toISOString() });
    } catch (error) {
      res.status(503).json({ ok: false, error: 'database unavailable' });
    }
  });

  function handleRefundApi(req, res, params) {
    const merchant = checkMerchant(req, db, config, params);
    let tradeNo = String(params.trade_no || '').trim();
    if (!tradeNo && params.out_trade_no) {
      tradeNo = db.prepare('SELECT trade_no FROM orders WHERE merchant_id = ? AND out_trade_no = ?').get(merchant.id, String(params.out_trade_no))?.trade_no;
    }
    if (!tradeNo) throw new EpayError('Order not found', 'ORDER_NOT_FOUND', 404);
    const amountMinor = params.money || params.refund_money ? parseMoneyToMinor(params.money || params.refund_money) : null;
    if ((params.money || params.refund_money) && amountMinor === null) throw new EpayError('Invalid refund amount', 'INVALID_REFUND_AMOUNT', 400);
    const result = refundOrder({
      db,
      tradeNo,
      merchantId: merchant.id,
      amountMinor,
      reason: params.reason,
      createdBy: 'merchant-api',
      outRefundNo: params.out_refund_no || params.refund_no || null
    });
    if (!result.reused) notification.enqueue(result.order.id);
    res.json({
      code: 1,
      msg: result.reused ? 'Refund already exists' : 'success',
      refund_no: result.refundNo,
      trade_no: result.order.tradeNo,
      out_trade_no: result.order.outTradeNo,
      refund_money: formatMinor(result.amountMinor),
      status: 'REFUND_SUCCESS'
    });
  }

  function handleApi(req, res) {
    try {
      const params = normalizeParams({ ...req.query, ...req.body });
      const action = String(params.act || 'order');
      if (action === 'refund' && req.method !== 'POST') throw new EpayError('Refund API only accepts POST', 'METHOD_NOT_ALLOWED', 405);
      if (action === 'refund') return handleRefundApi(req, res, params);
      if (action !== 'order') throw new EpayError('Only act=order or act=refund is supported', 'UNSUPPORTED_ACTION');
      const merchant = checkMerchant(req, db, config, params);
      const { order, reused, autoPaid } = createPaymentOrder({ req, params, merchant, createdVia: 'api' });
      const payurl = autoPaid ? signedReturnUrl(order, merchant) : paymentUrl(req, config, order.tradeNo);
      res.json({
        code: 1,
        msg: reused ? 'Order already exists' : 'success',
        trade_no: order.tradeNo,
        out_trade_no: order.outTradeNo,
        payurl,
        urlscheme: payurl,
        qrcode: payurl,
        money: formatMinor(order.moneyMinor),
        status: order.status.toLowerCase(),
        bind_card: order.cardId || null
      });
    } catch (error) {
      const epayError = error instanceof EpayError ? error : new EpayError('Internal server error', 'SYSTEM_ERROR', 500);
      res.status(200).json({ code: -1, msg: epayError.message, errcode: epayError.code });
    }
  }

  route.get('/api.php', handleApi);
  route.post('/api.php', handleApi);
  route.get('/mapi.php', handleApi);
  route.post('/mapi.php', handleApi);

  function handleSubmit(req, res, next) {
    try {
      const params = normalizeParams({ ...req.query, ...req.body });
      const merchant = checkMerchant(req, db, config, params);
      const { order, autoPaid } = createPaymentOrder({ req, params, merchant, createdVia: 'submit' });
      res.redirect(302, autoPaid ? signedReturnUrl(order, merchant) : paymentUrl(req, config, order.tradeNo));
    } catch (error) {
      if (error instanceof EpayError) {
        return res.status(error.statusCode).render('payment-error', {
          title: '支付请求失败',
          message: error.message,
          code: error.code,
          returnUrl: null
        });
      }
      next(error);
    }
  }

  route.get('/submit.php', handleSubmit);
  route.post('/submit.php', handleSubmit);

  function userSelectableCards(currentUser) {
    if (!currentUser) return [];
    if (currentUser.role === 'admin') {
      return db.prepare(`
        SELECT c.*, b.name AS bin_name, b.prefix AS bin_prefix, b.brand, b.card_type, b.require_3ds AS bin_require_3ds,
          u.username AS owner_username, u.uid AS owner_uid
        FROM cards c
        JOIN bins b ON b.id = c.bin_id
        LEFT JOIN users u ON u.id = c.owner_user_id
        ORDER BY CASE c.status WHEN 'active' THEN 0 ELSE 1 END, c.created_at DESC
        LIMIT 300
      `).all().map((row) => mapCard(row, config.appSecret, false));
    }
    return db.prepare(`
      SELECT c.*, b.name AS bin_name, b.prefix AS bin_prefix, b.brand, b.card_type, b.require_3ds AS bin_require_3ds,
        u.username AS owner_username, u.uid AS owner_uid
      FROM cards c
      JOIN bins b ON b.id = c.bin_id
      LEFT JOIN users u ON u.id = c.owner_user_id
      WHERE c.owner_user_id = ?
      ORDER BY CASE c.status WHEN 'active' THEN 0 ELSE 1 END, c.created_at DESC
      LIMIT 300
    `).all(currentUser.id).map((row) => mapCard(row, config.appSecret, false));
  }

  function orderMerchant(order) {
    return merchantByPid(db, config.appSecret, order.merchantPid);
  }

  function remainingSeconds(order) {
    return Math.max(0, Math.floor((order.expiresAt - Date.now()) / 1000));
  }

  function renderBinding(req, res, order, { error = null, statusCode = 200 } = {}) {
    const merchant = orderMerchant(order);
    return res.status(statusCode).render('payment-bind', {
      title: '绑定虚拟卡支付',
      order: renderOrderContext(order, merchant),
      currentUser: req.currentUser,
      userCards: userSelectableCards(req.currentUser),
      accountBalanceMinor: req.currentUser?.accountBalanceMinor || 0,
      error,
      remainingSeconds: remainingSeconds(order)
    });
  }

  function renderPayment(req, res, order, { error = null, statusCode = 200 } = {}) {
    const merchant = orderMerchant(order);
    const card = order.cardId ? cardById(db, config.appSecret, order.cardId, false) : null;
    const allowBinding = getSetting(db, 'require_card_binding', '1') === '1';
    if (!card && order.status === 'PENDING' && allowBinding) {
      return renderBinding(req, res, order, { error, statusCode });
    }
    return res.status(statusCode).render('payment', {
      title: '安全支付',
      order: renderOrderContext(order, merchant),
      card,
      require3ds: Boolean(card?.binRequire3ds),
      error,
      remainingSeconds: remainingSeconds(order)
    });
  }

  function loadOrder(req, res) {
    let order = orderByTradeNo(db, req.params.tradeNo);
    if (!order) {
      res.status(404).render('payment-error', {
        title: '订单不存在',
        message: '未找到该支付订单，请返回商户重新下单。',
        code: 'ORDER_NOT_FOUND',
        returnUrl: null
      });
      return null;
    }
    if (order.status === 'PENDING' && order.expiresAt <= Date.now()) {
      if (expireOrder({ db, tradeNo: order.tradeNo })) notification.enqueue(order.id);
      order = orderByTradeNo(db, req.params.tradeNo);
    }
    return order;
  }

  route.get('/pay/:tradeNo/status', (req, res) => {
    let order = orderByTradeNo(db, req.params.tradeNo);
    if (!order) return res.status(404).json({ ok: false, error: { code: 'ORDER_NOT_FOUND', message: 'Order not found' } });
    if (order.status === 'PENDING' && order.expiresAt <= Date.now()) {
      if (expireOrder({ db, tradeNo: order.tradeNo })) notification.enqueue(order.id);
      order = orderByTradeNo(db, req.params.tradeNo);
    }
    return res.set('Cache-Control', 'no-store').json({
      ok: true,
      status: order.status,
      expiresAt: order.expiresAt,
      canPay: order.status === 'PENDING' && order.expiresAt > Date.now()
    });
  });

  route.get('/pay/:tradeNo', (req, res, next) => {
    try {
      const order = loadOrder(req, res);
      if (!order) return;
      return renderPayment(req, res, order);
    } catch (error) {
      next(error);
    }
  });

  route.post('/pay/:tradeNo/login', (req, res, next) => {
    try {
      const order = loadOrder(req, res);
      if (!order) return;
      if (order.status !== 'PENDING') return renderPayment(req, res, order);
      const user = validUserCredentials(db, String(req.body.username || ''), String(req.body.password || ''));
      if (!user) return renderBinding(req, res, order, { error: '用户名或密码错误，或账号已被停用。', statusCode: 401 });
      const session = createSession(user, config);
      setSessionCookie(res, config, session.token);
      return res.redirect(303, `/pay/${encodeURIComponent(order.tradeNo)}`);
    } catch (error) {
      next(error);
    }
  });

  route.post('/pay/:tradeNo/bind', (req, res, next) => {
    try {
      const order = loadOrder(req, res);
      if (!order) return;
      if (order.status !== 'PENDING') return renderPayment(req, res, order);
      if (order.cardId) return res.redirect(303, `/pay/${encodeURIComponent(order.tradeNo)}`);

      const selectedCardId = String(req.body.card_id || '').trim();
      let card = null;

      if (selectedCardId && req.currentUser) {
        card = cardById(db, config.appSecret, selectedCardId, true);
        if (card && req.currentUser.role === 'user' && card.ownerUserId !== req.currentUser.id) {
          return renderBinding(req, res, order, { error: '该虚拟卡不属于当前登录用户。', statusCode: 403 });
        }
      } else {
        const cardNumber = normalizeCardNumber(req.body.card_number);
        const expiry = parseCardExpiry(req.body.expiry);
        const cvv = String(req.body.cvv || '').trim();
        if (cardNumber.length >= 12 && expiry && /^\d{3,4}$/.test(cvv)) {
          const candidate = cardByNumberHash(db, config.appSecret, cardNumber);
          if (candidate && candidate.expiresMonth === expiry.month && candidate.expiresYear === expiry.year && timingSafeEqualText(candidate.cvv, cvv)) {
            card = candidate;
          }
        }
      }

      if (!card) return renderBinding(req, res, order, { error: '卡号、有效期或 CVV 不匹配，请检查后重试。', statusCode: 400 });

      const updated = db.prepare("UPDATE orders SET card_id = ? WHERE id = ? AND status = 'PENDING' AND card_id IS NULL")
        .run(card.id, order.id).changes;
      if (!updated) return res.redirect(303, `/pay/${encodeURIComponent(order.tradeNo)}`);
      return res.redirect(303, `/pay/${encodeURIComponent(order.tradeNo)}`);
    } catch (error) {
      next(error);
    }
  });

  route.post('/pay/:tradeNo/account', (req, res, next) => {
    try {
      let order = loadOrder(req, res);
      if (!order) return;
      if (!req.currentUser) return res.status(401).render('payment-error', { title: '请先登录', message: '使用账户余额支付前需要登录。', code: 'LOGIN_REQUIRED', returnUrl: order.returnUrl });
      if (order.cardId) return res.redirect(303, `/pay/${encodeURIComponent(order.tradeNo)}`);
      const result = payOrderWithAccount({ db, tradeNo: req.params.tradeNo, user: req.currentUser });
      order = result.order;
      const merchant = orderMerchant(order);
      notification.enqueue(order.id);
      const target = signedReturnUrl(order, merchant);
      if (!result.paid) {
        if (req.get('x-payment-ajax') === '1') {
          return res.status(409).json({ ok: false, status: order.status, error: { code: result.code, message: result.message }, redirectUrl: target });
        }
        return res.redirect(303, target);
      }
      if (req.get('x-payment-ajax') === '1') return res.json({ ok: true, status: order.status, redirectUrl: target });
      return res.redirect(303, target);
    } catch (error) {
      if (error instanceof EpayError && error.terminal) {
        const order = orderByTradeNo(db, req.params.tradeNo);
        if (order) {
          const merchant = orderMerchant(order);
          notification.enqueue(order.id);
          const target = signedReturnUrl(order, merchant);
          if (req.get('x-payment-ajax') === '1') return res.status(error.statusCode || 409).json({ ok: false, status: order.status, error: { code: error.code, message: error.message }, redirectUrl: target });
          return res.redirect(303, target);
        }
      }
      next(error);
    }
  });

  route.post('/pay/:tradeNo/confirm', (req, res, next) => {
    try {
      let order = loadOrder(req, res);
      if (!order) return;
      if (order.status === 'PENDING' && !order.cardId) {
        return res.redirect(303, `/pay/${encodeURIComponent(order.tradeNo)}`);
      }
      const result = markOrderPaid({ db, config, tradeNo: req.params.tradeNo, pin: String(req.body.pin || '') });
      order = result.order;
      const merchant = orderMerchant(order);
      if (result.wrongPin) {
        if (req.get('x-payment-ajax') === '1') {
          return res.status(401).json({ ok: false, status: order.status, error: { code: 'WRONG_PIN', message: result.message } });
        }
        const card = cardById(db, config.appSecret, order.cardId, false);
        return res.status(401).render('payment', {
          title: '安全支付',
          order: renderOrderContext(order, merchant),
          card,
          require3ds: Boolean(card?.binRequire3ds),
          error: result.message,
          remainingSeconds: remainingSeconds(order)
        });
      }
      if (result.terminal) {
        notification.enqueue(order.id);
        const target = signedReturnUrl(order, merchant);
        if (req.get('x-payment-ajax') === '1') {
          return res.status(409).json({ ok: false, status: order.status, error: { code: result.code, message: result.message }, redirectUrl: target });
        }
        return res.redirect(303, target);
      }
      notification.enqueue(order.id);
      const target = signedReturnUrl(order, merchant);
      if (req.get('x-payment-ajax') === '1') {
        return res.json({ ok: true, status: order.status, redirectUrl: target });
      }
      return res.redirect(303, target);
    } catch (error) {
      if (error instanceof EpayError && error.terminal) {
        const order = orderByTradeNo(db, req.params.tradeNo);
        if (order) {
          const merchant = orderMerchant(order);
          notification.enqueue(order.id);
          const target = signedReturnUrl(order, merchant);
          if (req.get('x-payment-ajax') === '1') {
            return res.status(error.statusCode || 409).json({
              ok: false,
              status: order.status,
              error: { code: error.code, message: error.message },
              redirectUrl: target
            });
          }
          return res.redirect(303, target);
        }
      }
      next(error);
    }
  });

  return route;
}

module.exports = { router };
