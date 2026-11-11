const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');
const { loadConfig } = require('../src/config');
const { createApp } = require('../src/app');
const { isSuperAdmin, canManageUser, canRefundOrder } = require('../src/permissions');
const { encrypt, cardNumberHash, generateCardNumber, hashPassword } = require('../src/crypto');
const { mapUser } = require('../src/db');

function csrfFrom(html) {
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  assert.ok(match, 'CSRF token should be present');
  return match[1];
}

function makeBundle(t) {
  const config = loadConfig({
    databasePath: ':memory:',
    appSecret: 'role-hierarchy-test-secret',
    adminPassword: 'root-password-123',
    adminUsername: 'admin',
    adminPasswordIsDefault: false,
    defaultMerchantKey: 'role-hierarchy-merchant-key',
    sweepIntervalMs: 3600000,
    notifyRetryCount: 0,
    notifyTimeoutMs: 100
  });
  const bundle = createApp({ config, mailer: { async sendVerificationCode() {} }, logger: { error() {} } });
  bundle.config = config;
  t.after(() => bundle.close());
  return bundle;
}

async function login(agent, username, password) {
  return agent.post('/admin/login').type('form').send({ username, password });
}

async function loginRoot(bundle) {
  const agent = request.agent(bundle.app);
  const response = await login(agent, 'admin', 'root-password-123');
  assert.equal(response.status, 302);
  return agent;
}

async function createUser(admin, bundle, { username, password, role = 'user' }) {
  let response = await admin.get('/admin/users');
  const csrf = csrfFrom(response.text);
  response = await admin.post('/admin/users').type('form').send({ _csrf: csrf, username, password, role });
  assert.equal(response.status, 302);
  const row = bundle.db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(username);
  return mapUser(row);
}

function insertCard(bundle, ownerId, { id, name, prefix }) {
  const db = bundle.db;
  const now = Date.now();
  const bin = db.prepare(`
    INSERT INTO bins (name, prefix, brand, card_type, country, number_length, require_3ds, is_active, created_at, updated_at)
    VALUES (?, ?, 'Visa', 'debit', 'CN', 16, 0, 1, ?, ?)
  `).run(name, prefix, now, now);
  const binId = Number(bin.lastInsertRowid);
  const addGroup = db.prepare('INSERT INTO bin_groups (bin_id, group_id) VALUES (?, ?)');
  for (const group of db.prepare('SELECT id FROM user_groups').all()) addGroup.run(binId, group.id);
  const cardNumber = generateCardNumber(prefix, 16);
  db.prepare(`
    INSERT INTO cards (
      id, owner_user_id, bin_id, card_number_enc, card_number_hash, last4, expires_month, expires_year,
      cvv_enc, pin_enc, balance_minor, currency, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 12, ?, ?, ?, 50000, 'CNY', 'active', ?, ?)
  `).run(
    id,
    ownerId,
    binId,
    encrypt(cardNumber, bundle.config.appSecret),
    cardNumberHash(cardNumber, bundle.config.appSecret),
    cardNumber.slice(-4),
    new Date().getFullYear() + 5,
    encrypt('123', bundle.config.appSecret),
    encrypt('246810', bundle.config.appSecret),
    now,
    now
  );
  return id;
}

function insertPaidOrder(bundle, { tradeNo, cardId = null, payerId, paymentMethod, cardType = null }) {
  const merchant = bundle.db.prepare('SELECT id FROM merchants WHERE is_default = 1').get();
  const now = Date.now();
  const result = bundle.db.prepare(`
    INSERT INTO orders (
      trade_no, out_trade_no, merchant_id, type, name, money_minor, currency, status, card_id,
      payment_method, payer_user_id, card_type_snapshot, settlement_mode, settlement_due_at,
      notify_url, return_url, created_at, expires_at, paid_at
    ) VALUES (?, ?, ?, 'alipay', 'Role hierarchy order', 1000, 'CNY', 'PAID', ?, ?, ?, ?, 'guarantee', ?, ?, ?, ?, ?, ?)
  `).run(
    tradeNo,
    tradeNo,
    merchant.id,
    cardId,
    paymentMethod,
    payerId,
    cardType,
    now + 300000,
    'http://127.0.0.1:1/notify',
    'http://127.0.0.1:1/return',
    now,
    now + 900000,
    now
  );
  return Number(result.lastInsertRowid);
}

test('UID 0 is the only super administrator and database guards block disable, demotion and deletion', async (t) => {
  const bundle = makeBundle(t);
  const root = mapUser(bundle.db.prepare("SELECT * FROM users WHERE uid = 0 AND role = 'admin'").get());
  assert.equal(root.username, 'admin');
  assert.equal(root.isSuperAdmin, true);
  assert.equal(isSuperAdmin(root), true);
  assert.equal(bundle.db.prepare('SELECT COUNT(*) AS count FROM users WHERE is_super_admin = 1').get().count, 1);

  assert.throws(() => bundle.db.prepare('UPDATE users SET is_active = 0 WHERE uid = 0').run(), /cannot be disabled/);
  assert.throws(() => bundle.db.prepare("UPDATE users SET role = 'user' WHERE uid = 0").run(), /cannot be disabled/);
  assert.throws(() => bundle.db.prepare("UPDATE users SET account_risk = 'blocked' WHERE uid = 0").run(), /cannot be disabled/);
  assert.throws(() => bundle.db.prepare('UPDATE users SET uid = 99 WHERE uid = 0').run(), /Only UID 0 can be super administrator/);
  assert.throws(() => bundle.db.prepare('UPDATE users SET is_super_admin = 0 WHERE uid = 0').run(), /cannot be disabled/);
  assert.throws(() => bundle.db.prepare('UPDATE users SET deleted_at = 1 WHERE uid = 0').run(), /cannot be disabled/);
  assert.throws(() => bundle.db.prepare('DELETE FROM users WHERE uid = 0').run(), /cannot be deleted/);

  const admin = await loginRoot(bundle);
  const secondAdmin = await createUser(admin, bundle, { username: 'SecondAdmin', password: 'SecondAdmin123', role: 'admin' });
  assert.equal(secondAdmin.role, 'admin');
  assert.equal(secondAdmin.isSuperAdmin, false);
  assert.throws(() => bundle.db.prepare('UPDATE users SET is_super_admin = 1 WHERE id = ?').run(secondAdmin.id), /Only UID 0/);
});

test('changing ADMIN_USERNAME after initialization does not transfer or move UID 0', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'epay-super-admin-'));
  const databasePath = path.join(directory, 'epay.db');
  const baseEnv = {
    databasePath,
    appSecret: 'role-hierarchy-restart-secret',
    adminPassword: 'root-password-123',
    adminPasswordIsDefault: false,
    defaultMerchantKey: 'role-hierarchy-merchant-key',
    sweepIntervalMs: 3600000,
    notifyRetryCount: 0,
    notifyTimeoutMs: 100
  };
  let first;
  let second;
  try {
    first = createApp({ config: loadConfig({ ...baseEnv, adminUsername: 'admin' }), mailer: { async sendVerificationCode() {} }, logger: { error() {} } });
    const now = Date.now();
    first.db.prepare(`
      INSERT INTO users (uid, username, password_hash, role, group_id, invite_limit, can_invite, is_active, created_at, updated_at)
      VALUES (?, ?, ?, 'admin', 1, 2147483647, 1, 1, ?, ?)
    `).run(99, 'DifferentAdmin', hashPassword('DifferentAdmin123'), now, now);
    first.close();
    first = null;

    second = createApp({ config: loadConfig({ ...baseEnv, adminUsername: 'DifferentAdmin' }), mailer: { async sendVerificationCode() {} }, logger: { error() {} } });
    const root = second.db.prepare('SELECT uid, username, is_super_admin, role FROM users WHERE uid = 0').get();
    const other = second.db.prepare('SELECT uid, username, is_super_admin, role FROM users WHERE username = ? COLLATE NOCASE').get('DifferentAdmin');
    assert.deepEqual({ ...root }, { uid: 0, username: 'admin', is_super_admin: 1, role: 'admin' });
    assert.deepEqual({ ...other }, { uid: 99, username: 'DifferentAdmin', is_super_admin: 0, role: 'admin' });
    assert.equal(second.db.prepare('SELECT COUNT(*) AS count FROM users WHERE is_super_admin = 1').get().count, 1);
  } finally {
    first?.close();
    second?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('normal administrators cannot access super-admin modules or modify other administrators', async (t) => {
  const bundle = makeBundle(t);
  const rootAgent = await loginRoot(bundle);
  const secondAdmin = await createUser(rootAgent, bundle, { username: 'OpsAdmin', password: 'OpsAdmin123', role: 'admin' });
  const userOne = await createUser(rootAgent, bundle, { username: 'UserOne', password: 'UserOne123' });
  const userTwo = await createUser(rootAgent, bundle, { username: 'UserTwo', password: 'UserTwo123' });

  const admin = request.agent(bundle.app);
  assert.equal((await login(admin, secondAdmin.username, 'OpsAdmin123')).status, 302);
  let response = await admin.get('/admin');
  assert.equal(response.status, 200);
  assert.match(response.text, /用户管理/);
  assert.doesNotMatch(response.text, /href="\/admin\/bins"/);
  assert.doesNotMatch(response.text, /href="\/admin\/groups"/);
  assert.doesNotMatch(response.text, /href="\/admin\/merchants"/);
  assert.doesNotMatch(response.text, /href="\/admin\/settings"/);

  for (const path of ['/admin/bins', '/admin/groups', '/admin/merchants', '/admin/settings']) {
    response = await admin.get(path);
    assert.equal(response.status, 403, path);
  }

  response = await admin.get(`/admin/users/${secondAdmin.uid}`);
  assert.equal(response.status, 200);
  assert.doesNotMatch(response.text, new RegExp(`action="/admin/users/${secondAdmin.uid}/update"`));
  assert.doesNotMatch(response.text, /data-generate-password/);

  response = await admin.get(`/admin/users/${userOne.uid}`);
  assert.equal(response.status, 200);
  assert.match(response.text, new RegExp(`action="/admin/users/${userOne.uid}/update"`));
  const csrf = csrfFrom(response.text);

  response = await admin.post(`/admin/users/${secondAdmin.uid}/update`).type('form').send({ _csrf: csrf, group_id: secondAdmin.groupId, invite_limit: 10, account_risk: 'watch', card_risk: 'normal', spend_limit_mode: 'inherit', card_balance_limit_unlimited: '1', invite_permission_mode: 'inherit', can_invite: '1', is_active: '1' });
  assert.equal(response.status, 403);
  response = await admin.post(`/admin/users/${secondAdmin.uid}/password`).type('form').send({ _csrf: csrf, new_password: 'HackedPassword123' });
  assert.equal(response.status, 403);
  response = await admin.post(`/admin/users/${secondAdmin.uid}/balance`).type('form').send({ _csrf: csrf, operation: 'add', amount: '10.00' });
  assert.equal(response.status, 403);

  response = await admin.post('/admin/users/batch').type('form').send({ _csrf: csrf, user_ids: [String(secondAdmin.id), String(userOne.id)], action: 'disable', disabled_reason: 'test' });
  assert.equal(response.status, 302);
  assert.equal(bundle.db.prepare('SELECT is_active FROM users WHERE id = ?').get(secondAdmin.id).is_active, 1);
  assert.equal(bundle.db.prepare('SELECT is_active FROM users WHERE id = ?').get(userOne.id).is_active, 0);

  response = await admin.post(`/admin/users/${userTwo.uid}/super-risk`).type('form').send({ _csrf: csrf, reason: 'test' });
  assert.equal(response.status, 403);
  response = await admin.post(`/admin/users/${userOne.uid}/delete`).type('form').send({ _csrf: csrf });
  assert.equal(response.status, 403);

  response = await admin.post('/admin/users').type('form').send({ _csrf: csrf, username: 'ForbiddenAdmin', password: 'ForbiddenAdmin123', role: 'admin' });
  assert.equal(response.status, 302);
  assert.equal(bundle.db.prepare("SELECT COUNT(*) AS count FROM users WHERE username = 'ForbiddenAdmin'").get().count, 0);

  const rootRow = await rootAgent.get('/admin/users/0');
  const rootCsrf = csrfFrom(rootRow.text);
  const rootBefore = bundle.db.prepare('SELECT is_active, account_risk FROM users WHERE uid = 0').get();
  response = await rootAgent.post('/admin/users/0/update').type('form').send({ _csrf: rootCsrf, group_id: 1, invite_limit: 10, account_risk: 'normal', card_risk: 'normal', spend_limit_mode: 'inherit', card_balance_limit_unlimited: '1', invite_permission_mode: 'inherit', can_invite: '1' });
  assert.equal(response.status, 302);
  assert.deepEqual(bundle.db.prepare('SELECT is_active, account_risk FROM users WHERE uid = 0').get(), rootBefore);

  const adminDetail = await rootAgent.get(`/admin/users/${secondAdmin.uid}`);
  const adminCsrf = csrfFrom(adminDetail.text);
  response = await rootAgent.post(`/admin/users/${secondAdmin.uid}/update`).type('form').send({ _csrf: adminCsrf, group_id: secondAdmin.groupId, invite_limit: 10, account_risk: 'normal', card_risk: 'normal', spend_limit_mode: 'inherit', card_balance_limit_unlimited: '1', invite_permission_mode: 'inherit', can_invite: '1' });
  assert.equal(response.status, 302);
  assert.equal(bundle.db.prepare('SELECT is_active FROM users WHERE id = ?').get(secondAdmin.id).is_active, 0);
  const superAdmin = mapUser(bundle.db.prepare('SELECT * FROM users WHERE uid = 0').get());
  assert.equal(canManageUser(superAdmin, mapUser(bundle.db.prepare('SELECT * FROM users WHERE id = ?').get(secondAdmin.id))), true);
});

test('normal administrators can manage ordinary-user cards but not another administrator cards', async (t) => {
  const bundle = makeBundle(t);
  const rootAgent = await loginRoot(bundle);
  const secondAdmin = await createUser(rootAgent, bundle, { username: 'CardAdmin', password: 'CardAdmin123', role: 'admin' });
  const otherAdmin = await createUser(rootAgent, bundle, { username: 'OtherCardAdmin', password: 'OtherCardAdmin123', role: 'admin' });
  const cardOwner = await createUser(rootAgent, bundle, { username: 'CardOwner', password: 'CardOwner123' });
  const ordinaryCard = insertCard(bundle, cardOwner.id, { id: 'CARD-ORDINARY', name: 'Ordinary BIN', prefix: '621225' });
  const adminCard = insertCard(bundle, otherAdmin.id, { id: 'CARD-ADMIN', name: 'Admin BIN', prefix: '621226' });

  const admin = request.agent(bundle.app);
  assert.equal((await login(admin, secondAdmin.username, 'CardAdmin123')).status, 302);
  let response = await admin.get('/admin/cards');
  assert.equal(response.status, 200);
  assert.match(response.text, /CardOwner/);
  assert.doesNotMatch(response.text, /OtherCardAdmin/);

  response = await admin.get(`/admin/cards/${adminCard}`);
  assert.equal(response.status, 404);
  response = await admin.post(`/admin/cards/${adminCard}/decline`).type('form').send({ _csrf: 'test', reason: 'test' });
  assert.notEqual(response.status, 200);

  response = await admin.get(`/admin/cards/${ordinaryCard}`);
  assert.equal(response.status, 200);
  const csrf = csrfFrom(response.text);
  response = await admin.post(`/admin/cards/${ordinaryCard}/decline`).type('form').send({ _csrf: csrf, reason: '常规风控拒付' });
  assert.equal(response.status, 302);
  assert.equal(bundle.db.prepare('SELECT status FROM cards WHERE id = ?').get(ordinaryCard).status, 'declined');

  response = await admin.get('/admin/cards/new');
  assert.equal(response.status, 200);
  assert.match(response.text, /CardOwner/);
  assert.doesNotMatch(response.text, /OtherCardAdmin/);
  assert.doesNotMatch(response.text, /admin\/bins/);

  response = await rootAgent.get(`/admin/cards/${adminCard}`);
  assert.equal(response.status, 200);
});

test('normal administrators can only refund credit-card orders and never see merchant secrets', async (t) => {
  const bundle = makeBundle(t);
  const rootAgent = await loginRoot(bundle);
  const secondAdmin = await createUser(rootAgent, bundle, { username: 'OrderAdmin', password: 'OrderAdmin123', role: 'admin' });
  const payer = await createUser(rootAgent, bundle, { username: 'OrderPayer', password: 'OrderPayer123' });
  const cardId = insertCard(bundle, payer.id, { id: 'CARD-ORDER', name: 'Credit BIN', prefix: '622588' });
  const creditOrderId = insertPaidOrder(bundle, { tradeNo: 'CREDIT-ORDER-1', cardId, payerId: payer.id, paymentMethod: 'card', cardType: 'credit' });
  const accountOrderId = insertPaidOrder(bundle, { tradeNo: 'ACCOUNT-ORDER-1', payerId: payer.id, paymentMethod: 'account' });

  const admin = request.agent(bundle.app);
  assert.equal((await login(admin, secondAdmin.username, 'OrderAdmin123')).status, 302);
  let response = await admin.get(`/admin/orders/${creditOrderId}`);
  assert.equal(response.status, 200);
  assert.match(response.text, /发起退款/);
  assert.doesNotMatch(response.text, /role-hierarchy-merchant-key/);
  let csrf = csrfFrom(response.text);
  response = await admin.post(`/admin/orders/${creditOrderId}/chargeback`).type('form').send({ _csrf: csrf });
  assert.equal(response.status, 302);
  assert.equal(bundle.db.prepare('SELECT status FROM orders WHERE id = ?').get(creditOrderId).status, 'CHARGEBACK');

  response = await admin.get(`/admin/orders/${accountOrderId}`);
  assert.equal(response.status, 200);
  assert.doesNotMatch(response.text, /发起退款/);
  csrf = csrfFrom(response.text);
  response = await admin.post(`/admin/orders/${accountOrderId}/chargeback`).type('form').send({ _csrf: csrf });
  assert.equal(response.status, 403);
  assert.equal(bundle.db.prepare('SELECT status FROM orders WHERE id = ?').get(accountOrderId).status, 'PAID');

  const accountOrder = bundle.db.prepare('SELECT * FROM orders WHERE id = ?').get(accountOrderId);
  assert.equal(canRefundOrder(secondAdmin, {
    paymentMethod: accountOrder.payment_method,
    cardTypeSnapshot: accountOrder.card_type_snapshot
  }), false);
  response = await rootAgent.get('/admin/merchants');
  assert.equal(response.status, 200);
});
