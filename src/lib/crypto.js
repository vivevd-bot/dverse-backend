'use strict';
/**
 * Helper mã hoá — chỉ dùng `node:crypto`, không phụ thuộc thư viện ngoài.
 * - JWT HS256 tự ký/verify (đủ cho access/refresh + DRM token).
 * - HMAC-SHA512 cho VNPay/DCB callback.
 * - Hằng-thời-gian so sánh để chống timing attack.
 */
const crypto = require('node:crypto');

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlJson(obj) { return b64url(JSON.stringify(obj)); }
function fromB64url(s) { return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64'); }

function timingEqual(a, b) {
  const ba = Buffer.from(String(a)); const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// ---- JWT HS256 ----
function jwtSign(payload, secret, ttlSec) {
  const now = Math.floor(Date.now() / 1000);
  const body = Object.assign({ iat: now, exp: now + ttlSec }, payload);
  const head = { alg: 'HS256', typ: 'JWT' };
  const data = b64urlJson(head) + '.' + b64urlJson(body);
  const sig = b64url(crypto.createHmac('sha256', secret).update(data).digest());
  return data + '.' + sig;
}
function jwtVerify(token, secret) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const data = parts[0] + '.' + parts[1];
  const expSig = b64url(crypto.createHmac('sha256', secret).update(data).digest());
  if (!timingEqual(expSig, parts[2])) return null;
  let body;
  try { body = JSON.parse(fromB64url(parts[1]).toString('utf8')); } catch (e) { return null; }
  if (typeof body.exp !== 'number' || body.exp < Math.floor(Date.now() / 1000)) return null;
  return body;
}

// ---- HMAC (VNPay/DCB) ----
function hmac(algo, secret, data) {
  return crypto.createHmac(algo, secret).update(data, 'utf8').digest('hex');
}
function hmacSha512(secret, data) { return hmac('sha512', secret, data); }
function verifyHmacSha512(secret, data, expectedHex) {
  return timingEqual(hmacSha512(secret, data), (expectedHex || '').toLowerCase());
}

// ---- nonce / hash ----
function nonce(bytes) { return crypto.randomBytes(bytes || 16).toString('hex'); }
function sha256(s) { return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex'); }
function numericCode(digits) {
  const max = 10 ** (digits || 6);
  return String(crypto.randomInt(0, max)).padStart(digits || 6, '0');
}

module.exports = {
  b64url, timingEqual, jwtSign, jwtVerify,
  hmacSha512, verifyHmacSha512, nonce, sha256, numericCode,
};
