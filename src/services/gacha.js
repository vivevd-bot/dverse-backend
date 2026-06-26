'use strict';
/**
 * Gacha SERVER-AUTHORITATIVE. Không tin client một mili-li nào:
 *  - rights-gating: pool.rights=0 -> 403 (quyền phái sinh per DA).
 *  - odds + pity: roll Ở SERVER; 10-pull đầu đảm bảo SSR; pity cứng pool.pity_hard.
 *  - free-pull cooldown: theo gacha_state.last_free_at (KHÔNG theo localStorage client).
 *  - spend qua wallet (atomic) + idempotency.
 */
const { db } = require('../db');
const C = require('../lib/crypto');
const wallet = require('./wallet');
const idem = require('./idempotency');

const FREE_COOLDOWN_MS = 8 * 3600 * 1000;
const CHARS = ['Kiếm Thánh Lã Bố', 'Tiên Nữ Ngọc Long', 'Ma Vương Kiều', 'Long Vương Trần', 'Quỷ Y Thánh Thủ', 'Đại Hiệp Tôn Ngộ', 'Hắc Phong Nguyệt', 'Tiểu Thư Bạch Tuyết'];

const _pool = db.prepare('SELECT * FROM pools WHERE id=?');
const _state = db.prepare('SELECT pity,last_free_at FROM gacha_state WHERE user_id=? AND pool_id=?');
const _stateUp = db.prepare('INSERT INTO gacha_state (user_id,pool_id,pity,last_free_at) VALUES (?,?,?,?) ON CONFLICT(user_id,pool_id) DO UPDATE SET pity=excluded.pity, last_free_at=excluded.last_free_at');
const _insResult = db.prepare('INSERT INTO gacha_results (user_id,pool_id,rarity,char_id,cost,idem_key,created_at) VALUES (?,?,?,?,?,?,?)');

function rollOnce(rates) {
  let x = Math.random();
  for (const [rarity, p] of rates) { if (x < p) return rarity; x -= p; }
  return rates[rates.length - 1][0];
}
function topRarity(rates) { return rates[0][0]; } // odds đặt UR/SSR đầu mảng

function getState(userId, poolId) {
  const s = _state.get(userId, poolId) || { pity: 0, last_free_at: 0 };
  return s;
}

function pull(userId, poolId, count, idemKey) {
  count = count === 10 ? 10 : 1;
  const pool = _pool.get(poolId);
  if (!pool) return { ok: false, code: 'NO_POOL' };
  if (!pool.rights) return { ok: false, code: 'NO_RIGHTS' }; // DA chưa cấp quyền phái sinh
  if (idemKey) { const prev = idem.getStored(idemKey); if (prev) return prev; }

  const rates = JSON.parse(pool.rates_json);
  const cost = count === 10 ? pool.cost10 : pool.cost1;
  const sp = wallet.spend(userId, cost, { kind: 'gacha', label: 'Triệu hồi ' + count + 'x · ' + pool.name, ref: poolId, idemKey: idemKey ? idemKey + ':spend' : null });
  if (!sp.ok) return { ok: false, code: sp.code === 'INSUFFICIENT' ? 'INSUFFICIENT' : 'SPEND_FAIL', balance: sp.balance };

  const st = getState(userId, poolId);
  let pity = st.pity;
  const cards = [];
  const hi = topRarity(rates);
  for (let i = 0; i < count; i++) {
    pity++;
    let rarity;
    if (pity >= pool.pity_hard) { rarity = hi; pity = 0; }
    else rarity = rollOnce(rates);
    cards.push({ rarity, charId: CHARS[Math.floor(Math.random() * CHARS.length)] });
  }
  // 10-pull đầu chắc chắn có SSR+ (nếu chưa có)
  if (count === 10 && !cards.some((c) => c.rarity === 'SSR' || c.rarity === 'UR')) {
    cards[cards.length - 1].rarity = 'SSR';
  }

  const tx = db.transaction(() => {
    for (const c of cards) _insResult.run(userId, poolId, c.rarity, c.charId, Math.floor(cost / count), idemKey || null, Date.now());
    _stateUp.run(userId, poolId, pity, st.last_free_at);
  });
  tx();

  const res = { ok: true, cards, pity, balance: sp.balance };
  if (idemKey) idem.store(idemKey, userId, 'gacha', res);
  return res;
}

function freePull(userId, poolId) {
  const pool = _pool.get(poolId);
  if (!pool) return { ok: false, code: 'NO_POOL' };
  if (!pool.rights) return { ok: false, code: 'NO_RIGHTS' };
  const st = getState(userId, poolId);
  const left = (st.last_free_at + FREE_COOLDOWN_MS) - Date.now();
  if (left > 0) return { ok: false, code: 'COOLDOWN', leftMs: left };
  const rates = JSON.parse(pool.rates_json);
  const card = { rarity: rollOnce(rates), charId: CHARS[Math.floor(Math.random() * CHARS.length)] };
  const tx = db.transaction(() => {
    _insResult.run(userId, poolId, card.rarity, card.charId, 0, null, Date.now());
    _stateUp.run(userId, poolId, st.pity, Date.now());
  });
  tx();
  return { ok: true, card, nextFreeAt: Date.now() + FREE_COOLDOWN_MS };
}

// BXH + vote (1 vote/char/ngày, server enforce)
const _voteIns = db.prepare('INSERT OR IGNORE INTO character_votes (user_id,char_id,day,created_at) VALUES (?,?,?,?)');
function vote(userId, charId) {
  const day = new Date().toISOString().slice(0, 10);
  const r = _voteIns.run(userId, String(charId), day, Date.now());
  if (r.changes !== 1) return { ok: false, code: 'VOTED_TODAY' };
  return { ok: true };
}
function ranking() {
  return db.prepare('SELECT char_id, COUNT(*) votes FROM character_votes GROUP BY char_id ORDER BY votes DESC LIMIT 50').all();
}

function poolView(userId) {
  return db.prepare('SELECT id,name,rights,rates_json,cost1,cost10 FROM pools').all().map((p) => {
    const st = getState(userId, p.id);
    return {
      id: p.id, name: p.name, rights: !!p.rights, rates: JSON.parse(p.rates_json),
      cost1: p.cost1, cost10: p.cost10, pity: st.pity,
      freeReadyAt: st.last_free_at + FREE_COOLDOWN_MS,
    };
  });
}

module.exports = { pull, freePull, vote, ranking, poolView };
