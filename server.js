const { loadConfig } = require('./src/config');
const { createApp } = require('./src/app');

const config = loadConfig();
if (config.adminPasswordIsDefault) {
  console.warn('[security] ADMIN_PASSWORD is using the default value. Change it before exposing this service.');
}
if (config.appSecretGenerated) {
  console.warn('[security] APP_SECRET is not set. Encrypted card data and SMTP credentials will become unreadable after restart. Set APP_SECRET.');
}

const { app, close } = createApp({ config });

const server = app.listen(config.port, config.host, () => {
  console.log(`Epay Test Gateway listening on http://${config.host}:${config.port}`);
});

function shutdown(signal) {
  console.log(`Received ${signal}, shutting down...`);
  server.close(() => {
    close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
