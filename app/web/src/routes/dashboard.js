'use strict';
// บล็อก B08 · Dashboard ผู้บริหาร (/dashboard · /api/dashboard) + ส่งออก Excel/PDF (/api/dashboard/export)
// CONTRACT §2.9 §6.4 §6.8 (EXPORT) §7 · FR-22 FR-23 · BR-24 BR-25 BR-26 · DECISIONS §12 §18 · TEST-DATA §7
//
// - รับเรื่อง = คำขอที่ชำระสำเร็จ (มีเลขคำขอ) ที่ paid_at อยู่ในช่วง (รวม CANCELLED ที่เคยชำระ)
// - ปิดงาน = COMPLETED + REJECTED ที่ closed_at อยู่ในช่วง · ทันกำหนด = rules.isOnTime(closed_at, due_at) (รวม 16:30:00)
// - ทันกำหนด % = ทัน ÷ ปิดงาน × 100 (rules.roundHalfUp1) · ปิดงาน 0 → null / `–` · รายปีรวมยอดทุกเดือนแล้วคิด % (ไม่เฉลี่ย)
//   BUG_MODE B10 → หารด้วยรับเรื่องแทนปิดงาน (BUGS.md)
// - งานคงค้าง/เกินกำหนดคงค้าง คิด ณ นาฬิกาตอนนี้ ไม่ขึ้นกับช่วง แต่ขึ้นกับบริการ · งานในมือรายเจ้าหน้าที่ไม่ขึ้นกับตัวกรอง (A-41)
// - ช่วงเวลาตีความตามเวลาไทย: `YYYY-MM` = เดือน (ค.ศ.) · `YYYY` = ทั้งปี · ไม่ระบุ = เดือนของนาฬิกา
// - หน้าและไฟล์ส่งออกไม่มีข้อมูลส่วนบุคคล (ชื่อผู้ยื่น เลขบัตร เบอร์) · ไฟล์ส่งออกใช้ค่าชุดเดียวกับจอ + Audit `EXPORT`
//   detail `<format> <period> <service>` เช่น `xlsx 2026-11 ALL`
// - PDF สร้างเอง (ASCII · Helvetica) ใช้ xref stream แทนตาราง xref เพื่อไม่ให้ไบต์ดิบมีเลข 10 หลักที่ขึ้นต้นด้วย 0

const express = require('express');
const ExcelJS = require('exceljs');
const db = require('../db');
const clock = require('../lib/clock');
const rules = require('../lib/rules');
const { bug } = require('../lib/bugs');
const { requireRole } = require('../lib/auth');
const { sendError } = require('../lib/errors');
const { TH_MONTHS, SERVICES, bkkParts } = require('../lib/format');
const { renderPage, esc, raw, html, attrs, dt } = require('../views/layout');

const router = express.Router();
const ah = (fn) => (req, res, next) => Promise.resolve().then(() => fn(req, res, next)).catch(next);

const BACKLOG_STATUSES = new Set(['SUBMITTED', 'IN_REVIEW', 'NEED_FIX', 'PENDING_APPROVAL', 'APPROVED']);
const CLOSED_STATUSES = new Set(['COMPLETED', 'REJECTED']);
const NOT_RECEIVED_STATUSES = new Set(['DRAFT', 'PENDING_PAYMENT']);
const FORMATS = { xlsx: 'xlsx', pdf: 'pdf' };
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PDF_PAD_BYTES = 8192;

// ป้ายตัวชี้วัด 5 ช่อง (ลำดับเดียวกันบนจอ / xlsx แถว 2–6 / บรรทัด kpi ใน PDF)
const KPI_ROWS = [
  ['received', 'รับเรื่อง'],
  ['closed', 'ปิดงาน'],
  ['ontimePct', 'ทันกำหนด %'],
  ['backlog', 'งานคงค้าง'],
  ['overdue', 'เกินกำหนดคงค้าง'],
];

const pad2 = (n) => String(n).padStart(2, '0');

// ---------- ตัวกรอง ----------

function clockPeriod() {
  const p = bkkParts(clock.now());
  return `${p.year}-${pad2(p.month)}`;
}

// '2026-11' → { kind:'month', key:'2026-11' } · '2026' → { kind:'year', key:'2026' } · ผิดรูป → null
function parsePeriod(s) {
  const v = String(s).trim();
  let m = /^(\d{4})-(\d{2})$/.exec(v);
  if (m && +m[2] >= 1 && +m[2] <= 12) return { kind: 'month', key: v };
  m = /^(\d{4})$/.exec(v);
  if (m) return { kind: 'year', key: v };
  return null;
}

function periodLabel(period) {
  const p = parsePeriod(period);
  if (!p) return period;
  const year = +period.slice(0, 4);
  if (p.kind === 'year') return `ทั้งปี ${year + 543}`;
  return `${TH_MONTHS[+period.slice(5, 7) - 1]} ${year + 543}`;
}

function serviceList() {
  const rows = db.prepare('SELECT id, name FROM services ORDER BY sort_order, id').all();
  return rows.length ? rows : Object.values(SERVICES).map((s) => ({ id: s.id, name: s.name }));
}

// query → { period, service } · ค่าที่ผิด → { error } · ไม่ระบุ → ค่าเริ่มต้น (เดือนของนาฬิกา · ALL)
function readFilters(query) {
  const rawPeriod = query.period === undefined || query.period === '' ? clockPeriod() : String(query.period).trim();
  const rawService = query.service === undefined || query.service === '' ? 'ALL' : String(query.service).trim();
  const services = new Set(['ALL', ...serviceList().map((s) => s.id)]);
  if (!parsePeriod(rawPeriod) || !services.has(rawService)) return { error: true };
  return { period: rawPeriod, service: rawService };
}

// เวลา ISO → 'YYYY-MM' ตามเวลาไทย (ไม่พึ่งว่าเก็บ offset แบบใด)
function bkkMonth(x) {
  if (!x) return null;
  const p = bkkParts(x);
  return p ? `${p.year}-${pad2(p.month)}` : null;
}

function inPeriod(x, period) {
  const ym = bkkMonth(x);
  if (!ym) return false;
  return period.length === 4 ? ym.slice(0, 4) === period : ym === period;
}

// ---------- ตัวชี้วัด ----------

function workload() {
  const officers = db.prepare("SELECT username FROM users WHERE role = 'officer' ORDER BY id").all();
  const counts = new Map(db.prepare(
    "SELECT owner, COUNT(*) AS n FROM cases WHERE status = 'IN_REVIEW' AND owner IS NOT NULL GROUP BY owner"
  ).all().map((r) => [r.owner, r.n]));
  return officers.map((u) => ({ username: u.username, count: counts.get(u.username) || 0 }));
}

function computeDashboard({ period, service }) {
  const now = clock.now();
  const rows = db.prepare('SELECT service_id, status, paid_at, closed_at, due_at FROM cases').all()
    .filter((c) => service === 'ALL' || c.service_id === service);

  let received = 0;
  let closed = 0;
  let onTime = 0;
  let backlog = 0;
  let overdue = 0;
  for (const c of rows) {
    if (c.paid_at && !NOT_RECEIVED_STATUSES.has(c.status) && inPeriod(c.paid_at, period)) received += 1;
    if (CLOSED_STATUSES.has(c.status) && c.closed_at && inPeriod(c.closed_at, period)) {
      closed += 1;
      if (c.due_at && rules.isOnTime(c.closed_at, c.due_at)) onTime += 1;
    }
    if (BACKLOG_STATUSES.has(c.status)) {
      backlog += 1;
      if (c.status !== 'NEED_FIX' && c.due_at && rules.slaLevel(now, c.due_at, null, c.status) === 'overdue') overdue += 1;
    }
  }

  const den = bug('B10') ? received : closed; // B10: หารด้วยรับเรื่อง (ผิด)
  const ontimePct = den > 0 ? rules.roundHalfUp1((onTime * 100) / den) : null;

  return { received, closed, onTime, ontimePct, backlog, overdue, workload: workload() };
}

// ค่าที่แสดงบนจอ (ข้อความ) · ใช้ร่วมกับ xlsx
function pctText(p) {
  return p === null || p === undefined ? '–' : `${p.toFixed(1)}%`;
}

function displayValues(d) {
  return {
    received: String(d.received),
    closed: String(d.closed),
    ontimePct: pctText(d.ontimePct),
    backlog: String(d.backlog),
    overdue: String(d.overdue),
  };
}

// ---------- Audit ----------

// ใช้ writeAudit({ username, role, event, caseNo, fromStatus, toStatus, detail }) ของ lib/audit.js (append-only · บล็อกอื่นสร้าง)
// ถ้ามี · ยังไม่มีไฟล์หรือ signature ไม่ตรง (throw) → เขียนตาราง audit ตรง (1 แถวต่อการส่งออก 1 ครั้ง)
function writeExportAudit(user, detail) {
  let auditLib = null;
  try {
    auditLib = require('../lib/audit');
  } catch (err) {
    if (err.code !== 'MODULE_NOT_FOUND') throw err;
  }
  if (auditLib && typeof auditLib.writeAudit === 'function') {
    try {
      auditLib.writeAudit({
        username: user.username, role: user.role, event: 'EXPORT',
        caseNo: null, fromStatus: null, toStatus: null, detail,
      });
      return;
    } catch (err) {
      console.warn('[dashboard] lib/audit writeAudit ใช้ไม่ได้ → เขียนตาราง audit ตรง:', err.message);
    }
  }
  db.prepare(
    'INSERT INTO audit (time, username, role, event, case_no, from_status, to_status, detail) VALUES (?,?,?,?,?,?,?,?)'
  ).run(clock.nowIso(), user.username, user.role, 'EXPORT', null, null, null, detail);
}

// ---------- ไฟล์ส่งออก ----------

async function buildXlsx(filters, d) {
  const v = displayValues(d);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'e-Service';
  wb.created = clock.now();
  wb.modified = clock.now();

  const ws = wb.addWorksheet('Dashboard');
  ws.addRow(['ตัวชี้วัด', 'ค่า']);
  for (const [key, label] of KPI_ROWS) ws.addRow([label, v[key]]);
  ws.getRow(1).font = { bold: true };
  ws.getColumn(1).width = 22;
  ws.getColumn(2).width = 14;

  const meta = wb.addWorksheet('รายละเอียด');
  meta.addRow(['ช่วง', filters.period]);
  meta.addRow(['บริการ', filters.service]);
  meta.addRow(['ข้อมูล ณ', clock.nowIso()]);
  meta.addRow([]);
  meta.addRow(['เจ้าหน้าที่', 'งานในมือ']);
  for (const w of d.workload) meta.addRow([w.username, String(w.count)]);
  meta.getColumn(1).width = 22;
  meta.getColumn(2).width = 28;

  return Buffer.from(await wb.xlsx.writeBuffer());
}

// PDF 1 หน้า ข้อความ ASCII ล้วน · xref stream (/W [1 2 2]) ไม่มีตาราง xref ที่เป็นเลข 10 หลัก
function buildPdf(lines) {
  const pdfStr = (s) => `(${String(s).replace(/[\\()]/g, (m) => `\\${m}`)})`;
  let content = 'BT\n/F1 12 Tf\n16 TL\n50 790 Td\n';
  lines.forEach((line, i) => { content += `${i ? 'T*\n' : ''}${pdfStr(line)} Tj\n`; });
  content += 'ET\n';

  const bodies = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}endstream`,
  ];

  // หัวไฟล์ + บรรทัด comment เติมให้ไฟล์ > 8 KB: Buffer ของ Node ที่เล็กกว่า 4 KB มาจาก pool ร่วม (byteOffset ≠ 0)
  // และ pdf-parse (pdf.js 1.10) อ่านไฟล์แบบนั้นไม่ได้ → "Invalid PDF structure"
  const chunks = [Buffer.from(`%PDF-1.5\n%\xE2\xE3\xCF\xD3\n%${' '.repeat(PDF_PAD_BYTES)}\n`, 'latin1')];
  let offset = chunks[0].length;
  const offsets = [];
  bodies.forEach((b, i) => {
    const buf = Buffer.from(`${i + 1} 0 obj\n${b}\nendobj\n`, 'latin1');
    offsets.push(offset);
    chunks.push(buf);
    offset += buf.length;
  });

  const xrefObj = bodies.length + 1;
  offsets.push(offset); // ตัว xref stream เอง
  const size = xrefObj + 1;
  const entries = Buffer.alloc(size * 5);
  entries.writeUInt8(0, 0); entries.writeUInt16BE(0, 1); entries.writeUInt16BE(0xffff, 3); // obj 0 (free)
  offsets.forEach((off, i) => {
    const at = (i + 1) * 5;
    entries.writeUInt8(1, at);
    entries.writeUInt16BE(off, at + 1);
    entries.writeUInt16BE(0, at + 3);
  });
  chunks.push(Buffer.from(
    `${xrefObj} 0 obj\n<< /Type /XRef /Size ${size} /W [1 2 2] /Root 1 0 R /Length ${entries.length} >>\nstream\n`, 'latin1'
  ));
  chunks.push(entries);
  chunks.push(Buffer.from(`\nendstream\nendobj\nstartxref\n${offset}\n%%EOF\n`, 'latin1'));
  return Buffer.concat(chunks);
}

function pdfLines(filters, d) {
  const ontime = d.ontimePct === null ? '-' : `${d.ontimePct.toFixed(1)}%`;
  return [
    'e-Service Dashboard report (fictitious municipality)',
    `period=${filters.period} service=${filters.service}`,
    `as-of ${clock.nowIso()}`,
    `kpi received=${d.received} closed=${d.closed} ontime=${ontime} backlog=${d.backlog} overdue=${d.overdue}`,
    `workload ${d.workload.map((w) => `${w.username}=${w.count}`).join(' ')}`,
  ];
}

// ---------- API ----------

router.get('/api/dashboard', requireRole('executive'), (req, res) => {
  const filters = readFilters(req.query);
  if (filters.error) return sendError(res, 'BAD_REQUEST');
  const d = computeDashboard(filters);
  return res.json({
    received: d.received,
    closed: d.closed,
    onTime: d.onTime,
    ontimePct: d.ontimePct,
    backlog: d.backlog,
    overdue: d.overdue,
    workload: d.workload,
  });
});

router.get('/api/dashboard/export', requireRole('executive'), ah(async (req, res) => {
  const filters = readFilters(req.query);
  const format = FORMATS[String(req.query.format || '').toLowerCase()];
  if (filters.error || !format) return sendError(res, 'BAD_REQUEST');
  const d = computeDashboard(filters);
  const file = format === 'xlsx' ? await buildXlsx(filters, d) : buildPdf(pdfLines(filters, d));
  if (req.method !== 'HEAD') writeExportAudit(req.user, `${format} ${filters.period} ${filters.service}`);
  const name = `dashboard-${filters.period}-${filters.service}.${format}`;
  res.status(200)
    .set('Content-Type', format === 'xlsx' ? XLSX_TYPE : 'application/pdf')
    .set('Content-Disposition', `attachment; filename="${name}"`)
    .set('Content-Length', String(file.length));
  return res.end(file);
}));

// ---------- หน้า ----------

function periodOptions(selected) {
  const now = bkkParts(clock.now());
  const months = [];
  for (let i = 0; i < 12; i++) {
    const t = new Date(Date.UTC(now.year, now.month - 1 - i, 1));
    months.push(`${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}`);
  }
  const years = [String(now.year), String(now.year - 1)];
  if (!months.includes(selected) && !years.includes(selected)) (selected.length === 4 ? years : months).push(selected);
  const opt = (v) => `<option${attrs({ value: v, selected: v === selected })}>${esc(periodLabel(v))}</option>`;
  return `<optgroup label="รายเดือน">${months.map(opt).join('')}</optgroup>`
    + `<optgroup label="รายปี">${years.map(opt).join('')}</optgroup>`;
}

// ลิงก์ส่งออกไม่ใส่แอตทริบิวต์ download: server ตอบ Content-Disposition: attachment อยู่แล้ว
// (Chromium ส่ง <a download> ไปตัวจัดการดาวน์โหลดตรง ๆ จน e2e อ่าน header ของไฟล์ไม่ได้)
function exportHref(format, f) {
  return `/api/dashboard/export?format=${format}&period=${encodeURIComponent(f.period)}&service=${encodeURIComponent(f.service)}`;
}

const PAGE_SCRIPT = `
(function () {
  var form = document.getElementById('dash-filter');
  var period = document.getElementById('period-select');
  var service = document.getElementById('service-select');
  var region = document.getElementById('dash-kpis');
  var seq = 0;
  function qs() {
    return 'period=' + encodeURIComponent(period.value) + '&service=' + encodeURIComponent(service.value);
  }
  function syncLinks() {
    document.querySelectorAll('[data-export]').forEach(function (a) {
      a.setAttribute('href', '/api/dashboard/export?format=' + a.getAttribute('data-export') + '&' + qs());
    });
  }
  function setText(testid, v) {
    var el = document.querySelector('[data-testid="' + testid + '"]');
    if (el) el.textContent = v;
  }
  async function refresh() {
    var my = ++seq;
    syncLinks();
    try { history.replaceState(null, '', '/dashboard?' + qs()); } catch (e) { /* ไม่สำคัญ */ }
    region.setAttribute('aria-busy', 'true');
    var r = await eg.api('GET', '/api/dashboard?' + qs());
    if (my !== seq) return;
    region.removeAttribute('aria-busy');
    if (!r.ok || !r.data) { eg.showError((r.data && r.data.message) || 'โหลดข้อมูลไม่สำเร็จ'); return; }
    var d = r.data;
    setText('kpi-received', String(d.received));
    setText('kpi-closed', String(d.closed));
    setText('kpi-ontime-pct', d.ontimePct === null ? '\\u2013' : d.ontimePct.toFixed(1) + '%');
    setText('kpi-backlog', String(d.backlog));
    setText('kpi-overdue', String(d.overdue));
    var ontimeNote = document.getElementById('kpi-ontime-note');
    if (ontimeNote) ontimeNote.textContent = 'ทันกำหนด ' + d.onTime + ' งาน';
    (d.workload || []).forEach(function (w) {
      var row = document.querySelector('[data-testid="workload-row"][data-username="' + w.username + '"] [data-testid="workload-value"]');
      if (row) row.textContent = String(w.count);
    });
  }
  period.addEventListener('change', refresh);
  service.addEventListener('change', refresh);
  form.addEventListener('submit', function (e) { e.preventDefault(); refresh(); });
  document.querySelectorAll('[data-export]').forEach(function (a) { a.addEventListener('click', syncLinks); });
})();
`;

router.get('/dashboard', requireRole('executive'), (req, res) => {
  let f = readFilters(req.query);
  if (f.error) f = readFilters({}); // ตัวกรองไม่ถูกต้อง → ค่าเริ่มต้น
  const d = computeDashboard(f);
  const v = displayValues(d);
  const names = new Map(db.prepare("SELECT username, name FROM users WHERE role = 'officer'").all().map((u) => [u.username, u.name]));

  const serviceOptions = [{ id: 'ALL', name: 'ทุกบริการ' }, ...serviceList()]
    .map((s) => `<option${attrs({ value: s.id, selected: s.id === f.service })}>${esc(s.id === 'ALL' ? s.name : `${s.id} ${s.name}`)}</option>`)
    .join('');

  const kpi = (testid, label, value, note = '') => `<div class="kpi"><div class="label">${esc(label)}</div>`
    + `<div class="value" data-testid="${testid}">${esc(value)}</div>${note}</div>`;

  const workloadRows = d.workload.map((w) => `<tr${attrs({ 'data-testid': 'workload-row', 'data-username': w.username })}>
<td>${esc(names.get(w.username) || w.username)} <span class="muted">(${esc(w.username)})</span></td>
<td data-testid="workload-value">${w.count}</td>
</tr>`).join('\n');

  const body = html`
<h1>Dashboard ผู้บริหาร</h1>
<p class="muted">ข้อมูล ณ ${raw(dt('dashboard-as-of', clock.nowIso()))} · ไม่แสดงข้อมูลส่วนบุคคลของผู้ยื่น</p>
<form id="dash-filter" method="get" action="/dashboard" class="card filters" role="search" aria-label="ตัวกรอง Dashboard">
  <div class="field">
    <label for="period-select">ช่วงเวลา</label>
    <select id="period-select" name="period" data-testid="period-select">${raw(periodOptions(f.period))}</select>
  </div>
  <div class="field">
    <label for="service-select">บริการ</label>
    <select id="service-select" name="service" data-testid="service-select">${raw(serviceOptions)}</select>
  </div>
  <div class="actions">
    <button type="submit" class="btn btn-secondary">แสดงผล</button>
    <a class="btn" data-testid="export-xlsx-btn" data-export="xlsx" href="${exportHref('xlsx', f)}">ส่งออก Excel</a>
    <a class="btn" data-testid="export-pdf-btn" data-export="pdf" href="${exportHref('pdf', f)}">ส่งออก PDF</a>
  </div>
</form>
<section aria-labelledby="kpi-heading">
  <h2 id="kpi-heading">ตัวชี้วัด</h2>
  <div class="kpis" id="dash-kpis" aria-live="polite">
    ${raw(kpi('kpi-received', 'รับเรื่อง', v.received))}
    ${raw(kpi('kpi-closed', 'ปิดงาน', v.closed))}
    ${raw(kpi('kpi-ontime-pct', 'ทันกำหนด %', v.ontimePct, `<div class="muted" id="kpi-ontime-note">ทันกำหนด ${d.onTime} งาน</div>`))}
    ${raw(kpi('kpi-backlog', 'งานคงค้าง (ณ ตอนนี้)', v.backlog))}
    ${raw(kpi('kpi-overdue', 'เกินกำหนดคงค้าง (ณ ตอนนี้)', v.overdue))}
  </div>
</section>
<section aria-labelledby="workload-heading">
  <h2 id="workload-heading">งานในมือรายเจ้าหน้าที่</h2>
  <div class="table-wrap">
  <table class="table">
    <caption class="sr-only">จำนวนคำขอที่กำลังตรวจสอบซึ่งเจ้าหน้าที่แต่ละคนรับไว้ (ไม่ขึ้นกับตัวกรอง)</caption>
    <thead><tr><th scope="col">เจ้าหน้าที่</th><th scope="col">งานในมือ</th></tr></thead>
    <tbody>${raw(workloadRows)}</tbody>
  </table>
  </div>
</section>`;

  renderPage(req, res, { title: 'Dashboard', body, inlineScript: PAGE_SCRIPT });
});

module.exports = router;
