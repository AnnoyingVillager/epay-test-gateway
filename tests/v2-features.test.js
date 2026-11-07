const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { loadConfig } = require('../src/config');
const { createApp } = require('../src/app');
const { makeSign } = require('../src/epay');
const { setSetting } = require('../src/db');
const { accountTransaction } = require('../src/account-service');
const { settleMaturedOrders } = require('../src/order-service');

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
    out_trade_no: `V2-${Date.now()}-${Math.floor(Math.random() * 100000)}`,
    notify_url: 'http://127.0.0.1:1/notify',
    return_url: 'http://127.0.0.1:1/return',
    name: 'V2 feature test',
    money: '1.00',
    sitename: 'V2 Shop',
    ...overrides
  };
  params.sign = makeSign(params, key);
  params.sign_type = 'MD5';
  return params;
}

function signedApiParams(key, overrides = {}) {
  const params = { pid: '1001', ...overrides };
  params.sign = makeSign(params, key);
  params.sign_type = 'MD5';
  return params;
}

function makeBundle(t, options = {}) {
  const config = loadConfig({
    databasePath: ':memory:',
    appSecret: 'v2-integration-secret',
    adminPassword: 'admin-password',
    adminUsername: 'admin',
    adminPasswordIsDefault: false,
    defaultMerchantKey: 'v2-merchant-key',
    baseUrl: 'http://gateway.test',
    sweepIntervalMs: 3600000,
    notifyRetryCount: 0,
    notifyTimeoutMs: 250
  });
  const mailer = options.mailer || { async sendVerificationCode() {} };
  const bundle = createApp({ config, mailer, logger: { error() {} } });
  t.after(() => bundle.close());
  return bundle;
}

async function loginAdmin(agent) {
  const response = await agent.post('/admin/login').type('form').send({ username: 'admin', password: 'admin-password' });
  assert.equal(response.status, 302);
  assert.equal(response.headers.location, '/admin');
}

async function createBin(admin, values) {
  let response = await admin.get('/admin/bins');
  const csrf = csrfFrom(response.text);
  response = await admin.post('/admin/bins').type('form').send({ _csrf: csrf, group_ids_present: '1', ...values });
  assert.equal(response.status, 302);
  return response;
}

async function createAdminCard(admin, db, values) {
  let response = await admin.get('/admin/cards/new');
  const csrf = csrfFrom(response.text);
  const adminRow = db.prepare("SELECT id FROM users WHERE uid = 0").get();
  response = await admin.post('/admin/cards').type('form').send({
    _csrf: csrf,
    owner_user_id: String(adminRow.id),
    expires_month: '12',
    expires_year: String(new Date().getFullYear() + 5),
    cvv: '321',
    pin: '246810',
    status: 'active',
    decline_reason: '',
    ...values
  });
  assert.equal(response.status, 302);
  const cardId = decodeURIComponent(response.headers.location.split('/admin/cards/')[1].split('?')[0]);
  return cardId;
}

test('registration, email verification, invite replacement and invite quotas work', async (t) => {
  const sentCodes = new Map();
  const mailer = {
    fail: false,
    async sendVerificationCode(email, code) {
      if (mailer.fail) throw new Error('simulated SMTP failure');
      sentCodes.set(email, code);
    }
  };
  const bundle = makeBundle(t, { mailer });
  const { app, db } = bundle;
  setSetting(db, 'registration_enabled', '1');
  setSetting(db, 'registration_require_email', '1');
  setSetting(db, 'email_list_mode', 'whitelist');
  setSetting(db, 'email_whitelist', '@example.com');
  setSetting(db, 'invite_custom_fee_minor', '10000');
  setSetting(db, 'invite_slot_purchase_enabled', '1');
  setSetting(db, 'invite_slot_price_minor', '1000');

  const alice = request.agent(app);
  let response = await alice.get('/admin/login');
  assert.match(response.text, /立即注册/);

  response = await alice.post('/register').type('form').send({ username: '1invalid', password: 'Alice1234' });
  assert.equal(response.status, 400);
  assert.match(response.text, /用户名不符合/);

  response = await alice.post('/register/send-code').send({ email: 'alice@outside.test' });
  assert.equal(response.status, 400);
  assert.match(response.body.message, /白名单/);

  response = await alice.post('/register/send-code').send({ email: 'Alice@Example.com' });
  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.match(sentCodes.get('alice@example.com'), /^\d{6}$/);

  response = await alice.post('/register').type('form').send({
    username: 'AliceUser',
    password: 'Alice1234',
    email: 'alice@example.com',
    email_code: sentCodes.get('alice@example.com')
  });
  assert.equal(response.status, 302);
  assert.equal(response.headers.location, '/admin');

  let user = db.prepare("SELECT * FROM users WHERE username = 'AliceUser'").get();
  assert.equal(user.uid, 1);
  assert.equal(user.role, 'user');
  assert.equal(user.group_id, db.prepare("SELECT id FROM user_groups WHERE name = 'Default'").get().id);
  assert.match(user.invite_code, /^[A-Za-z0-9]{8}$/);
  const originalCode = user.invite_code;

  accountTransaction(db, user.id, 'TEST_CREDIT', 20000, 'Registration feature test credit');
  response = await alice.get('/admin/invite');
  let csrf = csrfFrom(response.text);
  response = await alice.post('/admin/invite/custom').type('form').send({ _csrf: csrf, code: 'Bad1234' });
  assert.equal(response.status, 302);
  assert.match(response.headers.location, /error=/);
  user = db.prepare("SELECT * FROM users WHERE id = ?").get(user.id);
  assert.equal(user.account_balance_minor, 20000);
  assert.equal(user.invite_code, originalCode);

  response = await alice.post('/admin/invite/custom').type('form').send({ _csrf: csrf, code: 'MyInviteCode' });
  assert.equal(response.status, 302);
  user = db.prepare("SELECT * FROM users WHERE id = ?").get(user.id);
  assert.equal(user.invite_code, 'MyInviteCode');
  assert.equal(user.account_balance_minor, 10000);

  response = await alice.post('/admin/invite/random').type('form').send({ _csrf: csrf });
  assert.equal(response.status, 302);
  user = db.prepare("SELECT * FROM users WHERE id = ?").get(user.id);
  assert.match(user.invite_code, /^[A-Za-z0-9]{8}$/);

  const codeAfterRandom = user.invite_code;
  response = await alice.post('/admin/invite/custom').type('form').send({ _csrf: csrf, code: codeAfterRandom });
  assert.equal(response.status, 302);
  assert.match(response.headers.location, /ok=/);
  assert.equal(db.prepare('SELECT account_balance_minor FROM users WHERE id = ?').get(user.id).account_balance_minor, 10000);

  response = await alice.post('/admin/invite/slots').type('form').send({ _csrf: csrf, quantity: 'not-a-number' });
  assert.equal(response.status, 302);
  assert.match(response.headers.location, /error=/);
  assert.equal(db.prepare('SELECT account_balance_minor FROM users WHERE id = ?').get(user.id).account_balance_minor, 10000);
  assert.equal(db.prepare('SELECT invite_limit FROM users WHERE id = ?').get(user.id).invite_limit, 10);

  response = await alice.post('/admin/invite/slots').type('form').send({ _csrf: csrf, quantity: '2' });
  assert.equal(response.status, 302);
  user = db.prepare("SELECT * FROM users WHERE id = ?").get(user.id);
  assert.equal(user.invite_limit, 12);
  assert.equal(user.account_balance_minor, 8000);
  const finalCode = user.invite_code;

  response = await alice.post('/admin/invite/random').type('form').send({ _csrf: csrf });
  assert.equal(response.status, 302);
  response = await alice.post('/admin/invite/custom').type('form').send({ _csrf: csrf, code: codeAfterRandom });
  assert.equal(response.status, 302);
  assert.match(response.headers.location, /error=/);
  assert.equal(db.prepare('SELECT account_balance_minor FROM users WHERE id = ?').get(user.id).account_balance_minor, 8000);
  const currentCode = db.prepare('SELECT invite_code FROM users WHERE id = ?').get(user.id).invite_code;

  setSetting(db, 'registration_require_email', '0');
  const bob = request.agent(app);
  response = await bob.post('/register').type('form').send({
    username: 'BobUser',
    password: 'BobUser123',
    invite_code: currentCode
  });
  assert.equal(response.status, 302);
  const invitee = db.prepare("SELECT * FROM users WHERE username = 'BobUser'").get();
  assert.equal(invitee.invited_by_uid, user.uid);
  assert.equal(db.prepare('SELECT invited_count FROM users WHERE id = ?').get(user.id).invited_count, 1);

  db.prepare('UPDATE users SET invite_limit = 1 WHERE id = ?').run(user.id);
  const charlie = request.agent(app);
  response = await charlie.post('/register').type('form').send({
    username: 'CharlieUser',
    password: 'Charlie123',
    invite_code: currentCode
  });
  assert.equal(response.status, 400);
  assert.match(response.text, /名额已用完/);

  setSetting(db, 'registration_require_email', '1');
  mailer.fail = true;
  const retryUser = request.agent(app);
  response = await retryUser.post('/register/send-code').send({ email: 'retry@example.com' });
  assert.equal(response.status, 500);
  response = await retryUser.post('/register/send-code').send({ email: 'retry@example.com' });
  assert.equal(response.status, 500);
  assert.doesNotMatch(response.body.message, /过于频繁/);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM email_verification_codes WHERE email = ?').get('retry@example.com').count, 0);
  mailer.fail = false;
  response = await retryUser.post('/register/send-code').send({ email: 'retry@example.com' });
  assert.equal(response.status, 200);
});

test('per-user invite permissions inherit the global policy or override it independently', async (t) => {
  const bundle = makeBundle(t);
  const { app, db } = bundle;
  const admin = request.agent(app);
  await loginAdmin(admin);
  const defaultGroup = db.prepare("SELECT id FROM user_groups WHERE name = 'Default'").get();
  setSetting(db, 'registration_enabled', '1');
  setSetting(db, 'registration_require_invite', '1');
  setSetting(db, 'registration_require_email', '0');
  setSetting(db, 'user_invites_enabled', '0');

  let response = await admin.get('/admin/users');
  assert.match(response.text, /邀请权限模式/);
  let csrf = csrfFrom(response.text);
  response = await admin.post('/admin/users').type('form').send({
    _csrf: csrf,
    username: 'CustomInviter',
    password: 'CustomInviter123',
    role: 'user',
    group_id: String(defaultGroup.id),
    invite_permission_mode: 'custom',
    can_invite: '1'
  });
  assert.equal(response.status, 302);
  let inviter = db.prepare("SELECT * FROM users WHERE username = 'CustomInviter'").get();
  assert.equal(inviter.invite_permission_mode, 'custom');
  assert.equal(inviter.can_invite, 1);

  response = await request.agent(app).post('/register').type('form').send({
    username: 'CustomInvitee',
    password: 'CustomInvitee123',
    invite_code: inviter.invite_code
  });
  assert.equal(response.status, 302, response.text);
  assert.equal(db.prepare("SELECT invited_by_uid FROM users WHERE username = 'CustomInvitee'").get().invited_by_uid, inviter.uid);

  response = await admin.post(`/admin/users/${inviter.uid}/invite-permission`).type('form').send({
    _csrf: csrf,
    invite_permission_mode: 'custom',
    can_invite: '0'
  });
  assert.equal(response.status, 302);
  inviter = db.prepare('SELECT * FROM users WHERE id = ?').get(inviter.id);
  assert.equal(inviter.can_invite, 0);
  assert.equal(inviter.invite_permission_mode, 'custom');

  response = await request.agent(app).post('/register').type('form').send({
    username: 'BlockedInvitee',
    password: 'BlockedInvitee123',
    invite_code: inviter.invite_code
  });
  assert.equal(response.status, 400);
  assert.match(response.text, /没有邀请权限/);

  response = await admin.post(`/admin/users/${inviter.uid}/invite-permission`).type('form').send({
    _csrf: csrf,
    invite_permission_mode: 'inherit',
    can_invite: '1'
  });
  assert.equal(response.status, 302);
  inviter = db.prepare('SELECT * FROM users WHERE id = ?').get(inviter.id);
  assert.equal(inviter.can_invite, 1);
  assert.equal(inviter.invite_permission_mode, 'inherit');

  response = await request.agent(app).post('/register').type('form').send({
    username: 'InheritedBlocked',
    password: 'InheritedBlocked123',
    invite_code: inviter.invite_code
  });
  assert.equal(response.status, 400);
  assert.match(response.text, /没有邀请权限/);

  setSetting(db, 'user_invites_enabled', '1');
  response = await admin.post(`/admin/users/${inviter.uid}/invite-permission`).type('form').send({
    _csrf: csrf,
    invite_permission_mode: 'inherit',
    can_invite: '0'
  });
  assert.equal(response.status, 302);
  response = await request.agent(app).post('/register').type('form').send({
    username: 'InheritedSwitchOff',
    password: 'InheritedSwitchOff123',
    invite_code: inviter.invite_code
  });
  assert.equal(response.status, 400);
  assert.match(response.text, /没有邀请权限/);

  response = await admin.post(`/admin/users/${inviter.uid}/invite-permission`).type('form').send({
    _csrf: csrf,
    invite_permission_mode: 'inherit',
    can_invite: ['0', '1']
  });
  assert.equal(response.status, 302);
  response = await request.agent(app).post('/register').type('form').send({
    username: 'InheritedAllowed',
    password: 'InheritedAllowed123',
    invite_code: inviter.invite_code
  });
  assert.equal(response.status, 302, response.text);
});
test('group BIN access, account transfers, super risk lock and archived UID work', async (t) => {
  const bundle = makeBundle(t);
  const { app, db } = bundle;
  const admin = request.agent(app);
  await loginAdmin(admin);
  let response = await admin.get('/admin/users/0');
  assert.equal(response.status, 200);
  assert.match(response.text, /UID/);

  const defaultGroup = db.prepare("SELECT id FROM user_groups WHERE name = 'Default'").get();
  const vipGroup = db.prepare("SELECT id FROM user_groups WHERE name = 'VIP'").get();
  await createBin(admin, { name: 'Default only', prefix: '411111', brand: 'Visa', card_type: 'debit', country: 'CN', number_length: '16', require_3ds: '0', group_ids: String(defaultGroup.id) });
  await createBin(admin, { name: 'VIP only', prefix: '522222', brand: 'Mastercard', card_type: 'credit', country: 'CN', number_length: '16', require_3ds: '1', group_ids: String(vipGroup.id) });

  response = await admin.get('/admin/users');
  let csrf = csrfFrom(response.text);
  response = await admin.post('/admin/users').type('form').send({
    _csrf: csrf,
    username: 'GroupUser',
    password: 'GroupUser123',
    role: 'user',
    group_id: String(defaultGroup.id)
  });
  assert.equal(response.status, 302);
  let user = db.prepare("SELECT * FROM users WHERE username = 'GroupUser'").get();
  assert.equal(user.uid, 1);

  const userAgent = request.agent(app);
  response = await userAgent.post('/admin/login').type('form').send({ username: 'GroupUser', password: 'GroupUser123' });
  assert.equal(response.status, 302);

  response = await userAgent.get('/admin/cards/new');
  assert.match(response.text, /411111/);
  assert.doesNotMatch(response.text, /522222/);
  assert.match(response.text, /Default 分组每张开卡赠送 700\.00 CNY/);
  csrf = csrfFrom(response.text);
  const defaultBin = db.prepare("SELECT * FROM bins WHERE prefix = '411111'").get();
  response = await userAgent.post('/admin/cards').type('form').send({
    _csrf: csrf,
    bin_id: String(defaultBin.id),
    balance: '999999.00',
    expires_month: '12',
    expires_year: String(new Date().getFullYear() + 3),
    cvv: '123',
    pin: '',
    status: 'declined'
  });
  assert.equal(response.status, 302);
  const defaultCardId = decodeURIComponent(response.headers.location.split('/admin/cards/')[1].split('?')[0]);
  let defaultCard = db.prepare('SELECT * FROM cards WHERE id = ?').get(defaultCardId);
  assert.equal(defaultCard.balance_minor, 70000);
  assert.equal(defaultCard.status, 'active');

  response = await admin.get(`/admin/users/${user.uid}`);
  assert.equal(response.status, 200, response.text);
  csrf = csrfFrom(response.text);
  response = await admin.post(`/admin/users/${user.uid}/update`).type('form').send({
    _csrf: csrf,
    group_id: String(vipGroup.id),
    account_risk: 'normal',
    card_risk: 'normal',
    spend_limit_mode: 'custom',
    spend_limit: '100.00',
    card_balance_limit_unlimited: '1',
    invite_limit: '10',
    can_invite: '1',
    is_active: '1'
  });
  assert.equal(response.status, 302);
  user = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  assert.equal(user.group_id, vipGroup.id);

  response = await userAgent.get('/admin/cards/new');
  assert.match(response.text, /522222/);
  assert.doesNotMatch(response.text, /411111/);
  assert.match(response.text, /VIP 分组每张开卡赠送 7000\.00 CNY/);
  csrf = csrfFrom(response.text);
  response = await userAgent.post('/admin/cards').type('form').send({
    _csrf: csrf,
    bin_id: String(db.prepare("SELECT id FROM bins WHERE prefix = '522222'").get().id),
    expires_month: '11',
    expires_year: String(new Date().getFullYear() + 4),
    cvv: '456',
    pin: '135790',
    status: 'active'
  });
  assert.equal(response.status, 302);
  const vipCardId = decodeURIComponent(response.headers.location.split('/admin/cards/')[1].split('?')[0]);
  assert.equal(db.prepare('SELECT balance_minor FROM cards WHERE id = ?').get(vipCardId).balance_minor, 700000);

  accountTransaction(db, user.id, 'TEST_CREDIT', 100000, 'Transfer test credit');
  setSetting(db, 'card_deposit_fee_bps', '100');
  setSetting(db, 'card_min_deposit_fee_minor', '50');
  setSetting(db, 'card_withdraw_fee_bps', '100');
  setSetting(db, 'card_min_withdraw_fee_minor', '50');
  response = await userAgent.get('/admin/account');
  csrf = csrfFrom(response.text);
  response = await userAgent.post('/admin/account/deposit').type('form').send({ _csrf: csrf, card_id: defaultCardId, amount: '100.00' });
  assert.equal(response.status, 302);
  assert.match(response.headers.location, /ok=/);
  assert.equal(db.prepare('SELECT account_balance_minor FROM users WHERE id = ?').get(user.id).account_balance_minor, 89900);
  assert.equal(db.prepare('SELECT balance_minor FROM cards WHERE id = ?').get(defaultCardId).balance_minor, 80000);

  response = await userAgent.post('/admin/account/withdraw').type('form').send({ _csrf: csrf, card_id: defaultCardId, amount: '50.00' });
  assert.equal(response.status, 302);
  assert.equal(db.prepare('SELECT account_balance_minor FROM users WHERE id = ?').get(user.id).account_balance_minor, 94850);
  assert.equal(db.prepare('SELECT balance_minor FROM cards WHERE id = ?').get(defaultCardId).balance_minor, 75000);

  response = await request(app).get('/api.php').query(signedOrderParams('v2-merchant-key', {
    money: '5.00',
    out_trade_no: `ACCOUNT-PAY-${Date.now()}`
  }));
  assert.equal(response.body.code, 1);
  const accountTradeNo = response.body.trade_no;
  response = await userAgent.get(`/pay/${accountTradeNo}`);
  assert.equal(response.status, 200);
  assert.match(response.text, /使用账户余额支付/);
  response = await userAgent.post(`/pay/${accountTradeNo}/account`).set('X-Payment-Ajax', '1').set('Accept', 'application/json');
  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.status, 'PAID');
  let accountOrder = db.prepare('SELECT * FROM orders WHERE trade_no = ?').get(accountTradeNo);
  assert.equal(accountOrder.payment_method, 'account');
  assert.equal(accountOrder.settlement_mode, 'guarantee');
  assert.equal(db.prepare('SELECT account_balance_minor FROM users WHERE id = ?').get(user.id).account_balance_minor, 94350);

  const accountRefund = signedApiParams('v2-merchant-key', {
    act: 'refund',
    trade_no: accountTradeNo,
    money: '5.00',
    out_refund_no: `ACCOUNT-REF-${Date.now()}`
  });
  response = await request(app).post('/api.php').type('form').send(accountRefund);
  assert.equal(response.body.code, 1);
  accountOrder = db.prepare('SELECT * FROM orders WHERE trade_no = ?').get(accountTradeNo);
  assert.equal(accountOrder.status, 'CHARGEBACK');
  assert.equal(db.prepare('SELECT account_balance_minor FROM users WHERE id = ?').get(user.id).account_balance_minor, 94850);

  db.prepare('UPDATE users SET spend_limit_minor = 100 WHERE id = ?').run(user.id);
  response = await request(app).get('/api.php').query(signedOrderParams('v2-merchant-key', {
    money: '5.00',
    out_trade_no: `ACCOUNT-LIMIT-${Date.now()}`
  }));
  const limitedTradeNo = response.body.trade_no;
  response = await userAgent.post(`/pay/${limitedTradeNo}/account`).set('X-Payment-Ajax', '1').set('Accept', 'application/json');
  assert.equal(response.status, 409);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.error.code, 'SPEND_LIMIT_EXCEEDED');
  assert.equal(db.prepare('SELECT status FROM orders WHERE trade_no = ?').get(limitedTradeNo).status, 'FAILED');

  db.prepare("UPDATE cards SET status = 'frozen' WHERE id = ?").run(defaultCardId);
  response = await userAgent.post('/admin/account/deposit').type('form').send({ _csrf: csrf, card_id: defaultCardId, amount: '10.00' });
  assert.equal(response.status, 302);
  assert.match(response.headers.location, /error=/);
  assert.equal(db.prepare('SELECT balance_minor FROM cards WHERE id = ?').get(defaultCardId).balance_minor, 75000);

  user = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  response = await admin.get(`/admin/users/${user.uid}`);
  assert.equal(response.status, 200, response.text);
  csrf = csrfFrom(response.text);
  response = await admin.post(`/admin/users/${user.uid}/super-risk`).type('form').send({ _csrf: csrf, reason: 'Automated extreme risk test' });
  assert.equal(response.status, 302);
  user = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  assert.equal(user.account_balance_minor, 0);
  assert.equal(user.is_active, 0);
  assert.ok(user.super_risk_at);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM cards WHERE owner_user_id = ?').get(user.id).count, 0);

  response = await admin.post(`/admin/users/${user.uid}/update`).type('form').send({ _csrf: csrf, is_active: '1', group_id: String(vipGroup.id) });
  assert.equal(response.status, 302);
  assert.match(response.headers.location, /error=/);
  assert.equal(db.prepare('SELECT is_active FROM users WHERE id = ?').get(user.id).is_active, 0);

  response = await admin.get(`/admin/users/${user.uid}`);
  assert.equal(response.status, 200, response.text);
  csrf = csrfFrom(response.text);
  response = await admin.post(`/admin/users/${user.uid}/delete`).type('form').send({ _csrf: csrf });
  assert.equal(response.status, 302);
  user = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  assert.ok(user.deleted_at);
  assert.equal(user.is_active, 0);
  assert.ok(db.prepare('SELECT id FROM deleted_users WHERE uid = ?').get(user.uid));
  response = await admin.get('/admin/users');
  assert.doesNotMatch(response.text, /GroupUser/);
  response = await admin.get(`/admin/users/${user.uid}`);
  assert.equal(response.status, 404);

  csrf = csrfFrom((await admin.get('/admin/users')).text);
  response = await admin.post('/admin/users').type('form').send({ _csrf: csrf, username: 'GroupUser', password: 'AnotherPass123', role: 'user', group_id: String(defaultGroup.id) });
  assert.equal(response.status, 302);
  assert.match(response.headers.location, /error=/);

  response = await admin.post('/admin/users').type('form').send({ _csrf: csrf, username: 'AfterDelete', password: 'AfterDelete123', role: 'user', group_id: String(defaultGroup.id) });
  assert.equal(response.status, 302);
  const afterDelete = db.prepare("SELECT uid FROM users WHERE username = 'AfterDelete'").get();
  assert.ok(afterDelete.uid > user.uid);
});

test('debit settlement, credit guarantee refunds, commission and idempotency work', async (t) => {
  const bundle = makeBundle(t);
  const { app, db } = bundle;
  const admin = request.agent(app);
  await loginAdmin(admin);
  const defaultGroup = db.prepare("SELECT id FROM user_groups WHERE name = 'Default'").get();

  await createBin(admin, { name: 'Debit', prefix: '433333', brand: 'Visa', card_type: 'debit', country: 'CN', number_length: '16', require_3ds: '0', group_ids: String(defaultGroup.id) });
  await createBin(admin, { name: 'Credit', prefix: '544444', brand: 'Mastercard', card_type: 'credit', country: 'CN', number_length: '16', require_3ds: '0', group_ids: String(defaultGroup.id) });
  const debitBin = db.prepare("SELECT id FROM bins WHERE prefix = '433333'").get();
  const creditBin = db.prepare("SELECT id FROM bins WHERE prefix = '544444'").get();
  const debitCardId = await createAdminCard(admin, db, { bin_id: String(debitBin.id), balance: '100.00' });
  const creditCardId = await createAdminCard(admin, db, { bin_id: String(creditBin.id), balance: '100.00' });

  const merchant = db.prepare("SELECT * FROM merchants WHERE pid = '1001'").get();
  db.prepare('UPDATE merchants SET commission_bps = 500 WHERE id = ?').run(merchant.id);

  let response = await request(app).get('/api.php').query(signedOrderParams('v2-merchant-key', { bind_card: debitCardId, money: '10.00', out_trade_no: `DEBIT-${Date.now()}` }));
  assert.equal(response.body.code, 1);
  const debitTradeNo = response.body.trade_no;
  response = await request(app).post(`/pay/${debitTradeNo}/confirm`).type('form').send({});
  assert.equal(response.status, 303);
  let order = db.prepare('SELECT * FROM orders WHERE trade_no = ?').get(debitTradeNo);
  assert.equal(order.status, 'PAID');
  assert.equal(order.settlement_mode, 'immediate');
  assert.ok(order.settled_at);
  assert.equal(db.prepare('SELECT balance_minor FROM cards WHERE id = ?').get(debitCardId).balance_minor, 9000);
  assert.equal(db.prepare('SELECT balance_minor FROM merchants WHERE id = ?').get(merchant.id).balance_minor, 950);

  const debitRefund = signedApiParams('v2-merchant-key', {
    act: 'refund',
    trade_no: debitTradeNo,
    money: '10.00',
    out_refund_no: `DREF-${Date.now()}`,
    reason: 'debit cannot refund'
  });
  response = await request(app).get('/api.php').query(debitRefund);
  assert.equal(response.body.code, -1);
  assert.equal(response.body.errcode, 'METHOD_NOT_ALLOWED');
  response = await request(app).post('/api.php').type('form').send(debitRefund);
  assert.equal(response.body.code, -1);
  assert.equal(response.body.errcode, 'REFUND_WINDOW_CLOSED');

  response = await request(app).get('/api.php').query(signedOrderParams('v2-merchant-key', { bind_card: creditCardId, money: '20.00', out_trade_no: `CREDIT-${Date.now()}` }));
  const creditTradeNo = response.body.trade_no;
  response = await request(app).post(`/pay/${creditTradeNo}/confirm`).type('form').send({});
  assert.equal(response.status, 303);
  order = db.prepare('SELECT * FROM orders WHERE trade_no = ?').get(creditTradeNo);
  assert.equal(order.status, 'PAID');
  assert.equal(order.settlement_mode, 'guarantee');
  assert.equal(order.settled_at, null);
  assert.equal(db.prepare('SELECT balance_minor FROM merchants WHERE id = ?').get(merchant.id).balance_minor, 950);

  const refundNo = `PREF-${Date.now()}`;
  const partialRefund = signedApiParams('v2-merchant-key', {
    act: 'refund',
    trade_no: creditTradeNo,
    money: '5.00',
    out_refund_no: refundNo,
    reason: 'partial test refund'
  });
  response = await request(app).post('/api.php').type('form').send(partialRefund);
  assert.equal(response.body.code, 1);
  assert.equal(response.body.status, 'REFUND_SUCCESS');
  order = db.prepare('SELECT * FROM orders WHERE trade_no = ?').get(creditTradeNo);
  assert.equal(order.status, 'PAID');
  assert.equal(order.refunded_minor, 500);
  assert.equal(db.prepare('SELECT balance_minor FROM cards WHERE id = ?').get(creditCardId).balance_minor, 8500);

  response = await request(app).post('/api.php').type('form').send(partialRefund);
  assert.equal(response.body.code, 1);
  assert.match(response.body.msg, /already exists/);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM refunds WHERE order_id = ?').get(order.id).count, 1);

  response = await request(app).get('/api.php').query(signedOrderParams('v2-merchant-key', { bind_card: creditCardId, money: '1.00', out_trade_no: `CREDIT-CONFLICT-${Date.now()}` }));
  const conflictTradeNo = response.body.trade_no;
  const conflictRefund = signedApiParams('v2-merchant-key', {
    act: 'refund',
    trade_no: conflictTradeNo,
    money: '0.50',
    out_refund_no: refundNo
  });
  response = await request(app).post('/api.php').type('form').send(conflictRefund);
  assert.equal(response.body.code, -1);
  assert.equal(response.body.errcode, 'IDEMPOTENCY_CONFLICT');

  const fullRefund = signedApiParams('v2-merchant-key', {
    act: 'refund',
    trade_no: creditTradeNo,
    money: '15.00',
    out_refund_no: `FREF-${Date.now()}`,
    reason: 'full remaining refund'
  });
  response = await request(app).post('/api.php').type('form').send(fullRefund);
  assert.equal(response.body.code, 1);
  order = db.prepare('SELECT * FROM orders WHERE trade_no = ?').get(creditTradeNo);
  assert.equal(order.status, 'CHARGEBACK');
  assert.equal(order.refunded_minor, 2000);
  assert.equal(db.prepare('SELECT balance_minor FROM cards WHERE id = ?').get(creditCardId).balance_minor, 10000);

  response = await request(app).get('/api.php').query(signedOrderParams('v2-merchant-key', { bind_card: creditCardId, money: '20.00', out_trade_no: `CREDIT-MATURE-${Date.now()}` }));
  const matureTradeNo = response.body.trade_no;
  response = await request(app).post(`/pay/${matureTradeNo}/confirm`).type('form').send({});
  assert.equal(response.status, 303);
  const matureOrder = db.prepare('SELECT * FROM orders WHERE trade_no = ?').get(matureTradeNo);
  assert.equal(db.prepare('SELECT balance_minor FROM merchants WHERE id = ?').get(merchant.id).balance_minor, 950);
  assert.equal(settleMaturedOrders({ db }), 0);
  const fingerprintBeforeSettlement = (await admin.get('/admin/orders/live')).body.fingerprint;
  db.prepare('UPDATE orders SET settlement_due_at = ? WHERE id = ?').run(Date.now() - 1000, matureOrder.id);
  assert.equal(settleMaturedOrders({ db }), 1);
  const fingerprintAfterSettlement = (await admin.get('/admin/orders/live')).body.fingerprint;
  assert.notEqual(fingerprintAfterSettlement, fingerprintBeforeSettlement);
  assert.ok(db.prepare('SELECT settled_at FROM orders WHERE id = ?').get(matureOrder.id).settled_at);
  assert.equal(db.prepare('SELECT balance_minor FROM merchants WHERE id = ?').get(merchant.id).balance_minor, 2850);
});