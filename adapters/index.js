'use strict';
/* ============================================================================
 * PARTNER ADAPTERS — đây là chỗ DND cắm credential thật vào.
 * Mock chạy được ngay để test end-to-end. Real provider = TODO, cần:
 *   - VNPT/Viettel/MobiFone: hợp đồng VAS + carrier-billing API + sandbox creds
 *   - VNPay: merchant ID + secret + IPN endpoint
 *   - DRM: chọn vendor (Widevine/PallyCon/...) + license server
 *   - Content: file nguồn + AI dịch CL (on-prem Singapore) hoặc tool độc lập
 * Mọi route gọi qua interface dưới đây → thay mock bằng real, KHÔNG đụng route.
 * ==========================================================================*/

// ---- 1. BILLING (nạp coin + mua membership) --------------------------------
// Rev-share theo kênh (đã chốt): VNPay direct ~2% | telco-billing 15-20%
//                                bundle 40-50% | IAP 30%
const CHANNEL_FEE = { direct: 0.02, telco_billing: 0.18, bundle: 0.45, iap: 0.30 };

class BillingAdapter {
  // charge() trả {status:'success'|'pending'|'failed', providerRef}
  async charge() { throw new Error('NotImplemented'); }
}

class MockBilling extends BillingAdapter {
  async charge({ provider, amountVnd }) {
    return { status: 'success', providerRef: `MOCK-${provider}-${Date.now()}` };
  }
}

// --- TODO real ---: ví dụ khung tích hợp telco billing (Vinaphone/VAS)
class TelcoBilling extends BillingAdapter {
  constructor(provider) { super(); this.provider = provider; }
  async charge() {
    throw new Error(
      `TelcoBilling[${this.provider}] chưa cấu hình. ` +
      `Cần: VAS short-code, API endpoint, HMAC secret, IPN callback URL.`);
  }
}
class VNPayDirect extends BillingAdapter {
  async charge() {
    throw new Error('VNPay chưa cấu hình. Cần: vnp_TmnCode, vnp_HashSecret, IPN URL.');
  }
}

function billingFor(provider, channel) {
  if (process.env.DVERSE_BILLING === 'real') {
    if (provider === 'vnpay') return new VNPayDirect();
    return new TelcoBilling(provider);
  }
  return new MockBilling();               // mặc định: chạy được ngay
}

// ---- 2. DRM (cấp phép đọc + chống copy) ------------------------------------
class DRMAdapter {
  // issueLicense → token đọc 1 chương cho 1 user (TTL ngắn)
  issueLicense() { throw new Error('NotImplemented'); }
  // wrap → bọc nội dung trước khi trả client (prod: encrypt)
  wrap(body) { return body; }
}
class MockDRM extends DRMAdapter {
  issueLicense(userId, bookId, seq) {
    return { lic: `LIC-${userId.slice(0,6)}-${bookId}-${seq}-${Date.now()}`, ttl: 3600 };
  }
  // TODO real: AES-GCM encrypt + watermark userId vào payload (forensic)
  wrap(body) { return body; }
}
const drm = new MockDRM();

// ---- 3. CONTENT IMPORT (China Literature / Kakao / Yuewen) -----------------
// Pipeline thật: nhận file nguồn → dịch CN→VI trực tiếp → QC → publish.
class ContentImporter {
  async importTitle() { throw new Error('NotImplemented'); }
}
class MockImporter extends ContentImporter {
  async importTitle(meta) { return { ok: true, note: 'mock: dùng seed catalog' }; }
}
const importer = new MockImporter();

module.exports = { billingFor, drm, importer, CHANNEL_FEE };
