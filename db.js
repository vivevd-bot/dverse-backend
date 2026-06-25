'use strict';
// DVERSE backend — data layer (node:sqlite, zero external deps).
// Production: swap DatabaseSync for Postgres (pg). Schema is portable 1:1.
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const DB_PATH = process.env.DVERSE_DB || path.join(__dirname, 'dverse.db');
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  phone       TEXT UNIQUE NOT NULL,
  name        TEXT,
  coin_paid   INTEGER NOT NULL DEFAULT 0,   -- coin nạp tiền thật (1 coin = 20đ)
  coin_free   INTEGER NOT NULL DEFAULT 20,  -- coin tặng (tiêu trước)
  pass        TEXT,                          -- NULL | 'plus' | 'vip'
  pass_expires TEXT,
  exp         INTEGER NOT NULL DEFAULT 0,
  level       INTEGER NOT NULL DEFAULT 1,
  m_tickets   INTEGER NOT NULL DEFAULT 3,    -- phiếu tháng
  r_tickets   INTEGER NOT NULL DEFAULT 12,   -- phiếu đề cử
  streak      INTEGER NOT NULL DEFAULT 0,
  checkin_day TEXT DEFAULT '',
  created_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS otp (
  phone      TEXT PRIMARY KEY,
  code       TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS books (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  type       TEXT NOT NULL,        -- text | image | drama
  format     TEXT,
  cp         TEXT,                 -- rights holder: China Literature | Kakao Page ...
  cat        TEXT,
  tags       TEXT,                 -- JSON array
  rating     REAL,
  reads      INTEGER,
  complete   INTEGER,
  descr      TEXT,
  translator TEXT,
  base_votes INTEGER DEFAULT 0,
  donate     INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS chapters (
  book_id    TEXT NOT NULL REFERENCES books(id),
  seq        INTEGER NOT NULL,
  title      TEXT NOT NULL,
  tier       TEXT NOT NULL,        -- FREE | STANDARD | EARLY | PREMIUM
  price_coin INTEGER NOT NULL DEFAULT 0,
  words      INTEGER DEFAULT 0,
  body       TEXT,                 -- content (prod: encrypted blob ref via DRM adapter)
  PRIMARY KEY (book_id, seq)
);
CREATE TABLE IF NOT EXISTS ownership (
  user_id    TEXT NOT NULL REFERENCES users(id),
  book_id    TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  source     TEXT NOT NULL,        -- free | daily_free | paid | pass | bonus
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, book_id, seq)
);
CREATE TABLE IF NOT EXISTS ledger (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL REFERENCES users(id),
  ts         TEXT NOT NULL,
  title      TEXT NOT NULL,
  detail     TEXT,
  kind       TEXT NOT NULL,        -- grant | topup | spend | refund
  amount     INTEGER NOT NULL DEFAULT 0
);
-- METERING: nguồn chia 50% pass-revenue pool pro-rata theo phút đọc
CREATE TABLE IF NOT EXISTS reading_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL,
  book_id    TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  seconds    INTEGER NOT NULL,
  ts         TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS transactions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  provider    TEXT NOT NULL,       -- vnpt | viettel | mobifone | vnpay
  channel     TEXT NOT NULL,       -- telco_billing | direct | bundle | iap
  amount_vnd  INTEGER NOT NULL,
  coins       INTEGER NOT NULL DEFAULT 0,
  kind        TEXT NOT NULL,       -- topup | membership
  status      TEXT NOT NULL,       -- pending | success | failed
  provider_ref TEXT,
  created_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS shelf (
  user_id TEXT NOT NULL, book_id TEXT NOT NULL, PRIMARY KEY(user_id, book_id)
);
CREATE TABLE IF NOT EXISTS progress (
  user_id TEXT NOT NULL, book_id TEXT NOT NULL, seq INTEGER NOT NULL,
  PRIMARY KEY(user_id, book_id)
);
CREATE TABLE IF NOT EXISTS daily_free (
  user_id TEXT NOT NULL, book_id TEXT NOT NULL, day TEXT NOT NULL,
  PRIMARY KEY(user_id, book_id, day)
);
CREATE INDEX IF NOT EXISTS idx_read_user_day ON reading_events(user_id, ts);
CREATE INDEX IF NOT EXISTS idx_read_book ON reading_events(book_id, ts);
CREATE TABLE IF NOT EXISTS donations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL REFERENCES users(id),
  book_id     TEXT NOT NULL,
  amount      INTEGER NOT NULL,
  tier        TEXT NOT NULL,
  message     TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_donations_book ON donations(book_id);
CREATE TABLE IF NOT EXISTS social_accounts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL REFERENCES users(id),
  provider    TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  email       TEXT,
  name        TEXT,
  created_at  TEXT NOT NULL,
  UNIQUE(provider, provider_id)
);
`);

// Migrate: add spin columns to existing DBs (no-op if already present)
['free_spin_used_date TEXT DEFAULT ""', 'free_spin_used_count INTEGER DEFAULT 0'].forEach(col => {
  try { db.exec('ALTER TABLE users ADD COLUMN ' + col); } catch (e) {}
});

module.exports = { db, DB_PATH };
