'use strict';
/**
 * Seed nội dung (books + chapters) vào DB.
 * - Mặc định đọc nội dung đóng gói sẵn: src/db/seed_data.json (không cần file frontend).
 * - Hoặc truyền path HTML để trích trực tiếp từ DV_STORY: node src/db/seed_content.js <html>
 * - Tự chạy lúc boot nếu bảng chapters trống (gọi từ migrate.js). Idempotent.
 */
const fs = require('node:fs');
const path = require('node:path');
const { db } = require('./index');
const { config } = require('../lib/config');
const { logger } = require('../lib/logger');

const META = {
  b1: { title: 'Trảm Tiên Lục', provider: 'China Literature', rights: 1, cobrand: 'Yuewen' },
  b2: { title: 'Trùng Sinh Đô Thị Tu Tiên', provider: 'China Literature', rights: 0, cobrand: 'Yuewen' },
  b3: { title: 'Phượng Hoàn Triều', provider: 'Kakao', rights: 0, cobrand: 'Kakao Page' },
  b4: { title: 'Hệ Thống Cường Giả', provider: 'China Literature', rights: 0, cobrand: 'Yuewen' },
  b5: { title: 'Quỷ Bí Chi Chủ', provider: 'China Literature', rights: 1, cobrand: 'Yuewen' },
  b6: { title: 'Đấu Phá Thương Khung', provider: 'China Literature', rights: 0, cobrand: 'Yuewen' },
  b7: { title: 'Toàn Chức Cao Thủ', provider: 'China Literature', rights: 0, cobrand: 'Yuewen' },
  b8: { title: 'Khom Lưng', provider: 'Kakao', rights: 0, cobrand: 'Kakao Page' },
  w1: { title: 'Tiên Võ Đế Tôn', provider: 'China Literature', rights: 0, cobrand: 'Yuewen' },
  w2: { title: 'Yêu Thần Ký', provider: 'China Literature', rights: 0, cobrand: 'Yuewen' },
  w3: { title: 'Tháp Vô Tận', provider: 'China Literature', rights: 0, cobrand: 'Yuewen' },
  m1: { title: 'Thăng Cấp Một Mình', provider: 'Kakao', rights: 0, cobrand: 'Kakao Page' },
  m2: { title: 'Nhập Hồn Sư', provider: 'Kakao', rights: 0, cobrand: 'Kakao Page' },
  g1: { title: 'Kiếm Sĩ Lang Thang', provider: 'DVERSE Studio', rights: 1, cobrand: null },
  g2: { title: 'Đại Hải Trình', provider: 'DVERSE Studio', rights: 1, cobrand: null },
  c1: { title: 'Đặc Vụ Z', provider: 'DVERSE Studio', rights: 1, cobrand: null },
  c2: { title: 'Siêu Anh Hùng Phố', provider: 'DVERSE Studio', rights: 1, cobrand: null },
};

function extractObject(src, marker) {
  const at = src.indexOf(marker); if (at < 0) return null;
  let i = src.indexOf('{', at), depth = 0, inStr = false, esc = false; const start = i;
  for (; i < src.length; i++) {
    const c = src[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true; else if (c === '{') depth++; else if (c === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  return null;
}

function loadStory(htmlPath) {
  if (htmlPath && fs.existsSync(htmlPath)) {
    try { return JSON.parse(extractObject(fs.readFileSync(htmlPath, 'utf8'), 'DV_STORY =')); }
    catch (e) { logger.warn('seed.html_parse_fail', { e: e.message }); }
  }
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'seed_data.json'), 'utf8')); }
  catch (e) { logger.warn('seed.json_fail', { e: e.message }); return {}; }
}

function seedContent(htmlPath) {
  const STORY = loadStory(htmlPath);
  const upBook = db.prepare('INSERT INTO books (id,title,provider,rights_derivative,cobrand,license_start,territory,created_at) VALUES (@id,@title,@provider,@rights,@cobrand,@ls,@terr,@now) ON CONFLICT(id) DO UPDATE SET title=@title, provider=@provider, rights_derivative=@rights, cobrand=@cobrand');
  const upCh = db.prepare('INSERT INTO chapters (book_id,seq,title,content,tier,price_coin,published_at) VALUES (@b,@seq,@title,@content,@tier,@price,@pub) ON CONFLICT(book_id,seq) DO UPDATE SET title=@title, content=@content, tier=@tier, price_coin=@price');
  const FREE = config.freeTier.freeChapters;
  const now = Date.now();
  let nB = 0, nC = 0;
  const ids = new Set(Object.keys(META).concat(Object.keys(STORY)));
  const tx = db.transaction(() => {
    for (const id of ids) {
      const m = META[id] || { title: id, provider: 'China Literature', rights: 0, cobrand: 'Yuewen' };
      upBook.run({ id, title: m.title, provider: m.provider, rights: m.rights, cobrand: m.cobrand, ls: Math.floor(now / 1000), terr: 'VN', now });
      nB++;
      const chs = STORY[id] || {};
      for (const seqStr of Object.keys(chs)) {
        const seq = Number(seqStr);
        const paras = chs[seqStr];
        const contentText = Array.isArray(paras) ? paras.join('\n\n') : String(paras || '');
        if (!contentText) continue;
        const tier = seq <= FREE ? 'free' : 'paid';
        upCh.run({ b: id, seq, title: 'Chương ' + seq, content: contentText, tier, price: tier === 'free' ? 0 : 30, pub: now });
        nC++;
      }
    }
  });
  tx();
  logger.info('seed.content', { books: nB, chapters: nC });
  return { books: nB, chapters: nC };
}

module.exports = { seedContent };

if (require.main === module) { seedContent(process.argv[2]); process.exit(0); }
