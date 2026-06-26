'use strict';
/** Catalog server-side — MIRROR đúng frontend (SPIN_PRIZES, nhân vật). Sửa đây nếu frontend đổi. */

// Khớp index với SPIN_PRIZES ở client (8 ô). k=coin -> cộng ví; exp/rt/mt -> client tự grant.
const SPIN_PRIZES = [
  { index: 0, k: 'coin', v: 5, weight: 30 },
  { index: 1, k: 'coin', v: 20, weight: 25 },
  { index: 2, k: 'exp', v: 30, weight: 20 },
  { index: 3, k: 'exp', v: 60, weight: 10 },
  { index: 4, k: 'coin', v: 50, weight: 8 },
  { index: 5, k: 'rt', v: 2, weight: 4 },
  { index: 6, k: 'mt', v: 1, weight: 2 },
  { index: 7, k: 'coin', v: 100, weight: 1 },
];
function weightedPick() {
  const total = SPIN_PRIZES.reduce((a, p) => a + p.weight, 0);
  let x = Math.random() * total;
  for (const p of SPIN_PRIZES) { if (x < p.weight) return p.index; x -= p.weight; }
  return 0;
}

const CHAR_NAMES = ['Kiếm Thánh Lã Bố', 'Ma Vương Kiều', 'Tiên Nữ Ngọc Long', 'Đại Hiệp Tôn Ngộ', 'Tiểu Thư Bạch Tuyết', 'Long Vương Trần', 'Hắc Phong Nguyệt', 'Quỷ Y Thánh Thủ'];
const CHAR_EMOJIS = ['\u2694\uFE0F', '\uD83D\uDDE1\uFE0F', '\uD83C\uDF38', '\uD83D\uDCA5', '\u2744\uFE0F', '\uD83D\uDD25', '\uD83C\uDF19', '\uD83D\uDC8E'];
const CHARS = CHAR_NAMES.map((n, i) => ({ name: n, emoji: CHAR_EMOJIS[i], rarity: i === 0 ? 'SSR' : i < 3 ? 'SR' : 'R', baseVotes: 9800 - i * 800 }));

module.exports = { SPIN_PRIZES, weightedPick, CHARS, CHAR_NAMES, CHAR_EMOJIS };
