'use strict';
/**
 * VNPay — golive. Bảo mật cốt lõi nằm ở IPN:
 *  - Build secure hash theo spec v2.1.0 (sort key, urlencode, HMAC-SHA512).
 *  - IPN: verify chữ ký TRƯỚC; idempotency theo vnp_TxnRef; chỉ credit ví khi hợp lệ + chưa xử lý.
 *  - Trả đúng format VNPay yêu cầu {RspCode, Message}.
 * Đối soát/refund: trạng thái payments + ledger (kind=topup/refund).
 */
const { db } = require('../db');
const { config } = require('../lib/config');
const C = require('../lib/crypto');
const wallet = require('./wallet');
const { logger } = require('../lib/logger');

// gói nạp cố định (DCB/IAP là SKU cố định; ở đây map VND -> xu)
const PACKS = { '20000': 200, '50000': 520, '100000': 1100, '200000': 2300, '500000': 6000 };

const _payIns = db.prepare('INSERT INTO payments (user_id,provider,txn_ref,amount_vnd,coin,status,raw,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)');
const _payByRef = db.prepare('SELECT * FROM payments WHERE provider=? AND txn_ref=?');
const _payUpd = db.prepare('UPDATE payments SET status=?, raw=?, updated_at=? WHERE id=?');

function sortedQuery(params) {
  const keys = Object.keys(params).filter((k) => params[k] !== '' && params[k] != null).sort();
  return keys.map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(params[k])).join('&');
}

// Tạo URL thanh toán (return URL). amount tính theo VND.
function createPayment(userId, amountVnd, ip) {
  if (!config.vnp.enabled) return { ok: false, code: 'VNP_DISABLED' };
  const coin = PACKS[String(amountVnd)];
  if (!coin) return { ok: false, code: 'BAD_PACK' };
  const txnRef = 'DV' + Date.now() + C.nonce(3);
  _payIns.run(userId, 'vnpay', txnRef, amountVnd, coin, 'pending', null, Date.now(), Date.now());

  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const createDate = '' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
  const params = {
    vnp_Version: '2.1.0', vnp_Command: 'pay', vnp_TmnCode: config.vnp.tmnCode,
    vnp_Amount: amountVnd * 100, vnp_CurrCode: 'VND', vnp_TxnRef: txnRef,
    vnp_OrderInfo: 'Nap xu DVERSE ' + txnRef, vnp_OrderType: 'other',
    vnp_Locale: 'vn', vnp_ReturnUrl: config.vnp.returnUrl, vnp_IpAddr: ip || '127.0.0.1',
    vnp_CreateDate: createDate,
  };
  const data = sortedQuery(params);
  const hash = C.hmacSha512(config.vnp.hashSecret, data);
  const url = config.vnp.payUrl + '?' + data + '&vnp_SecureHash=' + hash;
  return { ok: true, payUrl: url, txnRef };
}

// IPN handler — VNPay gọi server->server. Đây là chỗ credit ví (KHÔNG credit ở return-url).
function handleIpn(query) {
  const params = Object.assign({}, query);
  const recvHash = params.vnp_SecureHash;
  delete params.vnp_SecureHash; delete params.vnp_SecureHashType;
  const data = sortedQuery(params);
  if (!C.verifyHmacSha512(config.vnp.hashSecret, data, recvHash)) {
    return { RspCode: '97', Message: 'Invalid signature' };
  }
  const txnRef = params.vnp_TxnRef;
  const pay = _payByRef.get('vnpay', txnRef);
  if (!pay) return { RspCode: '01', Message: 'Order not found' };
  if (Number(params.vnp_Amount) !== pay.amount_vnd * 100) return { RspCode: '04', Message: 'Invalid amount' };
  if (pay.status !== 'pending') return { RspCode: '02', Message: 'Order already confirmed' }; // idempotent

  const success = params.vnp_ResponseCode === '00' && params.vnp_TransactionStatus === '00';
  const tx = db.transaction(() => {
    if (success) {
      _payUpd.run('success', JSON.stringify(params), Date.now(), pay.id);
      wallet.grant(pay.user_id, 0, pay.coin, { kind: 'topup', label: 'Nạp xu VNPay', ref: txnRef, idemKey: 'vnpay:' + txnRef });
    } else {
      _payUpd.run('failed', JSON.stringify(params), Date.now(), pay.id);
    }
  });
  tx();
  logger.audit('payment.ipn', { ref: txnRef, success });
  return { RspCode: '00', Message: 'Confirm Success' };
}

module.exports = { createPayment, handleIpn, PACKS };
