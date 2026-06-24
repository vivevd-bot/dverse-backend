# DVERSE Backend — Reference Implementation v1

Backend **chạy thật** cho DVERSE, thay toàn bộ phần giả lập trong demo
(`dverse-deploy-fixed.html`). Viết bằng Node 22 + SQLite built-in (`node:sqlite`),
**không cần npm install**, chạy offline được ngay.

## Chạy
```bash
node server.js          # API trên :8787 (tự seed catalog lần đầu)
node smoketest.js       # test end-to-end toàn flow
```

## Cái gì ĐÃ THẬT (server giữ nguồn sự thật)
| Lớp | Trạng thái |
|---|---|
| Auth OTP + session token (30 ngày) | ✅ thật (OTP dev = `000000`; prod gửi SMS) |
| Ví coin: trừ **free trước, paid sau**, atomic, có ledger | ✅ thật |
| Nạp coin 5 tier bonus | ✅ thật (qua billing adapter) |
| Mở khóa chương: FREE / trả coin / pass / wait-for-free | ✅ thật, server-authoritative |
| Membership DVERSE+ 59k / VIP 129k | ✅ thật |
| **Đo phút đọc** (`reading_events`) + báo cáo pool theo rights-holder | ✅ thật — nền chia 50% pass-revenue pool |
| Catalog + chapter (10 truyện seed) | ✅ thật trong DB |

## Cái gì là STUB — chờ DND cấp credential
Tất cả nằm sau adapter trong `adapters/index.js`. Thay mock → real **không đụng route**.

| Adapter | Cần gì từ DND |
|---|---|
| `TelcoBilling` (VNPT/Viettel/MobiFone) | HĐ VAS + carrier-billing API + short-code + HMAC secret + IPN URL |
| `VNPayDirect` | `vnp_TmnCode`, `vnp_HashSecret`, IPN endpoint |
| `DRM` | Chọn vendor (Widevine/PallyCon…) + license server; hiện chỉ cấp license token + chưa encrypt |
| `ContentImporter` (China Literature/Kakao) | File nguồn + pipeline dịch CN→VI (AI tool CL on-prem Singapore, hoặc tool độc lập) |

Bật real billing: `DVERSE_BILLING=real node server.js` (sẽ throw kèm hướng dẫn nếu thiếu cấu hình).

## Endpoint
```
POST /auth/otp/request {phone}
POST /auth/otp/verify  {phone,code}          -> {token,user}
GET  /me
GET  /catalog                                 GET /catalog/:bookId
GET  /chapters/:bookId/:seq                   -> 200 body | 402 paywall
POST /chapters/:bookId/:seq/unlock            (trả coin / pass)
POST /chapters/:bookId/:seq/daily-free        (wait-for-free 1 ch/truyện/ngày)
POST /reading/heartbeat {bookId,seq,seconds}  (metering)
POST /wallet/topup {packageId,provider,channel}
POST /membership/subscribe {plan,provider,channel}
GET  /wallet/ledger
```

## Nối với demo frontend
`api-client.js` là drop-in: thay `usePersist(coin/owned/pass/ledger)` bằng gọi `DV.me()`,
`DV.unlock()`, `DV.readChapter()`… Client **không** tự cộng/trừ coin nữa — server quyết.

## Lên production (việc của team backend)
1. Swap `node:sqlite` → Postgres (schema port 1:1, đã tách trong `db.js`).
2. Cắm 4 adapter real ở trên.
3. Reader ảnh thật cho Webtoon/manga (demo mới render text).
4. Rate-limit + chống gian lận nạp/đọc; heartbeat đã cap 10'/nhịp.
5. Job định kỳ chạy `passPoolReport()` → chia 50% net pass-revenue pro-rata theo phút đọc.
6. Deploy sau nginx/Cloudflare; HTTPS; secret qua env.

## Còn thiếu để đủ Beta T9 (ngoài phạm vi file này)
PRD Reader/Social/CMS, DRM vendor selection, push notification, ads, compliance/legal,
identity nâng cao (KYC nếu cần cho thanh toán). Backend này là xương sống để gắn các phần đó.

---
## Chạy frontend + backend cùng nhau (demo cho board)
```bash
# 1) backend
cd dverse-backend && node server.js          # :8787

# 2) frontend: serve file tĩnh (đừng mở file:// trực tiếp)
python3 -m http.server 5500                   # ở thư mục chứa dverse-wired.html
```
Mở: `http://localhost:5500/dverse-wired.html?api=http://localhost:8787`
- `?api=` rỗng (mở thường) → chạy y demo local cũ, không cần backend.
- Có `?api=` → hiện màn login OTP (dev code 000000) → coin/pass/sở hữu/mở khóa/đo phút đọc đều THẬT từ backend.
