'use strict';
/**
 * Tải + validate env. Fail-fast lúc boot nếu thiếu secret bắt buộc ở production.
 * Không bao giờ log giá trị secret.
 */

function bool(v, def) { if (v == null) return def; return /^(1|true|yes|on)$/i.test(String(v)); }
function int(v, def) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : def; }
function list(v) { return (v || '').split(',').map((s) => s.trim()).filter(Boolean); }

const env = process.env;
const NODE_ENV = env.NODE_ENV || 'development';
const isProd = NODE_ENV === 'production';

const config = {
  nodeEnv: NODE_ENV,
  isProd,
  port: int(env.PORT, 8080),

  // SQLite (Railway: TRỎ VÀO VOLUME BỀN, vd /data/dverse.db — KHÔNG để trong container ephemeral)
  dbPath: env.DB_PATH || './data/dverse.db',

  // Secrets
  jwtSecret: env.JWT_SECRET || (isProd ? '' : 'dev-jwt-secret-change-me'),
  jwtAccessTtlSec: int(env.JWT_ACCESS_TTL_SEC, 900),          // 15m
  jwtRefreshTtlSec: int(env.JWT_REFRESH_TTL_SEC, 60 * 60 * 24 * 30), // 30d
  drmSecret: env.DRM_SECRET || (isProd ? '' : 'dev-drm-secret-change-me'),
  drmTokenTtlSec: int(env.DRM_TOKEN_TTL_SEC, 90),             // token đọc chương sống 90s

  // OTP
  otpTtlSec: int(env.OTP_TTL_SEC, 300),
  otpMaxAttempts: int(env.OTP_MAX_ATTEMPTS, 5),
  otpProvider: env.OTP_PROVIDER || 'stub',                    // 'stub' | 'telco' (cắm gateway thật)

  // VNPay
  vnp: {
    tmnCode: env.VNP_TMN_CODE || '',
    hashSecret: env.VNP_HASH_SECRET || '',
    returnUrl: env.VNP_RETURN_URL || '',
    payUrl: env.VNP_PAY_URL || 'https://sandbox.vnpayment.vn/paymentv2/vpcpay.html',
    enabled: bool(env.DVERSE_VNPAY, false),
  },

  // Telco DCB (charging API — provider-specific, cắm khi tích hợp)
  dcb: {
    enabled: bool(env.DCB_ENABLED, false),
    callbackSecret: env.DCB_CALLBACK_SECRET || '',
  },

  // Security
  corsOrigins: list(env.CORS_ORIGINS) , // vd https://vivevd-bot.github.io
  rateLimit: {
    windowSec: int(env.RL_WINDOW_SEC, 60),
    authMax: int(env.RL_AUTH_MAX, 10),       // OTP/login mỗi IP/phút
    spendMax: int(env.RL_SPEND_MAX, 30),     // spend/gacha/unlock mỗi user/phút
    chapterMax: int(env.RL_CHAPTER_MAX, 40), // chương/phút/user — chống scrape
    defaultMax: int(env.RL_DEFAULT_MAX, 120),
  },

  // Free-tier ("đọc free khi chờ"): số chương free đầu + thời gian chờ mở chương kế (giờ)
  freeTier: {
    freeChapters: int(env.FREE_CHAPTERS, 10),
    waitUnlockHours: int(env.WAIT_UNLOCK_HOURS, 24),
  },
};

function validate() {
  const missing = [];
  if (config.isProd) {
    if (!config.jwtSecret) missing.push('JWT_SECRET');
    if (!config.drmSecret) missing.push('DRM_SECRET');
    if (config.corsOrigins.length === 0) missing.push('CORS_ORIGINS');
    if (config.vnp.enabled && (!config.vnp.tmnCode || !config.vnp.hashSecret || !config.vnp.returnUrl)) {
      missing.push('VNP_TMN_CODE/VNP_HASH_SECRET/VNP_RETURN_URL');
    }
  }
  if (missing.length) {
    throw new Error('[config] Thiếu env bắt buộc ở production: ' + missing.join(', '));
  }
}

module.exports = { config, validate };
