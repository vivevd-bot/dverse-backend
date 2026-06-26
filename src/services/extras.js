'use strict';
/** Các endpoint còn lại của contract frontend (server-authoritative cho mọi cái đụng xu). */
const { db } = require('../db');
const { config } = require('../lib/config');
const C = require('../lib/crypto');
const wallet = require('./wallet');
const { SPIN_PRIZES, weightedPick, CHARS } = require('../lib/catalog');

// ---------- Spin (vòng quay) ----------
const FREE_SPINS_PER_DAY = 1;
const COMBO_COST = 50;
const _spinGet = db.prepare('SELECT day, used_free FROM spin_state WHERE user_id=?');
const _spinSet = db.prepare('INSERT INTO spin_state (user_id,day,used_free) VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET day=excluded.day, used_free=excluded.used_free');
function today() { return new Date().toISOString().slice(0, 10); }
function nextResetAt() { const d = new Date(); d.setUTCHours(24, 0, 0, 0); return d.getTime(); }

function spinStatus(userId) {
  const s = _spinGet.get(userId);
  const used = s && s.day === today() ? s.used_free : 0;
  return { ok: true, freeSpinsLeft: Math.max(0, FREE_SPINS_PER_DAY - used), nextResetAt: nextResetAt() };
}

function grantCoinPrize(userId, idx) {
  const p = SPIN_PRIZES[idx];
  if (p && p.k === 'coin') wallet.grant(userId, p.v, 0, { kind: 'grant', label: 'Vòng quay · ' + p.v + ' xu', ref: 'spin' });
}

function spin(userId, combo) {
  const s = _spinGet.get(userId);
  const used = s && s.day === today() ? s.used_free : 0;
  if (combo) {
    const sp = wallet.spend(userId, COMBO_COST, { kind: 'spend', label: 'Quay combo x3', ref: 'spin_combo' });
    if (!sp.ok) return { ok: false, reason: sp.code === 'INSUFFICIENT' ? 'insufficient' : 'spend_fail' };
    const prizes = [weightedPick(), weightedPick(), weightedPick()];
    prizes.forEach((i) => grantCoinPrize(userId, i));
    const bal = wallet.balance(userId);
    return { ok: true, prizes, prizeIndex: prizes[prizes.length - 1], walletBalance: { freeCoins: bal.coinFree, paidCoins: bal.coinPaid }, freeSpinsLeft: Math.max(0, FREE_SPINS_PER_DAY - used), nextResetAt: nextResetAt() };
  }
  // single: dùng free/ngày
  if (used >= FREE_SPINS_PER_DAY) return { ok: false, reason: 'no_free_spin' };
  const idx = weightedPick();
  grantCoinPrize(userId, idx);
  _spinSet.run(userId, today(), used + 1);
  const bal = wallet.balance(userId);
  return { ok: true, prizeIndex: idx, walletBalance: { freeCoins: bal.coinFree, paidCoins: bal.coinPaid }, freeSpinsLeft: Math.max(0, FREE_SPINS_PER_DAY - (used + 1)), nextResetAt: nextResetAt() };
}

// ---------- Lì xì ----------
const _rpClaim = db.prepare('INSERT OR IGNORE INTO redpacket_claims (user_id,packet_id,amount,created_at) VALUES (?,?,?,?)');
const RP_AMOUNTS = { p1: 8888, p2: 6666, p3: 5555 }; // map id -> xu (khớp MOCK_PACKETS client)
function claimRedPacket(userId, packetId) {
  const amount = RP_AMOUNTS[packetId] || 5000;
  const r = _rpClaim.run(userId, String(packetId), amount, Date.now());
  if (r.changes !== 1) return { ok: false, error: 'Đã nhận rồi!' };
  wallet.grant(userId, amount, 0, { kind: 'grant', label: 'Lì xì khai trương', ref: 'rp:' + packetId, idemKey: 'rp:' + userId + ':' + packetId });
  return { ok: true, amount };
}

// ---------- Donate ----------
const _donIns = db.prepare('INSERT INTO donations (user_id,book_id,amount,message,created_at) VALUES (?,?,?,?,?)');
const _donTop = db.prepare('SELECT user_id, SUM(amount) amt FROM donations WHERE book_id=? GROUP BY user_id ORDER BY amt DESC LIMIT 20');
function donateTier(a) { return a >= 5000 ? 'Đại hộ pháp' : a >= 1000 ? 'Hộ pháp' : a >= 200 ? 'Đệ tử' : 'Bạn đọc'; }
function donate(userId, bookId, amount, message) {
  amount = Math.floor(amount);
  if (!(amount > 0)) return { ok: false, reason: 'bad_amount' };
  const sp = wallet.spend(userId, amount, { kind: 'spend', label: 'Donate ' + bookId, ref: 'donate:' + bookId });
  if (!sp.ok) return { ok: false, reason: sp.code === 'INSUFFICIENT' ? 'insufficient' : 'spend_fail' };
  _donIns.run(userId, bookId, amount, String(message || '').slice(0, 200), Date.now());
  return { ok: true, tier: donateTier(amount), balance: sp.balance };
}
function donors(bookId) {
  return { ok: true, donors: _donTop.all(bookId).map((d, i) => ({ rank: i + 1, name: 'Đạo hữu ' + d.user_id.slice(-4), amount: d.amt, tier: donateTier(d.amt) })) };
}

// ---------- Membership (bundle telco) ----------
const _subSet = db.prepare("INSERT INTO subscriptions (user_id,plan,status,channel,started_at,renews_at) VALUES (?,?, 'active', ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET plan=excluded.plan, status='active', channel=excluded.channel, renews_at=excluded.renews_at");
function subscribe(userId, plan, channel) {
  // Beta: kích hoạt ngay (golive: chờ xác nhận DCB telco). 30 ngày.
  _subSet.run(userId, plan || 'plus', channel || 'telco_billing', Date.now(), Date.now() + 30 * 86400 * 1000);
  return { ok: true, plan: plan || 'plus', pass: plan || 'plus' };
}

// ---------- Topup (telco/test direct credit) ----------
const PACKS = { p20: 200, p50: 520, p100: 1100, p200: 2300, p500: 6000, '20000': 200, '50000': 520, '100000': 1100, '200000': 2300, '500000': 6000 };
function topup(userId, packageId, provider) {
  const coins = PACKS[String(packageId)];
  if (!coins) return { ok: false, reason: 'bad_pack' };
  // Beta direct/telco: credit ngay (golive VNPay đi qua IPN, không qua đây).
  wallet.grant(userId, 0, coins, { kind: 'topup', label: 'Nạp xu (' + (provider || 'direct') + ')', ref: 'topup:' + packageId, idemKey: 'topup:' + userId + ':' + Date.now() });
  return { ok: true, coins };
}

// ---------- Character ranking ----------
const _voteIns = db.prepare('INSERT OR IGNORE INTO character_votes (user_id,char_id,day,created_at) VALUES (?,?,?,?)');
const _voteCount = db.prepare('SELECT char_id, COUNT(*) n FROM character_votes GROUP BY char_id');
function charRanking() {
  const counts = {}; _voteCount.all().forEach((r) => { counts[r.char_id] = r.n; });
  const list = CHARS.map((c) => ({ name: c.name, emoji: c.emoji, rarity: c.rarity, votes: c.baseVotes + (counts[c.name] || 0) }))
    .sort((a, b) => b.votes - a.votes);
  return { ok: true, characters: list };
}
function voteCharacter(userId, name) {
  const r = _voteIns.run(userId, String(name), today(), Date.now());
  if (r.changes !== 1) return { ok: false, reason: 'voted_today' };
  return { ok: true };
}

// ---------- Book rankings (catalog) ----------
function rankings(type) {
  const order = type === 'new' ? 'created_at DESC' : 'rowid ASC';
  const books = db.prepare('SELECT id, title, provider FROM books ORDER BY ' + order + ' LIMIT 50').all()
    .map((b) => ({ bookId: b.id, title: b.title, provider: b.provider }));
  return { ok: true, books };
}

// ---------- Social login (stub beta) ----------
const _userByMsisdn = db.prepare('SELECT * FROM users WHERE msisdn=?');
const _insUser = db.prepare('INSERT INTO users (id,msisdn,telco,status,created_at,last_login) VALUES (?,?,?,?,?,?)');
function socialLogin(provider, payload) {
  const key = 'social:' + provider + ':' + ((payload && (payload.email || payload.id)) || C.nonce(6));
  let user = _userByMsisdn.get(key);
  if (!user) {
    const id = 'u_' + C.nonce(10);
    _insUser.run(id, key, null, 'active', Date.now(), Date.now());
    user = _userByMsisdn.get(key);
    wallet.ensure(id);
    wallet.grant(id, 20, 0, { kind: 'grant', label: 'Tặng khi tạo tài khoản', idemKey: 'signup:' + id });
  }
  const token = C.jwtSign({ sub: user.id, sid: 'social', msisdn: key }, config.jwtSecret, config.jwtAccessTtlSec);
  return { ok: true, token };
}

function readingHeartbeat(userId, bookId, seq, seconds) {
  db.prepare('INSERT INTO events (user_id,name,props,ts) VALUES (?,?,?,?)').run(userId, 'read_heartbeat', JSON.stringify({ bookId, seq, seconds }), Date.now());
  return { ok: true };
}

module.exports = {
  spinStatus, spin, claimRedPacket, donate, donors, subscribe, topup,
  charRanking, voteCharacter, rankings, socialLogin, readingHeartbeat,
};
