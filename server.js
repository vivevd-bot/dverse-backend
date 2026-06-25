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
    // Social login (Google, Zalo)
    if (seg[0] === 'auth' && seg[1] === 'social' && seg[2] && req.method === 'POST') {
      const provider = seg[2];
      if (!['google', 'zalo'].includes(provider)) return json(res, 400, { error: 'unsupported_provider' });

      let profile;

      if (process.env.NODE_ENV !== 'prod' && body.dev) {
        // DEV MODE: bypass OAuth
        profile = {
          id: body.email || body.phone || ('dev_' + Date.now()),
          email: body.email || null,
          name: body.name || 'Đạo hữu'
        };
      } else if (provider === 'google') {
        const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
        if (!GOOGLE_CLIENT_ID || !body.credential) return json(res, 400, { error: 'missing_credential' });
        try {
          const https = require('https');
          const payload = await new Promise((resolve, reject) => {
            https.get('https://oauth2.googleapis.com/tokeninfo?id_token=' + body.credential, (r2) => {
              let d = ''; r2.on('data', c => d += c); r2.on('end', () => {
                try { const p2 = JSON.parse(d); if (p2.aud === GOOGLE_CLIENT_ID) resolve(p2); else reject(new Error('aud_mismatch')); } catch { reject(new Error('parse_error')); }
              });
            }).on('error', reject);
          });
          profile = { id: payload.sub, email: payload.email, name: payload.name };
        } catch (e) {
          return json(res, 401, { error: 'invalid_google_token', detail: e.message });
        }
      } else if (provider === 'zalo') {
        const ZALO_APP_ID = process.env.ZALO_APP_ID;
        const ZALO_APP_SECRET = process.env.ZALO_APP_SECRET;
        if (!ZALO_APP_ID || !body.code) return json(res, 400, { error: 'missing_code' });
        try {
          const https = require('https');
          const tokenData = await new Promise((resolve, reject) => {
            const postData = JSON.stringify({ app_id: ZALO_APP_ID, app_secret: ZALO_APP_SECRET, code: body.code, grant_type: 'authorization_code' });
            const opts = { hostname: 'oauth.zaloapp.com', path: '/v4/access_token', method: 'POST', headers: { 'Content-Type': 'application/json', 'secret_key': ZALO_APP_SECRET } };
            const req2 = https.request(opts, (r2) => { let d = ''; r2.on('data', c => d += c); r2.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error('parse')); } }); });
            req2.on('error', reject); req2.write(postData); req2.end();
          });
          if (!tokenData.access_token) return json(res, 401, { error: 'zalo_token_failed' });
          const userInfo = await new Promise((resolve, reject) => {
            const opts = { hostname: 'graph.zalo.me', path: '/v2.0/me?fields=id,name', method: 'GET', headers: { 'access_token': tokenData.access_token } };
            https.get(opts, (r2) => { let d = ''; r2.on('data', c => d += c); r2.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error('parse')); } }); }).on('error', reject);
          });
          profile = { id: userInfo.id, name: userInfo.name, email: null };
        } catch (e) {
          return json(res, 401, { error: 'zalo_auth_failed', detail: e.message });
        }
      }

      if (!profile) return json(res, 400, { error: 'no_profile' });
      const result = C.socialLogin(provider, profile);
      return json(res, 200, result);
    }
    if (p === '/rankings' && req.method === 'GET') return json(res, 200, C.rankings(url.searchParams.get('type') || 'hot'));
    if (p === '/catalog' && req.method === 'GET') return json(res, 200, { books: C.catalog() });
    if (seg[0] === 'catalog' && seg[1] && req.method === 'GET') {
      const b = C.bookDetail(seg[1]);
      return b ? json(res, 200, b) : json(res, 404, { error: 'not_found' });
    }
    // /books/:bookId/donors (public)
    if (seg[0] === 'books' && seg[1] && seg[2] === 'donors' && req.method === 'GET')
      return json(res, 200, { donors: C.donationLeaderboard(seg[1]) });

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

    // /books/:bookId/donate (authed)
    if (seg[0] === 'books' && seg[1] && seg[2] === 'donate' && req.method === 'POST')
      return json(res, 200, C.donate(u.id, seg[1], body.amount, body.message));

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

    // ---- LUCKY WHEEL ----
    if (p === '/spin/status' && req.method === 'GET') return json(res, 200, C.spinStatus(u.id));
    if (p === '/spin' && req.method === 'POST') return json(res, 200, C.spin(u.id, !!body.combo));

    return json(res, 404, { error: 'route_not_found', path: p });
  } catch (e) {
    return json(res, 500, { error: 'server_error', message: e.message });
  }
});

const PORT = process.env.PORT || 8787;
if (require.main === module) server.listen(PORT, () => console.log('DVERSE API on :' + PORT));
module.exports = { server };
