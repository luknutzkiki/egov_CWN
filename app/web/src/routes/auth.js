'use strict';
// ยืนยันตัวตน (บล็อก B04) · CONTRACT §1 §2.2 §2.3 §5 §6.1 · REQUIREMENTS BR-01..03 FR-01..03 · DECISIONS §1 §2
//
// หน้า:  GET /login (แท็บประชาชน ThaiD จำลอง + OTP · แท็บเจ้าหน้าที่ SSO จำลอง) · GET /register (ประชาชนเข้าครั้งแรก)
// API:   POST /api/auth/thaid/start · POST /api/auth/thaid/verify · POST /api/auth/register
//        POST /api/auth/staff/login · POST /api/auth/logout · GET /api/me
//
// ตัวนับ OTP ผิด/การล็อกเก็บในตาราง otp_attempts (คีย์ = lookupHash(เลขบัตร) · reset ล้างเพราะ DROP ตาราง)
//   - ผิดติดกัน 3 ครั้ง → locked_until = เวลาครั้งที่ 3 + 15 นาที (BR-02 · A-06) · ระหว่างล็อก OTP ถูกก็ยัง 423
//   - now ≥ locked_until → ปลดล็อก ตัวนับเริ่ม 0 · OTP ถูก → ตัวนับ 0
//   - เวลาอ่านจาก lib/clock เท่านั้น · ไม่เก็บเลขบัตร/เบอร์ตรง ๆ ใน DB หรือ session (NFR-04)
// ไม่มีบั๊ก BUG_MODE ในบล็อกนี้ (BUGS.md B01–B12 ไม่เกี่ยวกับการยืนยันตัวตน)

const express = require('express');
const db = require('../db');
const clock = require('../lib/clock');
const auth = require('../lib/auth');
const { sendError } = require('../lib/errors');
const cryptoLib = require('../lib/crypto');
const { validateThaiId } = require('../lib/rules');
const { TH_MONTHS } = require('../lib/format');
const { renderPage, esc } = require('../views/layout');

const OTP_CODE = '123456';            // A-05
const MAX_OTP_FAILS = 3;              // A-06
const LOCK_MS = 15 * 60 * 1000;       // 15 นาที
const MOBILE_RE = /^0\d{9}$/;         // BR-03
const UNKNOWN_CITIZEN_NAME = 'ผู้ใช้ ThaiD จำลอง'; // เลขบัตรถูกแต่ไม่อยู่ใน seed → ThaiD จำลองคืนชื่อนี้

const ah = (fn) => (req, res, next) => Promise.resolve().then(() => fn(req, res, next)).catch(next);

const router = express.Router();

// ---------- ตัวช่วย ----------

function normalizeIdNo(v) {
  if (typeof v === 'number') return String(v);
  return typeof v === 'string' ? v.trim() : '';
}

const isConsent = (v) => v === true || v === 1 || ['true', 'on', '1', 'yes'].includes(String(v).toLowerCase());

// สถานะล็อกปัจจุบันของเลขบัตร · ล็อกหมดอายุแล้ว → ลบแถว (ตัวนับเริ่ม 0)
function otpState(idHash, nowIso) {
  const row = db.prepare('SELECT fail_count, locked_until FROM otp_attempts WHERE id_hash = ?').get(idHash);
  if (!row) return { fails: 0, lockedUntil: null };
  if (row.locked_until) {
    if (nowIso < row.locked_until) return { fails: row.fail_count, lockedUntil: row.locked_until };
    db.prepare('DELETE FROM otp_attempts WHERE id_hash = ?').run(idHash);
    return { fails: 0, lockedUntil: null };
  }
  return { fails: row.fail_count, lockedUntil: null };
}

// ผลการกรอก OTP (ทำใน transaction เดียว) → { locked, lockedUntil } | { ok } | { fail, attemptsLeft }
const applyOtp = db.transaction((idHash, otp) => {
  const nowIso = clock.nowIso();
  const st = otpState(idHash, nowIso);
  if (st.lockedUntil) return { locked: true, lockedUntil: st.lockedUntil };
  if (otp === OTP_CODE) {
    db.prepare('DELETE FROM otp_attempts WHERE id_hash = ?').run(idHash);
    return { ok: true };
  }
  const fails = st.fails + 1;
  const lockedUntil = fails >= MAX_OTP_FAILS ? clock.toIso(clock.nowMs() + LOCK_MS) : null;
  db.prepare(`INSERT INTO otp_attempts (id_hash, fail_count, last_fail_at, locked_until) VALUES (?, ?, ?, ?)
    ON CONFLICT(id_hash) DO UPDATE SET fail_count = excluded.fail_count, last_fail_at = excluded.last_fail_at, locked_until = excluded.locked_until`)
    .run(idHash, fails, nowIso, lockedUntil);
  if (lockedUntil) return { locked: true, lockedUntil };
  return { fail: true, attemptsLeft: MAX_OTP_FAILS - fails };
});

// ประชาชนตามเลขบัตร · ไม่มีใน DB → สร้างแถวใหม่ (ยังไม่ลงทะเบียน) ด้วยชื่อจาก ThaiD จำลอง
function findOrCreateCitizen(idNo, idHash) {
  const found = db.prepare('SELECT id, name, registered FROM citizens WHERE id_hash = ?').get(idHash);
  if (found) return found;
  const info = db.prepare(`INSERT INTO citizens (id_hash, id_enc, name, email, registered, created_at)
    VALUES (?, ?, ?, '', 0, ?)`).run(idHash, cryptoLib.encrypt(idNo), UNKNOWN_CITIZEN_NAME, clock.nowIso());
  return { id: Number(info.lastInsertRowid), name: UNKNOWN_CITIZEN_NAME, registered: 0 };
}

const citizenSessionUser = (c) => ({ kind: 'citizen', id: c.id, username: null, name: c.name, role: 'citizen', dept: null, citizenId: c.id });

// ---------- API §6.1 ----------

router.post('/api/auth/thaid/start', (req, res) => {
  const idNo = normalizeIdNo(req.body && req.body.idNo);
  if (!validateThaiId(idNo)) return sendError(res, 'INVALID_ID');
  const st = otpState(cryptoLib.lookupHash(idNo), clock.nowIso());
  if (st.lockedUntil) return sendError(res, 'LOCKED', { lockedUntil: st.lockedUntil });
  return res.status(200).json({ status: 'OTP_SENT' });
});

router.post('/api/auth/thaid/verify', ah(async (req, res) => {
  const body = req.body || {};
  const idNo = normalizeIdNo(body.idNo);
  if (!validateThaiId(idNo)) return sendError(res, 'INVALID_ID');
  const idHash = cryptoLib.lookupHash(idNo);
  const otp = body.otp === undefined || body.otp === null ? '' : String(body.otp).trim();
  const r = applyOtp(idHash, otp);
  if (r.locked) return sendError(res, 'LOCKED', { lockedUntil: r.lockedUntil });
  if (r.fail) return sendError(res, 'OTP_INVALID', { attemptsLeft: r.attemptsLeft });

  const citizen = findOrCreateCitizen(idNo, idHash);
  if (citizen.registered) {
    await auth.login(req, citizenSessionUser(citizen));
    return res.status(200).json({ registered: true });
  }
  await auth.loginPendingCitizen(req, { citizenId: citizen.id, name: citizen.name });
  return res.status(200).json({ registered: false });
}));

router.post('/api/auth/register', ah(async (req, res) => {
  const pending = req.session && req.session.pendingCitizen;
  if (!pending) {
    if (auth.currentUser(req)) return sendError(res, 'INVALID_STATE'); // ลงทะเบียนแล้ว/ไม่ใช่ประชาชนใหม่ → 409
    return sendError(res, 'UNAUTHENTICATED');
  }
  const citizen = db.prepare('SELECT id, name, registered FROM citizens WHERE id = ?').get(pending.citizenId);
  if (!citizen) return sendError(res, 'UNAUTHENTICATED');
  if (citizen.registered) return sendError(res, 'INVALID_STATE');

  const body = req.body || {};
  const mobile = typeof body.mobile === 'string' ? body.mobile.trim() : (typeof body.mobile === 'number' ? String(body.mobile) : '');
  if (!MOBILE_RE.test(mobile)) return sendError(res, 'INVALID_MOBILE');
  if (!isConsent(body.consent)) return sendError(res, 'CONSENT_REQUIRED');
  const email = typeof body.email === 'string' ? body.email.trim() : '';

  const nowIso = clock.nowIso();
  db.prepare(`UPDATE citizens SET mobile_enc = ?, email = ?, registered = 1, consent_at = ?, registered_at = ? WHERE id = ?`)
    .run(cryptoLib.encrypt(mobile), email, nowIso, nowIso, citizen.id);
  await auth.login(req, citizenSessionUser(citizen));
  return res.status(201).json({ registered: true, landing: auth.landingFor({ role: 'citizen' }) });
}));

router.post('/api/auth/staff/login', ah(async (req, res) => {
  const body = req.body || {};
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const user = username ? db.prepare('SELECT id, username, password_hash, name, role, dept, active FROM users WHERE username = ?').get(username) : null;
  if (!user || !user.active || user.role === 'citizen' || !cryptoLib.verifyPassword(password, user.password_hash)) {
    return sendError(res, 'INVALID_CREDENTIALS');
  }
  const sessionUser = await auth.login(req, {
    kind: 'staff', id: user.id, username: user.username, name: user.name, role: user.role, dept: user.dept || null, citizenId: null,
  });
  db.prepare(`INSERT INTO audit (time, username, role, event, case_no, from_status, to_status, detail)
    VALUES (?, ?, ?, 'STAFF_LOGIN', NULL, NULL, NULL, '')`).run(clock.nowIso(), user.username, user.role);
  return res.status(200).json({ role: sessionUser.role, dept: sessionUser.dept, landing: auth.landingFor(sessionUser) });
}));

router.post('/api/auth/logout', ah(async (req, res) => {
  await auth.logout(req);
  res.clearCookie('egov.sid', { path: '/' });
  return res.status(204).end();
}));

router.get('/api/me', auth.requireLogin, (req, res) => {
  const u = auth.currentUser(req);
  return res.status(200).json({ username: u.username, name: u.name, role: u.role, dept: u.dept || null });
});

// ---------- หน้า /login ----------

const LOGIN_BODY = `
<h1>เข้าสู่ระบบ</h1>
<div class="card login-card">
  <div class="tabs" role="tablist" aria-label="ประเภทผู้ใช้" style="display:flex;flex-wrap:wrap;gap:.5rem;margin-bottom:1rem">
    <button type="button" class="btn tab" role="tab" id="tab-citizen" data-testid="login-tab-citizen" aria-selected="true" aria-controls="panel-citizen">ประชาชน</button>
    <button type="button" class="btn btn-secondary tab" role="tab" id="tab-staff" data-testid="login-tab-staff" aria-selected="false" aria-controls="panel-staff" tabindex="-1">เจ้าหน้าที่</button>
  </div>

  <section id="panel-citizen" role="tabpanel" aria-labelledby="tab-citizen">
    <form id="thaid-form" novalidate>
      <div class="field">
        <label for="thaid-id">เลขบัตรประชาชน 13 หลัก</label>
        <input type="text" id="thaid-id" name="idNo" data-testid="thaid-id-input" inputmode="numeric" autocomplete="off" aria-describedby="thaid-error">
        <p class="error-text" id="thaid-error" data-testid="thaid-error" role="alert" hidden></p>
      </div>
      <button type="submit" class="btn" data-testid="thaid-submit">เข้าสู่ระบบด้วย ThaiD (จำลอง)</button>
    </form>
    <div class="msg msg-error" id="lock-box" role="alert" hidden>
      <p data-testid="lock-message" id="lock-message"></p>
      <p>ปลดล็อกเวลา <time data-testid="lock-until" id="lock-until"></time></p>
    </div>
    <form id="otp-form" data-testid="otp-step" novalidate hidden>
      <p class="msg msg-info">ส่งรหัส OTP แล้ว (โหมดทดสอบใช้ 123456)</p>
      <div class="field">
        <label for="otp-input">รหัส OTP</label>
        <input type="text" id="otp-input" name="otp" data-testid="otp-input" inputmode="numeric" autocomplete="one-time-code" aria-describedby="otp-error otp-attempts-left">
        <p class="error-text" id="otp-error" data-testid="otp-error" role="alert" hidden></p>
        <p id="otp-attempts-left" data-testid="otp-attempts-left" hidden></p>
      </div>
      <button type="submit" class="btn" data-testid="otp-submit">ยืนยัน OTP</button>
    </form>
  </section>

  <section id="panel-staff" role="tabpanel" aria-labelledby="tab-staff" hidden>
    <form id="staff-form" novalidate>
      <div class="field">
        <label for="staff-username">ชื่อผู้ใช้</label>
        <input type="text" id="staff-username" name="username" data-testid="staff-username" autocomplete="username">
      </div>
      <div class="field">
        <label for="staff-password">รหัสผ่าน</label>
        <input type="password" id="staff-password" name="password" data-testid="staff-password" autocomplete="current-password" aria-describedby="staff-error">
      </div>
      <p class="error-text" id="staff-error" data-testid="staff-error" role="alert" hidden></p>
      <button type="submit" class="btn" data-testid="staff-submit">เข้าสู่ระบบเจ้าหน้าที่ (SSO ภาครัฐ จำลอง)</button>
    </form>
  </section>
</div>`;

// สคริปต์หน้า /login (inline · ทำงานหลัง DOM พร้อม)
const LOGIN_SCRIPT = `
(function () {
  var MONTHS = ${JSON.stringify(TH_MONTHS)};
  function $(id) { return document.getElementById(id); }
  function show(el, text) { if (text !== undefined) el.textContent = text; el.hidden = false; }
  function hide(el) { el.hidden = true; el.textContent = ''; }
  async function post(url, body) {
    var res = await fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) });
    var data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    return { status: res.status, data: data || {} };
  }
  // '2026-12-01T09:15:00+07:00' → '1 ธ.ค. 2569 09:15' (เวลาไทยจากสตริงตรง ๆ)
  function thaiDateTime(iso) {
    var m = /^(\\d{4})-(\\d{2})-(\\d{2})T(\\d{2}):(\\d{2})/.exec(iso || '');
    if (!m) return iso || '';
    return Number(m[3]) + ' ' + MONTHS[Number(m[2]) - 1] + ' ' + (Number(m[1]) + 543) + ' ' + m[4] + ':' + m[5];
  }

  function init() {
    var tabs = { citizen: $('tab-citizen'), staff: $('tab-staff') };
    var panels = { citizen: $('panel-citizen'), staff: $('panel-staff') };
    function select(name, focus) {
      Object.keys(tabs).forEach(function (k) {
        var on = k === name;
        tabs[k].setAttribute('aria-selected', on ? 'true' : 'false');
        tabs[k].tabIndex = on ? 0 : -1;
        tabs[k].classList.toggle('btn-secondary', !on);
        panels[k].hidden = !on;
      });
      if (focus) tabs[name].focus();
    }
    tabs.citizen.addEventListener('click', function () { select('citizen'); });
    tabs.staff.addEventListener('click', function () { select('staff'); });
    Object.keys(tabs).forEach(function (k) {
      tabs[k].addEventListener('keydown', function (e) {
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); select(k === 'citizen' ? 'staff' : 'citizen', true); }
      });
    });
    if (location.hash === '#staff') select('staff');

    var idInput = $('thaid-id'), thaidError = $('thaid-error');
    var otpForm = $('otp-form'), otpInput = $('otp-input'), otpError = $('otp-error'), attemptsLeft = $('otp-attempts-left');
    var lockBox = $('lock-box'), lockMsg = $('lock-message'), lockUntil = $('lock-until');
    var currentId = '';

    function showLock(data) {
      otpForm.hidden = true;
      hide(otpError); hide(attemptsLeft);
      lockMsg.textContent = data.message || '';
      var iso = data.lockedUntil || '';
      lockUntil.setAttribute('data-iso', iso);
      lockUntil.setAttribute('datetime', iso);
      lockUntil.textContent = thaiDateTime(iso);
      lockBox.hidden = false;
    }
    function clearLock() { lockBox.hidden = true; }

    $('thaid-form').addEventListener('submit', async function (e) {
      e.preventDefault();
      hide(thaidError); clearLock();
      otpForm.hidden = true; hide(otpError); hide(attemptsLeft);
      var idNo = idInput.value;
      var r = await post('/api/auth/thaid/start', { idNo: idNo });
      if (r.status === 200) {
        currentId = idNo;
        otpInput.value = '';
        otpForm.hidden = false;
        otpInput.focus();
      } else if (r.status === 423) {
        showLock(r.data);
      } else {
        show(thaidError, r.data.message || 'เลขบัตรประชาชนไม่ถูกต้อง');
        idInput.focus();
      }
    });

    otpForm.addEventListener('submit', async function (e) {
      e.preventDefault();
      hide(otpError); hide(attemptsLeft);
      var r = await post('/api/auth/thaid/verify', { idNo: currentId, otp: otpInput.value });
      if (r.status === 200) {
        location.assign(r.data.registered ? '/citizen' : '/register');
      } else if (r.status === 423) {
        showLock(r.data);
      } else if (r.status === 401) {
        show(otpError, r.data.message || '');
        if (typeof r.data.attemptsLeft === 'number') show(attemptsLeft, 'เหลือ ' + r.data.attemptsLeft + ' ครั้ง');
        otpInput.value = '';
        otpInput.focus();
      } else {
        show(otpError, r.data.message || '');
      }
    });

    var staffError = $('staff-error');
    $('staff-form').addEventListener('submit', async function (e) {
      e.preventDefault();
      hide(staffError);
      var r = await post('/api/auth/staff/login', { username: $('staff-username').value, password: $('staff-password').value });
      if (r.status === 200 && r.data.landing) {
        location.assign(r.data.landing);
      } else {
        show(staffError, r.data.message || '');
        $('staff-password').value = '';
      }
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();`;

router.get('/login', (req, res) => renderPage(req, res, {
  title: 'เข้าสู่ระบบ',
  user: null, // หน้าเข้าสู่ระบบไม่แสดงหัวเว็บของผู้ใช้
  body: LOGIN_BODY,
  inlineScript: LOGIN_SCRIPT,
}));

// ---------- หน้า /register ----------

function registerBody(name) {
  return `
<h1>ลงทะเบียนใช้งานครั้งแรก</h1>
<div class="card">
  <form id="reg-form" novalidate>
    <div class="field">
      <label for="reg-name">ชื่อ-สกุล (จาก ThaiD)</label>
      <input type="text" id="reg-name" name="name" data-testid="reg-name" value="${esc(name)}" readonly>
    </div>
    <div class="field">
      <label for="reg-mobile">เบอร์มือถือ (บังคับ)</label>
      <input type="tel" id="reg-mobile" name="mobile" data-testid="reg-mobile" inputmode="numeric" autocomplete="tel" aria-describedby="reg-error-mobile">
      <p class="error-text" id="reg-error-mobile" data-testid="reg-error-mobile" role="alert" hidden></p>
    </div>
    <div class="field">
      <label for="reg-email">อีเมล (ไม่บังคับ)</label>
      <input type="email" id="reg-email" name="email" data-testid="reg-email" autocomplete="email">
    </div>
    <div class="field">
      <label class="check" for="reg-consent"><input type="checkbox" id="reg-consent" name="consent" data-testid="reg-consent" aria-describedby="reg-error-consent">
        ข้าพเจ้ายินยอมให้เทศบาลนครตัวอย่างเก็บและประมวลผลข้อมูลส่วนบุคคลเพื่อให้บริการ e-Service ตาม พ.ร.บ.คุ้มครองข้อมูลส่วนบุคคล (PDPA)</label>
      <p class="error-text" id="reg-error-consent" data-testid="reg-error-consent" role="alert" hidden></p>
    </div>
    <button type="submit" class="btn" data-testid="reg-submit">ลงทะเบียน</button>
  </form>
</div>`;
}

const REGISTER_SCRIPT = `
(function () {
  function $(id) { return document.getElementById(id); }
  function init() {
    var errMobile = $('reg-error-mobile'), errConsent = $('reg-error-consent');
    $('reg-form').addEventListener('submit', async function (e) {
      e.preventDefault();
      errMobile.hidden = true; errMobile.textContent = '';
      errConsent.hidden = true; errConsent.textContent = '';
      var res = await fetch('/api/auth/register', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ mobile: $('reg-mobile').value, email: $('reg-email').value, consent: $('reg-consent').checked }),
      });
      var data = {};
      try { data = await res.json(); } catch (x) { data = {}; }
      if (res.status === 201) { location.assign(data.landing || '/citizen'); return; }
      if (data.code === 'INVALID_MOBILE') { errMobile.textContent = data.message; errMobile.hidden = false; $('reg-mobile').focus(); }
      else if (data.code === 'CONSENT_REQUIRED') { errConsent.textContent = data.message; errConsent.hidden = false; $('reg-consent').focus(); }
      else if (res.status === 401) { location.assign('/login'); }
      else if (res.status === 409) { location.assign('/citizen'); }
      else if (window.eg) { window.eg.showError(data.message || 'เกิดข้อผิดพลาด'); }
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();`;

router.get('/register', (req, res) => {
  const pending = req.session && req.session.pendingCitizen;
  if (!pending) {
    const user = auth.currentUser(req);
    return res.redirect(user ? auth.landingFor(user) : '/login');
  }
  const citizen = db.prepare('SELECT name, registered FROM citizens WHERE id = ?').get(pending.citizenId);
  if (!citizen) return res.redirect('/login');
  return renderPage(req, res, {
    title: 'ลงทะเบียน',
    user: null,
    body: registerBody(citizen.name),
    inlineScript: REGISTER_SCRIPT,
  });
});

module.exports = router;
