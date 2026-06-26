-- DVERSE backend core — schema v001 (beta critical-path)
-- Tất cả tiền tệ là số nguyên "xu". Ledger là nguồn sự thật; wallet là số dư vật chất hoá.

PRAGMA foreign_keys = ON;

-- ---- Identity ----
CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  msisdn      TEXT UNIQUE NOT NULL,          -- E.164, vd +8490...
  telco       TEXT,                          -- vnpt|viettel|mobifone
  status      TEXT NOT NULL DEFAULT 'active',-- active|blocked
  created_at  INTEGER NOT NULL,
  last_login  INTEGER
);

CREATE TABLE IF NOT EXISTS otp (
  msisdn      TEXT PRIMARY KEY,
  code_hash   TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,            -- session id (jti của refresh)
  user_id       TEXT NOT NULL REFERENCES users(id),
  refresh_hash  TEXT NOT NULL,              -- sha256 của refresh token (không lưu thô)
  device        TEXT,
  ip            TEXT,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  revoked       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- ---- Wallet / Ledger ----
CREATE TABLE IF NOT EXISTS wallet (
  user_id     TEXT PRIMARY KEY REFERENCES users(id),
  coin_free   INTEGER NOT NULL DEFAULT 0,    -- xu tặng (ưu tiên tiêu trước)
  coin_paid   INTEGER NOT NULL DEFAULT 0,    -- xu đã trả tiền
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ledger (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL REFERENCES users(id),
  delta_free  INTEGER NOT NULL DEFAULT 0,
  delta_paid  INTEGER NOT NULL DEFAULT 0,
  kind        TEXT NOT NULL,                 -- grant|spend|topup|refund|gacha|unlock|autosub|free
  label       TEXT,
  ref         TEXT,                          -- book:ch / pool / txn ref...
  idem_key    TEXT,                          -- idempotency key (nếu có)
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_user ON ledger(user_id, id DESC);

-- ---- Idempotency (mọi mutation có thể lặp: spend, gacha, topup credit) ----
CREATE TABLE IF NOT EXISTS idempotency (
  key         TEXT PRIMARY KEY,
  user_id     TEXT,
  scope       TEXT NOT NULL,                 -- spend|gacha|payment
  response    TEXT NOT NULL,                 -- JSON kết quả đã trả
  created_at  INTEGER NOT NULL
);

-- ---- Catalog / Chapters (DRM-served) ----
CREATE TABLE IF NOT EXISTS books (
  id                TEXT PRIMARY KEY,
  title             TEXT NOT NULL,
  provider          TEXT,                    -- DVERSE Studio | China Literature | Kakao ...
  rights_derivative INTEGER NOT NULL DEFAULT 0, -- quyền phái sinh (gacha/merch) per DA
  cobrand           TEXT,                    -- nhãn co-branding bắt buộc (DA), null nếu không
  license_start     INTEGER,                 -- epoch ngày publish (DA: tính từ publish)
  license_end       INTEGER,
  territory         TEXT NOT NULL DEFAULT 'VN',
  created_at        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chapters (
  book_id     TEXT NOT NULL REFERENCES books(id),
  seq         INTEGER NOT NULL,
  title       TEXT,
  content     TEXT NOT NULL,                 -- nội dung (serve QUA DRM, không expose trực tiếp)
  tier        TEXT NOT NULL DEFAULT 'free',  -- free|paid
  price_coin  INTEGER NOT NULL DEFAULT 0,
  published_at INTEGER,                      -- lịch phát hành (null = chưa phát)
  PRIMARY KEY (book_id, seq)
);

-- entitlement: user đã mở khoá chương nào (paid unlock)
CREATE TABLE IF NOT EXISTS entitlements (
  user_id     TEXT NOT NULL REFERENCES users(id),
  book_id     TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  via         TEXT NOT NULL,                 -- paid|free|wait|subscription
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, book_id, seq)
);

-- "đọc free khi chờ": mốc mở khoá theo thời gian chờ
CREATE TABLE IF NOT EXISTS wait_unlocks (
  user_id     TEXT NOT NULL REFERENCES users(id),
  book_id     TEXT NOT NULL,
  next_at     INTEGER NOT NULL,              -- epoch được mở chương "chờ" kế
  PRIMARY KEY (user_id, book_id)
);

-- DRM: token đọc chương dùng-1-lần
CREATE TABLE IF NOT EXISTS chapter_access (
  jti         TEXT PRIMARY KEY,             -- nonce token
  user_id     TEXT NOT NULL,
  book_id     TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  issued_at   INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER,
  ip          TEXT
);
CREATE INDEX IF NOT EXISTS idx_caccess_user ON chapter_access(user_id, issued_at DESC);

-- ---- Subscription bundle ----
CREATE TABLE IF NOT EXISTS subscriptions (
  user_id     TEXT PRIMARY KEY REFERENCES users(id),
  plan        TEXT NOT NULL,                 -- plus | ...
  status      TEXT NOT NULL,                 -- active|grace|cancelled|expired
  channel     TEXT,                          -- vnpt|viettel|mobifone|vnpay
  started_at  INTEGER NOT NULL,
  renews_at   INTEGER,
  cancelled_at INTEGER
);

-- ---- Gacha (server-authoritative) ----
CREATE TABLE IF NOT EXISTS pools (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  rights      INTEGER NOT NULL DEFAULT 0,    -- quyền kích hoạt (DA) — server enforce
  rates_json  TEXT NOT NULL,                 -- [["SSR",0.03],["SR",0.20],...]
  cost1       INTEGER NOT NULL,
  cost10      INTEGER NOT NULL,
  pity_hard   INTEGER NOT NULL DEFAULT 90
);

CREATE TABLE IF NOT EXISTS gacha_state (
  user_id     TEXT NOT NULL REFERENCES users(id),
  pool_id     TEXT NOT NULL,
  pity        INTEGER NOT NULL DEFAULT 0,
  last_free_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, pool_id)
);

CREATE TABLE IF NOT EXISTS gacha_results (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL REFERENCES users(id),
  pool_id     TEXT NOT NULL,
  rarity      TEXT NOT NULL,
  char_id     TEXT,
  cost        INTEGER NOT NULL,
  idem_key    TEXT,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS character_votes (
  user_id     TEXT NOT NULL REFERENCES users(id),
  char_id     TEXT NOT NULL,
  day         TEXT NOT NULL,                 -- YYYY-MM-DD (1 vote/char/ngày)
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, char_id, day)
);

-- ---- Payments ----
CREATE TABLE IF NOT EXISTS payments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT REFERENCES users(id),
  provider    TEXT NOT NULL,                 -- vnpay|dcb_vnpt|...
  txn_ref     TEXT NOT NULL,                 -- mã giao dịch (idempotency)
  amount_vnd  INTEGER NOT NULL,
  coin        INTEGER NOT NULL,
  status      TEXT NOT NULL,                 -- pending|success|failed|refunded
  raw         TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  UNIQUE (provider, txn_ref)
);

-- ---- Analytics events (funnel lậu->trả-tiền) ----
CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT,
  anon_id     TEXT,
  name        TEXT NOT NULL,                 -- install|read_free|paywall_view|unlock|first_pay|subscribe|gacha_pull...
  props       TEXT,
  ts          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_name ON events(name, ts);

-- ---- Audit log ----
CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  actor       TEXT,
  action      TEXT NOT NULL,
  target      TEXT,
  meta        TEXT,
  ts          INTEGER NOT NULL
);

-- ---- Rate limit (sliding window theo bucket) ----
CREATE TABLE IF NOT EXISTS rate_buckets (
  k           TEXT PRIMARY KEY,             -- scope:identity:windowStart
  count       INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
