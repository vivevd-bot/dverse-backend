'use strict';
/**
 * Content + account state khớp contract frontend (/me, /me/library, /wallet/ledger,
 * GET /chapters/{b}/{s}, POST /chapters/{b}/{s}/unlock).
 *
 * Đọc chương = DRM-lite (beta): entitlement-gated + watermark theo user + rate-limit (middleware).
 * Không serve URL tĩnh (sau auth + check quyền). Bản 2-bước token (services/drm.js) là nâng cấp golive.
 */
const { db } = require('../db');
const { config } = require('../lib/config');
const C = require('../lib/crypto');
const wallet = require('./wallet');
const drm = require('./drm');

const _sub = db.prepare("SELECT plan FROM subscriptions WHERE user_id=? AND status IN ('active','grace')");
const _ents = db.prepare('SELECT book_id, seq FROM entitlements WHERE user_id=?');
const _chapter = db.prepare('SELECT * FROM chapters WHERE book_id=? AND seq=?');
const _book = db.prepare('SELECT * FROM books WHERE id=?');
const _insEnt = db.prepare('INSERT OR IGNORE INTO entitlements (user_id,book_id,seq,via,created_at) VALUES (?,?,?,?,?)');
const _hasEnt = db.prepare('SELECT 1 FROM entitlements WHERE user_id=? AND book_id=? AND seq=?');

function me(userId) {
  const b = wallet.balance(userId);
  const sub = _sub.get(userId);
  return { ok: true, coinFree: b.coinFree, coinPaid: b.coinPaid, pass: sub ? sub.plan : null };
}

function library(userId) {
  return { ok: true, owned: _ents.all(userId).map((r) => ({ bookId: r.book_id, seq: r.seq })) };
}

function ledger(userId) {
  const rows = wallet.ledger(userId, 50);
  return {
    ok: true,
    ledger: rows.map((x) => {
      const total = x.delta_free + x.delta_paid;
      return { t: x.label || x.kind, d: (total >= 0 ? '+' : '') + total + ' coin', k: x.kind };
    }),
  };
}

// GET chương — trả {ok, body} kèm watermark; hoặc {ok:false, reason, price}
function readChapter(userId, bookId, seq) {
  seq = Number(seq);
  const book = _book.get(bookId);
  if (!book) return { ok: false, reason: 'no_book' };
  const ent = drm.checkEntitlement(userId, book, seq);
  if (!ent.allowed) return { ok: false, reason: (ent.reason || 'locked').toLowerCase(), price: ent.price, waitReadyAt: ent.waitReadyAt };
  const ch = ent.chapter || _chapter.get(bookId, seq);
  const wm = C.sha256(userId + ':' + config.drmSecret).slice(0, 10);
  return {
    ok: true,
    body: ch.content,
    title: ch.title,
    via: ent.via,
    cobrand: book.cobrand || null,           // co-branding bắt buộc (DA)
    wm,                                        // vân tay forensic (client nhúng watermark)
  };
}

// POST unlock — spend xu, cấp entitlement. {ok, via, spent} | {ok:false, reason:'insufficient'}
function unlock(userId, bookId, seq, idemKey) {
  seq = Number(seq);
  const ch = _chapter.get(bookId, seq);
  if (!ch) return { ok: false, reason: 'no_chapter' };
  if (_hasEnt.get(userId, bookId, seq)) return { ok: true, via: 'paid', spent: 0, already: true };
  if (ch.tier === 'free' || ch.price_coin === 0) {
    _insEnt.run(userId, bookId, seq, 'free', Date.now());
    return { ok: true, via: 'free', spent: 0 };
  }
  const sp = wallet.spend(userId, ch.price_coin, { kind: 'unlock', label: 'Mở khoá ' + bookId + ' · Ch.' + seq, ref: bookId + ':' + seq, idemKey });
  if (!sp.ok) return { ok: false, reason: sp.code === 'INSUFFICIENT' ? 'insufficient' : 'spend_fail' };
  _insEnt.run(userId, bookId, seq, 'paid', Date.now());
  return { ok: true, via: 'paid', spent: ch.price_coin, balance: sp.balance };
}

module.exports = { me, library, ledger, readChapter, unlock };
