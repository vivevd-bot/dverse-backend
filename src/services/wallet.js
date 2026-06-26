'use strict';
/**
 * Ví SERVER-AUTHORITATIVE. Quy tắc bất biến:
 *  - Mọi thay đổi số dư đi qua đây, trong transaction, kèm dòng ledger.
 *  - Tiêu xu free trước, paid sau.
 *  - spend()/grant() nhận idem_key để chống lặp (double-tap).
 *  - KHÔNG client nào được tự cộng/trừ xu. Frontend chỉ hiển thị số server trả.
 */
const { db } = require('../db');
const idem = require('./idempotency');

const _wallet = db.prepare('SELECT coin_free, coin_paid FROM wallet WHERE user_id = ?');
const _ensure = db.prepare('INSERT OR IGNORE INTO wallet (user_id,coin_free,coin_paid,updated_at) VALUES (?,?,?,?)');
const _ledger = db.prepare(
  'INSERT INTO ledger (user_id,delta_free,delta_paid,kind,label,ref,idem_key,created_at) VALUES (?,?,?,?,?,?,?,?)'
);
const _setWallet = db.prepare('UPDATE wallet SET coin_free=?, coin_paid=?, updated_at=? WHERE user_id=?');

function ensure(userId) { _ensure.run(userId, 0, 0, Date.now()); }

function balance(userId) {
  ensure(userId);
  const w = _wallet.get(userId) || { coin_free: 0, coin_paid: 0 };
  return { coinFree: w.coin_free, coinPaid: w.coin_paid, coin: w.coin_free + w.coin_paid };
}

// Trừ xu — trả {ok, balance} hoặc {ok:false, code:'INSUFFICIENT'}
function spend(userId, amount, opts) {
  opts = opts || {};
  amount = Math.floor(amount);
  if (!(amount > 0)) return { ok: false, code: 'BAD_AMOUNT' };
  if (opts.idemKey) {
    const prev = idem.getStored(opts.idemKey);
    if (prev) return prev;
  }
  const tx = db.transaction(() => {
    ensure(userId);
    const w = _wallet.get(userId);
    const total = w.coin_free + w.coin_paid;
    if (total < amount) return { ok: false, code: 'INSUFFICIENT', balance: { coinFree: w.coin_free, coinPaid: w.coin_paid, coin: total } };
    const useFree = Math.min(w.coin_free, amount);
    const usePaid = amount - useFree;
    const nf = w.coin_free - useFree;
    const np = w.coin_paid - usePaid;
    _setWallet.run(nf, np, Date.now(), userId);
    _ledger.run(userId, -useFree, -usePaid, opts.kind || 'spend', opts.label || null, opts.ref || null, opts.idemKey || null, Date.now());
    return { ok: true, balance: { coinFree: nf, coinPaid: np, coin: nf + np } };
  });
  const res = tx();
  if (opts.idemKey && res.ok) idem.store(opts.idemKey, userId, 'spend', res);
  return res;
}

// Cộng xu (grant tặng / topup trả tiền) — server-issued, không tin client
function grant(userId, freeDelta, paidDelta, opts) {
  opts = opts || {};
  freeDelta = Math.floor(freeDelta || 0);
  paidDelta = Math.floor(paidDelta || 0);
  if (freeDelta < 0 || paidDelta < 0) return { ok: false, code: 'BAD_AMOUNT' };
  if (opts.idemKey) {
    const prev = idem.getStored(opts.idemKey);
    if (prev) return prev;
  }
  const tx = db.transaction(() => {
    ensure(userId);
    const w = _wallet.get(userId);
    const nf = w.coin_free + freeDelta;
    const np = w.coin_paid + paidDelta;
    _setWallet.run(nf, np, Date.now(), userId);
    _ledger.run(userId, freeDelta, paidDelta, opts.kind || 'grant', opts.label || null, opts.ref || null, opts.idemKey || null, Date.now());
    return { ok: true, balance: { coinFree: nf, coinPaid: np, coin: nf + np } };
  });
  const res = tx();
  if (opts.idemKey && res.ok) idem.store(opts.idemKey, userId, 'spend', res);
  return res;
}

function ledger(userId, limit) {
  return db.prepare('SELECT delta_free,delta_paid,kind,label,ref,created_at FROM ledger WHERE user_id=? ORDER BY id DESC LIMIT ?')
    .all(userId, Math.min(limit || 50, 200));
}

// Đối soát: tổng ledger phải khớp số dư wallet (chạy cron/health)
function reconcile(userId) {
  const w = balance(userId);
  const sum = db.prepare('SELECT COALESCE(SUM(delta_free),0) f, COALESCE(SUM(delta_paid),0) p FROM ledger WHERE user_id=?').get(userId);
  return { ok: sum.f === w.coinFree && sum.p === w.coinPaid, wallet: w, ledgerSum: { coinFree: sum.f, coinPaid: sum.p } };
}

module.exports = { ensure, balance, spend, grant, ledger, reconcile };
