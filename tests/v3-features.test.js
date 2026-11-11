const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const request = require('supertest');
const { loadConfig } = require('../src/config');
const { createApp } = require('../src/app');
const { makeSign } = require('../src/epay');
const { openDatabase, setSetting, cardById, mapUser } = require('../src/db');
const { encrypt, cardNumberHash } = require('../src/crypto');
const { accountTransaction, withdrawFromCard, cancelOwnCard, internalTransfer, unfreezeCard, transferFee } = require('../src/account-service');
const { userSpendLimit, cardSpendLimit, calculateCardDebit } = require('../src/card-service');
const { payOrderWithAccount, refundOrder } = require('../src/order-service');

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
    out_trade_no: `V3-${Date.now()}-${Math.floor(Math.random() * 1000000)}`,
    notify_url: 'http://127.0.0.1:1/notify',
    return_url: 'http://127.0.0.1:1/return',
    name: 'V3 feature test',
    money: '1.00',
    sitename: 'V3 Shop',
    ...overrides
  };
  params.sign = makeSign(params, key);
  params.sign_type = 'MD5';
  return params;
}

function makeBundle(t) {
  const config = loadConfig({
    databasePath: ':memory:',
    appSecret: 'v3-feature-test-secret',
    adminPassword: 'admin-password',
    adminUsername: 'admin',
    adminPasswordIsDefault: false,
    defaultMerchantKey: 'v3-merchant-key',
    baseUrl: 'http://gateway.test',
    sweepIntervalMs: 3600000,
    notifyRetryCount: 0,
    notifyTimeoutMs: 100
  });
  const bundle = createApp({ config, mailer: { async sendVerificationCode() {} }, logger: { error() {} } });
  bundle.config = config;
  t.after(() => bundle.close());
  return bundle;
}

async function loginAdmin(agent) {
  const response = await agent.post('/admin/login').type('form').send({ username: 'admin', password: 'admin-password' });
  assert.equal(response.status, 302);
}

async function createBin(admin, values) {
  const page = await admin.get('/admin/bins');
  const response = await admin.post('/admin/bins').type('form').send({
    _csrf: csrfFrom(page.text),
    group_ids_present: '1',
    group_ids: ['1', '2', '3'],
    require_3ds: '0',
    overdraft_limit: '5000.00',
    overdraft_fee_bps: '500',
    overdraft_min_fee: '1.00',
    overdraft_warning_bps: '9500',
    ...values
  });
  assert.equal(response.status, 302);
}

async function createUser(admin, db, values) {
  const page = await admin.get('/admin/users');
  const response = await admin.post('/admin/users').type('form').send({
    _csrf: csrfFrom(page.text),
    role: 'user',
    ...values
  });
  assert.equal(response.status, 302);
  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(values.username);
  assert.ok(row, response.headers.location);
  return mapUser(row);
}

async function createCard(admin, db, { ownerId, binId, balance = '0.00', ...values }) {
  const page = await admin.get('/admin/cards/new');
  const response = await admin.post('/admin/cards').type('form').send({
    _csrf: csrfFrom(page.text),
    owner_user_id: String(ownerId),
    bin_id: String(binId),
    balance,
    expires_month: '12',
    expires_year: String(new Date().getFullYear() + 5),
    cvv: '321',
    pin: '',
    status: 'active',
    decline_reason: '',
    spend_limit_mode: 'inherit',
    overdraft_mode: 'inherit',
    ...values
  });
  assert.equal(response.status, 302, response.text);
  return decodeURIComponent(response.headers.location.split('/admin/cards/')[1].split('?')[0]);
}

async function createOrder(app, overrides) {
  const response = await request(app).get('/api.php').query(signedOrderParams('v3-merchant-key', overrides));
  assert.equal(response.body.code, 1, JSON.stringify(response.body));
  return response.body.trade_no;
}

async function confirmCardPayment(app, tradeNo) {
  return request(app)
    .post(`/pay/${tradeNo}/confirm`)
    .set('X-Payment-Ajax', '1')
    .set('Accept', 'application/json')
    .send({ pin: '' });
}

test('limits use group, user and card inheritance with per-transaction semantics', async (t) => {
  const bundle = makeBundle(t);
  const { app, db } = bundle;
  const admin = request.agent(app);
  await loginAdmin(admin);

  const defaultGroup = db.prepare("SELECT id FROM user_groups WHERE name = 'Default'").get();
  db.prepare('UPDATE user_groups SET spend_limit_minor = 10000 WHERE id = ?').run(defaultGroup.id);
  await createBin(admin, { name: 'Limit Debit', prefix: '411111', brand: 'Visa', card_type: 'debit', country: 'CN', number_length: '16' });
  const bin = db.prepare("SELECT * FROM bins WHERE prefix = '411111'").get();
  const user = await createUser(admin, db, { username: 'LimitUser', password: 'LimitUser123' });
  const cardId = await createCard(admin, db, { ownerId: user.id, binId: bin.id, balance: '200.00' });

  assert.equal(userSpendLimit(db, user.id), 10000);
  let card = cardById(db, bundle.config.appSecret, cardId, false);
  assert.equal(cardSpendLimit(db, card), 10000);

  db.prepare("UPDATE users SET spend_limit_mode = 'custom', spend_limit_minor = 4000 WHERE id = ?").run(user.id);
  assert.equal(userSpendLimit(db, user.id), 4000);
  accountTransaction(db, user.id, 'TEST_CREDIT', 10000, 'limit test');
  for (const amount of ['40.00', '40.00']) {
    const tradeNo = await createOrder(app, { money: amount });
    const result = payOrderWithAccount({ db, tradeNo, user: { id: user.id } });
    assert.equal(result.paid, true);
  }
  const overLimitTrade = await createOrder(app, { money: '40.01' });
  const overLimit = payOrderWithAccount({ db, tradeNo: overLimitTrade, user: { id: user.id } });
  assert.equal(overLimit.paid, false);
  assert.equal(overLimit.code, 'SPEND_LIMIT_EXCEEDED');

  db.prepare("UPDATE cards SET spend_limit_mode = 'custom', spend_limit_minor = 5000 WHERE id = ?").run(cardId);
  card = cardById(db, bundle.config.appSecret, cardId, false);
  assert.equal(cardSpendLimit(db, card), 5000);
  const cardTrade = await createOrder(app, { money: '50.01', bind_card: cardId });
  const cardResponse = await confirmCardPayment(app, cardTrade);
  assert.equal(cardResponse.body.ok, false);
  assert.equal(cardResponse.body.error.code, 'SPEND_LIMIT_EXCEEDED');
  assert.equal(db.prepare('SELECT status FROM orders WHERE trade_no = ?').get(cardTrade).status, 'FAILED');

  db.prepare("UPDATE cards SET spend_limit_mode = 'custom', spend_limit_minor = 0 WHERE id = ?").run(cardId);
  card = cardById(db, bundle.config.appSecret, cardId, false);
  assert.equal(cardSpendLimit(db, card), null);
});

test('credit overdraft charges only the excess, reverses on refund, and warns at the configured threshold', async (t) => {
  const bundle = makeBundle(t);
  const { app, db } = bundle;
  const admin = request.agent(app);
  await loginAdmin(admin);

  await createBin(admin, {
    name: 'Credit Overdraft', prefix: '522222', brand: 'Mastercard', card_type: 'credit', country: 'CN', number_length: '16',
    overdraft_limit: '5000.00', overdraft_fee_bps: '500', overdraft_min_fee: '1.00', overdraft_warning_bps: '9500'
  });
  const bin = db.prepare("SELECT * FROM bins WHERE prefix = '522222'").get();
  const user = await createUser(admin, db, { username: 'OverdraftUser', password: 'OverdraftUser123' });
  const cardId = await createCard(admin, db, { ownerId: user.id, binId: bin.id, balance: '1500.00' });

  let card = cardById(db, bundle.config.appSecret, cardId, true);
  assert.equal(bin.overdraft_limit_minor, 500000);
  assert.equal(bin.overdraft_fee_bps, 500);
  assert.equal(bin.overdraft_min_fee_minor, 100);
  assert.equal(card.balanceMinor, 150000);
  const quote = calculateCardDebit(card, 200000);
  assert.equal(quote.ok, true);
  assert.equal(quote.feeMinor, 2500);

  const tradeNo = await createOrder(app, { money: '2000.00', bind_card: cardId });
  const paid = await confirmCardPayment(app, tradeNo);
  assert.equal(paid.body.ok, true);
  card = cardById(db, bundle.config.appSecret, cardId, false);
  assert.equal(card.balanceMinor, -52500);
  let order = db.prepare('SELECT * FROM orders WHERE trade_no = ?').get(tradeNo);
  assert.equal(order.status, 'PAID');
  assert.equal(order.overdraft_fee_minor, 2500);

  const partial = refundOrder({ db, tradeNo, amountMinor: 50000, reason: 'partial refund' });
  assert.equal(partial.order.refundedMinor, 50000);
  card = cardById(db, bundle.config.appSecret, cardId, false);
  assert.equal(card.balanceMinor, -1875);
  const full = refundOrder({ db, tradeNo, reason: 'full refund' });
  assert.equal(full.order.status, 'CHARGEBACK');
  card = cardById(db, bundle.config.appSecret, cardId, false);
  assert.equal(card.balanceMinor, 150000);
  assert.equal(db.prepare('SELECT refunded_overdraft_fee_minor FROM orders WHERE trade_no = ?').get(tradeNo).refunded_overdraft_fee_minor, 2500);

  const warningCardId = await createCard(admin, db, { ownerId: user.id, binId: bin.id, balance: '0.00' });
  const warningTrade = await createOrder(app, { money: '4700.00', bind_card: warningCardId });
  const warningPaid = await confirmCardPayment(app, warningTrade);
  assert.equal(warningPaid.body.ok, true);
  let warningCard = cardById(db, bundle.config.appSecret, warningCardId, false);
  assert.equal(warningCard.status, 'frozen');
  assert.equal(warningCard.freezeSource, 'automatic');
  assert.equal(warningCard.freezeCode, 'OVERDRAFT_WARNING');

  accountTransaction(db, user.id, 'TEST_CREDIT', 500000, 'warning card top up');
  const { depositToCard } = require('../src/account-service');
  depositToCard({ db, config: bundle.config, user: mapUser(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id)), cardId: warningCardId, amountMinor: 500000 });
  warningCard = cardById(db, bundle.config.appSecret, warningCardId, false);
  assert.ok(warningCard.balanceMinor > 0);
  const unfreeze = unfreezeCard({ db, card: warningCard, actor: mapUser(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id)), selfService: true });
  assert.equal(unfreeze.fee, 0);
  assert.equal(cardById(db, bundle.config.appSecret, warningCardId, false).status, 'active');
});

test('five insufficient payment attempts freeze a card and self-service unfreeze charges the configured fee', async (t) => {
  const bundle = makeBundle(t);
  const { app, db } = bundle;
  const admin = request.agent(app);
  await loginAdmin(admin);
  setSetting(db, 'card_unfreeze_fee_minor', '10000');

  await createBin(admin, { name: 'Risk Debit', prefix: '433333', brand: 'Visa', card_type: 'debit', country: 'CN', number_length: '16' });
  const bin = db.prepare("SELECT * FROM bins WHERE prefix = '433333'").get();
  const user = await createUser(admin, db, { username: 'RiskUser', password: 'RiskUser123' });
  accountTransaction(db, user.id, 'TEST_CREDIT', 20000, 'unfreeze fee reserve');
  const cardId = await createCard(admin, db, { ownerId: user.id, binId: bin.id, balance: '0.00' });

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const tradeNo = await createOrder(app, { money: '1.00', bind_card: cardId });
    const response = await confirmCardPayment(app, tradeNo);
    assert.equal(response.body.ok, false);
    assert.equal(response.body.error.code, 'INSUFFICIENT_FUNDS');
  }
  let card = cardById(db, bundle.config.appSecret, cardId, false);
  assert.equal(card.status, 'frozen');
  assert.equal(card.freezeSource, 'automatic');
  assert.equal(card.consecutiveFailures, 5);

  const currentUser = mapUser(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id));
  const unfreeze = unfreezeCard({ db, card, actor: currentUser, selfService: true });
  assert.equal(unfreeze.fee, 10000);
  assert.equal(db.prepare('SELECT account_balance_minor FROM users WHERE id = ?').get(user.id).account_balance_minor, 10000);
  assert.equal(cardById(db, bundle.config.appSecret, cardId, false).status, 'active');
});

test('internal transfer validates recipient identity, charges fees, and declined cards can withdraw and be cancelled', async (t) => {
  const bundle = makeBundle(t);
  const { db } = bundle;
  const admin = request.agent(bundle.app);
  await loginAdmin(admin);
  setSetting(db, 'internal_transfer_fee_bps', '100');
  setSetting(db, 'internal_transfer_min_fee_minor', '50');
  await createBin(admin, { name: 'Transfer Debit', prefix: '444444', brand: 'Visa', card_type: 'debit', country: 'CN', number_length: '16' });
  const bin = db.prepare("SELECT * FROM bins WHERE prefix = '444444'").get();
  const sender = await createUser(admin, db, { username: 'TransferSender', password: 'TransferSender123' });
  const recipient = await createUser(admin, db, { username: 'TransferRecipient', password: 'TransferRecipient123' });
  const recipientCardId = await createCard(admin, db, { ownerId: recipient.id, binId: bin.id, balance: '0.00' });
  accountTransaction(db, sender.id, 'TEST_CREDIT', 10000, 'transfer test');
  const recipientCard = cardById(db, bundle.config.appSecret, recipientCardId, true);

  assert.equal(transferFee(5000, 100, 50), 50);
  const transfer = internalTransfer({
    db, config: bundle.config, user: mapUser(db.prepare('SELECT * FROM users WHERE id = ?').get(sender.id)),
    sourceType: 'account', sourceCardId: '', recipientCardNumber: recipientCard.cardNumber,
    recipientUsername: recipient.username, amountMinor: 5000
  });
  assert.equal(transfer.fee, 50);
  assert.equal(db.prepare('SELECT account_balance_minor FROM users WHERE id = ?').get(sender.id).account_balance_minor, 4950);
  assert.equal(db.prepare('SELECT balance_minor FROM cards WHERE id = ?').get(recipientCardId).balance_minor, 5000);

  assert.throws(() => internalTransfer({
    db, config: bundle.config, user: mapUser(db.prepare('SELECT * FROM users WHERE id = ?').get(sender.id)),
    sourceType: 'account', sourceCardId: '', recipientCardNumber: recipientCard.cardNumber,
    recipientUsername: 'WrongUser', amountMinor: 100
  }), /卡号与用户名不匹配/);

  const declinedCardId = await createCard(admin, db, { ownerId: sender.id, binId: bin.id, balance: '300.00', status: 'declined', decline_reason: 'decline test' });
  const senderUser = mapUser(db.prepare('SELECT * FROM users WHERE id = ?').get(sender.id));
  withdrawFromCard({ db, config: bundle.config, user: senderUser, cardId: declinedCardId, amountMinor: 30000 });
  assert.equal(cardById(db, bundle.config.appSecret, declinedCardId, false).balanceMinor, 0);
  cancelOwnCard({ db, config: bundle.config, user: senderUser, cardId: declinedCardId });
  assert.equal(cardById(db, bundle.config.appSecret, declinedCardId, false), null);
});

test('admin card filters and batch operations work without exposing super-admin cards', async (t) => {
  const bundle = makeBundle(t);
  const { app, db } = bundle;
  const rootAgent = request.agent(app);
  await loginAdmin(rootAgent);
  await createBin(rootAgent, { name: 'Batch Debit', prefix: '455555', brand: 'Visa', card_type: 'debit', country: 'CN', number_length: '16' });
  const bin = db.prepare("SELECT * FROM bins WHERE prefix = '455555'").get();
  const userA = await createUser(rootAgent, db, { username: 'BatchUserA', password: 'BatchUserA123' });
  const userB = await createUser(rootAgent, db, { username: 'BatchUserB', password: 'BatchUserB123' });
  const cardA = await createCard(rootAgent, db, { ownerId: userA.id, binId: bin.id, balance: '1.00' });
  const cardB = await createCard(rootAgent, db, { ownerId: userB.id, binId: bin.id, balance: '2.00' });
  const root = db.prepare('SELECT id FROM users WHERE uid = 0').get();
  const rootCard = await createCard(rootAgent, db, { ownerId: root.id, binId: bin.id, balance: '3.00' });
  await createUser(rootAgent, db, { username: 'BatchAdmin', password: 'BatchAdmin123', role: 'admin' });
  const admin = request.agent(app);
  let response = await admin.post('/admin/login').type('form').send({ username: 'BatchAdmin', password: 'BatchAdmin123' });
  assert.equal(response.status, 302);

  response = await admin.get(`/admin/cards?scope=all&bin_id=${bin.id}&status=active&q=BatchUserA`);
  assert.equal(response.status, 200);
  assert.match(response.text, /BatchUserA/);
  assert.doesNotMatch(response.text, /BatchUserB/);
  assert.doesNotMatch(response.text, new RegExp(rootCard));

  response = await admin.get(`/admin/cards/${rootCard}`);
  assert.equal(response.status, 404);
  let page = await admin.get('/admin/cards');
  let csrf = csrfFrom(page.text);
  response = await admin.post('/admin/cards/batch').type('form').send({
    _csrf: csrf,
    card_ids: [cardA, cardB],
    action: 'freeze',
    reason: '批量风控测试'
  });
  assert.equal(response.status, 302);
  assert.equal(db.prepare('SELECT status FROM cards WHERE id = ?').get(cardA).status, 'frozen');
  assert.equal(db.prepare('SELECT status FROM cards WHERE id = ?').get(cardB).status, 'frozen');

  response = await admin.post('/admin/cards/batch').type('form').send({ _csrf: csrf, card_ids: [cardA, cardB], action: 'add_balance', amount: '10.00' });
  assert.equal(response.status, 302);
  assert.equal(db.prepare('SELECT balance_minor FROM cards WHERE id = ?').get(cardA).balance_minor, 1100);
  assert.equal(db.prepare('SELECT balance_minor FROM cards WHERE id = ?').get(cardB).balance_minor, 1200);

  response = await admin.post('/admin/cards/batch').type('form').send({ _csrf: csrf, card_ids: [cardA, cardB], action: 'set_limit', limit_mode: 'custom', limit_amount: '25.00' });
  assert.equal(response.status, 302);
  assert.deepEqual({ ...db.prepare('SELECT spend_limit_mode, spend_limit_minor FROM cards WHERE id = ?').get(cardA) }, { spend_limit_mode: 'custom', spend_limit_minor: 2500 });

  response = await admin.post('/admin/cards/batch').type('form').send({ _csrf: csrf, card_ids: [cardA, cardB], action: 'delete' });
  assert.equal(response.status, 302);
  assert.equal(db.prepare('SELECT id FROM cards WHERE id IN (?, ?)').get(cardA, cardB), undefined);
  assert.ok(db.prepare('SELECT id FROM cards WHERE id = ?').get(rootCard));

  response = await rootAgent.get('/admin/bins');
  csrf = csrfFrom(response.text);
  response = await rootAgent.post(`/admin/bins/${bin.id}/delete`).type('form').send({ _csrf: csrf, group_ids_present: '1' });
  assert.equal(response.status, 302);
  assert.ok(db.prepare('SELECT id FROM bins WHERE id = ?').get(bin.id));
});

test('v3 databases migrate cards to signed balances and add overdraft configuration', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'epay-v3-migration-'));
  const databasePath = path.join(directory, 'epay.db');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const appSecret = 'v3-migration-secret';
  const now = Date.now();
  const number = '4111111111111111';
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    CREATE TABLE bins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      prefix TEXT NOT NULL UNIQUE,
      brand TEXT NOT NULL DEFAULT 'Visa',
      card_type TEXT NOT NULL DEFAULT 'debit',
      country TEXT NOT NULL DEFAULT 'CN',
      number_length INTEGER NOT NULL DEFAULT 16,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE cards (
      id TEXT PRIMARY KEY,
      owner_user_id INTEGER,
      bin_id INTEGER NOT NULL,
      card_number_enc TEXT NOT NULL,
      card_number_hash TEXT,
      last4 TEXT NOT NULL,
      expires_month INTEGER NOT NULL,
      expires_year INTEGER NOT NULL,
      cvv_enc TEXT NOT NULL,
      pin_enc TEXT NOT NULL,
      balance_minor INTEGER NOT NULL DEFAULT 0 CHECK(balance_minor >= 0),
      currency TEXT NOT NULL DEFAULT 'CNY',
      status TEXT NOT NULL DEFAULT 'active',
      decline_reason TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_used_at INTEGER
    );
  `);
  legacy.prepare('INSERT INTO bins (name, prefix, brand, card_type, country, number_length, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)')
    .run('Legacy BIN', '411111', 'Visa', 'debit', 'CN', 16, now, now);
  legacy.prepare('INSERT INTO cards (id, owner_user_id, bin_id, card_number_enc, card_number_hash, last4, expires_month, expires_year, cvv_enc, pin_enc, balance_minor, currency, status, created_at, updated_at) VALUES (?, NULL, 1, ?, ?, ?, 12, 2035, ?, ?, 1234, \'CNY\', \'active\', ?, ?)')
    .run('CARD-LEGACY', encrypt(number, appSecret), cardNumberHash(number, appSecret), number.slice(-4), encrypt('123', appSecret), encrypt('246810', appSecret), now, now);
  legacy.close();

  const migrated = openDatabase(loadConfig({ databasePath, appSecret, adminPassword: 'MigrationAdmin123', adminPasswordIsDefault: false, defaultMerchantKey: 'migration-key' }));
  try {
    const card = migrated.prepare('SELECT * FROM cards WHERE id = ?').get('CARD-LEGACY');
    assert.equal(card.balance_minor, 1234);
    assert.equal(card.spend_limit_mode, 'inherit');
    assert.equal(card.overdraft_mode, 'inherit');
    assert.equal(card.freeze_source, 'none');
    const bin = migrated.prepare("SELECT * FROM bins WHERE prefix = '411111'").get();
    assert.equal(bin.overdraft_limit_minor, 500000);
    assert.equal(bin.overdraft_fee_bps, 500);
    assert.equal(bin.overdraft_min_fee_minor, 100);
    assert.equal(bin.overdraft_warning_bps, 9500);
    const userColumns = new Set(migrated.prepare('PRAGMA table_info(users)').all().map((column) => column.name));
    assert.equal(userColumns.has('spend_limit_mode'), true);
    migrated.prepare('UPDATE cards SET balance_minor = -1 WHERE id = ?').run('CARD-LEGACY');
    assert.equal(migrated.prepare('SELECT balance_minor FROM cards WHERE id = ?').get('CARD-LEGACY').balance_minor, -1);
  } finally {
    migrated.close();
  }
});
