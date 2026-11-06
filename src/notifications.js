const { buildCallbackParams, callbackUrl, formatMinor } = require('./epay');
const { orderByTradeNo, merchantById } = require('./db');

class NotificationService {
  constructor({ db, config, logger = console }) {
    this.db = db;
    this.config = config;
    this.logger = logger;
    this.inFlight = new Set();
  }

  callbackPayload(order, merchant) {
    if (order.status === 'PAID') {
      return {
        event: 'payment.success',
        tradeStatus: 'TRADE_SUCCESS',
        extras: {}
      };
    }
    if (order.status === 'EXPIRED') {
      return {
        event: 'payment.expired',
        tradeStatus: 'TRADE_CLOSED',
        extras: { errcode: 'ORDER_EXPIRED', errmsg: 'Order expired' }
      };
    }
    if (order.status === 'CHARGEBACK') {
      return {
        event: 'payment.chargeback',
        tradeStatus: 'TRADE_CLOSED',
        extras: { refund_status: 'REFUND_SUCCESS', errcode: 'CHARGEBACK', errmsg: 'Simulated chargeback' }
      };
    }
    const failureReasons = {
      CARD_DECLINED: { errcode: 'CARD_DECLINED', errmsg: 'Card payment declined' },
      INSUFFICIENT_FUNDS: { errcode: 'INSUFFICIENT_FUNDS', errmsg: 'Insufficient card balance' },
      CARD_EXPIRED: { errcode: 'CARD_EXPIRED', errmsg: 'Card has expired' }
    };
    return {
      event: 'payment.failed',
      tradeStatus: 'TRADE_CLOSED',
      extras: failureReasons[order.callbackEvent] || { errcode: 'PAYMENT_FAILED', errmsg: 'Payment failed' }
    };
  }

  publicReturnParams(order, merchant) {
    const payload = this.callbackPayload(order, merchant);
    return buildCallbackParams(order, merchant, payload.tradeStatus, payload.extras);
  }

  enqueue(orderId, options = {}) {
    const key = `${orderId}:${options.force ? `force-${Date.now()}` : 'auto'}`;
    if (!options.force && this.inFlight.has(String(orderId))) return;
    if (!options.force) this.inFlight.add(String(orderId));
    setImmediate(() => {
      this.deliver(Number(orderId), options).catch((error) => {
        this.logger.error?.('Notification task failed', error);
      }).finally(() => {
        if (!options.force) this.inFlight.delete(String(orderId));
      });
    });
  }

  async deliver(orderId, options = {}) {
    const order = this.db.prepare(`
      SELECT o.*, m.pid AS merchant_pid, m.name AS merchant_name, c.last4 AS card_last4
      FROM orders o
      JOIN merchants m ON m.id = o.merchant_id
      LEFT JOIN cards c ON c.id = o.card_id
      WHERE o.id = ?
    `).get(orderId);
    if (!order) return { ok: false, error: 'Order not found' };

    const { mapOrder } = require('./db');
    const mappedOrder = mapOrder(order);
    const merchant = merchantById(this.db, this.config.appSecret, order.merchant_id);
    if (!merchant) return { ok: false, error: 'Merchant not found' };

    const payload = this.callbackPayload(mappedOrder, merchant);
    const params = buildCallbackParams(mappedOrder, merchant, payload.tradeStatus, payload.extras);
    const targetUrl = callbackUrl(order.notify_url, params);
    const maxAttempts = options.force ? 1 : Math.max(0, this.config.notifyRetryCount) + 1;
    let lastError = '';

    this.db.prepare(`
      UPDATE orders SET notify_state = 'PENDING', callback_event = ?, notify_last_error = NULL
      WHERE id = ?
    `).run(payload.event, orderId);

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const response = await fetch(targetUrl, {
          method: 'GET',
          redirect: 'manual',
          signal: AbortSignal.timeout(this.config.notifyTimeoutMs),
          headers: { 'User-Agent': 'Epay-Test-Gateway/1.0' }
        });
        const responseBody = (await response.text()).slice(0, 2000);
        const success = response.status >= 200 && response.status < 300 && responseBody.trim().toLowerCase() === 'success';
        this.db.prepare(`
          INSERT INTO callback_logs (order_id, event, url, success, status_code, response_body, error, attempted_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(orderId, payload.event, targetUrl, success ? 1 : 0, response.status, responseBody, success ? null : 'Response body was not "success" or HTTP status was not 2xx', Date.now());
        this.db.prepare('UPDATE orders SET notify_attempts = notify_attempts + 1 WHERE id = ?').run(orderId);

        if (success) {
          this.db.prepare(`
            UPDATE orders SET notify_state = 'SENT', notified_at = ?, notify_last_error = NULL WHERE id = ?
          `).run(Date.now(), orderId);
          return { ok: true, responseBody };
        }
        lastError = `HTTP ${response.status}: ${responseBody.slice(0, 300)}`;
      } catch (error) {
        lastError = error.message;
        this.db.prepare(`
          INSERT INTO callback_logs (order_id, event, url, success, status_code, response_body, error, attempted_at)
          VALUES (?, ?, ?, 0, NULL, NULL, ?, ?)
        `).run(orderId, payload.event, targetUrl, lastError, Date.now());
        this.db.prepare('UPDATE orders SET notify_attempts = notify_attempts + 1 WHERE id = ?').run(orderId);
      }

      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(5000, attempt * 1000)));
      }
    }

    this.db.prepare(`
      UPDATE orders SET notify_state = 'FAILED', notify_last_error = ? WHERE id = ?
    `).run(lastError || 'Notification failed', orderId);
    return { ok: false, error: lastError };
  }
}

module.exports = { NotificationService, formatMinor };
