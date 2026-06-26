'use strict';
/** Entrypoint: validate env -> migrate -> mount middleware + routes -> listen. */
const express = require('express');
const { config, validate } = require('./lib/config');
const { logger } = require('./lib/logger');

validate(); // fail-fast nếu thiếu secret ở production
require('./db/migrate'); // đảm bảo schema (idempotent)

const mw = require('./middleware');
const routes = require('./routes');

const app = express();
app.set('trust proxy', 1); // Railway sau proxy -> req.ip đúng
app.disable('x-powered-by');
app.use(mw.cors);
app.use(express.json({ limit: '256kb' }));
app.use(mw.jsonError);
app.use(routes);
app.use(mw.onError);

const server = app.listen(config.port, () => {
  logger.info('server.up', { port: config.port, env: config.nodeEnv, vnpay: config.vnp.enabled });
});

function shutdown(sig) {
  logger.info('server.shutdown', { sig });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 8000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = app;
