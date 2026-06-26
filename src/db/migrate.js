'use strict';
/** Chạy migrations theo thứ tự tên file, idempotent qua bảng _migrations. */
const fs = require('node:fs');
const path = require('node:path');
const { db } = require('./index');
const { logger } = require('../lib/logger');

db.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER)');

const dir = path.join(__dirname, 'migrations');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
const applied = new Set(db.prepare('SELECT name FROM _migrations').all().map((r) => r.name));

for (const f of files) {
  if (applied.has(f)) continue;
  const sql = fs.readFileSync(path.join(dir, f), 'utf8');
  const run = db.transaction(() => {
    db.exec(sql);
    db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(f, Date.now());
  });
  run();
  logger.info('migration.applied', { file: f });
}

// Seed pools tối thiểu nếu trống (server là nguồn sự thật cho odds/rights)
const havePools = db.prepare('SELECT COUNT(*) c FROM pools').get().c;
if (!havePools) {
  const ins = db.prepare('INSERT INTO pools (id,name,rights,rates_json,cost1,cost10,pity_hard) VALUES (?,?,?,?,?,?,?)');
  const rOrig = JSON.stringify([['SSR', 0.03], ['SR', 0.20], ['R', 0.77]]);
  const rHuyen = JSON.stringify([['UR', 0.01], ['SSR', 0.02], ['SR', 0.15], ['R', 0.82]]);
  const rNgon = JSON.stringify([['UR', 0.01], ['SSR', 0.02], ['SR', 0.15], ['R', 0.82]]);
  db.transaction(() => {
    ins.run('dverse', 'DVERSE Original', 1, rOrig, 80, 700, 90);   // original: có quyền
    ins.run('huyenhuyen', 'Huyền Huyễn', 1, rHuyen, 100, 900, 90);  // demo bật quyền
    ins.run('ngontinh', 'Ngôn Tình', 0, rNgon, 100, 900, 90);       // chưa có quyền: server khoá
  })();
  logger.info('seed.pools', { count: 3 });
}

// Auto-seed nội dung nếu chapters trống (deploy không cần lệnh phụ)
try {
  const haveCh = db.prepare('SELECT COUNT(*) c FROM chapters').get().c;
  if (!haveCh) { const { seedContent } = require('./seed_content'); seedContent(); }
} catch (e) { logger.warn('seed.content_fail', { e: e.message }); }

logger.info('migrate.done', { files: files.length });
if (require.main === module) process.exit(0);
