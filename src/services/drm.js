'use strict';
/**
 * DRM / Anti-piracy — MOAT.
 * Luồng 2 bước (không bao giờ serve nội dung trực tiếp):
 *   1) POST /chapter/access  -> kiểm entitlement (free-tier | paid unlock | sub) ->
 *      cấp token KÝ, TTL ngắn (config.drmTokenTtlSec), nonce dùng-1-lần (bảng chapter_access).
 *   2) GET  /chapter/content -> verify token (sig+exp+nonce-chưa-dùng), đánh dấu used,
 *      rate-limit/scrape-guard, trả nội dung CÓ DẤU VÂN TAY (watermark) theo user -> truy được kẻ leak.
 *
 * Chống lậu thực tế đạt được:
 *  - Không có URL tĩnh tới nội dung; mỗi lần đọc = 1 token sống ~90s, dùng 1 lần.
 *  - Rate-limit + phát hiện đọc tuần tự nhanh (enumerate) -> chặn bot scrape hàng loạt.
 *  - Watermark forensic nhúng uid -> bản leak truy ngược tài khoản -> răn đe + takedown.
 *  Giới hạn: không chống được người dùng hợp lệ copy-paste thủ công từng chương
 *  (không hệ nào chống tuyệt đối) — nhưng nâng chi phí scrape hàng loạt lên rất cao.
 */
const { db } = require('../db');
const { config } = require('../lib/config');
const C = require('../lib/crypto');
const { logger } = require('../lib/logger');

const _book = db.prepare('SELECT * FROM books WHERE id=?');
const _chapter = db.prepare('SELECT * FROM chapters WHERE book_id=? AND seq=?');
const _ent = db.prepare('SELECT 1 FROM entitlements WHERE user_id=? AND book_id=? AND seq=?');
const _insEnt = db.prepare('INSERT OR IGNORE INTO entitlements (user_id,book_id,seq,via,created_at) VALUES (?,?,?,?,?)');
const _wait = db.prepare('SELECT next_at FROM wait_unlocks WHERE user_id=? AND book_id=?');
const _waitSet = db.prepare('INSERT INTO wait_unlocks (user_id,book_id,next_at) VALUES (?,?,?) ON CONFLICT(user_id,book_id) DO UPDATE SET next_at=excluded.next_at');
const _sub = db.prepare("SELECT status FROM subscriptions WHERE user_id=? AND status IN ('active','grace')");

const _accPut = db.prepare('INSERT INTO chapter_access (jti,user_id,book_id,seq,issued_at,expires_at,ip) VALUES (?,?,?,?,?,?,?)');
const _accGet = db.prepare('SELECT * FROM chapter_access WHERE jti=?');
const _accUse = db.prepare('UPDATE chapter_access SET used_at=? WHERE jti=? AND used_at IS NULL');

function now() { return Date.now(); }
function licenseOk(book) {
  if (!book) return false;
  const t = Math.floor(now() / 1000);
  if (book.territory && book.territory !== 'VN') return false;
  if (book.license_start && t < Math.floor(book.license_start)) return false;
  if (book.license_end && t > Math.floor(book.license_end)) return false;
  return true;
}

/**
 * Kiểm quyền đọc 1 chương. Trả {allowed, via} hoặc {allowed:false, reason, price}.
 * Quy tắc free-tier "đọc free khi chờ":
 *  - seq <= freeChapters: free luôn.
 *  - tier=free: free.
 *  - đã paid-unlock / có sub active: cho.
 *  - còn lại: cần mở khoá (paid) HOẶC chờ (wait) tới wait_unlocks.next_at.
 */
function checkEntitlement(userId, book, seq) {
  if (!licenseOk(book)) return { allowed: false, reason: 'LICENSE' };
  const ch = _chapter.get(book.id, seq);
  if (!ch) return { allowed: false, reason: 'NO_CHAPTER' };
  if (ch.published_at && ch.published_at > now()) return { allowed: false, reason: 'NOT_PUBLISHED' };

  if (seq <= config.freeTier.freeChapters || ch.tier === 'free' || ch.price_coin === 0) {
    return { allowed: true, via: 'free', chapter: ch };
  }
  if (_ent.get(userId, book.id, seq)) return { allowed: true, via: 'paid', chapter: ch };
  if (_sub.get(userId)) return { allowed: true, via: 'subscription', chapter: ch };

  const w = _wait.get(userId, book.id);
  if (w && w.next_at <= now()) {
    // tới lượt "đọc free khi chờ" -> cấp entitlement wait + đặt mốc chờ kế
    _insEnt.run(userId, book.id, seq, 'wait', now());
    _waitSet.run(userId, book.id, now() + config.freeTier.waitUnlockHours * 3600 * 1000);
    return { allowed: true, via: 'wait', chapter: ch };
  }
  return {
    allowed: false, reason: 'LOCKED', price: ch.price_coin,
    waitReadyAt: w ? w.next_at : (now() + config.freeTier.waitUnlockHours * 3600 * 1000),
  };
}

// Cấp token đọc (sau khi entitlement OK)
function issueAccess(userId, bookId, seq, ip) {
  const jti = C.nonce(16);
  const exp = now() + config.drmTokenTtlSec * 1000;
  _accPut.run(jti, userId, bookId, seq, now(), exp, ip || null);
  const token = C.jwtSign({ jti, sub: userId, book: bookId, seq }, config.drmSecret, config.drmTokenTtlSec);
  return { token, expiresIn: config.drmTokenTtlSec };
}

// Watermark forensic: nhúng vân tay user vào payload trả về.
function watermark(userId) {
  const fp = C.sha256(userId + ':' + config.drmSecret).slice(0, 12);
  return { uidFp: fp, stamp: now() };
}

// Verify token + trả nội dung (đã đánh dấu used). Anti-scrape do middleware rate-limit lo.
function consumeAccess(token, ctx) {
  const claims = C.jwtVerify(token, config.drmSecret);
  if (!claims || !claims.jti) return { ok: false, code: 'BAD_TOKEN' };
  const acc = _accGet.get(claims.jti);
  if (!acc) return { ok: false, code: 'NO_TOKEN' };
  if (acc.used_at) return { ok: false, code: 'TOKEN_USED' };
  if (acc.expires_at < now()) return { ok: false, code: 'EXPIRED' };
  if (acc.user_id !== claims.sub) return { ok: false, code: 'MISMATCH' };
  const marked = _accUse.run(now(), claims.jti);
  if (marked.changes !== 1) return { ok: false, code: 'RACE_USED' };

  const book = _book.get(acc.book_id);
  const ch = _chapter.get(acc.book_id, acc.seq);
  if (!ch) return { ok: false, code: 'NO_CHAPTER' };

  return {
    ok: true,
    book: acc.book_id,
    seq: acc.seq,
    title: ch.title,
    cobrand: book ? book.cobrand : null,      // co-branding bắt buộc (DA) -> client phải render
    rightsDerivative: book ? !!book.rights_derivative : false,
    content: ch.content,
    wm: watermark(acc.user_id),                // vân tay forensic
  };
}

module.exports = { checkEntitlement, issueAccess, consumeAccess, licenseOk };
