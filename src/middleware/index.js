'use strict';
/** Middleware bảo mật: CORS allowlist, JWT guard, rate-limit (sqlite sliding-window), error handler. */
const { db } = require('../db');
const { config } = require('../lib/config');
const C = require('../lib/crypto');
const { logger } = require('../lib/logger');

// ---- CORS allowlist (KHÔNG dùng *) ----
function cors(req, res, next) {
  const origin = req.headers.origin;
  if (origin && config.corsOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Idempotency-Key');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
}

// ---- JWT auth guard ----
function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  const claims = m ? C.jwtVerify(m[1], config.jwtSecret) : null;
  if (!claims || !claims.sub) return res.status(401).json({ ok: false, code: 'UNAUTH' });
  // session còn sống?
  const s = db.prepare('SELECT revoked, expires_at FROM sessions WHERE id=?').get(claims.sid);
  if (!s || s.revoked || s.expires_at < Date.now()) return res.status(401).json({ ok: false, code: 'SESSION_INVALID' });
  req.user = { id: claims.sub, msisdn: claims.msisdn, telco: claims.telco, sid: claims.sid };
  next();
}

// ---- Rate limit (sliding window theo bucket trong SQLite) ----
const _rlGet = db.prepare('SELECT count, expires_at FROM rate_buckets WHERE k=?');
const _rlUp = db.prepare('INSERT INTO rate_buckets (k,count,expires_at) VALUES (?,1,?) ON CONFLICT(k) DO UPDATE SET count=count+1');
function rateLimit(scope, max) {
  return function (req, res, next) {
    const id = (req.user && req.user.id) || req.ip || req.headers['x-forwarded-for'] || 'anon';
    const win = config.rateLimit.windowSec;
    const bucket = Math.floor(Date.now() / 1000 / win);
    const k = scope + ':' + id + ':' + bucket;
    const row = _rlGet.get(k);
    if (row && row.count >= max) {
      res.setHeader('Retry-After', win);
      return res.status(429).json({ ok: false, code: 'RATE_LIMIT' });
    }
    _rlUp.run(k, (bucket + 1) * win * 1000);
    next();
  };
}
// dọn bucket hết hạn định kỳ
setInterval(() => { try { db.prepare('DELETE FROM rate_buckets WHERE expires_at < ?').run(Date.now()); } catch (e) { /* */ } }, 60000).unref();

// ---- JSON body guard (giới hạn size) ----
function jsonError(err, req, res, next) {
  if (err && err.type === 'entity.too.large') return res.status(413).json({ ok: false, code: 'TOO_LARGE' });
  if (err && err.status === 400) return res.status(400).json({ ok: false, code: 'BAD_JSON' });
  next(err);
}

// ---- Error handler (không leak stack) ----
function onError(err, req, res, next) {
  logger.error('unhandled', { msg: err && err.message, path: req.path });
  if (res.headersSent) return next(err);
  res.status(500).json({ ok: false, code: 'INTERNAL' });
}

module.exports = { cors, auth, rateLimit, jsonError, onError };
