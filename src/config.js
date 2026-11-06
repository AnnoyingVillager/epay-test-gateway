const path = require('node:path');
const crypto = require('node:crypto');
require('dotenv').config({ quiet: true });

function envBool(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function envInt(name, fallback, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function loadConfig(overrides = {}) {
  const rootDir = path.resolve(__dirname, '..');
  const nodeEnv = process.env.NODE_ENV || 'development';
  const generatedSecret = crypto.randomBytes(32).toString('hex');
  const appSecret = process.env.APP_SECRET || (nodeEnv === 'production' ? generatedSecret : 'dev-only-change-me');
  const adminPassword = process.env.ADMIN_PASSWORD || 'change-me-now';

  return {
    rootDir,
    nodeEnv,
    isProduction: nodeEnv === 'production',
    host: process.env.HOST || '0.0.0.0',
    port: envInt('PORT', 3001, 1, 65535),
    databasePath: process.env.DB_PATH || path.join(rootDir, 'data', 'epay.db'),
    appSecret,
    appSecretGenerated: !process.env.APP_SECRET && nodeEnv === 'production',
    adminUsername: process.env.ADMIN_USERNAME || 'admin',
    adminPassword,
    adminPasswordIsDefault: adminPassword === 'change-me-now',
    adminSessionHours: envInt('ADMIN_SESSION_HOURS', 12, 1, 168),
    baseUrl: (process.env.BASE_URL || '').replace(/\/$/, ''),
    trustProxy: envBool('TRUST_PROXY', false),
    secureCookies: envBool('COOKIE_SECURE', false),
    defaultMerchantPid: process.env.DEFAULT_MERCHANT_PID || '1001',
    defaultMerchantName: process.env.DEFAULT_MERCHANT_NAME || 'Demo Merchant',
    defaultMerchantKey: process.env.DEFAULT_MERCHANT_KEY || 'test-merchant-key-change-me',
    defaultTimeoutSeconds: envInt('ORDER_TIMEOUT_SECONDS', 900, 60, 86400),
    sweepIntervalMs: envInt('SWEEP_INTERVAL_MS', 15000, 1000, 300000),
    notifyTimeoutMs: envInt('NOTIFY_TIMEOUT_MS', 8000, 1000, 30000),
    notifyRetryCount: envInt('NOTIFY_RETRY_COUNT', 3, 0, 10),
    logLevel: process.env.LOG_LEVEL || 'info',
    ...overrides
  };
}

module.exports = { loadConfig };
