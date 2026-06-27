// gacha.js — Character summon (gacha), SERVER-AUTHORITATIVE
// Stack: Node 22 + better-sqlite3 (Railway).
//
// Why: gacha spends REAL xu and is gambling-adjacent. RNG, spend, pity and the
// odds table MUST live on the server — never client Math.random(). The client
// only renders what the server returns. Two hard rules enforced here:
//   1) LICENSED pools are refused until a derivative-rights agreement is signed
//      (only DVERSE-original content may run gacha now).
//   2) Published odds == server odds (no hidden rates). UR is actually rollable.

const POOLS = {
  pool_dverse:    { licensed: false, cost1: 80,  cost10: 700,  odds: [["SSR",0.03],["SR",0.20],["R",0.77]],
                    roster: [["Phong Vũ","\u2694\uFE0F"],["Lạc Thần","\uD83C\uDF38"],["Hắc Diệm","\uD83D\uDD25"],["Tuyết Cơ","\u2744\uFE0F"]] },
  pool_huyenhuyem:{ licensed: true,  cost1: 100, cost10: 880,  odds: [["SSR",0.02],["SR",0.15],["R",0.83]], roster: [] },
  pool_ngontinh:  { licensed: true,  cost1: 120, cost10: 1000, odds: [["UR",0.01],["SSR",0.04],["SR",0.18],["R",0.77]], roster: [] },
};
const PITY_AT = 90;                         // guaranteed top-rarity pull
const WEIGHT = { UR: 15, SSR: 8, SR: 3, R: 1 };   // dupe -> essence

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS gacha_pity  (user_id TEXT, pool_id TEXT, n INTEGER DEFAULT 0, PRIMARY KEY(user_id,pool_id));
    CREATE TABLE IF NOT EXISTS gacha_codex (user_id TEXT, char_name TEXT, PRIMARY KEY(user_id,char_name));
  `);
}

function rollRarity(odds, rnd) {
  let r = rnd();
  for (const [rar, p] of odds) { if (r < p) return rar; r -= p; }
  return odds[odds.length - 1][0];
}

// deps: getBalance(userId)->int, spend(userId,amt)->bool, addEssence(userId,amt),
//       rnd?() -> [0,1) (inject for tests). All inside ONE db transaction by caller.
function pullGacha(db, deps, userId, poolId, count) {
  if (!userId) return { status: 401, body: { granted: false, message: "Cần đăng nhập" } };
  const pool = POOLS[poolId];
  if (!pool) return { status: 400, body: { granted: false, message: "Pool không tồn tại" } };
  if (pool.licensed) return { status: 403, body: { granted: false, code: "LOCKED", message: "Pool bản quyền — chờ thoả thuận phái sinh" } };
  count = count === 10 ? 10 : 1;
  const cost = count === 10 ? pool.cost10 : pool.cost1;
  const rnd = deps.rnd || Math.random;

  const run = () => {
    if (deps.getBalance(userId) < cost) return { status: 200, body: { granted: false, code: "INSUFFICIENT", message: "Không đủ xu" } };
    if (!deps.spend(userId, cost)) return { status: 200, body: { granted: false, code: "INSUFFICIENT", message: "Không đủ xu" } };

    let pity = (db.prepare("SELECT n FROM gacha_pity WHERE user_id=? AND pool_id=?").get(userId, poolId) || {}).n || 0;
    const topRarity = pool.odds[0][0];
    const owned = new Set(db.prepare("SELECT char_name FROM gacha_codex WHERE user_id=?").all(userId).map(r => r.char_name));
    const addChar = db.prepare("INSERT OR IGNORE INTO gacha_codex (user_id, char_name) VALUES (?,?)");

    const cards = [], newChars = []; let essenceGained = 0;
    for (let i = 0; i < count; i++) {
      const guaranteed = (i === count - 1) && (pity + count >= PITY_AT);
      const rarity = guaranteed ? topRarity : rollRarity(pool.odds, rnd);
      const ch = pool.roster.length ? pool.roster[Math.floor(rnd() * pool.roster.length)] : ["Nhân vật", "\u2728"];
      const name = ch[0], emoji = ch[1];
      cards.push({ name, emoji, rarity });
      if (owned.has(name) || newChars.includes(name)) essenceGained += WEIGHT[rarity] || 1;
      else { newChars.push(name); addChar.run(userId, name); }
    }
    pity = (pity + count) % 100;
    db.prepare("INSERT INTO gacha_pity (user_id,pool_id,n) VALUES (?,?,?) ON CONFLICT(user_id,pool_id) DO UPDATE SET n=excluded.n").run(userId, poolId, pity);
    if (essenceGained) deps.addEssence(userId, essenceGained);
    return { status: 200, body: { granted: true, cards, pity, essenceGained, newChars, balance: deps.getBalance(userId) } };
  };

  // Atomic: spend + pity + codex either all commit or all roll back
  return db.transaction(run)();
}

function createGachaRoute(db, deps) {
  return function (req, res) {
    try {
      const { poolId, count } = req.body || {};
      const out = pullGacha(db, deps, req.userId, poolId, Number(count));
      res.status(out.status).json(out.body);
    } catch (e) { console.error("[gacha/pull]", e); res.status(500).json({ granted: false, message: "Lỗi máy chủ" }); }
  };
}

module.exports = { migrate, pullGacha, createGachaRoute, POOLS };

/* ---- Wiring ----
const { migrate, createGachaRoute } = require("./gacha");
migrate(db);
const deps = {
  getBalance: (u) => db.prepare("SELECT coin FROM wallets WHERE user_id=?").get(u)?.coin || 0,   // TODO: match wallet table
  spend:      (u, amt) => db.prepare("UPDATE wallets SET coin=coin-? WHERE user_id=? AND coin>=?").run(amt,u,amt).changes>0, // TODO
  addEssence: (u, amt) => db.prepare("INSERT INTO essence(user_id,bal) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET bal=bal+?").run(u,amt,amt), // TODO
};
app.post("/gacha/pull", authMiddleware, createGachaRoute(db, deps));
------------------------------------------------ */
