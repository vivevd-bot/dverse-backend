'use strict';
/**
 * Khởi tạo SQLite (better-sqlite3) — WAL, busy_timeout, foreign_keys ON.
 * LƯU Ý SCALE: SQLite chỉ 1 writer. Ổn cho beta; trước golive lên Postgres
 * (xem README §Database). DB_PATH PHẢI trỏ vào volume bền trên Railway.
 */
const path = require('node:path');
const fs = require('node:fs');
const Database = require('better-sqlite3');
const { config } = require('../lib/config');

const dir = path.dirname(config.dbPath);
try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* ignore */ }

const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('busy_timeout = 5000');
db.pragma('foreign_keys = ON');

module.exports = { db };
