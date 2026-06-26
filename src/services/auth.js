'use strict';
/**
 * Auth telco-native: MSISDN + OTP -> JWT access + refresh (rotation).
 * - OTP hash lưu DB, TTL + max attempts (chống brute force).
 * - Refresh token lưu dạng sha256 (không lưu thô), rotate mỗi lần refresh.
 * - HE (header enrichment) telco: thay otpProvider.detectMsisdn() khi tích hợp gateway thật.
 */
const { db } = require('../db');
const { config } = require('../lib/config');
const C = require('../lib/crypto');
const wallet = require('./wallet');
const { logger } = require('../lib/logger');

// ---- OTP provider (stub | telco) ----
const otpProvider = {
  async send(msisdn, code) {
    if (config.otpProvider === 'telco') {
      // TODO tích hợp SMS gateway/telco API thật ở đây.
      throw new Error('otpProvider=telco chưa cắm gateway');
    }
    // stub: log (KHÔNG dùng ở production). Beta nội bộ có thể tạm chấp nhận.
    logger.warn('otp.stub', { msisdn: mask(msisdn) });
    return { ok: true, devCode: config.isProd ? undefined : code };
  },
};
function mask(m) { return String(m).replace(/.(?=.{3})/g, '*'); }
function normMsisdn(m) {
  let s = String(m || '').replace(/[^\d+]/g, '');
  if (s.startsWith('0')) s = '+84' + s.slice(1);
  if (!s.startsWith('+')) s = '+' + s;
  return s;
}

const _otpPut = db.prepare('INSERT INTO otp (msisdn,code_hash,expires_at,attempts,created_at) VALUES (?,?,?,0,?) ON CONFLICT(msisdn) DO UPDATE SET code_hash=excluded.code_hash, expires_at=excluded.expires_at, attempts=0, created_at=excluded.created_at');
const _otpGet = db.prepare('SELECT code_hash,expires_at,attempts FROM otp WHERE msisdn=?');
const _otpBump = db.prepare('UPDATE otp SET attempts=attempts+1 WHERE msisdn=?');
const _otpDel = db.prepare('DELETE FROM otp WHERE msisdn=?');

async function requestOtp(rawMsisdn) {
  const msisdn = normMsisdn(rawMsisdn);
  if (!/^\+\d{8,15}$/.test(msisdn)) return { ok: false, code: 'BAD_MSISDN' };
  const code = config.otpProvider === 'stub' ? config.otpDevCode : C.numericCode(6);
  _otpPut.run(msisdn, C.sha256(code + msisdn), Date.now() + config.otpTtlSec * 1000, Date.now());
  const sent = await otpProvider.send(msisdn, code);
  return { ok: true, msisdn: mask(msisdn), devCode: sent.devCode };
}

const _userByMsisdn = db.prepare('SELECT * FROM users WHERE msisdn=?');
const _insUser = db.prepare('INSERT INTO users (id,msisdn,telco,status,created_at,last_login) VALUES (?,?,?,?,?,?)');
const _touchUser = db.prepare('UPDATE users SET last_login=? WHERE id=?');
const _insSession = db.prepare('INSERT INTO sessions (id,user_id,refresh_hash,device,ip,created_at,expires_at,revoked) VALUES (?,?,?,?,?,?,?,0)');
const _sessGet = db.prepare('SELECT * FROM sessions WHERE id=?');
const _sessRevoke = db.prepare('UPDATE sessions SET revoked=1 WHERE id=?');
const _sessRotate = db.prepare('UPDATE sessions SET refresh_hash=?, expires_at=? WHERE id=?');

function issueTokens(user, ctx) {
  const sid = C.nonce(16);
  const refresh = C.nonce(32);
  _insSession.run(sid, user.id, C.sha256(refresh), (ctx && ctx.device) || null, (ctx && ctx.ip) || null,
    Date.now(), Date.now() + config.jwtRefreshTtlSec * 1000);
  const access = C.jwtSign({ sub: user.id, msisdn: user.msisdn, telco: user.telco, sid }, config.jwtSecret, config.jwtAccessTtlSec);
  return { accessToken: access, refreshToken: sid + '.' + refresh, expiresIn: config.jwtAccessTtlSec };
}

async function verifyOtp(rawMsisdn, code, ctx) {
  const msisdn = normMsisdn(rawMsisdn);
  const row = _otpGet.get(msisdn);
  if (!row) return { ok: false, code: 'NO_OTP' };
  if (row.expires_at < Date.now()) { _otpDel.run(msisdn); return { ok: false, code: 'EXPIRED' }; }
  if (row.attempts >= config.otpMaxAttempts) { _otpDel.run(msisdn); return { ok: false, code: 'LOCKED' }; }
  if (!C.timingEqual(row.code_hash, C.sha256(String(code) + msisdn))) {
    _otpBump.run(msisdn);
    return { ok: false, code: 'WRONG' };
  }
  _otpDel.run(msisdn);
  let user = _userByMsisdn.get(msisdn);
  const created = !user;
  if (!user) {
    const id = 'u_' + C.nonce(10);
    _insUser.run(id, msisdn, (ctx && ctx.telco) || null, 'active', Date.now(), Date.now());
    user = _userByMsisdn.get(msisdn);
    wallet.ensure(id);
    wallet.grant(id, 20, 0, { kind: 'grant', label: 'Tặng khi tạo tài khoản', idemKey: 'signup:' + id });
  } else {
    _touchUser.run(Date.now(), user.id);
  }
  const tok = issueTokens(user, ctx);
  logger.audit('auth.login', { user: user.id, created });
  return { ok: true, created, user: { id: user.id, msisdn: mask(user.msisdn), telco: user.telco }, tokens: tok };
}

function refresh(refreshToken, ctx) {
  const [sid, secret] = String(refreshToken || '').split('.');
  if (!sid || !secret) return { ok: false, code: 'BAD_REFRESH' };
  const s = _sessGet.get(sid);
  if (!s || s.revoked || s.expires_at < Date.now()) return { ok: false, code: 'INVALID' };
  if (!C.timingEqual(s.refresh_hash, C.sha256(secret))) {
    _sessRevoke.run(sid); // nghi reuse -> thu hồi
    return { ok: false, code: 'REUSE_DETECTED' };
  }
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(s.user_id);
  if (!user || user.status !== 'active') return { ok: false, code: 'USER_BLOCKED' };
  const newSecret = C.nonce(32);
  _sessRotate.run(C.sha256(newSecret), Date.now() + config.jwtRefreshTtlSec * 1000, sid);
  const access = C.jwtSign({ sub: user.id, msisdn: user.msisdn, telco: user.telco, sid }, config.jwtSecret, config.jwtAccessTtlSec);
  return { ok: true, tokens: { accessToken: access, refreshToken: sid + '.' + newSecret, expiresIn: config.jwtAccessTtlSec } };
}

function logout(sid) { if (sid) _sessRevoke.run(sid); return { ok: true }; }

module.exports = { requestOtp, verifyOtp, refresh, logout, normMsisdn };
