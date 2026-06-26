'use strict';
/** Logger JSON tối giản (đủ để ship sang Sentry/observability sau). */
function log(level, msg, meta) {
  const rec = Object.assign({ t: new Date().toISOString(), level, msg }, meta || {});
  // KHÔNG log secret/token/PII thô. Caller chịu trách nhiệm.
  process.stdout.write(JSON.stringify(rec) + '\n');
}
const logger = {
  info: (m, x) => log('info', m, x),
  warn: (m, x) => log('warn', m, x),
  error: (m, x) => log('error', m, x),
  audit: (action, x) => log('audit', action, x),
};

module.exports = { logger };
