'use strict';
/**
 * Routes — KHỚP CHÍNH XÁC contract frontend (object DV trong dverse-deploy-fixed.html).
 * Mount ở ROOT (frontend gọi BASE + "/auth/..."; BASE = window.DVERSE_API, KHÔNG có /api).
 * Mọi endpoint đụng xu đều server-authoritative + rate-limit.
 */
const express = require('express');
const { db } = require('../db');
const { config } = require('../lib/config');
const { auth, rateLimit } = require('../middleware');
const { migrate: migrateWff, claimWff } = require('../wff');
migrateWff(db);
const _wffDeps = {
  getChapterTier: (bookId, seq) => {
    const row = db.prepare('SELECT tier FROM chapters WHERE book_id=? AND seq=?').get(bookId, seq);
    if (!row) return null;
    return row.tier === 'paid' ? 'STANDARD' : 'FREE';
  },
  grantOwnership: (userId, bookId, seq) => db.prepare(
    "INSERT OR IGNORE INTO entitlements (user_id, book_id, seq, via, created_at) VALUES (?,?,?,'wait',unixepoch())")
    .run(userId, bookId, seq),
};
const authSvc = require('../services/auth');
const wallet = require('../services/wallet');
const gacha = require('../services/gacha');
const { migrate: migrateGacha, pullGacha } = require('../gacha');
migrateGacha(db);
db.exec('CREATE TABLE IF NOT EXISTS gacha_essence (user_id TEXT PRIMARY KEY, bal INTEGER NOT NULL DEFAULT 0)');
const _gachaDeps = {
  getBalance: (u) => { const r = db.prepare('SELECT coin_free+coin_paid AS coin FROM wallet WHERE user_id=?').get(u); return r ? r.coin : 0; },
  spend: (u, amt) => { const { spend: wSpend } = require('../services/wallet'); return wSpend(u, amt, { kind: 'gacha', label: 'Triệu hồi' }).ok; },
  addEssence: (u, amt) => db.prepare('INSERT INTO gacha_essence (user_id,bal) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET bal=bal+?').run(u, amt, amt),
};
const payment = require('../services/payment');
const content = require('../services/content');
const extras = require('../services/extras');
const { CHARS } = require('../lib/catalog');

const r = express.Router();
const rl = config.rateLimit;
const idemKey = (req) => req.headers['idempotency-key'] || null;
const EMOJI_BY_NAME = {}; CHARS.forEach((c) => { EMOJI_BY_NAME[c.name] = c.emoji; });
const PACK_VND = { p20: 20000, p50: 50000, p100: 100000, p200: 200000, p500: 500000 };

function mapCards(cards) {
  return (cards || []).map((c, i) => ({ id: Date.now() + '_' + i, emoji: EMOJI_BY_NAME[c.charId] || '\u2694\uFE0F', name: c.charId, rarity: c.rarity }));
}

// ---------- Health ----------
r.get('/health', (req, res) => {
  let dbok = false; try { db.prepare('SELECT 1').get(); dbok = true; } catch (e) { /* */ }
  res.json({ ok: dbok, ts: Date.now(), env: config.nodeEnv, vnpay: config.vnp.enabled });
});

// ---------- Auth (phone -> token) ----------
r.post('/auth/otp/request', rateLimit('auth', rl.authMax), async (req, res) => {
  const out = await authSvc.requestOtp((req.body || {}).phone);
  res.status(out.ok ? 200 : 400).json(out);
});
r.post('/auth/otp/verify', rateLimit('auth', rl.authMax), async (req, res) => {
  const b = req.body || {};
  const out = await authSvc.verifyOtp(b.phone, b.code, { ip: req.ip, device: req.headers['user-agent'] });
  if (!out.ok) return res.status(401).json(out);
  res.json({ ok: true, token: out.tokens.accessToken, refreshToken: out.tokens.refreshToken, created: out.created });
});
r.post('/auth/social/:provider', rateLimit('auth', rl.authMax), (req, res) => {
  res.json(extras.socialLogin(req.params.provider, req.body || {}));
});

// ---------- Account ----------
r.get('/me', auth, (req, res) => res.json(content.me(req.user.id)));
r.get('/me/library', auth, (req, res) => res.json(content.library(req.user.id)));
r.get('/wallet/ledger', auth, (req, res) => res.json(content.ledger(req.user.id)));
r.post('/wallet/topup', auth, rateLimit('spend', rl.spendMax), (req, res) => {
  const b = req.body || {};
  res.json(extras.topup(req.user.id, b.packageId, b.provider));
});

// ---------- Chapters (DRM-lite: gated + watermark + rate-limit) ----------
r.get('/chapters/:book/:seq', auth, rateLimit('chapter', rl.chapterMax), (req, res) => {
  const out = content.readChapter(req.user.id, req.params.book, req.params.seq);
  res.status(out.ok ? 200 : 403).json(out);
});
r.post('/chapters/:book/:seq/unlock', auth, rateLimit('spend', rl.spendMax), (req, res) => {
  const out = content.unlock(req.user.id, req.params.book, req.params.seq, idemKey(req));
  res.status(out.ok ? 200 : (out.reason === 'insufficient' ? 402 : 400)).json(out);
});

// ---------- Gacha ----------
r.post('/gacha/pull', auth, rateLimit('spend', rl.spendMax), (req, res) => {
  const b = req.body || {};
  const out = pullGacha(db, _gachaDeps, req.user.id, b.poolId, Number(b.count));
  res.status(out.status).json(out.body);
});
r.get('/gacha/pools', auth, (req, res) => res.json({ ok: true, pools: gacha.poolView(req.user.id) }));
r.get('/gacha/inventory', auth, (req, res) => {
  const rows = db.prepare('SELECT pool_id,rarity,char_id,created_at FROM gacha_results WHERE user_id=? ORDER BY id DESC LIMIT 200').all(req.user.id);
  res.json({ ok: true, cards: rows.map((x) => ({ pool: x.pool_id, rarity: x.rarity, name: x.char_id, emoji: EMOJI_BY_NAME[x.char_id] || '\u2694\uFE0F' })) });
});
r.post('/gacha/free', auth, rateLimit('spend', rl.spendMax), (req, res) => {
  const out = gacha.freePull(req.user.id, (req.body || {}).poolId);
  res.status(out.ok ? 200 : (out.code === 'COOLDOWN' ? 429 : 400)).json(out);
});

// ---------- Character ranking ----------
r.get('/ranking/characters', auth, (req, res) => res.json(extras.charRanking()));
r.post('/ranking/characters/vote', auth, rateLimit('spend', rl.spendMax), (req, res) => {
  const out = extras.voteCharacter(req.user.id, (req.body || {}).name);
  res.status(out.ok ? 200 : 409).json(out);
});

// ---------- Spin ----------
r.get('/spin/status', auth, (req, res) => res.json(extras.spinStatus(req.user.id)));
r.post('/spin', auth, rateLimit('spend', rl.spendMax), (req, res) => {
  const out = extras.spin(req.user.id, !!(req.body || {}).combo);
  res.status(out.ok ? 200 : (out.reason === 'insufficient' ? 402 : 400)).json(out);
});

// ---------- Red packet (lì xì) ----------
r.get('/redpacket/open', auth, (req, res) => res.json({ ok: true, packets: [{ id: 'p1', amount: 8888 }, { id: 'p2', amount: 6666 }, { id: 'p3', amount: 5555 }] }));
r.post('/redpacket/:id/claim', auth, rateLimit('spend', rl.spendMax), (req, res) => {
  const out = extras.claimRedPacket(req.user.id, req.params.id);
  res.status(out.ok ? 200 : 409).json(out);
});

// ---------- Donate ----------
r.post('/books/:id/donate', auth, rateLimit('spend', rl.spendMax), (req, res) => {
  const b = req.body || {};
  const out = extras.donate(req.user.id, req.params.id, Number(b.amount), b.message);
  res.status(out.ok ? 200 : (out.reason === 'insufficient' ? 402 : 400)).json(out);
});
r.get('/books/:id/donors', auth, (req, res) => res.json(extras.donors(req.params.id)));

// ---------- Membership / heartbeat / rankings ----------
r.post('/membership/subscribe', auth, rateLimit('spend', rl.spendMax), (req, res) => {
  const b = req.body || {};
  res.json(extras.subscribe(req.user.id, b.plan, b.channel));
});
r.post('/reading/heartbeat', auth, (req, res) => {
  const b = req.body || {};
  res.json(extras.readingHeartbeat(req.user.id, b.bookId, b.seq, b.seconds));
});
r.get('/rankings', auth, (req, res) => res.json(extras.rankings(req.query.type)));

// ---------- Payment ----------
r.post('/payment/vnpay/create', auth, rateLimit('spend', rl.spendMax), (req, res) => {
  if (!config.vnp.enabled) return res.json({ ok: false, reason: 'vnpay_not_configured' });
  const b = req.body || {};
  const amountVnd = PACK_VND[String(b.packageId)] || Number(b.packageId);
  const out = payment.createPayment(req.user.id, amountVnd, req.ip);
  res.json(out.ok ? { ok: true, payUrl: out.payUrl } : { ok: false, reason: 'vnpay_not_configured' });
});
r.get('/payment/vnpay/ipn', (req, res) => res.json(payment.handleIpn(req.query)));
r.post('/payment/vnpay/ipn', (req, res) => res.json(payment.handleIpn(Object.assign({}, req.query, req.body))));

// ---------- WFF (Wait-For-Free) ----------
r.post('/wff/claim', auth, rateLimit('spend', rl.spendMax), (req, res) => {
  const b = req.body || {};
  const out = claimWff(db, _wffDeps, req.user.id, b.bid, Number(b.seq));
  res.status(out.status).json(out.body);
});

// ---------- Analytics ----------
const _evIns = db.prepare('INSERT INTO events (user_id,anon_id,name,props,ts) VALUES (?,?,?,?,?)');
r.post('/events', rateLimit('default', rl.defaultMax), (req, res) => {
  const evs = Array.isArray((req.body || {}).events) ? req.body.events : [];
  const tx = db.transaction(() => { for (const e of evs.slice(0, 50)) _evIns.run((req.body || {}).userId || null, (req.body || {}).anonId || null, String(e.name || 'x').slice(0, 64), JSON.stringify(e.props || {}).slice(0, 2000), e.ts || Date.now()); });
  tx();
  res.json({ ok: true, n: Math.min(evs.length, 50) });
});

module.exports = r;
