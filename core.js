'use strict';
// Core domain — toàn bộ business rule khớp demo, nhưng atomic & server-authoritative.
const crypto = require('crypto');
const { db } = require('./db');
const { billingFor, drm } = require('./adapters');

const now = () => new Date().toISOString();
const today = () => new Date().toISOString().slice(0, 10);
const uid = (p) => p + crypto.randomBytes(8).toString('hex');
const COIN_VND = 20; // 1 coin = 20đ

// ---- AUTH (OTP stub) -------------------------------------------------------
function requestOtp(phone) {
  const code = process.env.NODE_ENV === 'prod'
    ? ('' + Math.floor(100000 + Math.random() * 900000))
    : '000000'; // dev: cố định để test. Prod: gửi SMS qua telco.
  const exp = new Date(Date.now() + 5 * 60000).toISOString();
  db.prepare('INSERT INTO otp(phone,code,expires_at) VALUES(?,?,?) ' +
    'ON CONFLICT(phone) DO UPDATE SET code=?,expires_at=?').run(phone, code, exp, code, exp);
  return { sent: true, devCode: process.env.NODE_ENV === 'prod' ? undefined : code };
}
function verifyOtp(phone, code) {
  const row = db.prepare('SELECT * FROM otp WHERE phone=?').get(phone);
  if (!row || row.code !== code || row.expires_at < now()) return null;
  db.prepare('DELETE FROM otp WHERE phone=?').run(phone);
  let u = db.prepare('SELECT * FROM users WHERE phone=?').get(phone);
  if (!u) {
    const id = uid('u_');
    db.prepare(`INSERT INTO users(id,phone,name,coin_paid,coin_free,created_at)
      VALUES(?,?,?,?,?,?)`).run(id, phone, 'Đạo hữu', 0, 20, now());
    db.prepare(`INSERT INTO ledger(user_id,ts,title,detail,kind,amount)
      VALUES(?,?,?,?,?,?)`).run(id, now(), 'Tặng khi tạo tài khoản', '+20 coin tặng', 'grant', 20);
    u = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  }
  const token = crypto.randomBytes(24).toString('hex');
  db.prepare(`INSERT INTO sessions(token,user_id,created_at,expires_at)
    VALUES(?,?,?,?)`).run(token, u.id, now(), new Date(Date.now() + 30 * 864e5).toISOString());
  return { token, user: publicUser(u) };
}
function userByToken(token) {
  if (!token) return null;
  const s = db.prepare('SELECT * FROM sessions WHERE token=? AND expires_at>?').get(token, now());
  if (!s) return null;
  return db.prepare('SELECT * FROM users WHERE id=?').get(s.user_id);
}
function publicUser(u) {
  return { id: u.id, name: u.name, phone: u.phone, coin: u.coin_paid + u.coin_free,
    coinPaid: u.coin_paid, coinFree: u.coin_free, pass: u.pass, passExpires: u.pass_expires,
    level: u.level, exp: u.exp, mTickets: u.m_tickets, rTickets: u.r_tickets, streak: u.streak };
}

// ---- WALLET (spend: free trước, paid sau — atomic) -------------------------
function spend(userId, amount, title) {
  const tx = db.prepare('SELECT coin_paid,coin_free FROM users WHERE id=?').get(userId);
  if (!tx || tx.coin_paid + tx.coin_free < amount) return { ok: false, reason: 'insufficient' };
  const f = Math.min(tx.coin_free, amount);
  const p = amount - f;
  db.prepare('UPDATE users SET coin_free=coin_free-?, coin_paid=coin_paid-? WHERE id=?')
    .run(f, p, userId);
  db.prepare(`INSERT INTO ledger(user_id,ts,title,detail,kind,amount)
    VALUES(?,?,?,?,?,?)`).run(userId, now(), title, `-${amount} coin`, 'spend', -amount);
  return { ok: true };
}
function ledger(userId) {
  return db.prepare('SELECT title t,detail d,kind k,amount a,ts FROM ledger WHERE user_id=? ORDER BY id DESC LIMIT 100').all(userId);
}

// ---- TOPUP (nạp coin qua billing adapter) ----------------------------------
// 5-tier bonus đã chốt
const TOPUP = {
  t1: { vnd: 20000, coins: 1000, bonus: 0 },
  t2: { vnd: 50000, coins: 2500, bonus: 100 },
  t3: { vnd: 100000, coins: 5000, bonus: 350 },
  t4: { vnd: 200000, coins: 10000, bonus: 900 },
  t5: { vnd: 500000, coins: 25000, bonus: 3000 },
};
async function topup(userId, packageId, provider, channel) {
  const pkg = TOPUP[packageId];
  if (!pkg) return { ok: false, reason: 'bad_package' };
  const txId = uid('tx_');
  db.prepare(`INSERT INTO transactions(id,user_id,provider,channel,amount_vnd,coins,kind,status,created_at)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(txId, userId, provider, channel, pkg.vnd, pkg.coins + pkg.bonus, 'topup', 'pending', now());
  const res = await billingFor(provider, channel).charge({ userId, provider, channel, amountVnd: pkg.vnd, ref: txId });
  if (res.status !== 'success') {
    db.prepare('UPDATE transactions SET status=? WHERE id=?').run('failed', txId);
    return { ok: false, reason: 'billing_failed' };
  }
  db.prepare('UPDATE transactions SET status=?,provider_ref=? WHERE id=?').run('success', res.providerRef, txId);
  db.prepare('UPDATE users SET coin_paid=coin_paid+? WHERE id=?').run(pkg.coins, userId);
  db.prepare('UPDATE users SET coin_free=coin_free+? WHERE id=?').run(pkg.bonus, userId);
  db.prepare(`INSERT INTO ledger(user_id,ts,title,detail,kind,amount)
    VALUES(?,?,?,?,?,?)`).run(userId, now(), `Nạp ${pkg.vnd.toLocaleString('vi-VN')}đ`, `+${pkg.coins} coin${pkg.bonus ? ` +${pkg.bonus} tặng` : ''}`, 'topup', pkg.coins + pkg.bonus);
  return { ok: true, coins: pkg.coins + pkg.bonus };
}

// ---- MEMBERSHIP (reading pass) ---------------------------------------------
const PLANS = { plus: { vnd: 59000, name: 'DVERSE+' }, vip: { vnd: 129000, name: 'VIP' } };
async function subscribe(userId, plan, provider, channel) {
  const p = PLANS[plan];
  if (!p) return { ok: false, reason: 'bad_plan' };
  const txId = uid('tx_');
  db.prepare(`INSERT INTO transactions(id,user_id,provider,channel,amount_vnd,kind,status,created_at)
    VALUES(?,?,?,?,?,?,?,?)`).run(txId, userId, provider, channel, p.vnd, 'membership', 'pending', now());
  const res = await billingFor(provider, channel).charge({ userId, provider, channel, amountVnd: p.vnd, ref: txId });
  if (res.status !== 'success') { db.prepare('UPDATE transactions SET status=? WHERE id=?').run('failed', txId); return { ok: false, reason: 'billing_failed' }; }
  db.prepare('UPDATE transactions SET status=?,provider_ref=? WHERE id=?').run('success', res.providerRef, txId);
  const exp = new Date(Date.now() + 30 * 864e5).toISOString();
  db.prepare('UPDATE users SET pass=?,pass_expires=? WHERE id=?').run(plan, exp, userId);
  return { ok: true, pass: plan, expires: exp };
}
function hasActivePass(u) { return u.pass && u.pass_expires && u.pass_expires > now(); }

// ---- CATALOG ---------------------------------------------------------------
function catalog() {
  return db.prepare('SELECT id,title,type,format,cp,cat,tags,rating,reads,complete FROM books')
    .all().map(b => ({ ...b, tags: JSON.parse(b.tags || '[]'), complete: !!b.complete }));
}
function bookDetail(bookId) {
  const b = db.prepare('SELECT * FROM books WHERE id=?').get(bookId);
  if (!b) return null;
  const chapters = db.prepare('SELECT seq,title,tier,price_coin priceCoin,words FROM chapters WHERE book_id=? ORDER BY seq').all(bookId);
  return { ...b, tags: JSON.parse(b.tags || '[]'), complete: !!b.complete, chapters };
}

// ---- UNLOCK + READ ---------------------------------------------------------
function owns(userId, bookId, seq) {
  return !!db.prepare('SELECT 1 FROM ownership WHERE user_id=? AND book_id=? AND seq=?').get(userId, bookId, seq);
}
function grantOwnership(userId, bookId, seq, source) {
  db.prepare(`INSERT OR IGNORE INTO ownership(user_id,book_id,seq,source,created_at)
    VALUES(?,?,?,?,?)`).run(userId, bookId, seq, source, now());
}
// Trả nội dung nếu được phép, else paywall info
function readChapter(u, bookId, seq) {
  const ch = db.prepare('SELECT * FROM chapters WHERE book_id=? AND seq=?').get(bookId, seq);
  if (!ch) return { status: 404 };
  const allowed = ch.tier === 'FREE' || owns(u.id, bookId, seq) || hasActivePass(u);
  if (!allowed) return { status: 402, paywall: { seq, tier: ch.tier, priceCoin: ch.price_coin } };
  if (ch.tier === 'FREE') grantOwnership(u.id, bookId, seq, 'free');
  const lic = drm.issueLicense(u.id, bookId, seq);
  return { status: 200, chapter: { seq, title: ch.title, words: ch.words, body: drm.wrap(ch.body), license: lic } };
}
function unlock(u, bookId, seq) {
  const ch = db.prepare('SELECT * FROM chapters WHERE book_id=? AND seq=?').get(bookId, seq);
  if (!ch) return { ok: false, reason: 'not_found' };
  if (owns(u.id, bookId, seq) || ch.tier === 'FREE') return { ok: true, already: true };
  if (hasActivePass(u)) { grantOwnership(u.id, bookId, seq, 'pass'); return { ok: true, via: 'pass' }; }
  const r = spend(u.id, ch.price_coin, `Mở khóa ${bookId} · Ch.${seq}`);
  if (!r.ok) return { ok: false, reason: 'insufficient', priceCoin: ch.price_coin };
  grantOwnership(u.id, bookId, seq, 'paid');
  return { ok: true, via: 'paid', spent: ch.price_coin };
}
// Wait-for-free: 1 chương/truyện/ngày
function claimDailyFree(u, bookId, seq) {
  const day = today();
  const had = db.prepare('SELECT 1 FROM daily_free WHERE user_id=? AND book_id=? AND day=?').get(u.id, bookId, day);
  if (had) return { ok: false, reason: 'claimed_today' };
  db.prepare('INSERT INTO daily_free(user_id,book_id,day) VALUES(?,?,?)').run(u.id, bookId, day);
  grantOwnership(u.id, bookId, seq, 'daily_free');
  return { ok: true };
}
// METERING — heartbeat phút đọc (nguồn chia pass-revenue pool)
function readingHeartbeat(u, bookId, seq, seconds) {
  const s = Math.max(0, Math.min(600, parseInt(seconds, 10) || 0)); // cap 10' / nhịp chống gian lận
  db.prepare('INSERT INTO reading_events(user_id,book_id,seq,seconds,ts) VALUES(?,?,?,?,?)')
    .run(u.id, bookId, seq, s, now());
  db.prepare('UPDATE progress SET seq=? WHERE user_id=? AND book_id=?').run(seq, u.id, bookId);
  db.prepare('INSERT OR IGNORE INTO progress(user_id,book_id,seq) VALUES(?,?,?)').run(u.id, bookId, seq);
  // EXP + ticket cấp khi đọc (giữ logic gamification demo)
  db.prepare('UPDATE users SET exp=exp+1 WHERE id=?').run(u.id);
  return { ok: true, logged: s };
}
// Báo cáo phân bổ pool: phút đọc theo rights holder trong kỳ
function passPoolReport(fromTs, toTs) {
  return db.prepare(`
    SELECT b.cp AS rights_holder, SUM(r.seconds)/60.0 AS minutes
    FROM reading_events r JOIN books b ON b.id=r.book_id
    WHERE r.ts BETWEEN ? AND ? GROUP BY b.cp ORDER BY minutes DESC`).all(fromTs, toTs);
}

// Hydrate frontend: danh sách chương đã sở hữu + tiến độ
function library(userId) {
  const owned = db.prepare('SELECT book_id bookId, seq, source FROM ownership WHERE user_id=?').all(userId);
  const progress = db.prepare('SELECT book_id bookId, seq FROM progress WHERE user_id=?').all(userId);
  return { owned, progress };
}
// Spend chung (cho donate/gift trong demo)
function spendApi(userId, amount, label) {
  const r = spend(userId, parseInt(amount, 10) || 0, label || 'Chi tiêu');
  return r.ok ? { ok: true } : { ok: false, reason: r.reason };
}

module.exports = {
  requestOtp, verifyOtp, userByToken, publicUser,
  spend, spendApi, library, ledger, topup, subscribe, hasActivePass,
  catalog, bookDetail, readChapter, unlock, claimDailyFree,
  readingHeartbeat, passPoolReport, TOPUP, PLANS, COIN_VND,
};
