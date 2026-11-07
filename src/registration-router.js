const express = require('express');
const { getAllSettings, getSetting } = require('./db');
const { registerUser, sendVerificationCode } = require('./registration-service');
const { createSession, setSessionCookie } = require('./admin-auth');

function router({ db, config, mailer, logger = console }) {
  const route = express.Router();

  function renderRegister(req, res, { statusCode = 200, error = null, message = null, form = {} } = {}) {
    const settings = getAllSettings(db);
    return res.status(statusCode).render('register', {
      title: '注册账号', settings, registrationEnabled: settings.registration_enabled === '1',
      requireEmail: settings.registration_require_email === '1', requireInvite: settings.registration_require_invite === '1',
      inviteCode: String(form.invite_code || req.query.invite || ''), error, message, form
    });
  }

  route.get('/register', (req, res) => renderRegister(req, res));
  route.post('/register/send-code', async (req, res) => {
    if (getSetting(db, 'registration_enabled', '0') !== '1') return res.status(403).json({ ok: false, message: '当前未开放注册。' });
    if (getSetting(db, 'registration_require_email', '0') !== '1') return res.status(400).json({ ok: false, message: '当前注册不需要邮箱验证码。' });
    try {
      const result = await sendVerificationCode({ db, config, mailer, email: req.body.email });
      return res.status(result.ok ? 200 : 400).json(result);
    } catch (error) {
      logger.error?.('Verification email delivery failed', error);
      return res.status(500).json({ ok: false, message: '验证码发送失败，请稍后重试或联系管理员。' });
    }
  });
  route.post('/register', (req, res) => {
    try {
      const result = registerUser({ db, config, input: req.body });
      if (result.error) return renderRegister(req, res, { statusCode: 400, error: result.error, form: req.body });
      const session = createSession(result.user, config);
      setSessionCookie(res, config, session.token);
      return res.redirect('/admin');
    } catch (error) {
      return renderRegister(req, res, { statusCode: error.statusCode || 500, error: error.message || '注册失败。', form: req.body });
    }
  });
  return route;
}

module.exports = { router };