'use strict';
// โครงหน้า server-rendered ทุกหน้า (CONTRACT §2.1 · NFR-01 responsive · NFR-02 WCAG 2.1 AA · lang=th)
//
// ใช้ในบล็อกอื่น:
//   const { renderPage, esc, html, raw, dt, statusBadge, levelBadge, setFlash } = require('../views/layout');
//   renderPage(req, res, { title: 'คิวงาน', body: '<h1>…</h1>…', status: 200, scripts: ['/static/x.js'], inlineScript: '…' });
//   body เป็น HTML ที่เชื่อถือได้ (string หรือผลของ html``) — ค่าที่มาจากผู้ใช้ต้องผ่าน esc() หรือใส่ผ่าน html`` เสมอ
//
// ข้อความผลการกระทำ (`action-error` role=alert · `action-success` role=status) มีได้ชิ้นเดียวต่อหน้า:
//   - ฝั่งเซิร์ฟเวอร์: setFlash(req, 'error'|'success', ข้อความ) ก่อน redirect → หน้าถัดไปแสดงครั้งเดียว
//   - ฝั่งเบราว์เซอร์: eg.showError(ข้อความ) / eg.showSuccess(ข้อความ) จาก /static/app.js (สร้าง/แทนที่ชิ้นเดียว)
//   ห้าม render `action-error` / `action-success` เปล่า ๆ เอง (ซ้ำกันแล้ว locator ของ test จะเจอ 2 ชิ้น)

const { currentUser } = require('../lib/auth');
const { STATUS_TH, LEVEL_TH, ROLE_TH, thaiDateTime, thaiDate, iso } = require('../lib/format');
const { PAGE_MESSAGES } = require('../lib/errors');

const SITE_NAME = 'e-Service กลาง เทศบาลนครตัวอย่าง';

// ---------- escape / template ----------
class SafeHtml {
  constructor(s) { this.s = s; }
  toString() { return this.s; }
}

function esc(v) {
  if (v === null || v === undefined) return '';
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const raw = (s) => new SafeHtml(String(s ?? ''));

function renderValue(v) {
  if (v === null || v === undefined || v === false) return '';
  if (v instanceof SafeHtml) return v.s;
  if (Array.isArray(v)) return v.map(renderValue).join('');
  return esc(v);
}

// html`<td>${userInput}</td>` → escape อัตโนมัติ · ใส่ HTML ที่สร้างแล้วด้วย raw() หรือ html`` ซ้อน · array ต่อกันให้
function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += renderValue(values[i]) + strings[i + 1];
  return new SafeHtml(out);
}

// { 'data-case-no': 'EG-…', disabled: true, hidden: false } → ` data-case-no="EG-…" disabled`
function attrs(obj = {}) {
  let out = '';
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined || v === false) continue;
    out += v === true ? ` ${k}` : ` ${k}="${esc(v)}"`;
  }
  return out;
}

// ---------- ชิ้นส่วนที่ใช้บ่อย ----------
// วันเวลา: <time data-testid="sla-due" data-iso="2026-12-04T16:30:00+07:00">4 ธ.ค. 2569 16:30</time>
// opts.dateOnly → ข้อความ `2 ก.พ. 2570` และ data-iso `2027-02-02` (ถ้าส่ง 'YYYY-MM-DD' มา) · opts.prefix ต่อหน้าข้อความ
// opts.attrs เพิ่มแอตทริบิวต์ · value ว่าง → '' (หรือ opts.placeholder)
function dt(testid, value, opts = {}) {
  if (value === null || value === undefined || value === '') {
    return opts.placeholder !== undefined ? `<span${attrs({ 'data-testid': testid, ...opts.attrs })}>${esc(opts.placeholder)}</span>` : '';
  }
  const dateOnlyInput = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
  const isoVal = dateOnlyInput ? value : iso(value);
  const text = opts.dateOnly || dateOnlyInput ? thaiDate(value) : thaiDateTime(value);
  return `<time${attrs({ 'data-testid': testid, 'data-iso': isoVal, datetime: isoVal, ...opts.attrs })}>${esc((opts.prefix || '') + text)}</time>`;
}

// สถานะ: ข้อความไทย + data-status (+ สี แต่ไม่ใช้สีอย่างเดียว · NFR-11)
function statusBadge(testid, status, extraAttrs = {}) {
  return `<span${attrs({ class: `badge st-${status}`, 'data-testid': testid, 'data-status': status, ...extraAttrs })}>${esc(STATUS_TH[status] || status)}</span>`;
}

// ระดับเตือน: ข้อความไทย + data-level
function levelBadge(testid, level, extraAttrs = {}) {
  return `<span${attrs({ class: `badge lv-${level}`, 'data-testid': testid, 'data-level': level, ...extraAttrs })}>${esc(LEVEL_TH[level] || level)}</span>`;
}

// ---------- flash ----------
function setFlash(req, type, text) {
  if (req.session) req.session.flash = { type: type === 'success' ? 'success' : 'error', text: String(text) };
}

function takeFlash(req) {
  if (!req.session || !req.session.flash) return null;
  const f = req.session.flash;
  delete req.session.flash;
  return f;
}

function flashHtml(flash) {
  if (!flash) return '';
  if (flash.type === 'success') return `<div class="msg msg-success" data-testid="action-success" role="status">${esc(flash.text)}</div>`;
  return `<div class="msg msg-error" data-testid="action-error" role="alert">${esc(flash.text)}</div>`;
}

// ---------- หัวหน้าเว็บ ----------
const NAV = {
  citizen: [['nav-my-cases', '/citizen', 'คำขอของฉัน']],
  officer: [['nav-queue', '/officer/queue', 'คิวงาน']],
  head: [['nav-queue', '/officer/queue', 'คิวงาน'], ['nav-approvals', '/head/approvals', 'รออนุมัติ']],
  executive: [['nav-dashboard', '/dashboard', 'Dashboard']],
  auditor: [['nav-audit', '/audit', 'Audit Trail']],
  admin: [
    ['nav-admin-services', '/admin/services', 'บริการ'],
    ['nav-admin-holidays', '/admin/holidays', 'วันหยุด'],
    ['nav-admin-users', '/admin/users', 'ผู้ใช้'],
  ],
};

function bellCount(username) {
  if (!username) return 0;
  const db = require('../db');
  return db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE username = ?').get(username).n;
}

function headerHtml(user, currentPath) {
  if (!user) {
    return `<header class="app-header"><div class="bar"><a class="brand" href="/">${esc(SITE_NAME)}</a></div></header>`;
  }
  const links = (NAV[user.role] || []).map(([testid, href, label]) => {
    const current = currentPath === href || (currentPath || '').startsWith(href + '/');
    return `<li><a${attrs({ 'data-testid': testid, href, 'aria-current': current ? 'page' : null })}>${esc(label)}</a></li>`;
  });
  let bell = '';
  if (user.role === 'officer' || user.role === 'head') {
    const n = bellCount(user.username);
    bell = `<a class="bell" data-testid="nav-bell" href="/notifications">แจ้งเตือน <span class="count" data-testid="bell-count">${n}</span></a>`;
  }
  const roleAttrs = { 'data-testid': 'user-role', 'data-role': user.role, class: 'role' };
  if (user.role === 'officer') roleAttrs['data-dept'] = user.dept || '';
  return `<header class="app-header" data-testid="app-header">
  <div class="bar">
    <a class="brand" href="/">${esc(SITE_NAME)}</a>
    <nav aria-label="เมนูหลัก"><ul class="nav">${links.join('')}</ul></nav>
    <div class="userbox">
      <span class="who"><span data-testid="user-name">${esc(user.name)}</span> <span${attrs(roleAttrs)}>${esc(ROLE_TH[user.role] || user.role)}</span></span>
      ${bell}
      <form method="post" action="/logout" class="inline"><button type="submit" class="btn btn-light" data-testid="logout-btn">ออกจากระบบ</button></form>
    </div>
  </div>
</header>`;
}

// ---------- ทั้งหน้า ----------
// opts: { user, title, body, flash, currentPath, scripts: [src], inlineScript, head }
function layout(opts) {
  const user = opts.user || null;
  const title = opts.title ? `${opts.title} · ${SITE_NAME}` : SITE_NAME;
  const scripts = ['/static/app.js', ...(opts.scripts || [])]
    .map((src) => `<script src="${esc(src)}" defer></script>`).join('\n');
  const inline = opts.inlineScript ? `<script>${String(opts.inlineScript).replace(/<\/script/gi, '<\\/script')}</script>` : '';
  return `<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="stylesheet" href="/static/app.css">
${opts.head || ''}
</head>
<body>
<a class="skip-link" href="#main">ข้ามไปเนื้อหาหลัก</a>
${headerHtml(user, opts.currentPath)}
<main id="main" class="container" tabindex="-1">
<div id="flash-area" class="flash-area">${flashHtml(opts.flash)}</div>
${renderValue(opts.body instanceof SafeHtml || Array.isArray(opts.body) ? opts.body : raw(opts.body))}
</main>
<footer class="app-footer"><p>${esc(SITE_NAME)} (หน่วยงานสมมติ) · ThaiD, PromptPay และลายเซ็นดิจิทัลเป็นระบบจำลอง</p></footer>
${scripts}
${inline}
</body>
</html>`;
}

// ส่งหน้า HTML · opts เหมือน layout() + status (ค่าเริ่ม 200) · ผู้ใช้/flash/currentPath ดึงจาก req ให้
function renderPage(req, res, opts = {}) {
  const user = opts.user !== undefined ? opts.user : currentUser(req);
  const page = layout({
    ...opts,
    user,
    flash: opts.flash !== undefined ? opts.flash : takeFlash(req),
    currentPath: opts.currentPath || req.path,
  });
  res.status(opts.status || 200).type('html').set('Cache-Control', 'no-store').send(page);
  return res;
}

// 403 หน้า (`forbidden-msg`)
function renderForbidden(req, res) {
  return renderPage(req, res, {
    status: 403,
    title: 'ไม่มีสิทธิ์',
    body: `<h1>ไม่มีสิทธิ์</h1><p class="msg msg-error" data-testid="forbidden-msg">${esc(PAGE_MESSAGES.FORBIDDEN_PAGE)}</p>`,
  });
}

// 404 หน้า (`not-found-msg` = ไม่พบคำขอ) · ใช้ทั้งเลขที่ไม่มีและของคนอื่น (ห้ามเผยว่ามีอยู่)
function renderNotFound(req, res, message = PAGE_MESSAGES.NOT_FOUND_PAGE) {
  return renderPage(req, res, {
    status: 404,
    title: 'ไม่พบ',
    body: `<h1>ไม่พบข้อมูล</h1><p class="msg msg-error" data-testid="not-found-msg">${esc(message)}</p>`,
  });
}

module.exports = {
  SITE_NAME, SafeHtml, esc, raw, html, attrs, dt, statusBadge, levelBadge,
  setFlash, takeFlash, flashHtml, headerHtml, layout, renderPage, renderForbidden, renderNotFound,
};
