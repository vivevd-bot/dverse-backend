# DVERSE Backend Core v0.2 — beta-ready

Backend khớp **đúng contract** của app hiện tại (`dverse-deploy-fixed.html`). Deploy lên Railway là app chạy được ngay — **không sửa frontend** (chỉ trỏ domain). Stack: **Node 22 + better-sqlite3**; chỉ 2 dependency (`express`, `better-sqlite3`); crypto (JWT/HMAC) tự viết bằng `node:crypto`.

> Mục tiêu: diệt 6 rủi ro P0 trong audit — DRM, ví server-authoritative, auth telco, gacha enforce, VNPay IPN, security/data-bền — và **khớp 24 endpoint app đang gọi**.

---

## Chạy nhanh
```bash
cp .env.example .env     # điền JWT_SECRET, DRM_SECRET, CORS_ORIGINS
npm install
npm start                # boot tự migrate + seed (pools + 17 sách + chương). http://localhost:8080/health
npm run check            # node --check toàn bộ
```
Không cần lệnh seed riêng — **boot tự seed** nội dung nếu DB trống (đọc `src/db/seed_data.json`).

---

## Khớp contract frontend (mount ở ROOT, không prefix)
App gọi `BASE + "/auth/..."` với `BASE = window.DVERSE_API`. Backend phục vụ đúng:

| App (object DV) | Endpoint | Ghi chú |
|---|---|---|
| requestOtp/verifyOtp | `POST /auth/otp/request` · `/verify` | `{phone}`/`{phone,code}` → `{token}` |
| socialLogin | `POST /auth/social/:provider` | stub beta |
| me / library / ledger | `GET /me` · `/me/library` · `/wallet/ledger` | hydrate ví, owned, sổ |
| topup | `POST /wallet/topup` | telco/test → credit ngay; VNPay đi qua IPN |
| readChapter / unlock | `GET /chapters/:b/:s` · `POST .../unlock` | **DRM-lite**: gated + watermark + rate-limit |
| gacha / pools / inventory | `POST /gacha/pull` · `GET /gacha/pools` · `/inventory` | server odds/pity/rights |
| charRanking / vote | `GET /ranking/characters` · `POST .../vote` | 1 vote/char/ngày |
| spin / spinStatus | `POST /spin` · `GET /spin/status` | server prize, free 1/ngày, combo 50 xu |
| redpacket | `POST /redpacket/:id/claim` | lì xì 1-lần/user |
| donate / donors | `POST /books/:id/donate` · `GET /books/:id/donors` | |
| subscribe / heartbeat / rankings | `POST /membership/subscribe` · `/reading/heartbeat` · `GET /rankings` | |
| vnpayCreate | `POST /payment/vnpay/create` | golive |
| (VNPay server→server) | `GET/POST /payment/vnpay/ipn` | verify HMAC + idempotent credit |
| health | `GET /health` | |

Idempotency: gửi header `Idempotency-Key` cho `pull`/`unlock` (chống double-tap).

---

## Nối app: chỉ đổi 1 dòng
Trong `dverse-deploy-fixed.html`, đặt:
```js
window.DVERSE_API = "https://<domain-railway-mới>.up.railway.app";
```
(App đã có sẵn tầng `DV` + đăng nhập OTP + gắn `Bearer` token. Không sửa gì khác.)

**App tự tắt mọi demo client khi `DVERSE_API` có giá trị** (DV_ON=true) — gacha/spin/ví/đọc chương đều lấy từ server. Đây là điểm khử exploit P0.

---

## Deploy Railway
1. **Volume bền**: gắn volume, `DB_PATH=/data/dverse.db` (KHÔNG để DB trong container — mất khi redeploy).
2. Env: điền `.env.example`. Thiếu `JWT_SECRET`/`DRM_SECRET`/`CORS_ORIGINS` ở production → server **từ chối boot** (fail-fast).
3. Start `npm start` → tự migrate + seed.
4. Kiểm: mở `<domain>/health` → `{"ok":true}`.
5. **Backup**: cron `bash scripts/backup.sh` mỗi 6–12h (SQLite online backup, giữ 14 bản).
6. VNPay golive: `DVERSE_VNPAY=true` + `VNP_*`, khai báo IPN URL `/payment/vnpay/ipn` trên cổng VNPay.

---

## Đã test
- `node --check`: **18/18 file PASS**.
- **E2E 25/25 PASS** (chạy thật trên `node:sqlite`): signup OTP → ví tặng 20 → topup → gacha 10x (rights-gating + guarantee SSR + **idempotency chống double-spend**) → đọc free/paid + watermark → unlock → **ledger reconcile** → spin (free/ngày) → lì xì 1-lần → vote 1-lần → ranking → **VNPay IPN credit + idempotent + chặn sai chữ ký**.
- Seed thật từ app: 17 sách / 14 chương, 0 ký tự Hán.
- `lib/crypto`: 11/11 (JWT/HMAC/timing-safe). Config fail-fast: PASS.

> Lưu ý: test offline dùng shim `node:sqlite` (vì môi trường build không cài được better-sqlite3). **Production trên Railway cài better-sqlite3 thật** (`npm install`) — code không đổi. Thư mục `node_modules/` (shim) KHÔNG có trong gói giao.

---

## Còn phải làm trước golive (ngoài v0.2)
- **Telco DCB thật** (VNPT charging API) — hiện topup telco credit thẳng (beta); DCB là moat doanh thu.
- **SMS/OTP gateway thật** (đang stub: dev trả `devCode`). Trước golive bắt buộc cắm.
- **DRM 2-bước** (token đọc chương dùng-1-lần, `services/drm.js` đã có sẵn) thay cho DRM-lite hiện tại + watermark marker vô hình.
- **Postgres** khi concurrency tăng (SQLite 1-writer).
- **Compliance**: data localization NĐ53, giới hạn giờ/định danh minor cho gacha NĐ147.
