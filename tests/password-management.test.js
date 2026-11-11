const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { loadConfig } = require('../src/config');
const { createApp } = require('../src/app');
const { setSetting } = require('../src/db');
const { verifyPassword } = require('../src/crypto');

function csrfFrom(html) {
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  assert.ok(match, 'CSRF token should be present');
  return match[1];
}

function makeBundle(t, { configureMail = true } = {}) {
  const sentCodes = new Map();
  const state = { failMail: false };
  const config = loadConfig({
    databasePath: ':memory:',
    appSecret: 'password-management-test-secret',
    adminPassword: 'admin-password',
    adminUsername: 'admin',
    adminPasswordIsDefault: false,
    defaultMerchantKey: 'password-management-merchant-key',
    baseUrl: 'http://gateway.test',
    sweepIntervalMs: 3600000
  });
  const mailer = {
    async sendVerificationCode(email, code) {
      if (state.failMail) throw new Error('SMTP unavailable');
      sentCodes.set(email, code);
    }
  };
  const bundle = createApp({ config, mailer, logger: { error() {} } });
  if (configureMail) {
    setSetting(bundle.db, 'smtp_host', 'smtp.example.test');
    setSetting(bundle.db, 'mail_from', 'noreply@example.test');
  }
  setSetting(bundle.db, 'email_code_resend_seconds', '0');
  t.after(() => bundle.close());
  return { ...bundle, sentCodes, state };
}

async function login(agent, username, password, expectedStatus = 302) {
  return agent.post('/admin/login').type('form').send({ username, password }).expect(expectedStatus);
}

async function loginAdmin(bundle) {
  const agent = request.agent(bundle.app);
  await login(agent, 'admin', 'admin-password');
  return agent;
}

async function createUser(admin, bundle, { username, password, email = null }) {
  let response = await admin.get('/admin/users');
  const csrf = csrfFrom(response.text);
  response = await admin.post('/admin/users').type('form').send({ _csrf: csrf, username, password, role: 'user' });
  assert.equal(response.status, 302);
  const user = bundle.db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(username);
  assert.ok(user);
  if (email) bundle.db.prepare('UPDATE users SET email = ? WHERE id = ?').run(email, user.id);
  return { ...user, email };
}

test('account password change validates all fields and invalidates existing sessions', async (t) => {
  const bundle = makeBundle(t);
  const admin = await loginAdmin(bundle);
  const user = await createUser(admin, bundle, { username: 'PasswordUser', password: 'OldPassword123' });
  const agent = request.agent(bundle.app);
  const secondSession = request.agent(bundle.app);
  await login(agent, user.username, 'OldPassword123');
  await login(secondSession, user.username, 'OldPassword123');

  let response = await agent.get('/admin/account');
  assert.equal(response.status, 200);
  assert.match(response.text, /修改登录密码/);
  assert.match(response.text, /name="old_password"/);
  assert.match(response.text, /name="new_password"/);
  assert.match(response.text, /name="confirm_password"/);
  const csrf = csrfFrom(response.text);

  response = await agent.post('/admin/account/password').type('form').send({ _csrf: csrf, old_password: 'wrong-password', new_password: 'NewPassword123', confirm_password: 'NewPassword123' });
  assert.equal(response.status, 302);
  assert.match(decodeURIComponent(response.headers.location), /原密码不正确/);

  response = await agent.post('/admin/account/password').type('form').send({ _csrf: csrf, old_password: 'OldPassword123', new_password: 'NewPassword123', confirm_password: 'DifferentPassword123' });
  assert.match(decodeURIComponent(response.headers.location), /两次输入的新密码不一致/);

  response = await agent.post('/admin/account/password').type('form').send({ _csrf: csrf, old_password: 'OldPassword123', new_password: 'weakpassword', confirm_password: 'weakpassword' });
  assert.match(decodeURIComponent(response.headers.location), /密码不符合当前安全规则/);

  response = await agent.post('/admin/account/password').type('form').send({ _csrf: csrf, old_password: 'OldPassword123', new_password: 'NewPassword123', confirm_password: 'NewPassword123' });
  assert.equal(response.status, 302);
  assert.equal(response.headers.location, '/admin/login?password_changed=1');
  assert.ok(response.headers['set-cookie'].some((cookie) => cookie.includes('Max-Age=0')));

  const changed = bundle.db.prepare('SELECT password_hash, password_changed_at FROM users WHERE id = ?').get(user.id);
  assert.ok(changed.password_changed_at > 0);
  assert.equal(verifyPassword('OldPassword123', changed.password_hash), false);
  assert.equal(verifyPassword('NewPassword123', changed.password_hash), true);

  response = await secondSession.get('/admin');
  assert.equal(response.status, 302);
  assert.equal(response.headers.location, '/admin/login');
  response = await agent.get('/admin/account');
  assert.equal(response.status, 302);
  await login(request.agent(bundle.app), user.username, 'OldPassword123', 401);
  await login(request.agent(bundle.app), user.username, 'NewPassword123');
});

test('forgot password page explains when mail is not configured', async (t) => {
  const bundle = makeBundle(t, { configureMail: false });
  const admin = await loginAdmin(bundle);
  await createUser(admin, bundle, { username: 'NoMailConfig', password: 'NoMailConfig123', email: 'usermail@example.test' });

  let response = await request(bundle.app).get('/admin/forgot-password');
  assert.equal(response.status, 200);
  assert.match(response.text, /管理员尚未配置验证码发件邮箱，请联系管理员修改密码/);
  assert.doesNotMatch(response.text, /data-password-reset-form/);

  response = await request(bundle.app).post('/admin/forgot-password/send-code').send({ username: 'NoMailConfig', email: 'usermail@example.test' });
  assert.equal(response.status, 503);
  assert.match(response.body.message, /请联系管理员修改密码/);
});

test('email code password reset is bound to the account email and can only be used once', async (t) => {
  const bundle = makeBundle(t);
  const admin = await loginAdmin(bundle);
  const user = await createUser(admin, bundle, { username: 'ForgotUser', password: 'ForgotUser123', email: 'forgot@example.test' });
  await createUser(admin, bundle, { username: 'NoEmailUser', password: 'NoEmailUser123' });

  let response = await request(bundle.app).get('/admin/forgot-password');
  assert.equal(response.status, 200);
  assert.match(response.text, /data-password-reset-form/);

  response = await request(bundle.app).post('/admin/forgot-password/send-code').send({ username: user.username, email: 'wrong@example.test' });
  assert.equal(response.status, 400);
  assert.match(response.body.message, /联系管理员修改密码/);

  response = await request(bundle.app).post('/admin/forgot-password/send-code').send({ username: 'NoEmailUser', email: 'anything@example.test' });
  assert.equal(response.status, 400);
  assert.match(response.body.message, /未绑定邮箱/);

  response = await request(bundle.app).post('/admin/forgot-password/send-code').send({ username: user.username, email: 'forgot@example.test' });
  assert.equal(response.status, 200);
  const code = bundle.sentCodes.get('forgot@example.test');
  assert.match(code, /^\d{6}$/);

  response = await request(bundle.app).post('/admin/forgot-password').type('form').send({ username: user.username, email: 'forgot@example.test', email_code: '000000', new_password: 'ForgotNew123', confirm_password: 'ForgotNew123' });
  assert.equal(response.status, 400);

  response = await request(bundle.app).post('/admin/forgot-password').type('form').send({ username: user.username, email: 'forgot@example.test', email_code: code, new_password: 'ForgotNew123', confirm_password: 'ForgotNew123' });
  assert.equal(response.status, 302);
  assert.equal(response.headers.location, '/admin/login?reset=1');
  const resetCode = bundle.db.prepare('SELECT consumed_at FROM password_reset_codes WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(user.id);
  assert.ok(resetCode.consumed_at > 0);

  response = await request(bundle.app).post('/admin/forgot-password').type('form').send({ username: user.username, email: 'forgot@example.test', email_code: code, new_password: 'AnotherPassword123', confirm_password: 'AnotherPassword123' });
  assert.equal(response.status, 400);
  await login(request.agent(bundle.app), user.username, 'ForgotUser123', 401);
  await login(request.agent(bundle.app), user.username, 'ForgotNew123');

  bundle.state.failMail = true;
  response = await request(bundle.app).post('/admin/forgot-password/send-code').send({ username: user.username, email: 'forgot@example.test' });
  assert.equal(response.status, 500);
  assert.match(response.body.message, /联系管理员修改密码/);
  assert.equal(bundle.db.prepare('SELECT COUNT(*) AS count FROM password_reset_codes WHERE user_id = ? AND consumed_at IS NULL').get(user.id).count, 0);
});

test('administrators can set user passwords and changing their own password ends the session', async (t) => {
  const bundle = makeBundle(t);
  const admin = await loginAdmin(bundle);
  const user = await createUser(admin, bundle, { username: 'ManagedUser', password: 'ManagedOld123' });
  const userSession = request.agent(bundle.app);
  await login(userSession, user.username, 'ManagedOld123');

  let response = await admin.get(`/admin/users/${user.uid}`);
  assert.equal(response.status, 200);
  assert.match(response.text, /设定新密码/);
  assert.match(response.text, /data-generate-password/);
  assert.match(response.text, /data-password-target="#new-password-/);
  const csrf = csrfFrom(response.text);

  response = await admin.post(`/admin/users/${user.uid}/password`).type('form').send({ _csrf: csrf, new_password: 'short' });
  assert.match(decodeURIComponent(response.headers.location), /密码不符合当前安全规则/);

  response = await admin.post(`/admin/users/${user.uid}/password`).type('form').send({ _csrf: csrf, new_password: 'ManagedNew123' });
  assert.equal(response.status, 302);
  assert.match(decodeURIComponent(response.headers.location), /密码已更新/);
  response = await userSession.get('/admin');
  assert.equal(response.status, 302);
  await login(request.agent(bundle.app), user.username, 'ManagedOld123', 401);
  await login(request.agent(bundle.app), user.username, 'ManagedNew123');
  assert.ok(bundle.db.prepare("SELECT id FROM risk_events WHERE user_id = ? AND event = 'PASSWORD_RESET'").get(user.id));

  response = await admin.post('/admin/users/0/password').type('form').send({ _csrf: csrf, new_password: 'AdminChanged456' });
  assert.equal(response.status, 302);
  assert.equal(response.headers.location, '/admin/login?password_changed=1');
  response = await admin.get('/admin');
  assert.equal(response.status, 302);
  await login(request.agent(bundle.app), 'admin', 'admin-password', 401);
  await login(request.agent(bundle.app), 'admin', 'AdminChanged456');
});
