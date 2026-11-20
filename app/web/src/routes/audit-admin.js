'use strict';
// บล็อก B09 · Audit Trail (/audit · /api/audit*) + ผู้ดูแลระบบ (/admin/services · /admin/holidays · /admin/users)
// CONTRACT §2.10 §2.11 §5 §6.4 §6.5 §6.8 §7 · BR-27 BR-28 · DECISIONS §13
//
// - Audit เพิ่มได้อย่างเดียว: PUT/PATCH/DELETE (และเมธอดอื่นที่ไม่ใช่ GET) ที่ /api/audit และ /api/audit/:id → 405 ทุกบทบาท
//   (ตอบก่อนตรวจสิทธิ์ และตอบ 405 แม้ :id ไม่มีจริง)
// - ตัวกรองวันที่ใช้ช่วงเวลาไทย [from 00:00:00+07:00, วันถัดจาก to 00:00:00+07:00) เทียบกับสตริง ISO +07:00 ที่เก็บไว้
// - ADMIN_CHANGE บันทึกเฉพาะค่าที่เปลี่ยนจริง และเฉพาะคำขอที่สำเร็จ (คำขอที่ถูกปฏิเสธไม่บันทึก)
// - เขียนแถว audit ตรงเข้าตาราง audit ผ่านฟังก์ชันภายในไฟล์นี้ (ไม่พึ่ง signature ของ lib/audit.js ที่บล็อกอื่นสร้าง)

const express = require('express');
const db = require('../db');
const clock = require('../lib/clock');
const { requireRole } = require('../lib/auth');
const { sendError } = require('../lib/errors');
const { AUDIT_EVENTS, ROLES, DEPTS } = db;
const { renderPage, esc, raw, html, attrs, dt } = require('../views/layout');

const router = express.Router();
const ah = (fn) => (req, res, next) => Promise.resolve().then(() => fn(req, res, next)).catch(next);

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FEE_MAX = 100000;
const SLA_MIN = 1;
const SLA_MAX = 60;

// ---------- ตัวช่วย ----------
function writeAdminAudit(user, detail) {
  db.prepare(
    'INSERT INTO audit (time, username, role, event, case_no, from_status, to_status, detail) VALUES (?,?,?,?,?,?,?,?)'
  ).run(clock.nowIso(), user.username, user.role, 'ADMIN_CHANGE', null, null, null, detail);
}

function writeExportAudit(user, detail) {
  db.prepare(
    'INSERT INTO audit (time, username, role, event, case_no, from_status, to_status, detail) VALUES (?,?,?,?,?,?,?,?)'
  ).run(clock.nowIso(), user.username, user.role, 'EXPORT', null, null, null, detail);
}

function validYmd(s) {
  const m = DATE_RE.exec(String(s));
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

function nextYmd(s) {
  const m = DATE_RE.exec(s);
  const t = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1));
  return t.toISOString().slice(0, 10);
}

// รับจำนวนเต็มที่เป็นตัวเลข หรือสตริงตัวเลขจำนวนเต็ม · อย่างอื่น → null
function toInt(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? v : null;
  if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return Number(v.trim());
  return null;
}

const validFee = (n) => n !== null && n >= 0 && n <= FEE_MAX;
const validSla = (n) => n !== null && n >= SLA_MIN && n <= SLA_MAX;

const q1 = (v) => (typeof v === 'string' ? v.trim() : '');

// ---------- Audit: query ----------
// คืน { error } หรือ { rows, filters }
function queryAudit(query) {
  const actor = q1(query.actor);
  const event = q1(query.event);
  const from = q1(query.from);
  const to = q1(query.to);
  if (event && !AUDIT_EVENTS.includes(event)) return { error: true };
  if ((from && !validYmd(from)) || (to && !validYmd(to))) return { error: true };

  const where = [];
  const args = [];
  if (actor) { where.push('username = ?'); args.push(actor); }
  if (event) { where.push('event = ?'); args.push(event); }
  if (from) { where.push('time >= ?'); args.push(`${from}T00:00:00+07:00`); }
  if (to) { where.push('time < ?'); args.push(`${nextYmd(to)}T00:00:00+07:00`); }
  const sql = 'SELECT id, time, username, role, event, case_no, from_status, to_status, detail FROM audit'
    + (where.length ? ' WHERE ' + where.join(' AND ') : '')
    + ' ORDER BY time DESC, id DESC';
  return { rows: db.prepare(sql).all(...args), filters: { actor, event, from, to } };
}

const toItem = (r) => ({
  id: r.id, time: r.time, username: r.username, role: r.role, event: r.event, caseNo: r.case_no,
  fromStatus: r.from_status, toStatus: r.to_status, detail: r.detail,
});

function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function filterQueryString(filters) {
  const p = new URLSearchParams();
  for (const k of ['actor', 'event', 'from', 'to']) if (filters[k]) p.set(k, filters[k]);
  const s = p.toString();
  return s ? `?${s}` : '';
}

// ---------- Audit: API ----------
// ห้ามแก้/ลบ/เพิ่มทางเว็บ: เมธอดอื่นนอกจาก GET/HEAD → 405 ทุกบทบาท (รวมไม่ล็อกอิน และ :id ที่ไม่มีจริง)
router.all(['/api/audit', '/api/audit/:id'], (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  res.set('Allow', 'GET');
  return sendError(res, 'METHOD_NOT_ALLOWED');
});

router.get('/api/audit/export.csv', requireRole('auditor'), (req, res) => {
  const r = queryAudit(req.query);
  if (r.error) return sendError(res, 'BAD_REQUEST');
  const lines = ['time,username,role,event,caseNo,fromStatus,toStatus,detail'];
  for (const x of r.rows) {
    lines.push([x.time, x.username, x.role, x.event, x.case_no, x.from_status, x.to_status, x.detail].map(csvCell).join(','));
  }
  writeExportAudit(req.user, 'audit-csv'); // บันทึกหลังเลือกแถว → ไฟล์ไม่มีแถว EXPORT ของตัวเอง
  res.status(200)
    .set('Content-Type', 'text/csv; charset=utf-8')
    .set('Content-Disposition', 'attachment; filename="audit.csv"')
    .set('Cache-Control', 'no-store')
    .send(lines.join('\r\n') + '\r\n');
});

router.get('/api/audit/:id', (req, res) => sendError(res, 'METHOD_NOT_ALLOWED'));

router.get('/api/audit', requireRole('auditor'), (req, res) => {
  const r = queryAudit(req.query);
  if (r.error) return sendError(res, 'BAD_REQUEST');
  res.set('Cache-Control', 'no-store').json({ count: r.rows.length, items: r.rows.map(toItem) });
});

// ---------- Audit: หน้า ----------
router.get('/audit', requireRole('auditor'), (req, res) => {
  let r = queryAudit(req.query);
  if (r.error) r = queryAudit({}); // ตัวกรองไม่ถูกต้อง → แสดงทั้งหมด
  const f = r.filters;

  const eventOptions = ['', ...AUDIT_EVENTS]
    .map((e) => `<option value="${esc(e)}"${e === f.event ? ' selected' : ''}>${e === '' ? 'ทั้งหมด' : esc(e)}</option>`)
    .join('');

  const rows = r.rows.map((x) => `<tr${attrs({
    'data-testid': 'audit-row', 'data-id': x.id, 'data-event': x.event, 'data-actor': x.username, 'data-case-no': x.case_no || '',
  })}>
<td>${dt('audit-time', x.time)}</td>
<td data-testid="audit-actor">${esc(x.username)}</td>
<td data-testid="audit-role">${esc(x.role)}</td>
<td data-testid="audit-event">${esc(x.event)}</td>
<td data-testid="audit-case-no">${x.case_no ? esc(x.case_no) : '–'}</td>
<td data-testid="audit-transition">${x.from_status || x.to_status ? esc(`${x.from_status || '–'} → ${x.to_status || '–'}`) : '–'}</td>
<td data-testid="audit-detail">${esc(x.detail)}</td>
</tr>`).join('\n');

  const body = html`
<h1>Audit Trail</h1>
<form method="get" action="/audit" class="filters" role="search">
  <label for="audit-filter-actor">ผู้ทำ (username)</label>
  <input type="text" id="audit-filter-actor" name="actor" data-testid="audit-filter-actor" value="${f.actor}" autocomplete="off">
  <label for="audit-filter-event">เหตุการณ์</label>
  <select id="audit-filter-event" name="event" data-testid="audit-filter-event">${raw(eventOptions)}</select>
  <label for="audit-filter-from">ตั้งแต่วันที่</label>
  <input type="date" id="audit-filter-from" name="from" data-testid="audit-filter-from" value="${f.from}">
  <label for="audit-filter-to">ถึงวันที่</label>
  <input type="date" id="audit-filter-to" name="to" data-testid="audit-filter-to" value="${f.to}">
  <button type="submit" class="btn" data-testid="audit-apply-btn">ค้นหา</button>
  <a class="btn" data-testid="audit-export-csv-btn" href="${'/api/audit/export.csv' + filterQueryString(f)}">ส่งออก CSV</a>
</form>
<p>จำนวนรายการ: <strong data-testid="audit-count">${r.rows.length}</strong></p>
<div class="table-wrap">
<table class="table">
  <caption class="sr-only">รายการ Audit Trail เรียงจากใหม่ไปเก่า</caption>
  <thead><tr><th scope="col">เวลา</th><th scope="col">ผู้ทำ</th><th scope="col">บทบาท</th><th scope="col">เหตุการณ์</th><th scope="col">เลขคำขอ</th><th scope="col">สถานะก่อน → หลัง</th><th scope="col">รายละเอียด</th></tr></thead>
  <tbody>${raw(rows)}</tbody>
</table>
</div>`;
  renderPage(req, res, { title: 'Audit Trail', body });
});

// ---------- Admin: guard ----------
router.use(['/admin', '/api/admin'], requireRole('admin'));

// ---------- Admin: บริการ ----------
function serviceItem(s) {
  return { id: s.id, fee: s.fee, feePerSqm: s.fee_per_sqm === undefined ? null : s.fee_per_sqm, sla: s.sla };
}

const listServices = () => db.prepare('SELECT id, name, fee, fee_per_sqm, sla FROM services ORDER BY sort_order, id').all();

router.get('/api/admin/services', (req, res) => {
  res.set('Cache-Control', 'no-store').json({ items: listServices().map(serviceItem) });
});

router.put('/api/admin/services/:id', (req, res) => {
  const svc = db.prepare('SELECT id, fee, fee_per_sqm, sla FROM services WHERE id = ?').get(req.params.id);
  if (!svc) return sendError(res, 'NOT_FOUND');
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const isArea = svc.id === 'SV-03';

  // ฐาน/ค่าคงที่: SV-03 ใช้ feeBase (รับ fee เป็นชื่อแทนได้) · ฟิลด์ที่ไม่ส่งมา = ไม่เปลี่ยน
  const feeRaw = isArea && body.feeBase !== undefined ? body.feeBase : body.fee;
  const changes = []; // [ชื่อฟิลด์ในข้อความ, คอลัมน์, ค่าเดิม, ค่าใหม่]

  if (feeRaw !== undefined) {
    const n = toInt(feeRaw);
    if (!validFee(n)) return sendError(res, 'INVALID_FEE');
    changes.push(['fee', 'fee', svc.fee, n]);
  }
  if (isArea && body.feePerSqm !== undefined) {
    const n = toInt(body.feePerSqm);
    if (!validFee(n)) return sendError(res, 'INVALID_FEE');
    changes.push(['feePerSqm', 'fee_per_sqm', svc.fee_per_sqm, n]);
  }
  if (body.sla !== undefined) {
    const n = toInt(body.sla);
    if (!validSla(n)) return sendError(res, 'INVALID_SLA');
    changes.push(['sla', 'sla', svc.sla, n]);
  }

  db.transaction(() => {
    for (const [label, col, oldV, newV] of changes) {
      if (oldV === newV) continue;
      db.prepare(`UPDATE services SET ${col} = ? WHERE id = ?`).run(newV, svc.id);
      writeAdminAudit(req.user, `${svc.id} ${label} ${oldV} → ${newV}`);
    }
  })();
  const fresh = db.prepare('SELECT id, fee, fee_per_sqm, sla FROM services WHERE id = ?').get(svc.id);
  res.status(200).json({ ok: true, ...serviceItem(fresh) });
});

router.get('/admin/services', (req, res) => {
  const svcs = listServices();
  const num = (id, label, value) =>
    `<label for="${id}">${esc(label)}</label><input type="number" inputmode="numeric" step="1" id="${id}" data-testid="${id}" value="${esc(value)}">`;
  const rows = svcs.map((s) => {
    let feeCells;
    if (s.id === 'SV-01') feeCells = num(`svc-fee-${s.id}`, 'ค่าธรรมเนียมต่อฉบับ (฿)', s.fee);
    else if (s.id === 'SV-03') {
      feeCells = num(`svc-fee-${s.id}`, 'ค่าธรรมเนียมฐาน พื้นที่ 1–100 ตร.ม. (฿)', s.fee)
        + num(`svc-fee-per-sqm-${s.id}`, 'ค่าธรรมเนียมต่อ ตร.ม. ส่วนเกิน 100 (฿)', s.fee_per_sqm ?? 0);
    } else feeCells = num(`svc-fee-${s.id}`, 'ค่าธรรมเนียมคงที่ (฿)', s.fee);
    return `<section class="card" data-testid="service-row" data-service-id="${esc(s.id)}">
<h2>${esc(s.id)} · ${esc(s.name)}</h2>
<div class="form-row">${feeCells}${num(`svc-sla-${s.id}`, 'SLA (วันทำการ)', s.sla)}
<button type="button" class="btn svc-save" data-testid="svc-save-${esc(s.id)}" data-service-id="${esc(s.id)}">บันทึก</button></div>
</section>`;
  }).join('\n');

  const script = `
(function () {
  function val(id) { var el = document.getElementById(id); if (!el) return undefined; var v = el.value.trim(); return /^-?\\d+$/.test(v) ? Number(v) : (v === '' ? null : v); }
  document.querySelectorAll('.svc-save').forEach(function (btn) {
    btn.addEventListener('click', async function () {
      var id = btn.getAttribute('data-service-id');
      var body = { sla: val('svc-sla-' + id) };
      if (id === 'SV-03') { body.feeBase = val('svc-fee-' + id); body.feePerSqm = val('svc-fee-per-sqm-' + id); }
      else body.fee = val('svc-fee-' + id);
      var r = await eg.api('PUT', '/api/admin/services/' + encodeURIComponent(id), body);
      if (r.ok) eg.showSuccess('บันทึกแล้ว'); else eg.showError((r.data && r.data.message) || 'บันทึกไม่สำเร็จ');
    });
  });
})();`;
  renderPage(req, res, { title: 'จัดการบริการ', body: raw(`<h1>จัดการค่าธรรมเนียมและ SLA</h1>\n${rows}`), inlineScript: script });
});

// ---------- Admin: วันหยุด ----------
const listHolidays = () => db.prepare('SELECT date, name FROM holidays ORDER BY date').all();

router.get('/api/admin/holidays', (req, res) => {
  res.set('Cache-Control', 'no-store').json({ items: listHolidays() });
});

router.post('/api/admin/holidays', (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const date = typeof body.date === 'string' ? body.date.trim() : '';
  if (!validYmd(date)) return sendError(res, 'BAD_REQUEST');
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const ok = db.transaction(() => {
    if (db.prepare('SELECT 1 FROM holidays WHERE date = ?').get(date)) return false;
    db.prepare('INSERT INTO holidays (date, name) VALUES (?, ?)').run(date, name);
    writeAdminAudit(req.user, `holiday add ${date}`);
    return true;
  })();
  if (!ok) return sendError(res, 'DUPLICATE_HOLIDAY');
  res.status(201).json({ ok: true, date, name });
});

router.delete('/api/admin/holidays/:date', (req, res) => {
  const date = req.params.date;
  const ok = db.transaction(() => {
    const r = db.prepare('DELETE FROM holidays WHERE date = ?').run(date);
    if (!r.changes) return false;
    writeAdminAudit(req.user, `holiday delete ${date}`);
    return true;
  })();
  if (!ok) return sendError(res, 'NOT_FOUND');
  res.status(200).json({ ok: true, date });
});

router.get('/admin/holidays', (req, res) => {
  const rowHtml = (h) => `<tr data-testid="holiday-row" data-date="${esc(h.date)}"><td>${esc(h.date)}</td><td>${esc(h.name)}</td>`
    + `<td><button type="button" class="btn" data-testid="holiday-delete-btn" data-date="${esc(h.date)}" aria-label="ลบวันหยุด ${esc(h.date)}">ลบ</button></td></tr>`;
  const body = `<h1>จัดการวันหยุด</h1>
<form id="holiday-form" class="form-row" novalidate>
  <label for="holiday-date-input">วันที่ (YYYY-MM-DD)</label>
  <input type="text" id="holiday-date-input" data-testid="holiday-date-input" placeholder="2026-12-02" inputmode="numeric" autocomplete="off">
  <label for="holiday-name-input">ชื่อวันหยุด</label>
  <input type="text" id="holiday-name-input" data-testid="holiday-name-input" autocomplete="off">
  <button type="submit" class="btn" data-testid="holiday-add-btn">เพิ่มวันหยุด</button>
</form>
<div class="table-wrap"><table class="table">
<caption class="sr-only">รายการวันหยุด</caption>
<thead><tr><th scope="col">วันที่</th><th scope="col">ชื่อ</th><th scope="col">จัดการ</th></tr></thead>
<tbody id="holiday-body">${listHolidays().map(rowHtml).join('\n')}</tbody></table></div>`;

  const script = `
(function () {
  var tbody = document.getElementById('holiday-body');
  function render(items) {
    tbody.textContent = '';
    items.forEach(function (h) {
      var tr = document.createElement('tr');
      tr.setAttribute('data-testid', 'holiday-row'); tr.setAttribute('data-date', h.date);
      var a = document.createElement('td'); a.textContent = h.date;
      var b = document.createElement('td'); b.textContent = h.name;
      var c = document.createElement('td');
      var btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'btn'; btn.textContent = 'ลบ';
      btn.setAttribute('data-testid', 'holiday-delete-btn'); btn.setAttribute('data-date', h.date);
      btn.setAttribute('aria-label', 'ลบวันหยุด ' + h.date);
      c.appendChild(btn); tr.appendChild(a); tr.appendChild(b); tr.appendChild(c); tbody.appendChild(tr);
    });
  }
  async function refresh() { var r = await eg.api('GET', '/api/admin/holidays'); if (r.ok) render(r.data.items); }
  document.getElementById('holiday-form').addEventListener('submit', async function (e) {
    e.preventDefault();
    var date = document.getElementById('holiday-date-input').value.trim();
    var name = document.getElementById('holiday-name-input').value.trim();
    var r = await eg.api('POST', '/api/admin/holidays', { date: date, name: name });
    if (r.ok) {
      await refresh(); eg.showSuccess('เพิ่มวันหยุดแล้ว');
      document.getElementById('holiday-date-input').value = ''; document.getElementById('holiday-name-input').value = '';
    } else eg.showError((r.data && r.data.message) || 'เพิ่มวันหยุดไม่สำเร็จ');
  });
  tbody.addEventListener('click', async function (e) {
    var btn = e.target.closest('[data-testid="holiday-delete-btn"]'); if (!btn) return;
    var r = await eg.api('DELETE', '/api/admin/holidays/' + encodeURIComponent(btn.getAttribute('data-date')));
    if (r.ok) { await refresh(); eg.showSuccess('ลบวันหยุดแล้ว'); }
    else eg.showError((r.data && r.data.message) || 'ลบวันหยุดไม่สำเร็จ');
  });
})();`;
  renderPage(req, res, { title: 'จัดการวันหยุด', body: raw(body), inlineScript: script });
});

// ---------- Admin: ผู้ใช้ ----------
const listUsers = () => db.prepare('SELECT username, name, role, dept, active FROM users ORDER BY id').all();

router.get('/api/admin/users', (req, res) => {
  res.set('Cache-Control', 'no-store').json({
    items: listUsers().map((u) => ({ username: u.username, name: u.name, role: u.role, dept: u.dept || '', active: !!u.active })),
  });
});

router.put('/api/admin/users/:username', (req, res) => {
  const u = db.prepare('SELECT id, username, role, dept FROM users WHERE username = ?').get(req.params.username);
  if (!u) return sendError(res, 'NOT_FOUND');
  const body = req.body && typeof req.body === 'object' ? req.body : {};

  const newRole = body.role === undefined ? u.role : body.role;
  if (typeof newRole !== 'string' || !ROLES.includes(newRole)) return sendError(res, 'BAD_REQUEST');
  let newDept = u.dept;
  if (body.dept !== undefined) {
    if (body.dept === null || body.dept === '') newDept = null;
    else if (typeof body.dept === 'string' && DEPTS.includes(body.dept)) newDept = body.dept;
    else return sendError(res, 'BAD_REQUEST');
  }
  if (u.username === req.user.username && newRole !== u.role) return sendError(res, 'SELF_ROLE_CHANGE');

  db.transaction(() => {
    if (newRole !== u.role) writeAdminAudit(req.user, `${u.username} role ${u.role} → ${newRole}`);
    if (newDept !== u.dept) writeAdminAudit(req.user, `${u.username} dept ${u.dept || '-'} → ${newDept || '-'}`);
    db.prepare('UPDATE users SET role = ?, dept = ? WHERE id = ?').run(newRole, newDept, u.id);
  })();
  res.status(200).json({ ok: true, username: u.username, role: newRole, dept: newDept || '' });
});

router.get('/admin/users', (req, res) => {
  const opt = (v, label, cur) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(label)}</option>`;
  const roleLabels = { citizen: 'citizen', officer: 'officer', head: 'head', executive: 'executive', auditor: 'auditor', admin: 'admin' };
  const rows = listUsers().map((u) => {
    const rid = `role-${u.username}`;
    const did = `dept-${u.username}`;
    return `<tr data-testid="user-row" data-username="${esc(u.username)}">
<td>${esc(u.username)}</td><td>${esc(u.name)}</td>
<td><label class="sr-only" for="${esc(rid)}">บทบาทของ ${esc(u.username)}</label>
<select id="${esc(rid)}" data-testid="user-role-select">${ROLES.map((r) => opt(r, roleLabels[r], u.role)).join('')}</select></td>
<td><label class="sr-only" for="${esc(did)}">ฝ่ายของ ${esc(u.username)}</label>
<select id="${esc(did)}" data-testid="user-dept-select">${opt('', '(ไม่ระบุ)', u.dept || '')}${DEPTS.map((d) => opt(d, d, u.dept || '')).join('')}</select></td>
<td><button type="button" class="btn" data-testid="user-save-btn" data-username="${esc(u.username)}">บันทึก</button></td>
</tr>`;
  }).join('\n');

  const body = `<h1>จัดการผู้ใช้และบทบาท</h1>
<p>การเปลี่ยนบทบาทมีผลกับการล็อกอินครั้งถัดไป</p>
<div class="table-wrap"><table class="table">
<caption class="sr-only">รายชื่อผู้ใช้</caption>
<thead><tr><th scope="col">username</th><th scope="col">ชื่อ</th><th scope="col">บทบาท</th><th scope="col">ฝ่าย</th><th scope="col">จัดการ</th></tr></thead>
<tbody>${rows}</tbody></table></div>`;

  const script = `
(function () {
  document.querySelectorAll('[data-testid="user-save-btn"]').forEach(function (btn) {
    btn.addEventListener('click', async function () {
      var tr = btn.closest('tr');
      var role = tr.querySelector('[data-testid="user-role-select"]').value;
      var dept = tr.querySelector('[data-testid="user-dept-select"]').value;
      var r = await eg.api('PUT', '/api/admin/users/' + encodeURIComponent(btn.getAttribute('data-username')), { role: role, dept: dept });
      if (r.ok) eg.showSuccess('บันทึกแล้ว'); else eg.showError((r.data && r.data.message) || 'บันทึกไม่สำเร็จ');
    });
  });
})();`;
  renderPage(req, res, { title: 'จัดการผู้ใช้', body: raw(body), inlineScript: script });
});

module.exports = router;
