'use strict';
// Seed catalog — port từ demo (mk/mkChapters). Prod: thay bằng ContentImporter.
const { db } = require('./db');

const TIER_BASE = { PREMIUM: 60, EARLY: 35, STANDARD: 18, FREE: 0 };
function mkChapters(n, pm = 1, label = 'Chương') {
  const out = [];
  for (let i = 0; i < n; i++) {
    const seq = i + 1;
    let tier = 'STANDARD';
    if (seq <= 3) tier = 'FREE';
    else if (seq % 6 === 0) tier = 'PREMIUM';
    else if (seq % 4 === 0) tier = 'EARLY';
    out.push({
      seq, title: `${label} ${seq}`, tier,
      price_coin: Math.round(TIER_BASE[tier] * pm),
      words: 2800 + seq * 40,
      body: `[${label} ${seq}] Nội dung mẫu. Bản thật nạp qua ContentImporter ` +
            `(dịch CN→VI trực tiếp, QC, publish). Tier=${tier}.`,
    });
  }
  return out;
}

const CATALOG = [
  ['b1','Trảm Tiên Lục','text','Web novel','China Literature','Huyền huyễn',['Tu tiên','Hệ thống'],4.8,12400000,12],
  ['b2','Trùng Sinh Đô Thị Tu Tiên','text','Web novel','China Literature','Đô thị',['Trùng sinh'],4.6,8900000,10],
  ['b3','Phượng Hoàn Triều','text','Web novel','Kakao Page','Ngôn tình',['Cổ trang','Nữ cường'],4.9,10200000,11],
  ['b4','Hệ Thống Cường Giả','text','Web novel','China Literature','Khoa huyễn',['Hệ thống'],4.4,6100000,9],
  ['b5','Quỷ Bí Chi Chủ','text','Web novel','China Literature','Huyền huyễn',['Linh dị','Steampunk'],4.9,14800000,12],
  ['b6','Đấu Phá Thương Khung','text','Web novel','China Literature','Huyền huyễn',['Tu luyện'],4.7,9900000,12],
  ['b7','Toàn Chức Cao Thủ','text','Web novel','China Literature','Đô thị',['E-sport','Game'],4.8,8700000,11],
  ['b8','Khom Lưng','text','Web novel','Kakao Page','Ngôn tình',['Cổ trang','Ngọt'],4.7,7200000,11],
  ['w1','Tiên Võ Đế Tôn','image','Webtoon','China Literature','Huyền huyễn',['Manhua','Màu'],4.7,9300000,9],
  ['w2','Toàn Chức Pháp Sư','image','Webtoon','China Literature','Huyền huyễn',['Manhua'],4.6,6800000,9],
];

function seed() {
  const n = db.prepare('SELECT COUNT(*) c FROM books').get().c;
  if (n > 0) return { skipped: true, books: n };
  const insB = db.prepare(`INSERT INTO books
    (id,title,type,format,cp,cat,tags,rating,reads,complete,descr,translator,base_votes,donate)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insC = db.prepare(`INSERT INTO chapters
    (book_id,seq,title,tier,price_coin,words,body) VALUES (?,?,?,?,?,?,?)`);
  let chap = 0;
  for (const [id,title,type,format,cp,cat,tags,rating,reads,nCh] of CATALOG) {
    const pm = type === 'drama' ? 0.6 : 1;
    insB.run(id,title,type,format,cp,cat,JSON.stringify(tags),rating,reads,
             Math.round(reads/10000)%2===0?1:0,
             `${title} — bản quyền ${cp}.`, 'Nhóm dịch Thanh Vân',
             Math.round(reads/1500), Math.round(reads/90));
    for (const c of mkChapters(nCh, pm, type==='text'?'Chương':'Tập')) {
      insC.run(id,c.seq,c.title,c.tier,c.price_coin,c.words,c.body); chap++;
    }
  }
  return { books: CATALOG.length, chapters: chap };
}
module.exports = { seed };
