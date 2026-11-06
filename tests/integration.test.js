const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const request = require('supertest');
const { loadConfig } = require('../src/config');
const { createApp } = require('../src/app');
const { makeSign } = require('../src/epay');
const { cardById } = require('../src/db');

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

async function waitFor(predicate, timeoutMs = 8000) {
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

test('admin and user roles, card ownership, manual consume and card binding flow work end to end', async (t) => {
  const callbackServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('success');
  });
  await new Promise((resolve) => callbackServer.listen(0, '127.0.0.1', resolve));
  const callbackBase = `http://127.0.0.1:${callbackServer.address().port}`;

  const config = loadConfig({
    databasePath: ':memory:',
    appSecret: 'roles-binding-test-secret',
    adminPassword: 'test-admin-password',
    adminUsername: 'admin',
    adminPasswordIsDefault: false,
    defaultMerchantKey: 'roles-merchant-key',
    sweepIntervalMs: 3600000,
    notifyRetryCount: 1,
    notifyTimeoutMs: 1000
  });
  const appBundle = createApp({ config, logger: { error: console.error } });
  t.after(async () => {
    appBundle.close();
    await new Promise((resolve) => callbackServer.close(resolve));
  });

  const admin = request.agent(appBundle.app);
  let response = await admin.post('/admin/login').type('form').send({ username: 'admin', password: 'test-admin-password' });
  assert.equal(response.status, 302);
  response = await admin.get('/admin/orders/live');
  assert.equal(response.status, 200);
  const initialOrderFingerprint = response.body.fingerprint;
  assert.match(initialOrderFingerprint, /^[a-f0-9]{64}$/);

  response = await admin.get('/admin/users');
  assert.equal(response.status, 200);
  let csrf = csrfFrom(response.text);
  response = await admin.post('/admin/users').type('form').send({
    _csrf: csrf,
    username: 'normal-user',
    password: 'normal-password',
    role: 'user'
  });
  assert.equal(response.status, 302);
  const normalUser = appBundle.db.prepare("SELECT * FROM users WHERE username = 'normal-user'").get();
  assert.equal(normalUser.role, 'user');
  response = await admin.get('/admin/users');
  assert.equal(response.status, 200);
  assert.match(response.text, /normal-user/);

  response = await admin.get('/admin/bins');
  csrf = csrfFrom(response.text);
  response = await admin.post('/admin/bins').type('form').send({
    _csrf: csrf,
    name: 'Roles Test BIN',
    prefix: '553311',
    brand: 'Mastercard',
    card_type: 'debit',
    country: 'CN',
    number_length: '16'
  });
  assert.equal(response.status, 302);
  const bin = appBundle.db.prepare("SELECT * FROM bins WHERE prefix = '553311'").get();

  response = await admin.get('/admin/cards/new');
  csrf = csrfFrom(response.text);
  response = await admin.post('/admin/cards').type('form').send({
    _csrf: csrf,
    owner_user_id: String(normalUser.id),
    bin_id: String(bin.id),
    balance: '50.00',
    expires_month: '12',
    expires_year: String(new Date().getFullYear() + 5),
    cvv: '321',
    pin: '135790',
    status: 'active',
    decline_reason: ''
  });
  assert.equal(response.status, 302);
  const cardId = decodeURIComponent(response.headers.location.split('/admin/cards/')[1].split('?')[0]);
  assert.equal(appBundle.db.prepare('SELECT owner_user_id FROM cards WHERE id = ?').get(cardId).owner_user_id, normalUser.id);

  const user = request.agent(appBundle.app);
  response = await user.post('/admin/login').type('form').send({ username: 'normal-user', password: 'normal-password' });
  assert.equal(response.status, 302);
  assert.equal(response.headers.location, '/admin');

  response = await user.get('/admin');
  assert.equal(response.status, 200);
  assert.match(response.text, /我的仪表盘/);
  response = await user.get('/admin/cards');
  assert.equal(response.status, 200);
  assert.match(response.text, new RegExp(cardId));
  for (const path of ['/admin/bins', '/admin/users', '/admin/merchants', '/admin/settings']) {
    response = await user.get(path);
    assert.equal(response.status, 403, path);
  }

  response = await user.get(`/admin/cards/${cardId}`);
  assert.equal(response.status, 200);
  assert.match(response.text, /普通用户仅可创建自己的虚拟卡/);
  assert.doesNotMatch(response.text, /手工消费/);
  response = await user.get('/admin/cards/new');
  const userCsrf = csrfFrom(response.text);
  response = await user.post(`/admin/cards/${cardId}/update`).type('form').send({
    _csrf: userCsrf,
    status: 'active',
    balance: '999999.00',
    expires_month: '12',
    expires_year: String(new Date().getFullYear() + 5),
    pin: '135790',
    cvv: '321'
  });
  assert.equal(response.status, 403);

  response = await user.get('/admin/cards/new');
  csrf = csrfFrom(response.text);
  response = await user.post('/admin/cards').type('form').send({
    _csrf: csrf,
    bin_id: String(bin.id),
    balance: '20.00',
    expires_month: '11',
    expires_year: String(new Date().getFullYear() + 4),
    cvv: '777',
    pin: '864200',
    status: 'declined'
  });
  assert.equal(response.status, 302);
  const userCreatedCardId = decodeURIComponent(response.headers.location.split('/admin/cards/')[1].split('?')[0]);
  const userCreatedCard = appBundle.db.prepare('SELECT * FROM cards WHERE id = ?').get(userCreatedCardId);
  assert.equal(userCreatedCard.owner_user_id, normalUser.id);
  assert.equal(userCreatedCard.status, 'active');

  response = await admin.get(`/admin/cards/${cardId}`);
  csrf = csrfFrom(response.text);
  response = await admin.post(`/admin/cards/${cardId}/update`).type('form').send({
    _csrf: csrf,
    owner_user_id: String(normalUser.id),
    status: 'active',
    decline_reason: '',
    balance: '100.00',
    expires_month: '12',
    expires_year: String(new Date().getFullYear() + 5),
    pin: '135790',
    cvv: '321'
  });
  assert.equal(response.status, 302);
  response = await admin.post(`/admin/cards/${cardId}/consume`).type('form').send({
    _csrf: csrf,
    amount: '10.00',
    note: '管理员手工消费测试'
  });
  assert.equal(response.status, 302);
  assert.equal(appBundle.db.prepare('SELECT balance_minor FROM cards WHERE id = ?').get(cardId).balance_minor, 9000);
  const cardSecrets = cardById(appBundle.db, config.appSecret, cardId, true);
  const cardExpiry = `${String(cardSecrets.expiresMonth).padStart(2, '0')}/${String(cardSecrets.expiresYear).slice(-2)}`;

  const unboundSubmit = signedOrderParams('roles-merchant-key', {
    notify_url: `${callbackBase}/notify`,
    return_url: `${callbackBase}/return`,
    out_trade_no: `UNBOUND-SUBMIT-${Date.now()}`
  });
  response = await request(appBundle.app).get('/submit.php').query(unboundSubmit);
  assert.equal(response.status, 302);
  assert.match(response.headers.location, /\/pay\/T/);
  const submitTradeNo = response.headers.location.split('/pay/')[1];

  response = await request(appBundle.app).get(`/pay/${submitTradeNo}`);
  assert.equal(response.status, 200);
  assert.match(response.text, /绑定虚拟银行卡/);
  assert.match(response.text, /使用银行卡信息绑卡/);
  assert.match(response.text, /name="card_number"/);
  assert.match(response.text, /name="expiry"/);
  assert.match(response.text, /name="cvv"/);
  response = await request(appBundle.app).post(`/pay/${submitTradeNo}/bind`).type('form').send({
    card_number: cardSecrets.cardNumber,
    expiry: cardExpiry,
    cvv: '999'
  });
  assert.equal(response.status, 400);
  assert.match(response.text, /卡号、有效期或 CVV 不匹配/);
  response = await request(appBundle.app).post(`/pay/${submitTradeNo}/bind`).type('form').send({
    card_number: cardSecrets.cardNumber,
    expiry: cardExpiry,
    cvv: cardSecrets.cvv
  });
  assert.equal(response.status, 303);
  assert.equal(response.headers.location, `/pay/${submitTradeNo}`);
  response = await request(appBundle.app).get(`/pay/${submitTradeNo}`);
  assert.equal(response.status, 200);
  assert.match(response.text, /绑定的虚拟银行卡/);
  response = await request(appBundle.app).get('/js/payment.js');
  assert.equal(response.status, 200);
  assert.match(response.text, /正在处理支付/);
  const pendingOrderForRefresh = appBundle.db.prepare('SELECT id FROM orders WHERE trade_no = ?').get(submitTradeNo);
  response = await admin.get(`/admin/orders/${pendingOrderForRefresh.id}`);
  assert.equal(response.status, 200);
  assert.match(response.text, /http-equiv="refresh" content="3"/);
  response = await request(appBundle.app).post(`/pay/${submitTradeNo}/confirm`).type('form').send({ pin: '135790' });
  assert.equal(response.status, 303);
  assert.match(response.headers.location, /trade_status=TRADE_SUCCESS/);
  assert.equal(appBundle.db.prepare('SELECT balance_minor FROM cards WHERE id = ?').get(cardId).balance_minor, 7766);
  response = await admin.get('/admin/orders/live');
  assert.equal(response.status, 200);
  assert.notEqual(response.body.fingerprint, initialOrderFingerprint);
  const paidOrderForRefresh = appBundle.db.prepare('SELECT id FROM orders WHERE trade_no = ?').get(submitTradeNo);
  response = await admin.get(`/admin/orders/${paidOrderForRefresh.id}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.match(response.text, /data-orders-live-url="\/admin\/orders\/live"/);
  assert.match(response.text, /\/js\/admin\.js\?v=1\./);
  assert.doesNotMatch(response.text, /http-equiv="refresh"/);

  const unboundApi = signedOrderParams('roles-merchant-key', {
    notify_url: `${callbackBase}/notify`,
    return_url: `${callbackBase}/return`,
    out_trade_no: `UNBOUND-API-${Date.now()}`
  });
  response = await request(appBundle.app).get('/api.php').query(unboundApi);
  assert.equal(response.status, 200);
  assert.equal(response.body.code, 1);
  assert.equal(response.body.bind_card, null);
  const loginBindingTradeNo = response.body.trade_no;

  const payingUser = request.agent(appBundle.app);
  response = await payingUser.get(`/pay/${loginBindingTradeNo}`);
  assert.equal(response.status, 200);
  assert.match(response.text, /登录后选卡/);
  response = await payingUser.post(`/pay/${loginBindingTradeNo}/login`).type('form').send({
    username: 'normal-user',
    password: 'normal-password'
  });
  assert.equal(response.status, 303);
  response = await payingUser.get(`/pay/${loginBindingTradeNo}`);
  assert.equal(response.status, 200);
  assert.match(response.text, /选择我的虚拟卡/);
  assert.match(response.text, new RegExp(userCreatedCardId));
  response = await payingUser.post(`/pay/${loginBindingTradeNo}/bind`).type('form').send({ card_id: userCreatedCardId });
  assert.equal(response.status, 303);
  assert.equal(appBundle.db.prepare('SELECT card_id FROM orders WHERE trade_no = ?').get(loginBindingTradeNo).card_id, userCreatedCardId);

  const no3dsParams = signedOrderParams('roles-merchant-key', {
    notify_url: `${callbackBase}/notify`,
    return_url: `${callbackBase}/return`,
    out_trade_no: `NO-3DS-${Date.now()}`,
    money: '1.00'
  });
  response = await request(appBundle.app).get('/api.php').query(no3dsParams);
  assert.equal(response.body.code, 1);
  const no3dsTradeNo = response.body.trade_no;
  response = await request(appBundle.app).post(`/pay/${no3dsTradeNo}/bind`).type('form').send({
    card_number: cardSecrets.cardNumber,
    expiry: cardExpiry,
    cvv: cardSecrets.cvv
  });
  assert.equal(response.status, 303);
  appBundle.db.prepare("UPDATE settings SET value = '0' WHERE key = 'require_3ds'").run();
  response = await request(appBundle.app).get(`/pay/${no3dsTradeNo}`);
  assert.equal(response.status, 200);
  assert.match(response.text, /3DS 验证已关闭/);
  assert.doesNotMatch(response.text, /name="pin"/);
  response = await request(appBundle.app).post(`/pay/${no3dsTradeNo}/confirm`).type('form').send({});
  assert.equal(response.status, 303);
  assert.match(response.headers.location, /trade_status=TRADE_SUCCESS/);
  const no3dsOrder = appBundle.db.prepare('SELECT id, status FROM orders WHERE trade_no = ?').get(no3dsTradeNo);
  assert.equal(no3dsOrder.status, 'PAID');
  assert.equal(appBundle.db.prepare('SELECT balance_minor FROM cards WHERE id = ?').get(cardId).balance_minor, 7666);
  await waitFor(() => appBundle.db.prepare('SELECT * FROM callback_logs WHERE order_id = ? AND success = 1').get(no3dsOrder.id));
});
