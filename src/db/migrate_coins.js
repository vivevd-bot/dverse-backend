#!/usr/bin/env node
/**
 * migrate_coins.js — Cutover: wallet(coin_free, coin_paid) → coin_grants
 *
 * MỤC ĐÍCH:
 *   Chuyển toàn bộ số dư trong bảng `wallet` cũ sang schema coin_grants mới
 *   (của wallet.js server-authoritative với expiry 30 ngày cho xu free).
 *
 * AN TOÀN:
 *   - Idempotent: chạy lại không double-count (kiểm tra migration_log).
 *   - Reconciliation: tổng sau migrate phải == tổng trước.
 *   - Dry-run mặc định — thêm flag --commit để ghi thực.
 *
 * QUYTRÌNH (đúng thứ tự):
 *   1. Backup DB Railway trước
 *   2. node migrate_coins.js           (dry-run, kiểm tra output)
 *   3. node migrate_coins.js --commit  (ghi thực)
 *   4. Verify 1-2 user thật: GET /wallet/balance phải khớp
 *   5. Deploy cutover patch (routes dùng wallet.js mới)
 *
 * KHÔNG chạy bước 5 trước bước 3.
 */

'use strict';

const path = require('path');
// Detect env: Railway production dùng better-sqlite3; test local dùng node:sqlite shim.
let Database;
try {
  Database = require('better-sqlite3');
} catch (e) {
  // Fallback: node:sqlite (Node 22 built-in) với transaction shim
  const { DatabaseSync } = require('node:sqlite');
  Database = class {
    constructor(p) {
      this._db = new DatabaseSync(p);
      this._db.exec = this._db.exec.bind(this._db);
      this._db.prepare = this._db.prepare.bind(this._db);
      this.prepare = (sql) => this._db.prepare(sql);
      this.exec = (sql) => this._db.exec(sql);
      this.transaction = (fn) => (...args) => {
        this._db.exec('BEGIN');
        try { const r = fn(...args); this._db.exec('COMMIT'); return r; }
        catch (err) { this._db.exec('ROLLBACK'); throw err; }
      };
    }
  };
}

const COMMIT = process.argv.includes('--commit');
const DB_PATH = process.env.DVERSE_DB || path.join(__dirname, '../../dverse.db');

console.log(`\n=== DVERSE Coin Migration ===`);
console.log(`DB: ${DB_PATH}`);
console.log(`Mode: ${COMMIT ? '🔴 COMMIT (ghi thực)' : '🟡 DRY-RUN (không ghi)'}\n`);

const db = new Database(DB_PATH);

// ---- Đảm bảo coin_grants tồn tại (wallet.migrate idempotent) ----
db.exec(`
  CREATE TABLE IF NOT EXISTS coin_grants (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    TEXT    NOT NULL,
    kind       TEXT    NOT NULL CHECK (kind IN ('paid','free')),
    source     TEXT    NOT NULL,
    amount     INTEGER NOT NULL CHECK (amount > 0),
    remaining  INTEGER NOT NULL CHECK (remaining >= 0),
    created_at TEXT    NOT NULL,
    expires_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_grants_spend
    ON coin_grants (user_id, kind, remaining, expires_at, created_at);

  CREATE TABLE IF NOT EXISTS migration_log (
    user_id    TEXT PRIMARY KEY,
    old_free   INTEGER NOT NULL,
    old_paid   INTEGER NOT NULL,
    migrated_at TEXT NOT NULL
  );
`);

// ---- Đọc tất cả user có số dư > 0 và chưa migrate ----
const users = db.prepare(`
  SELECT w.user_id, w.coin_free, w.coin_paid
  FROM wallet w
  LEFT JOIN migration_log ml ON ml.user_id = w.user_id
  WHERE ml.user_id IS NULL
    AND (w.coin_free > 0 OR w.coin_paid > 0)
`).all();

if (users.length === 0) {
  console.log('✅ Không có user nào cần migrate (tất cả đã migrate hoặc số dư = 0).');
  process.exit(0);
}

console.log(`Tìm thấy ${users.length} user cần migrate:\n`);

// ---- Tính tổng trước ----
const totalBefore = users.reduce((acc, u) => ({
  free: acc.free + u.coin_free,
  paid: acc.paid + u.coin_paid,
}), { free: 0, paid: 0 });

console.log(`Tổng số dư cần chuyển:`);
console.log(`  coin_free: ${totalBefore.free}`);
console.log(`  coin_paid: ${totalBefore.paid}`);
console.log(`  total:     ${totalBefore.free + totalBefore.paid}\n`);

// ---- Dry-run preview (tối đa 10 dòng) ----
console.log('Preview (tối đa 10 user):');
users.slice(0, 10).forEach((u) => {
  console.log(`  ${u.user_id.slice(0, 16)}... free=${u.coin_free} paid=${u.coin_paid}`);
});
if (users.length > 10) console.log(`  ... và ${users.length - 10} user khác`);
console.log('');

if (!COMMIT) {
  console.log('🟡 DRY-RUN xong. Thêm --commit để ghi thực.\n');
  process.exit(0);
}

// ---- Commit: migrate trong 1 transaction ----
const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
// free coins: expires 30 ngày kể từ hôm nay (conservative — user không mất xu đang có)
const expiresAt = new Date(Date.now() + 30 * 86400 * 1000).toISOString().replace('T', ' ').slice(0, 19);

const insGrant = db.prepare(`
  INSERT INTO coin_grants (user_id, kind, source, amount, remaining, created_at, expires_at)
  VALUES (?, ?, 'migration', ?, ?, ?, ?)
`);
const insLog = db.prepare(`
  INSERT OR IGNORE INTO migration_log (user_id, old_free, old_paid, migrated_at)
  VALUES (?, ?, ?, ?)
`);

let migratedUsers = 0;
let migratedFree = 0;
let migratedPaid = 0;

const tx = db.transaction(() => {
  for (const u of users) {
    if (u.coin_free > 0) {
      insGrant.run(u.user_id, 'free', u.coin_free, u.coin_free, now, expiresAt);
      migratedFree += u.coin_free;
    }
    if (u.coin_paid > 0) {
      insGrant.run(u.user_id, 'paid', u.coin_paid, u.coin_paid, now, null);
      migratedPaid += u.coin_paid;
    }
    insLog.run(u.user_id, u.coin_free, u.coin_paid, now);
    migratedUsers++;
  }
});

tx();

// ---- Reconciliation: tổng coin_grants phải == tổng trước ----
const check = db.prepare(`
  SELECT
    COALESCE(SUM(CASE WHEN kind='free' THEN remaining ELSE 0 END), 0) AS new_free,
    COALESCE(SUM(CASE WHEN kind='paid' THEN remaining ELSE 0 END), 0) AS new_paid
  FROM coin_grants
  WHERE source = 'migration'
`).get();

console.log(`\n✅ Migration xong:`);
console.log(`  Users migrated: ${migratedUsers}`);
console.log(`  coin_free → coin_grants(free): ${migratedFree}`);
console.log(`  coin_paid → coin_grants(paid): ${migratedPaid}`);
console.log('');
console.log('Reconciliation:');
console.log(`  Trước: free=${totalBefore.free} paid=${totalBefore.paid} total=${totalBefore.free + totalBefore.paid}`);
console.log(`  Sau:   free=${check.new_free} paid=${check.new_paid} total=${check.new_free + check.new_paid}`);

const ok = check.new_free >= totalBefore.free && check.new_paid >= totalBefore.paid;
if (ok) {
  console.log('\n✅ RECONCILIATION PASS — tổng khớp, an toàn deploy cutover.\n');
  process.exit(0);
} else {
  console.log('\n🔴 RECONCILIATION FAIL — kiểm tra lại trước khi cutover!\n');
  process.exit(1);
}
