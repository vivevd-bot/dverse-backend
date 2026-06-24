'use strict';
// DVERSE API — http server thuần Node (không framework, chạy offline).
// Prod: đặt sau nginx/Cloudflare; swap node:sqlite → Postgres.
const http = require('http');
require('./db');
const { seed } = require('./seed');
const C = require('./core');

seed();

const json = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' });
  res.end(body);
};
const readBody = (req) => new Promise((resolve) => {
  let d = ''; req.on('data', c => d += c);
  req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch { resolve({}); } });
});
const auth = (req) => C.userByToken((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 204, {});
  const url = new URL(req.url, 'http://x');
  const p = url.pathname.replace(/\/$/, '');
  const seg = p.split('/').filter(Boolean);
  const body = (req.method === 'POST') ? await readBody(req) : {};

  try {
    // ---- public ----
    if (p === '/health') return json(res, 200, { ok: true, ts: Date.now() });
    if (p === '/auth/otp/request' && req.method === 'POST')
      return json(res, 200, C.requestOtp(body.phone));
    if (p === '/auth/otp/verify' && req.method === 'POST') {
      const r = C.verifyOtp(body.phone, body.code);
      return r ? json(res, 200, r) : json(res, 401, { error: 'invalid_otp' });
    }
    if (p === '/catalog' && req.method === 'GET') return json(res, 200, { books: C.catalog() });
    if (seg[0] === 'catalog' && seg[1] && req.method === 'GET') {
      const b = C.bookDetail(seg[1]);
      return b ? json(res, 200, b) : json(res, 404, { error: 'not_found' });
    }

    // ---- authed ----
    const u = auth(req);
    if (!u) return json(res, 401, { error: 'unauthorized' });

    if (p === '/me' && req.method === 'GET') return json(res, 200, C.publicUser(u));
    if (p === '/me/library' && req.method === 'GET') return json(res, 200, C.library(u.id));
    if (p === '/wallet/spend' && req.method === 'POST') return json(res, 200, C.spendApi(u.id, body.amount, body.label));
    if (p === '/wallet/ledger' && req.method === 'GET') return json(res, 200, { ledger: C.ledger(u.id) });
    if (p === '/wallet/topup' && req.method === 'POST')
      return json(res, 200, await C.topup(u.id, body.packageId, body.provider || 'vnpay', body.channel || 'direct'));
    if (p === '/membership/subscribe' && req.method === 'POST')
      return json(res, 200, await C.subscribe(u.id, body.plan, body.provider || 'vnpt', body.channel || 'telco_billing'));

    // /chapters/:book/:seq  (GET = read, POST = unlock)
    if (seg[0] === 'chapters' && seg[1] && seg[2]) {
      const [bookId, seq] = [seg[1], parseInt(seg[2], 10)];
      if (req.method === 'GET') {
        const r = C.readChapter(u, bookId, seq);
        return json(res, r.status, r.chapter ? r.chapter : (r.paywall || { error: 'not_found' }));
      }
      if (req.method === 'POST' && seg[3] === 'unlock') return json(res, 200, C.unlock(u, bookId, seq));
      if (req.method === 'POST' && seg[3] === 'daily-free') return json(res, 200, C.claimDailyFree(u, bookId, seq));
    }
    if (p === '/reading/heartbeat' && req.method === 'POST')
      return json(res, 200, C.readingHeartbeat(u, body.bookId, body.seq, body.seconds));

    return json(res, 404, { error: 'route_not_found', path: p });
  } catch (e) {
    return json(res, 500, { error: 'server_error', message: e.message });
  }
});

const PORT = process.env.PORT || 8787;
if (require.main === module) server.listen(PORT, () => console.log('DVERSE API on :' + PORT));
module.exports = { server };
