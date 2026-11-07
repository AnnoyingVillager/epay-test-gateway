const {
  createUserSession,
  verifyUserSession,
  parseCookies,
  timingSafeEqualText,
  verifyPassword
} = require('./crypto');
const { mapUser, userById } = require('./db');

const COOKIE_NAME = 'epay_session';

function userSessionFromRequest(req, db, config) {
  const cookies = parseCookies(req.headers.cookie || '');
  const payload = verifyUserSession(cookies[COOKIE_NAME], config.appSecret);
  if (!payload) return null;
  const user = userById(db, payload.uid);
  if (!user || !user.isActive || user.accountRisk === 'blocked' || user.username !== payload.u || user.role !== payload.r) return null;
  return { payload, user, token: cookies[COOKIE_NAME] };
}

function setSessionCookie(res, config, token) {
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

function clearSessionCookie(res) {
  res.append('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function createSession(user, config) {
  return createUserSession(user, config.appSecret, config.adminSessionHours * 60 * 60);
}

function requireUser(req, res, next) {
  const session = userSessionFromRequest(req, req.app.locals.db, req.app.locals.config);
  if (!session) return res.redirect('/admin/login');
  req.user = session.user;
  req.sessionCsrf = session.payload.csrf;
  res.locals.currentUser = session.user;
  res.locals.csrfToken = session.payload.csrf;
  next();
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.user) return res.redirect('/admin/login');
    if (req.user.role !== role) {
      return res.status(403).render('error', {
        title: '没有访问权限',
        message: role === 'admin' ? '该操作仅限管理员。' : '当前账号无权访问该页面。',
        statusCode: 403
      });
    }
    next();
  };
}

function verifyCsrf(req, res, next) {
  const session = req.user;
  const token = req.sessionCsrf || '';
  if (!session || !timingSafeEqualText(token, String(req.body?._csrf || ''))) {
    return res.status(403).render('error', {
      title: '无效的安全令牌',
      message: '页面已过期或请求来源无效，请刷新后重试。',
      statusCode: 403
    });
  }
  next();
}

function validUserCredentials(db, username, password) {
  const row = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(String(username));
  if (!row || !row.is_active || row.account_risk === 'blocked' || !verifyPassword(password, row.password_hash)) return null;
  return mapUser(row);
}

module.exports = {
  COOKIE_NAME,
  userSessionFromRequest,
  setSessionCookie,
  clearSessionCookie,
  createSession,
  requireUser,
  requireRole,
  verifyCsrf,
  validUserCredentials
};
