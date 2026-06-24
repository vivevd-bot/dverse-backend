/* DVERSE API client — drop-in thay localStorage trong demo React.
 * Cách dùng trong dverse-deploy-fixed.html:
 *   1. Thêm <script src="api-client.js"></script> trước script app.
 *   2. Đổi BASE sang domain API thật.
 *   3. Thay usePersist(coin/owned/pass/ledger...) bằng state load từ DV.me()/DV.catalog().
 *   4. spend()/unlock()/openChapter() gọi DV.* thay vì set localStorage.
 * Server giữ nguồn sự thật (coin, ownership, pass) — client không tự ý cộng/trừ.
 */
const DV = (() => {
  const BASE = (window.DVERSE_API || 'http://localhost:8787');
  let token = localStorage.getItem('dverse:token') || null;

  async function api(path, { method = 'GET', body } = {}) {
    const res = await fetch(BASE + path, {
      method,
      headers: Object.assign({ 'Content-Type': 'application/json' },
        token ? { Authorization: 'Bearer ' + token } : {}),
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) { token = null; localStorage.removeItem('dverse:token'); }
    return { status: res.status, data };
  }

  return {
    get token() { return token; },
    isAuthed: () => !!token,
    // auth
    requestOtp: (phone) => api('/auth/otp/request', { method: 'POST', body: { phone } }),
    async verifyOtp(phone, code) {
      const r = await api('/auth/otp/verify', { method: 'POST', body: { phone, code } });
      if (r.status === 200) { token = r.data.token; localStorage.setItem('dverse:token', token); }
      return r;
    },
    me: () => api('/me'),
    // catalog + reading
    catalog: () => api('/catalog'),
    book: (id) => api('/catalog/' + id),
    readChapter: (bookId, seq) => api(`/chapters/${bookId}/${seq}`),       // 200=body | 402=paywall
    unlock: (bookId, seq) => api(`/chapters/${bookId}/${seq}/unlock`, { method: 'POST' }),
    dailyFree: (bookId, seq) => api(`/chapters/${bookId}/${seq}/daily-free`, { method: 'POST' }),
    heartbeat: (bookId, seq, seconds) => api('/reading/heartbeat', { method: 'POST', body: { bookId, seq, seconds } }),
    // economy
    topup: (packageId, provider, channel) => api('/wallet/topup', { method: 'POST', body: { packageId, provider, channel } }),
    subscribe: (plan, provider, channel) => api('/membership/subscribe', { method: 'POST', body: { plan, provider, channel } }),
    ledger: () => api('/wallet/ledger'),
  };
})();
window.DV = DV;
