-- v002: spin state, redpacket claims, donations

CREATE TABLE IF NOT EXISTS spin_state (
  user_id     TEXT PRIMARY KEY REFERENCES users(id),
  day         TEXT NOT NULL,
  used_free   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS redpacket_claims (
  user_id     TEXT NOT NULL REFERENCES users(id),
  packet_id   TEXT NOT NULL,
  amount      INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, packet_id)
);

CREATE TABLE IF NOT EXISTS donations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL REFERENCES users(id),
  book_id     TEXT NOT NULL,
  amount      INTEGER NOT NULL,
  message     TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_don_book ON donations(book_id, amount DESC);

-- gói nạp (telco/test direct) + lì xì cấu hình
CREATE TABLE IF NOT EXISTS packets (
  id          TEXT PRIMARY KEY,
  amount      INTEGER NOT NULL,
  total       INTEGER NOT NULL DEFAULT 9999
);
