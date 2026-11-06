const { createAdminSession, verifyAdminSession, parseCookies, timingSafeEqualText } = require('./crypto');

const COOKIE_NAME = 'epay_admin';

function adminSessionFromRequest(req, config) {
  const cookies = parseCookies(req.headers.cookie || '');
  const payload = verifyAdminSession(cookies[COOKIE_NAME], config.appSecret, config.adminUsername);
  if (!payload) return null;
  return { payload, token: cookies[COOKIE_NAME] };
}

function setAdminCookie(res, config, token) {
  const maxAge = config.adminSessionHours * 60 * 60;
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`
  ];
  if (config.secureCookies) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

function clearAdminCookie(res) {
  res.append('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function createSession(config) {
  return createAdminSession(config.adminUsername, config.appSecret, config.adminSessionHours * 60 * 60);
}

function requireAdmin(req, res, next) {
  const session = adminSessionFromRequest(req, req.app.locals.config);
  if (!session) return res.redirect('/admin/login');
  req.admin = session.payload;
  res.locals.admin = session.payload;
  res.locals.csrfToken = session.payload.csrf;
  next();
}

function verifyCsrf(req, res, next) {
  const session = req.admin;
  if (!session || !timingSafeEqualText(session.csrf, String(req.body?._csrf || ''))) {
    return res.status(403).render('error', {
      title: '无效的安全令牌',
      message: '页面已过期或请求来源无效，请刷新后重试。',
      statusCode: 403
    });
  }
  next();
}

function validAdminCredentials(config, username, password) {
  return timingSafeEqualText(username, config.adminUsername) && timingSafeEqualText(password, config.adminPassword);
}

module.exports = {
  COOKIE_NAME,
  adminSessionFromRequest,
  setAdminCookie,
  clearAdminCookie,
  createSession,
  requireAdmin,
  verifyCsrf,
  validAdminCredentials
};
