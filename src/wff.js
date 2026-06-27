// wff.js — Wait-for-Free claim, SERVER-AUTHORITATIVE
// Stack: Node 22 + better-sqlite3 (Railway). Drop into the DVERSE backend.
//
// Why: the frontend must never decide WFF eligibility. Clearing localStorage,
// replaying requests, or forging EARLY/PREMIUM tiers must NOT yield free reads.
// The server enforces: (1) chapter tier === STANDARD, (2) max 1 free chapter
// per (user, book, day). The UNIQUE constraint makes the daily limit atomic
// and race-safe (last-write-wins is impossible; the 2nd insert throws).
//
// Timezone: "day" is computed in ICT (UTC+7) so the reset matches VN reading
// behavior (evening peak). Adjust TZ_OFFSET_MIN if infra runs another TZ.

const TZ_OFFSET_MIN = 7 * 60; // UTC+7
const WFF_MAX_BOOKS = 2;       // max distinct books per user per day

function todayICT() {
  const now = new Date(Date.now() + TZ_OFFSET_MIN * 60 * 1000);
  return now.toISOString().slice(0, 10); // YYYY-MM-DD
}

// ---- Migration: run once on boot ----
function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS wff_claims (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    TEXT NOT NULL,
      book_id    TEXT NOT NULL,
      day        TEXT NOT NULL,
      chapter_seq INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (user_id, book_id, day)
    );
    CREATE INDEX IF NOT EXISTS idx_wff_user_day ON wff_claims (user_id, day);
  `);
}

// ---- Core (pure-ish, unit-testable) ----
// deps.getChapterTier(bookId, seq) -> "FREE" | "STANDARD" | "EARLY" | "PREMIUM"
// deps.grantOwnership(userId, bookId, seq) -> records the free unlock in the
//   SAME table the paid unlock flow uses, so the reader treats it as owned.
function claimWff(db, deps, userId, bookId, seq) {
  if (!userId) return { status: 401, body: { granted: false, message: "Cần đăng nhập" } };
  if (!bookId || !Number.isInteger(seq)) return { status: 400, body: { granted: false, message: "Tham số không hợp lệ" } };

  const tier = deps.getChapterTier(bookId, seq);
  if (tier !== "STANDARD") {
    return { status: 200, body: { granted: false, message: "Chương này không áp dụng đọc free khi chờ" } };
  }

  const day = todayICT();

  // Global cap: max WFF_MAX_BOOKS distinct books per user per day
  const usedToday = db.prepare(
    "SELECT COUNT(*) n FROM wff_claims WHERE user_id=? AND day=?"
  ).get(userId, day).n;
  const thisBookAlready = db.prepare(
    "SELECT 1 FROM wff_claims WHERE user_id=? AND book_id=? AND day=?"
  ).get(userId, bookId, day);
  if (usedToday >= WFF_MAX_BOOKS && !thisBookAlready) {
    return { status: 200, body: { granted: false, message: "Hết lượt đọc free hôm nay · tối đa 2 truyện/ngày" } };
  }

  const insert = db.prepare(
    "INSERT INTO wff_claims (user_id, book_id, day, chapter_seq) VALUES (?, ?, ?, ?)"
  );
  try {
    insert.run(userId, bookId, day, seq);
  } catch (e) {
    // UNIQUE(user_id, book_id, day) violated -> already used today's free read
    if (String(e.message || e).includes("UNIQUE")) {
      return { status: 200, body: { granted: false, message: "Hôm nay đã dùng lượt đọc free cho truyện này" } };
    }
    throw e;
  }
  // Record ownership so the chapter opens as unlocked (no coin charged)
  deps.grantOwnership(userId, bookId, seq);
  return { status: 200, body: { granted: true, day, seq } };
}

// ---- Express route: POST /wff/claim  { bid, seq } ----
// Assumes auth middleware sets req.userId (same as other authed routes).
function createWffRoute(db, deps) {
  return function (req, res) {
    try {
      const { bid, seq } = req.body || {};
      const out = claimWff(db, deps, req.userId, bid, Number(seq));
      res.status(out.status).json(out.body);
    } catch (e) {
      console.error("[wff/claim]", e);
      res.status(500).json({ granted: false, message: "Lỗi máy chủ" });
    }
  };
}

module.exports = { migrate, claimWff, createWffRoute, todayICT };

/* ---- Wiring (in your server bootstrap) ----
const { migrate, createWffRoute } = require("./wff");
migrate(db);
const deps = {
  getChapterTier: (bookId, seq) => db.prepare(
    "SELECT tier FROM chapters WHERE book_id=? AND seq=?").get(bookId, seq)?.tier,   // TODO: match your chapters table
  grantOwnership: (userId, bookId, seq) => db.prepare(
    "INSERT OR IGNORE INTO unlocks (user_id, book_id, chapter_seq, source) VALUES (?,?,?,'wff')")
    .run(userId, bookId, seq),                                                       // TODO: match your unlocks/owned table
};
app.post("/wff/claim", authMiddleware, createWffRoute(db, deps));
------------------------------------------------ */
