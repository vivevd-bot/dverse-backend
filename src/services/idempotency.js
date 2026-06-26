'use strict';
/** Idempotency: chống double-tap/replay cho mọi mutation tiền/gacha/payment. */
const { db } = require('../db');

const _get = db.prepare('SELECT response FROM idempotency WHERE key = ?');
const _put = db.prepare('INSERT OR IGNORE INTO idempotency (key,user_id,scope,response,created_at) VALUES (?,?,?,?,?)');

function getStored(key) {
  if (!key) return null;
  const row = _get.get(key);
  return row ? JSON.parse(row.response) : null;
}
function store(key, userId, scope, response) {
  if (!key) return;
  _put.run(key, userId || null, scope, JSON.stringify(response), Date.now());
}

module.exports = { getStored, store };
