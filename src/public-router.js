const express = require('express');
const {
  normalizeParams
} = require('./epay');
const {
  merchantByPid,
  cardById,
  orderByTradeNo
} = require('./db');
const {
  EpayError,
  checkMerchant,
  createOrder,
  paymentUrl,
  markOrderPaid,
  expireOrder,
  renderOrderContext
} = require('./order-service');
const { formatMinor } = require('./epay');

function router({ db, config, notification }) {
  const route = express.Router();

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

  function handleApi(req, res) {
    try {
      const params = normalizeParams({ ...req.query, ...req.body });
      if (String(params.act || 'order') !== 'order') {
        throw new EpayError('Only act=order is supported', 'UNSUPPORTED_ACTION');
      }
      const merchant = checkMerchant(req, db, config, params);
      const { order, reused } = createOrder({ req, db, config, input: params, merchant, createdVia: 'api' });
      const payurl = paymentUrl(req, config, order.tradeNo);
      res.json({
        code: 1,
        msg: reused ? 'Order already exists' : 'success',
        trade_no: order.tradeNo,
        out_trade_no: order.outTradeNo,
        payurl,
        urlscheme: payurl,
        qrcode: payurl,
        money: formatMinor(order.moneyMinor),
        status: order.status.toLowerCase()
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
      const { order } = createOrder({ req, db, config, input: params, merchant, createdVia: 'submit' });
      res.redirect(302, paymentUrl(req, config, order.tradeNo));
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

  route.get('/pay/:tradeNo', (req, res, next) => {
    try {
      let order = orderByTradeNo(db, req.params.tradeNo);
      if (!order) {
        return res.status(404).render('payment-error', {
          title: '订单不存在',
          message: '未找到该支付订单，请返回商户重新下单。',
          code: 'ORDER_NOT_FOUND',
          returnUrl: null
        });
      }
      if (order.status === 'PENDING' && order.expiresAt <= Date.now()) {
        if (expireOrder({ db, tradeNo: order.tradeNo })) notification.enqueue(order.id);
        order = orderByTradeNo(db, req.params.tradeNo);
      }
      const merchant = merchantByPid(db, config.appSecret, order.merchantPid);
      const card = order.cardId ? cardById(db, config.appSecret, order.cardId, false) : null;
      res.render('payment', {
        title: '安全支付',
        order: renderOrderContext(order, merchant),
        card,
        error: null,
        remainingSeconds: Math.max(0, Math.floor((order.expiresAt - Date.now()) / 1000))
      });
    } catch (error) {
      next(error);
    }
  });

  route.post('/pay/:tradeNo/confirm', (req, res, next) => {
    try {
      const result = markOrderPaid({ db, config, tradeNo: req.params.tradeNo, pin: String(req.body.pin || '') });
      const order = result.order;
      const merchant = merchantByPid(db, config.appSecret, order.merchantPid);
      if (result.wrongPin) {
        const card = cardById(db, config.appSecret, order.cardId, false);
        return res.status(401).render('payment', {
          title: '安全支付',
          order: renderOrderContext(order, merchant),
          card,
          error: result.message,
          remainingSeconds: Math.max(0, Math.floor((order.expiresAt - Date.now()) / 1000))
        });
      }
      notification.enqueue(order.id);
      const params = notification.publicReturnParams(order, merchant);
      const target = new URL(order.returnUrl);
      for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value);
      return res.redirect(303, target.toString());
    } catch (error) {
      if (error instanceof EpayError && error.terminal) {
        const order = orderByTradeNo(db, req.params.tradeNo);
        if (order) {
          const merchant = merchantByPid(db, config.appSecret, order.merchantPid);
          notification.enqueue(order.id);
          const params = notification.publicReturnParams(order, merchant);
          const target = new URL(order.returnUrl);
          for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value);
          return res.redirect(303, target.toString());
        }
      }
      next(error);
    }
  });

  return route;
}

module.exports = { router };
