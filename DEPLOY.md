# DEPLOY — DVERSE (bàn giao cho dev/ops)

## TL;DR
- Backend Node 22, **không có dependency ngoài**. Lệnh chạy: `node server.js`.
- Deploy lên Railway (hoặc bất kỳ host Node nào) trong ~15–20 phút.
- **Chạy được ngay (thật):** đăng nhập OTP, ví coin, mở khóa chương, đo phút đọc.
- **Đang MOCK — phải cắm thật trước khi thu tiền:** nạp tiền/membership (billing),
  DRM, nội dung, SMS OTP. Cứ deploy mock trước cho chạy demo, tiền thật làm sau.

---

## 0. Yêu cầu
- Node **>= 22.5** (cần `node:sqlite`). Trên Railway set Node 22.
- Pilot: dùng SQLite (file). Scale: Postgres — schema trong `db.js` port 1:1, đổi driver là xong.

## 1. Deploy BACKEND (Railway)
1. Đẩy thư mục `dverse-backend/` lên 1 Git repo → Railway → **New Project → Deploy from repo**.
2. Start command: `node server.js` (nixpacks tự nhận Node; `package.json` đã khai engines 22).
3. **TẠO VOLUME — bắt buộc:** Railway → Add Volume, mount `/data`.
   Đặt env `DVERSE_DB=/data/dverse.db`. **Không có volume = mất sạch dữ liệu mỗi lần deploy.**
4. Env vars:
   | Key | Value |
   |---|---|
   | `NODE_ENV` | `prod` |
   | `DVERSE_DB` | `/data/dverse.db` |
   | `DVERSE_BILLING` | `mock` (đổi `real` khi đã có credential) |
   | `PORT` | Railway tự cấp, không cần đặt |
5. Deploy → lấy URL `https://xxx.up.railway.app`. Test ngay: mở `…/health` phải trả `{ok:true}`.
   (Nếu báo lỗi experimental sqlite trên 1 bản Node lạ: đổi start thành `node --experimental-sqlite server.js`.)

> Host khác (VM/Docker): bất kỳ máy Node 22 nào, `node server.js` đặt sau nginx, nhớ mount ổ cho file DB.

## 2. Deploy FRONTEND
- `dverse-wired.html` là **file tĩnh** — host bằng Railway static / Netlify / Vercel / Cloudflare Pages / nginx.
- **Trỏ API:** mở file, sửa dòng đầu khối "DVERSE API BRIDGE":
  thay bằng `window.DVERSE_API = "https://xxx.up.railway.app";` (prod nên hardcode, bỏ `?api=`).
- Backend đang để CORS `*`. Prod: siết về đúng domain FE (sửa header trong `server.js`).

## 3. Smoke test sau khi deploy
Chạy `node smoketest.js` (đổi host trỏ URL thật) **hoặc** thử tay trên web:
login OTP (dev `000000`) → mở chương FREE OK → mở chương PREMIUM ra paywall 402 →
nạp 1 gói → mở lại thấy **coin tụt đúng** → đọc → kiểm tra `/me/library` có chương vừa mua.

## 4. TRƯỚC KHI THU TIỀN THẬT (việc dev)
Khác biệt quan trọng nhất: **thanh toán thật là bất đồng bộ (IPN callback)** — mock thì cộng coin ngay.
1. **OTP SMS thật:** thay `requestOtp` trong `core.js` để gửi qua SMS gateway/telco (giờ trả `000000`).
2. **Billing thật:** điền adapter trong `adapters/index.js` + thêm route webhook `/webhooks/:provider`
   cho telco/VNPay gọi về; **chỉ cộng coin khi callback xác nhận `success`**, không cộng lúc tạo giao dịch.
3. **DRM:** chọn vendor, encrypt `body` + watermark `userId` (hiện chỉ cấp license token).
4. Siết CORS, bật HTTPS (Railway có sẵn), rate-limit OTP/topup.
5. (Scale) Đổi SQLite → Postgres.

## 5. CẦN DND CẤP (không phải việc dev)
- VNPT / Viettel / MobiFone: HĐ VAS + carrier-billing API + short-code + HMAC secret + IPN URL
- VNPay: `vnp_TmnCode` + `vnp_HashSecret` + IPN endpoint
- DRM vendor + license server
- File nội dung China Literature + pipeline dịch CN→VI

## Trạng thái — rõ ràng
| Hạng mục | Deploy chạy được | Tiền thật chạy |
|---|---|---|
| Auth / ví / mở khóa / đo phút đọc | ✅ ngay | ✅ |
| Nạp coin / membership | ✅ (mock) | ❌ cần credential + webhook |
| DRM | ⚠️ token, chưa mã hóa | ❌ cần vendor |
| Nội dung | seed mẫu 10 truyện | ❌ cần file CL |

**Nguyên tắc an toàn:** giữ `DVERSE_BILLING=mock` cho tới khi credential thật đã test xong trên sandbox.
Đừng bật `real` rồi đẩy thẳng production khi chưa có webhook xác nhận — sẽ lệch tiền.
