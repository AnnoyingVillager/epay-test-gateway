const express = require('express');
const path = require('node:path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { openDatabase, getSetting } = require('./db');
const { NotificationService } = require('./notifications');
const { sweepExpiredOrders } = require('./order-service');
const { userSessionFromRequest } = require('./admin-auth');
const publicRouter = require('./public-router');
const adminRouter = require('./admin-router');
const { formatMinor } = require('./epay');

function createApp(options) {
  const config = options.config;
  const logger = options.logger || console;
  const db = options.db || openDatabase(config);
  const notification = new NotificationService({ db, config, logger });
  const app = express();

  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);
  app.set('view engine', 'ejs');
  app.set('views', path.join(config.rootDir, 'views'));
  app.locals.config = config;
  app.locals.db = db;
  app.locals.notification = notification;
  app.locals.formatMinor = formatMinor;
  app.locals.siteName = getSetting(db, 'site_name', 'Epay Test Gateway');
  app.locals.formatDateTime = (value) => {
    if (!value) return '-';
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    }).format(new Date(Number(value)));
  };
  app.locals.statusLabel = (status) => ({
    active: '可支付', declined: '模拟拒付', frozen: '已冻结',
    PENDING: '待支付', PAID: '已支付', EXPIRED: '已超时', FAILED: '支付失败', CHARGEBACK: '已拒付/退单',
    SENT: '已送达', NONE: '未回调'
  })[status] || status;

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: null
      }
    },
    crossOriginEmbedderPolicy: false
  }));
  app.use(express.urlencoded({ extended: false, limit: '128kb' }));
  app.use(express.json({ limit: '128kb' }));
  app.use(express.static(path.join(config.rootDir, 'public'), {
    maxAge: config.isProduction ? '1h' : 0,
    etag: true
  }));

  app.use((req, res, next) => {
    const session = userSessionFromRequest(req, db, config);
    req.currentUser = session?.user || null;
    res.locals.currentUser = session?.user || null;
    res.locals.hasUserSession = Boolean(session);
    res.locals.hasAdminSession = Boolean(session);
    res.locals.csrfToken = session?.payload?.csrf || '';
    res.locals.currentPath = req.path;
    res.locals.query = req.query;
    next();
  });

  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: '登录尝试次数过多，请 15 分钟后再试。'
  });
  const payLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 30,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: '操作过于频繁，请稍后重试。'
  });

  app.use('/pay/:tradeNo/confirm', payLimiter);
  app.use('/pay/:tradeNo/bind', payLimiter);
  app.use('/pay/:tradeNo/login', loginLimiter);
  app.use('/admin/login', loginLimiter);
  app.use('/admin', adminRouter({ db, config, notification, logger }));
  app.use('/', publicRouter.router({ db, config, notification }));

  app.use((req, res) => {
    res.status(404).render('error', {
      title: '页面不存在',
      message: '请求的页面不存在。',
      statusCode: 404
    });
  });

  app.use((error, req, res, next) => {
    logger.error?.('Unhandled request error', error);
    if (res.headersSent) return next(error);
    res.status(error.statusCode || 500).render('error', {
      title: '服务器错误',
      message: config.isProduction ? '服务器处理请求时发生错误。' : error.message,
      statusCode: error.statusCode || 500
    });
  });

  const sweep = () => {
    try {
      sweepExpiredOrders({ db, notification });
    } catch (error) {
      logger.error?.('Expired order sweep failed', error);
    }
  };
  const sweepTimer = setInterval(sweep, config.sweepIntervalMs);
  sweepTimer.unref();
  sweep();

  return {
    app,
    db,
    notification,
    close() {
      clearInterval(sweepTimer);
      db.close();
    }
  };
}

module.exports = { createApp };
