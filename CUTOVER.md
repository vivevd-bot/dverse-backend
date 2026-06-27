# DVERSE Wallet Cutover — Runbook

## Điều kiện tiên quyết
- [ ] Migration đã chạy thành công (`RECONCILIATION PASS`)
- [ ] Railway DB đã backup

## Bước 1: Backup DB
```bash
# Railway Shell hoặc qua API
cp $DVERSE_DB ${DVERSE_DB}.bak.$(date +%Y%m%d_%H%M%S)
```

## Bước 2: Chạy migration (dry-run trước)
```bash
node src/db/migrate_coins.js
# Xem output, kiểm tra số user và tổng xu

node src/db/migrate_coins.js --commit
# Phải thấy: ✅ RECONCILIATION PASS
```

## Bước 3: Deploy cutover patch

Sửa 3 file (thay `require('../services/wallet')` → `require('../services/wallet_new')`):

### src/routes/index.js
```diff
-const wallet = require('../services/wallet');
+const wallet = require('../services/wallet_new');
```

### src/services/extras.js
```diff
-const wallet = require('./wallet');
+const wallet = require('./wallet_new');
```

### src/services/content.js
```diff
-const wallet = require('./wallet');
+const wallet = require('./wallet_new');
```

Commit + push → Railway auto-deploy.

## Bước 4: Verify trên user thật
```bash
# Lấy token user thật, kiểm tra balance trước và sau
curl -s $API/wallet/balance -H "Authorization: Bearer $TOKEN"

# Mở khoá 1 chương (spend test)
curl -s -X POST $API/chapters/b1/4/unlock -H "Authorization: Bearer $TOKEN"
curl -s $API/wallet/balance -H "Authorization: Bearer $TOKEN"
# Số dư phải giảm đúng price_coin
```

## Rollback (nếu có vấn đề)
```bash
# Revert 3 file về wallet cũ: git revert HEAD
# DB không cần rollback — coin_grants chỉ thêm bảng mới, wallet cũ không bị xoá
```

## Sau cutover an toàn
- Tắt hybrid balance trong routes (xoá đoạn đọc `wallet.coinFree/Paid` trong `/wallet/balance`)
- Có thể DROP bảng `wallet` sau 30 ngày monitor ổn định
