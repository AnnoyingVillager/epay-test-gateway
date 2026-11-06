const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const request = require('supertest');
const { loadConfig } = require('../src/config');
const { createApp } = require('../src/app');
const { makeSign } = require('../src/epay');

function csrfFrom(html) {
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  assert.ok(match, 'CSRF token should be present');
  return match[1];
}

function signedOrderParams(key, overrides = {}) {
  const params = {
    act: 'order',
    pid: '1001',
    type: 'alipay',
    out_trade_no: `ORDER-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
    notify_url: '',
    return_url: '',
    name: 'Integration test order',
    money: '12.34',
    sitename: 'Test Shop',
    ...overrides
  };
  params.sign = makeSign(params, key);
  params.sign_type = 'MD5';
  return params;
}

async function waitFor(predicate, timeoutMs = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error('Timed out waiting for condition');
}

test('admin, Epay API, payment, callbacks, failures and chargeback work end to end', async (t) => {
  const callbackServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('success');
  });
  await new Promise((resolve) => callbackServer.listen(0, '127.0.0.1', resolve));
  const callbackPort = callbackServer.address().port;
  const callbackBase = `http://127.0.0.1:${callbackPort}`;

  const config = loadConfig({
    databasePath: ':memory:',
    appSecret: 'integration-test-secret',
    adminPassword: 'test-admin-password',
    adminUsername: 'admin',
    adminPasswordIsDefault: false,
    defaultMerchantKey: 'integration-merchant-key',
    sweepIntervalMs: 3600000,
    notifyRetryCount: 1,
    notifyTimeoutMs: 1000
  });
  const appBundle = createApp({ config, logger: { error: console.error } });
  t.after(async () => {
    appBundle.close();
    await new Promise((resolve) => callbackServer.close(resolve));
  });

  const agent = request.agent(appBundle.app);
  let response = await agent.post('/admin/login').type('form').send({ username: 'admin', password: 'test-admin-password' });
  assert.equal(response.status, 302);
  assert.equal(response.headers.location, '/admin');

  response = await agent.get('/admin');
  assert.equal(response.status, 200);
  assert.match(response.text, /仪表盘/);

  response = await agent.get('/admin/bins');
  assert.equal(response.status, 200);
  let csrf = csrfFrom(response.text);

  for (const path of ['/admin/cards', '/admin/merchants', '/admin/settings', '/admin/orders']) {
    response = await agent.get(path);
    assert.equal(response.status, 200, path);
  }
  response = await agent.post('/admin/bins').type('form').send({
    _csrf: csrf,
    name: 'Integration Visa',
    prefix: '424242',
    brand: 'Visa',
    card_type: 'debit',
    country: 'CN',
    number_length: '16'
  });
  assert.equal(response.status, 302);

  response = await agent.get('/admin/cards/new');
  assert.equal(response.status, 200);
  csrf = csrfFrom(response.text);
  const bin = appBundle.db.prepare("SELECT * FROM bins WHERE prefix = '424242'").get();
  response = await agent.post('/admin/cards').type('form').send({
    _csrf: csrf,
    bin_id: String(bin.id),
    balance: '100.00',
    expires_month: '12',
    expires_year: String(new Date().getFullYear() + 5),
    cvv: '123',
    pin: '246810',
    status: 'active',
    decline_reason: 'declined for test'
  });
  assert.equal(response.status, 302);
  const cardId = decodeURIComponent(response.headers.location.split('/admin/cards/')[1].split('?')[0]);
  assert.match(cardId, /^CARD-/);

  response = await agent.get(`/admin/cards/${cardId}`);
  assert.equal(response.status, 200);
  assert.match(response.text, /246810/);
  assert.match(response.text, /100\.00/);

  response = await request(appBundle.app).get('/api.php').query(signedOrderParams('wrong-key', {
    notify_url: `${callbackBase}/notify`,
    return_url: `${callbackBase}/return`,
    bind_card: cardId
  }));
  assert.equal(response.status, 200);
  assert.equal(response.body.code, -1);
  assert.equal(response.body.errcode, 'SIGN_ERROR');

  const orderParams = signedOrderParams('integration-merchant-key', {
    notify_url: `${callbackBase}/notify`,
    return_url: `${callbackBase}/return`,
    bind_card: cardId
  });
  response = await request(appBundle.app).get('/api.php').query(orderParams);
  assert.equal(response.status, 200);
  assert.equal(response.body.code, 1);
  assert.match(response.body.payurl, /\/pay\/T/);
  const tradeNo = response.body.trade_no;

  response = await request(appBundle.app).get(`/pay/${tradeNo}`);
  assert.equal(response.status, 200);
  assert.match(response.text, /绑定的虚拟银行卡/);
  assert.match(response.text, /•••• •••• ••••/);

  response = await request(appBundle.app).post(`/pay/${tradeNo}/confirm`).type('form').send({ pin: 'wrong-pin' });
  assert.equal(response.status, 401);
  assert.match(response.text, /3DS 密码错误/);

  response = await request(appBundle.app).post(`/pay/${tradeNo}/confirm`).type('form').send({ pin: '246810' });
  assert.equal(response.status, 303);
  assert.match(response.headers.location, /trade_status=TRADE_SUCCESS/);
  assert.match(response.headers.location, /sign=/);

  const paidOrder = appBundle.db.prepare('SELECT * FROM orders WHERE trade_no = ?').get(tradeNo);
  assert.equal(paidOrder.status, 'PAID');
  const cardAfterPayment = appBundle.db.prepare('SELECT * FROM cards WHERE id = ?').get(cardId);
  assert.equal(cardAfterPayment.balance_minor, 8766);
  await waitFor(() => appBundle.db.prepare("SELECT * FROM callback_logs WHERE order_id = ? AND success = 1").get(paidOrder.id));

  appBundle.db.prepare("UPDATE cards SET status = 'declined', decline_reason = 'Risk rule' WHERE id = ?").run(cardId);
  const failedParams = signedOrderParams('integration-merchant-key', {
    notify_url: `${callbackBase}/notify`,
    return_url: `${callbackBase}/return`,
    bind_card: cardId,
    out_trade_no: `FAILED-${Date.now()}`,
    money: '5.00'
  });
  response = await request(appBundle.app).get('/api.php').query(failedParams);
  assert.equal(response.body.code, 1);
  const failedTradeNo = response.body.trade_no;
  response = await request(appBundle.app).post(`/pay/${failedTradeNo}/confirm`).type('form').send({ pin: '246810' });
  assert.equal(response.status, 303);
  assert.match(response.headers.location, /trade_status=TRADE_CLOSED/);
  assert.match(response.headers.location, /errcode=CARD_DECLINED/);
  const declinedOrder = appBundle.db.prepare('SELECT * FROM orders WHERE trade_no = ?').get(failedTradeNo);
  assert.equal(declinedOrder.status, 'FAILED');
  assert.equal(appBundle.db.prepare('SELECT balance_minor FROM cards WHERE id = ?').get(cardId).balance_minor, 8766);

  appBundle.db.prepare("UPDATE cards SET status = 'active' WHERE id = ?").run(cardId);
  const expiryParams = signedOrderParams('integration-merchant-key', {
    notify_url: `${callbackBase}/notify`,
    return_url: `${callbackBase}/return`,
    bind_card: cardId,
    out_trade_no: `EXPIRY-${Date.now()}`,
    money: '1.00'
  });
  response = await request(appBundle.app).get('/api.php').query(expiryParams);
  const expiryTradeNo = response.body.trade_no;
  appBundle.db.prepare('UPDATE orders SET expires_at = ? WHERE trade_no = ?').run(Date.now() - 1000, expiryTradeNo);
  response = await request(appBundle.app).get(`/pay/${expiryTradeNo}`);
  assert.equal(response.status, 200);
  assert.match(response.text, /已超时/);
  assert.equal(appBundle.db.prepare('SELECT status FROM orders WHERE trade_no = ?').get(expiryTradeNo).status, 'EXPIRED');

  response = await agent.get(`/admin/orders/${paidOrder.id}`);
  assert.equal(response.status, 200);
  csrf = csrfFrom(response.text);
  response = await agent.post(`/admin/orders/${paidOrder.id}/chargeback`).type('form').send({ _csrf: csrf });
  assert.equal(response.status, 302);
  assert.equal(appBundle.db.prepare('SELECT status FROM orders WHERE id = ?').get(paidOrder.id).status, 'CHARGEBACK');
  assert.equal(appBundle.db.prepare('SELECT balance_minor FROM cards WHERE id = ?').get(cardId).balance_minor, 10000);

  response = await request(appBundle.app).get('/submit.php').query(signedOrderParams('integration-merchant-key', {
    notify_url: `${callbackBase}/notify`,
    return_url: `${callbackBase}/return`,
    bind_card: cardId,
    out_trade_no: `SUBMIT-${Date.now()}`
  }));
  assert.equal(response.status, 302);
  assert.match(response.headers.location, /\/pay\/T/);
});
