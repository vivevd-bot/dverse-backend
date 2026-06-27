/**
 * wallet_new.js — Adapter: map wallet.js (coin_grants schema) lên API
 * cũ của src/services/wallet.js để cutover không cần sửa routes.
 *
 * CÁCH DÙNG (sau khi migration xong):
 *   Trong src/routes/index.js và src/services/extras.js / content.js:
 *   THAY: const wallet = require('../services/wallet');
 *   BẰNG: const wallet = require('../services/wallet_new');
 *
 * API giữ nguyên: balance(userId), spend(userId, amount, opts), grant(userId, free, paid, opts)
 * Internally dùng coin_grants (wallet.js mới) thay vì wallet table cũ.
 */

'use strict';

const { db } = require('../db');
const W = require('../../wallet'); // wallet.js mới ở gốc backend

// Đảm bảo migration đã chạy trước khi dùng (wallet.migrate idempotent)
W.migrate(db);

/**
 * balance(userId) → { coinFree, coinPaid, coin }
 * (giữ nguyên shape cũ để không break client)
 */
function balance(userId) {
  const b = W.balance(db, userId);
  return { coinFree: b.free, coinPaid: b.paid, coin: b.total };
}

/**
 * spend(userId, amount, opts) → { ok, balance } | { ok:false, code }
 * opts: { kind, label, ref, idemKey }
 */
function spend(userId, amount, opts) {
  opts = opts || {};
  // paidOnly: donate/gacha dùng paid trước
  const paidOnly = !!(opts.paidOnly);
  const r = W.spend(db, userId, amount, opts.label || opts.kind || '', paidOnly);
  if (!r.ok) return { ok: false, code: r.reason === 'insufficient_paid' ? 'INSUFFICIENT' : 'INSUFFICIENT' };
  const b = balance(userId);
  return { ok: true, balance: b };
}

/**
 * grant(userId, freeDelta, paidDelta, opts) → { ok, balance }
 * Cộng xu — giống shape cũ.
 */
function grant(userId, freeDelta, paidDelta, opts) {
  opts = opts || {};
  freeDelta = Math.floor(freeDelta || 0);
  paidDelta = Math.floor(paidDelta || 0);
  if (freeDelta > 0) W.grant(db, userId, freeDelta, 'free', opts.label || opts.kind || 'grant');
  if (paidDelta > 0) W.grant(db, userId, paidDelta, 'paid', opts.label || opts.kind || 'grant');
  const b = balance(userId);
  return { ok: true, balance: b };
}

function ensure(userId) { balance(userId); } // no-op (wallet.js lazy creates)

function ledger(userId, limit) {
  // Đọc từ coin_spends (mới) + legacy ledger (cũ) — merge theo thời gian
  const spends = db.prepare(
    `SELECT amount, spent_free, spent_paid, label, created_at FROM coin_spends
     WHERE user_id=? ORDER BY id DESC LIMIT ?`
  ).all(userId, Math.min(limit || 50, 100)).map((r) => ({
    delta_free: -r.spent_free, delta_paid: -r.spent_paid,
    kind: 'spend', label: r.label, ref: null, created_at: r.created_at,
  }));
  const grants = db.prepare(
    `SELECT amount, kind, source, created_at FROM coin_grants
     WHERE user_id=? ORDER BY id DESC LIMIT ?`
  ).all(userId, Math.min(limit || 50, 100)).map((r) => ({
    delta_free: r.kind === 'free' ? r.amount : 0,
    delta_paid: r.kind === 'paid' ? r.amount : 0,
    kind: 'grant', label: r.source, ref: null, created_at: r.created_at,
  }));
  return [...spends, ...grants]
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, limit || 50);
}

function reconcile(userId) {
  const w = balance(userId);
  return { ok: true, wallet: w, note: 'coin_grants schema — reconcile via wallet.js balance()' };
}

module.exports = { ensure, balance, spend, grant, ledger, reconcile };
