/* ตัวช่วยฝั่งเบราว์เซอร์ที่ใช้ร่วมกันทุกหน้า (โหลดโดย views/layout.js อัตโนมัติ)
 *   const r = await eg.api('POST', '/api/drafts', { serviceId: 'SV-01', qty: 1 });  // r = { ok, status, data }
 *   await eg.api('POST', '/api/drafts/DR-0003/files', formData);                    // ส่ง FormData ได้ตรง ๆ
 *   eg.showError('ข้อความ') · eg.showSuccess('ข้อความ') · eg.clearMessages()
 *   → `action-error` (role=alert) / `action-success` (role=status) มีชิ้นเดียวต่อหน้าเสมอ
 */
(function () {
  'use strict';

  async function api(method, url, body) {
    const opts = { method: method, credentials: 'same-origin', headers: { Accept: 'application/json' } };
    if (body instanceof FormData) {
      opts.body = body;
    } else if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(url, opts);
    let data = null;
    const type = res.headers.get('content-type') || '';
    if (type.indexOf('application/json') !== -1) {
      try { data = await res.json(); } catch (e) { data = null; }
    }
    return { ok: res.ok, status: res.status, data: data };
  }

  function area() {
    let el = document.getElementById('flash-area');
    if (!el) {
      el = document.createElement('div');
      el.id = 'flash-area';
      el.className = 'flash-area';
      (document.querySelector('main') || document.body).prepend(el);
    }
    return el;
  }

  function show(type, text) {
    const testid = type === 'success' ? 'action-success' : 'action-error';
    const other = type === 'success' ? 'action-error' : 'action-success';
    document.querySelectorAll('[data-testid="' + other + '"]').forEach(function (n) { n.remove(); });
    let el = document.querySelector('[data-testid="' + testid + '"]');
    if (!el) {
      el = document.createElement('div');
      el.setAttribute('data-testid', testid);
      el.setAttribute('role', type === 'success' ? 'status' : 'alert');
      el.className = 'msg ' + (type === 'success' ? 'msg-success' : 'msg-error');
      area().appendChild(el);
    }
    el.textContent = text;
    return el;
  }

  function clearMessages() {
    document.querySelectorAll('[data-testid="action-error"],[data-testid="action-success"]').forEach(function (n) { n.remove(); });
  }

  window.eg = {
    api: api,
    showError: function (text) { return show('error', text); },
    showSuccess: function (text) { return show('success', text); },
    clearMessages: clearMessages,
  };
})();
