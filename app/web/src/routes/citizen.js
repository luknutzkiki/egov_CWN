'use strict';
/*
 * บล็อก B05 · ประชาชน: ร่าง · แนบไฟล์ · ชำระ QR · เลขคำขอ · ยกเลิก/ส่งแก้
 * CONTRACT §1 §2.4 §2.5 §2.6 (ฝั่ง citizen) §4 §5 §6.2 §6.7 §8 · REQUIREMENTS FR-04..11 BR-06..11 BR-20 BR-22 · DECISIONS §3..7 §18
 *
 * หน้า (citizen เท่านั้น · บทบาทอื่น 403 · ไม่ล็อกอิน → /login)
 *   GET  /citizen                              รายการคำขอ (my-case-row) + ร่าง/รอชำระ (my-draft-row) + เริ่มบริการ
 *   GET  /citizen/new/:service                 ขั้นตอนยื่น 3 ขั้น · ?draft=DR-0003 เปิดร่างเดิม · &step=1|2|3
 *                                              DRAFT → ขั้น 1 (ค่าเริ่ม) · PENDING_PAYMENT/ชำระแล้ว → ขั้น 3 เสมอ (ยอดล็อกแล้ว)
 *   GET  /citizen/new/:service/payment-panel   HTML ส่วนชำระเงิน (ขั้น 3) ให้ JS ในหน้าโหลดซ้ำ/โพลล์
 *   GET  /citizen/cases/:caseNo                รายละเอียดคำขอของตัวเอง · ของคนอื่น/ไม่มี → 404 `not-found-msg` (B06: เปิดได้)
 *   POST /citizen/cases/:caseNo/cancel         ฟอร์ม confirm-cancel-btn → redirect + flash
 *   POST /citizen/cases/:caseNo/resubmit       ฟอร์ม submit-fix-btn (multipart `file` ไม่บังคับ) → redirect + flash
 *
 * API (CONTRACT §6.2 · ร่าง/ไฟล์/ชำระ = citizen เจ้าของเท่านั้น: ของคนอื่น/ไม่มี → 404 NOT_FOUND · บทบาทอื่น 403 · ไม่ล็อกอิน 401)
 *   POST   /api/drafts                         {serviceId, qty|areaSqm} → 201 {draftId, fee}
 *   GET    /api/drafts · GET /api/drafts/:id   → {items:[…]} · รายละเอียดร่าง {…, files, missing, payment}
 *   PUT    /api/drafts/:id                     (นอก CONTRACT · หน้าเว็บใช้) แก้ qty/areaSqm ของร่าง DRAFT → 200 {draftId, fee}
 *   DELETE /api/drafts/:id                     DRAFT/PENDING_PAYMENT → 204 (ลบไฟล์และ ref ชำระของร่างนั้น) · ชำระแล้ว 409 INVALID_STATE
 *   POST   /api/drafts/:id/files               multipart file + docKey → 201 {fileId, name, docKey, size}
 *   DELETE /api/drafts/:id/files/:fileId       (นอก CONTRACT · ปุ่ม file-remove-btn) → 204
 *   POST   /api/drafts/:id/payment             → 201 {ref, amount, qrCreatedAt, qrExpiresAt} (ref ใหม่ทุกครั้ง · ref เก่าที่ค้างกลายเป็น EXPIRED)
 *   GET    /api/payments/:ref                  → {ref, amount, status PENDING|PAID|EXPIRED, qrCreatedAt, qrExpiresAt, caseNo, receiptNo, paidAt}
 *   GET    /api/cases                          → {items:[{caseNo, serviceId, status, dueAt, slaLevel, …}]} ของฉัน เรียงเลขมาก → น้อย
 *   GET    /api/cases/:caseNo                  citizen เจ้าของ (ได้ idNo) · officer/head (ได้ idMasked เท่านั้น) · บทบาทอื่น 403 (§6.7)
 *   POST   /api/cases/:caseNo/cancel           SUBMITTED ที่ไม่มีผู้รับ → 200 {status:'CANCELLED'} · อื่น 409 CANNOT_CANCEL
 *   POST   /api/cases/:caseNo/resubmit         NEED_FIX ภายใน 168 ชม. → 200 {status:'IN_REVIEW', dueAt} · 409 FIX_WINDOW_EXPIRED / INVALID_STATE
 *   POST   /api/test/payments/:ref/pay         (TEST_MODE · server.js ตอบ 404 ให้เองเมื่อปิด) {amount} → 200 {status, caseNo, receiptNo, duplicate}
 *
 * กฎสำคัญ
 *   - ค่าธรรมเนียม/อายุ QR/กำหนดเสร็จ/หยุดนับ/168 ชม. มาจาก lib/rules.js เท่านั้น (feeFor feeTable qrValid dueAt dueAfterResubmit fixDeadline)
 *   - ยอดถูกล็อกตอนร่างเข้า PENDING_PAYMENT (สร้าง QR ครั้งแรก) · QR ใหม่ใช้ยอดที่ล็อก (A-42)
 *   - ออกเลขคำขอ EG-<พ.ศ. ของเวลาชำระ>-xxxxxx และใบเสร็จ RC- เลขลำดับเดียวกัน ใน transaction เดียว (A-14 A-48)
 *   - callback ซ้ำ ref เดิม → duplicate:true เลขเดิม (idempotent)
 *   - hook 'auto-cancel' (order 10) ยกเลิก NEED_FIX ที่เลย ตีกลับ + 168 ชม. · ลงไทม์ไลน์ AUTO_CANCEL เวลา = เส้นตาย (A-46)
 *   - BUG_MODE: B02 ขนาดไฟล์ใช้ < แทน ≤ · B06 ประชาชนเปิดคำขอคนอื่นได้ (หน้า + GET API)
 *
 * export เพิ่ม (require('./citizen')): caseJson(caseRow, user) · payByRef(ref, amount) · autoCancelExpired(now)
 */

const express = require('express');
const QRCode = require('qrcode');
const db = require('../db');
const clock = require('../lib/clock');
const { bug } = require('../lib/bugs');
const auth = require('../lib/auth');
const { sendError, AppError, messageOf, missingDocsMessage } = require('../lib/errors');
const format = require('../lib/format');
const cryptoLib = require('../lib/crypto');
const rules = require('../lib/rules');
const hooks = require('../lib/hooks');
const layout = require('../views/layout');

const { esc, attrs, dt, statusBadge, levelBadge, renderPage, renderNotFound, setFlash } = layout;
const { SERVICES, STATUS_TH, PAYMENT_STATUS_TH, money } = format;

const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5,242,880 ไบต์ รวมค่านี้ (BR-07)
const MAX_FILES = 5;                    // ต่อคำขอ รวมทุกช่องแนบ (A-49)
const EXTRA_KEY = 'extra';
const EXTRA_NAME = 'เอกสารเพิ่มเติม';
const FEE_CODES = ['INVALID_QTY', 'INVALID_AREA', 'AREA_TOO_LARGE'];
const NO_REFUND = 'ค่าธรรมเนียมที่ชำระแล้วไม่คืน';
const STEP_TEXT = { 1: '1/3 กรอกข้อมูล', 2: '2/3 แนบเอกสาร', 3: '3/3 ชำระเงิน' };
const CASE_STEP_TEXT = { 1: 'ขั้นตอน 1/3 · ฝ่ายทะเบียน', 2: 'ขั้นตอน 2/3 · ฝ่ายโยธา', 3: 'ขั้นตอน 3/3 · หัวหน้าฝ่าย' };
const CLOSED = new Set(['COMPLETED', 'REJECTED', 'CANCELLED']);
const IN_PROGRESS = new Set(['IN_REVIEW', 'NEED_FIX', 'PENDING_APPROVAL', 'APPROVED']);

// บล็อก B07 (documents.js) มีตัวช่วย render เอกสาร/ไฟล์แนบ · โหลดตอนใช้ (ถ้าโหลดไม่ขึ้นใช้ของสำรองในไฟล์นี้)
function documentsLib() {
  try { return require('./documents'); } catch (_) { return null; }
}

// ---------------------------------------------------------------- ข้อมูล

const q = {
  service: () => db.prepare('SELECT * FROM services WHERE id = ?'),
  draftByNo: () => db.prepare('SELECT * FROM drafts WHERE draft_no = ?'),
  draftById: () => db.prepare('SELECT * FROM drafts WHERE id = ?'),
  draftsOf: () => db.prepare("SELECT * FROM drafts WHERE citizen_id = ? AND status IN ('DRAFT','PENDING_PAYMENT') ORDER BY id DESC"),
  filesOfDraft: () => db.prepare('SELECT id, draft_id, case_id, doc_key, name, mime, size, created_at FROM files WHERE draft_id = ? AND case_id IS NULL ORDER BY created_at, rowid'),
  filesOfCase: () => db.prepare('SELECT id, doc_key, name, mime, size, created_at FROM files WHERE case_id = ? ORDER BY created_at, rowid'),
  countCaseFiles: () => db.prepare('SELECT COUNT(*) AS n FROM files WHERE case_id = ?'),
  paymentByRef: () => db.prepare('SELECT * FROM payments WHERE ref = ?'),
  latestPayment: () => db.prepare('SELECT * FROM payments WHERE draft_id = ? ORDER BY id DESC LIMIT 1'),
  paidPayment: () => db.prepare("SELECT * FROM payments WHERE draft_id = ? AND status = 'PAID' ORDER BY id DESC LIMIT 1"),
  caseByNo: () => db.prepare('SELECT * FROM cases WHERE case_no = ?'),
  caseById: () => db.prepare('SELECT * FROM cases WHERE id = ?'),
  casesOf: () => db.prepare('SELECT * FROM cases WHERE citizen_id = ? ORDER BY case_no DESC'),
  citizen: () => db.prepare('SELECT id, name, id_enc FROM citizens WHERE id = ?'),
  docOfCase: () => db.prepare('SELECT * FROM documents WHERE case_id = ? ORDER BY id DESC LIMIT 1'),
  events: () => db.prepare('SELECT * FROM case_events WHERE case_id = ? ORDER BY at, id'),
  autoCancelled: () => db.prepare("SELECT COUNT(*) AS n FROM case_events WHERE case_id = ? AND type = 'AUTO_CANCEL'"),
  needFix: () => db.prepare("SELECT * FROM cases WHERE status = 'NEED_FIX'"),
  insEvent: () => db.prepare(`INSERT INTO case_events (case_id, at, type, actor, from_status, to_status, note, data)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
};

const serviceRow = (id) => q.service().get(id) || null;
const feeOf = (serviceId, input) => rules.feeFor(serviceId, input, serviceRow(serviceId));
const docsOf = (serviceId) => (SERVICES[serviceId] ? SERVICES[serviceId].docs : []);
const docKeysOf = (serviceId) => [...docsOf(serviceId).map((d) => d.key), EXTRA_KEY];
const holidays = () => rules.holidaysFrom(db);

function docLabel(key) {
  if (key === EXTRA_KEY) return EXTRA_NAME;
  for (const s of Object.values(SERVICES)) for (const d of s.docs) if (d.key === key) return d.name;
  return key;
}

// ชื่อเอกสารบังคับที่ยังไม่มีไฟล์ เรียงตามตาราง 4.3
function missingDocs(serviceId, files) {
  const have = new Set(files.map((f) => f.doc_key || f.docKey));
  return docsOf(serviceId).filter((d) => d.required && !have.has(d.key)).map((d) => d.name);
}

function addEvent(caseId, at, type, actor, from, to, note = null, data = null) {
  q.insEvent().run(caseId, at, type, actor, from, to, note, data ? JSON.stringify(data) : null);
}

function safeDecrypt(blob) {
  try { return cryptoLib.decrypt(blob) || ''; } catch (_) { return ''; }
}

// รับจำนวนเต็ม (ตัวเลขหรือสตริงตัวเลข) · อื่น ๆ → null
function toInt(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? v : null;
  if (typeof v === 'string' && /^\s*[+-]?\d+\s*$/.test(v)) return Number(v);
  return null;
}

// ยอดของร่าง: DRAFT = คำนวณใหม่จากค่าธรรมเนียมปัจจุบัน · เข้า PENDING_PAYMENT แล้ว = ยอดที่ล็อก (A-42)
function draftFee(d) {
  if (d.status !== 'DRAFT') return d.locked_fee !== null && d.locked_fee !== undefined ? d.locked_fee : d.fee;
  const r = feeOf(d.service_id, { qty: d.qty, areaSqm: d.area_sqm });
  return r.ok ? r.fee : d.fee;
}

// สถานะรายการชำระตามนาฬิกา · VOID (มี QR ใหม่แทน) แสดงเป็น EXPIRED
function paymentStatus(p, now = clock.now()) {
  if (p.status === 'PAID') return 'PAID';
  if (p.status !== 'PENDING') return 'EXPIRED';
  return rules.qrValid(p.qr_created_at, now) ? 'PENDING' : 'EXPIRED';
}

function paymentJson(p) {
  return {
    ref: p.ref,
    amount: p.amount,
    status: paymentStatus(p),
    qrCreatedAt: p.qr_created_at,
    qrExpiresAt: p.qr_expires_at,
    caseNo: p.case_no || null,
    receiptNo: p.receipt_no || null,
    paidAt: p.paid_at || null,
  };
}

const fileJson = (f) => ({ fileId: f.id, name: f.name, docKey: f.doc_key, size: f.size, mime: f.mime });

function draftJson(d, { full = false } = {}) {
  const out = {
    draftId: d.draft_no,
    serviceId: d.service_id,
    status: d.status,
    fee: draftFee(d),
    qty: d.qty === undefined ? null : d.qty,
    areaSqm: d.area_sqm === undefined ? null : d.area_sqm,
    updatedAt: d.updated_at,
  };
  if (!full) return out;
  const files = q.filesOfDraft().all(d.id);
  const p = q.latestPayment().get(d.id);
  const c = d.case_id ? q.caseById().get(d.case_id) : null;
  return {
    ...out,
    serviceName: SERVICES[d.service_id] ? SERVICES[d.service_id].name : d.service_id,
    lockedFee: d.locked_fee === undefined ? null : d.locked_fee,
    files: files.map(fileJson),
    missing: missingDocs(d.service_id, files),
    payment: p ? paymentJson(p) : null,
    caseNo: c ? c.case_no : null,
    createdAt: d.created_at,
  };
}

function slaLevelOf(c, now = clock.now(), hol = holidays()) {
  return rules.slaLevel(now, c.due_at, hol, c.status);
}

function fixDeadlineOf(c) {
  if (c.returned_at) return rules.fixDeadline(c.returned_at);
  return c.fix_deadline || null;
}

function fixWindowClosed(c, now) {
  if (c.returned_at) return rules.fixWindowExpired(c.returned_at, now);
  if (c.fix_deadline) return clock.parseIso(c.fix_deadline).getTime() <= now.getTime();
  return false;
}

// JSON ของคำขอ (CONTRACT §6.7) · เจ้าของ (citizen) ได้ idNo เต็ม · เจ้าหน้าที่/หัวหน้าได้ idMasked เท่านั้น (ห้ามมี idNo)
function caseJson(c, user) {
  const cz = q.citizen().get(c.citizen_id);
  const idNo = cz ? safeDecrypt(cz.id_enc) : '';
  const doc = q.docOfCase().get(c.id);
  const isCitizen = !!user && user.role === 'citizen';
  const out = {
    caseNo: c.case_no,
    serviceId: c.service_id,
    status: c.status,
    step: c.service_id === 'SV-03' ? (Number(c.step) || 1) : null,
    fee: c.fee,
    paidAt: c.paid_at,
    dueAt: c.due_at,
    slaLevel: slaLevelOf(c),
    owner: c.owner || null,
    returnCount: c.return_count || 0,
    closedAt: c.closed_at || null,
    applicantName: cz ? cz.name : '',
  };
  if (isCitizen) out.idNo = idNo;
  else out.idMasked = rules.maskId(idNo);
  Object.assign(out, {
    fixDeadline: c.status === 'NEED_FIX' ? fixDeadlineOf(c) : null,
    docNo: doc ? doc.doc_no : null,
    verifyCode: doc ? doc.verify_code : null,
    serviceName: SERVICES[c.service_id] ? SERVICES[c.service_id].name : c.service_id,
    qty: c.qty === undefined ? null : c.qty,
    areaSqm: c.area_sqm === undefined ? null : c.area_sqm,
    receiptNo: c.receipt_no || null,
    returnReason: c.status === 'NEED_FIX' ? c.return_reason || null : null,
    cancelledAt: c.cancelled_at || null,
  });
  return out;
}

// ---------------------------------------------------------------- ไฟล์แนบ (BR-06 BR-07 BR-08 · A-49)

// ชนิดไฟล์จาก magic bytes เท่านั้น (ไม่ดูนามสกุล/Content-Type)
function sniffMime(buf) {
  if (!buf || buf.length < 3) return null;
  if (buf.length >= 4 && buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return 'application/pdf'; // %PDF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  return null;
}

// multer ถอดชื่อไฟล์เป็น latin1 → ถ้าเป็น UTF-8 (เช่นชื่อไทย) แปลงกลับ
function fileName(file) {
  const raw = String((file && file.originalname) || 'file').split(/[\\/]/).pop() || 'file';
  if (!/[^\x00-\x7f]/.test(raw)) return raw;
  const utf8 = Buffer.from(raw, 'latin1').toString('utf8');
  return utf8.includes('\ufffd') ? raw : utf8;
}

// ตรวจไฟล์ 1 ชิ้น → mime · ผิด → throw AppError (ลำดับ: ขนาด → ชนิด → แบบแปลน PDF)
function checkFile(file, docKey) {
  const size = file.buffer ? file.buffer.length : Number(file.size) || 0;
  // B02: ไฟล์ 5,242,880 ไบต์พอดีถูกปฏิเสธ (ใช้ < แทน ≤)
  const sizeOk = bug('B02') ? size < MAX_FILE_BYTES : size <= MAX_FILE_BYTES;
  if (!sizeOk) throw new AppError('FILE_TOO_LARGE');
  const mime = sniffMime(file.buffer);
  if (!mime) throw new AppError('FILE_TYPE');
  if (docKey === 'plan' && mime !== 'application/pdf') throw new AppError('PLAN_NOT_PDF');
  return { mime, size };
}

const pickFiles = (req) => (Array.isArray(req.files) ? req.files : req.file ? [req.file] : [])
  .filter((f) => f && (f.fieldname === 'file' || f.fieldname === 'files' || f.fieldname === 'file[]'));

function insertFile({ draftId = null, caseId = null, docKey, file, mime, size, nowIso }) {
  const id = cryptoLib.randomId('f_');
  const name = fileName(file);
  db.prepare(`INSERT INTO files (id, draft_id, case_id, doc_key, name, mime, size, data, uploaded_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'citizen', ?)`).run(id, draftId, caseId, docKey, name, mime, size, file.buffer, nowIso);
  return { id, name, doc_key: docKey, size, mime };
}

// ---------------------------------------------------------------- ธุรกรรม

const createDraftTx = db.transaction((citizenId, serviceId, fee, qty, areaSqm, nowIso) => {
  const draftNo = format.numbers.draftNo(db.nextSeq('draft'));
  db.prepare(`INSERT INTO drafts (draft_no, citizen_id, service_id, qty, area_sqm, fee, locked_fee, status, case_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, NULL, 'DRAFT', NULL, ?, ?)`).run(draftNo, citizenId, serviceId, qty, areaSqm, fee, nowIso, nowIso);
  return draftNo;
});

const addDraftFileTx = db.transaction((draftId, docKey, file) => {
  const d = q.draftById().get(draftId);
  if (!d || d.status !== 'DRAFT') throw new AppError('INVALID_STATE');
  const { mime, size } = checkFile(file, docKey);
  if (q.filesOfDraft().all(draftId).length >= MAX_FILES) throw new AppError('FILE_COUNT');
  const nowIso = clock.nowIso();
  const f = insertFile({ draftId, docKey, file, mime, size, nowIso });
  db.prepare('UPDATE drafts SET updated_at = ? WHERE id = ?').run(nowIso, draftId);
  return f;
});

// สร้าง QR: ตรวจเอกสารบังคับ · DRAFT → ล็อกยอดตามค่าธรรมเนียมปัจจุบันแล้วเข้า PENDING_PAYMENT · ref ใหม่ทุกครั้ง
const createPaymentTx = db.transaction((draftId) => {
  const d = q.draftById().get(draftId);
  if (!d || d.status === 'SUBMITTED') throw new AppError('INVALID_STATE');
  const missing = missingDocs(d.service_id, q.filesOfDraft().all(d.id));
  if (missing.length) throw new AppError('MISSING_DOCS', { missing });
  const now = clock.now();
  const nowIso = clock.toIso(now);
  let amount;
  if (d.status === 'DRAFT') {
    const r = feeOf(d.service_id, { qty: d.qty, areaSqm: d.area_sqm });
    if (!r.ok) throw new AppError(r.code);
    amount = r.fee;
    db.prepare("UPDATE drafts SET status = 'PENDING_PAYMENT', fee = ?, locked_fee = ?, updated_at = ? WHERE id = ?").run(amount, amount, nowIso, d.id);
  } else {
    amount = d.locked_fee !== null && d.locked_fee !== undefined ? d.locked_fee : d.fee;
    db.prepare('UPDATE drafts SET updated_at = ? WHERE id = ?').run(nowIso, d.id);
  }
  db.prepare("UPDATE payments SET status = 'VOID' WHERE draft_id = ? AND status = 'PENDING'").run(d.id);
  const ref = format.numbers.paymentRef(db.nextSeq('payment'));
  const expires = rules.qrExpiresAt(nowIso);
  db.prepare(`INSERT INTO payments (ref, draft_id, amount, status, qr_created_at, qr_expires_at, paid_at, case_no, receipt_no)
    VALUES (?, ?, ?, 'PENDING', ?, ?, NULL, NULL, NULL)`).run(ref, d.id, amount, nowIso, expires);
  return { ref, amount, qrCreatedAt: nowIso, qrExpiresAt: expires };
});

// ธนาคารจำลองยิง callback: ออกเลขคำขอ + ใบเสร็จ + กำหนดเสร็จ ใน transaction เดียว (BR-09 BR-10 BR-11)
const payTx = db.transaction((ref, rawAmount) => {
  const p = q.paymentByRef().get(ref);
  if (!p) throw new AppError('NOT_FOUND');
  if (p.status === 'PAID') return { status: 'PAID', caseNo: p.case_no, receiptNo: p.receipt_no, duplicate: true };
  const d = q.draftById().get(p.draft_id);
  if (!d) throw new AppError('NOT_FOUND');
  const now = clock.now();
  const nowIso = clock.toIso(now);
  if (p.status !== 'PENDING' || !rules.qrValid(p.qr_created_at, now)) throw new AppError('QR_EXPIRED');
  const amount = toInt(rawAmount);
  if (amount === null || amount !== p.amount) throw new AppError('AMOUNT_MISMATCH');
  if (d.status !== 'PENDING_PAYMENT') throw new AppError('INVALID_STATE');

  const be = format.beYear(now);
  const seq = db.nextSeq(`case:${be}`);
  const caseNo = format.numbers.caseNo(be, seq);
  const receiptNo = format.numbers.receiptNo(be, seq); // ใบเสร็จลำดับเดียวกับเลขคำขอ (A-48)
  db.setSeq(`receipt:${be}`, seq);
  const svc = serviceRow(d.service_id);
  const dueAt = rules.dueAt(nowIso, rules.slaDaysOf(d.service_id, svc), holidays());
  const info = db.prepare(`INSERT INTO cases (case_no, draft_id, citizen_id, service_id, qty, area_sqm, fee, status, step, dept, owner, issuer,
      return_count, paid_at, receipt_no, due_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'SUBMITTED', ?, 'registry', NULL, NULL, 0, ?, ?, ?, ?, ?)`).run(
    caseNo, d.id, d.citizen_id, d.service_id,
    d.service_id === 'SV-01' ? d.qty : null,
    d.service_id === 'SV-03' ? d.area_sqm : null,
    p.amount, d.service_id === 'SV-03' ? 1 : null,
    nowIso, receiptNo, dueAt, d.created_at, nowIso,
  );
  const caseId = Number(info.lastInsertRowid);
  db.prepare('UPDATE files SET case_id = ? WHERE draft_id = ? AND case_id IS NULL').run(caseId, d.id);
  db.prepare("UPDATE drafts SET status = 'SUBMITTED', case_id = ?, updated_at = ? WHERE id = ?").run(caseId, nowIso, d.id);
  db.prepare("UPDATE payments SET status = 'PAID', paid_at = ?, case_no = ?, receipt_no = ? WHERE id = ?").run(nowIso, caseNo, receiptNo, p.id);
  db.prepare("UPDATE payments SET status = 'VOID' WHERE draft_id = ? AND id <> ? AND status = 'PENDING'").run(d.id, p.id);
  addEvent(caseId, nowIso, 'PAID', 'citizen', 'PENDING_PAYMENT', 'SUBMITTED', null, { receiptNo, amount: p.amount, ref });
  return { status: 'PAID', caseNo, receiptNo, duplicate: false };
});

// ยกเลิกโดยประชาชน: เฉพาะ SUBMITTED ที่ไม่มีผู้รับ · UPDATE แบบมีเงื่อนไข → ชนกับรับเรื่องสำเร็จฝั่งเดียว (A-62)
const cancelTx = db.transaction((caseId) => {
  const c = q.caseById().get(caseId);
  if (!c) throw new AppError('NOT_FOUND');
  if (c.status === 'SUBMITTED' && !c.owner) {
    const nowIso = clock.nowIso();
    const r = db.prepare(`UPDATE cases SET status = 'CANCELLED', cancelled_at = ?, owner = NULL, dept = NULL, updated_at = ?
      WHERE id = ? AND status = 'SUBMITTED' AND owner IS NULL`).run(nowIso, nowIso, c.id);
    if (r.changes !== 1) throw new AppError('CANNOT_CANCEL');
    addEvent(c.id, nowIso, 'CANCEL', 'citizen', 'SUBMITTED', 'CANCELLED');
    return { status: 'CANCELLED' };
  }
  if (CLOSED.has(c.status)) throw new AppError('INVALID_STATE');
  throw new AppError('CANNOT_CANCEL');
});

// ยกเลิกอัตโนมัติเมื่อเลยเวลาแก้ไข · เวลาในไทม์ไลน์ = ตีกลับ + 168 ชม. (A-46)
function autoCancelCase(c) {
  const at = fixDeadlineOf(c) || clock.nowIso();
  const r = db.prepare(`UPDATE cases SET status = 'CANCELLED', cancelled_at = ?, owner = NULL, dept = NULL, updated_at = ?
    WHERE id = ? AND status = 'NEED_FIX'`).run(at, at, c.id);
  if (r.changes === 1) addEvent(c.id, at, 'AUTO_CANCEL', 'system', 'NEED_FIX', 'CANCELLED', 'หมดเวลาแก้ไข 168 ชั่วโมง ระบบยกเลิกคำขออัตโนมัติ');
  return r.changes === 1;
}

function autoCancelExpired(now = clock.now()) {
  let n = 0;
  for (const c of q.needFix().all()) if (fixWindowClosed(c, now) && autoCancelCase(c)) n += 1;
  return n;
}

// ส่งแก้ไข: NEED_FIX ภายใน 168 ชม. → IN_REVIEW ผู้ถือเดิม ขั้นเดิม (A-29) · กำหนดเสร็จ + วันทำการที่หยุดนับ (BR-13 · A-42)
const resubmitTx = db.transaction((caseId, files, docKeyRaw) => {
  const c = q.caseById().get(caseId);
  if (!c) throw new AppError('NOT_FOUND');
  const now = clock.now();
  const nowIso = clock.toIso(now);
  if (c.status !== 'NEED_FIX') {
    if (c.status === 'CANCELLED' && q.autoCancelled().get(c.id).n > 0) return { error: 'FIX_WINDOW_EXPIRED' };
    throw new AppError('INVALID_STATE');
  }
  if (fixWindowClosed(c, now)) {
    autoCancelCase(c); // ยกเลิกให้มีผลแม้ request นี้ตอบ 409
    return { error: 'FIX_WINDOW_EXPIRED' };
  }
  const docKey = docKeysOf(c.service_id).includes(docKeyRaw) ? docKeyRaw : EXTRA_KEY;
  const checked = files.map((f) => ({ file: f, ...checkFile(f, docKey) }));
  if (checked.length && q.countCaseFiles().get(c.id).n + checked.length > MAX_FILES) throw new AppError('FILE_COUNT');
  for (const x of checked) insertFile({ caseId: c.id, docKey, file: x.file, mime: x.mime, size: x.size, nowIso });

  const hol = holidays();
  const returnedAt = c.returned_at || nowIso;
  const pausedDays = rules.pausedExtension(returnedAt, nowIso, hol);
  const dueAfter = rules.dueAfterResubmit(c.due_at, returnedAt, nowIso, hol);
  const r = db.prepare(`UPDATE cases SET status = 'IN_REVIEW', due_at = ?, fix_deadline = NULL, updated_at = ?
    WHERE id = ? AND status = 'NEED_FIX'`).run(dueAfter, nowIso, c.id);
  if (r.changes !== 1) throw new AppError('INVALID_STATE');
  addEvent(c.id, nowIso, 'RESUBMIT', 'citizen', 'NEED_FIX', 'IN_REVIEW', null,
    { pausedDays, dueBefore: c.due_at, dueAfter, files: checked.length });
  return { status: 'IN_REVIEW', dueAt: dueAfter, owner: c.owner || null };
});

function runResubmit(caseId, files, docKey) {
  const out = resubmitTx(caseId, files, docKey);
  if (out.error) throw new AppError(out.error);
  return out;
}

function payByRef(ref, amount) {
  return payTx(ref, amount);
}

// ---------------------------------------------------------------- hook ทุก request (CONTRACT §0 ข้อ 7 · A-46)

hooks.onRequest('auto-cancel', ({ now }) => { autoCancelExpired(now); }, { order: 10 });

// ---------------------------------------------------------------- ตัวช่วยสิทธิ์

// ร่าง/คำขอของประชาชนคนนี้ (ของคนอื่น = ไม่มี)
function ownDraft(user, draftNo) {
  const d = q.draftByNo().get(String(draftNo || ''));
  return d && d.citizen_id === user.citizenId ? d : null;
}

function ownCase(user, caseNo, { allowOthers = false } = {}) {
  const c = q.caseByNo().get(String(caseNo || ''));
  if (!c) return null;
  if (c.citizen_id === user.citizenId || allowOthers) return c;
  return null;
}

// ส่ง AppError เป็น JSON · error อื่นโยนต่อให้ตัวจัดการกลาง
function sendAppError(res, err, next) {
  if (err && err.isAppError) return sendError(res, err.code, err.extra || {}, { status: err.status });
  return next(err);
}

function errorText(err) {
  if (err && err.code === 'MISSING_DOCS' && err.extra && Array.isArray(err.extra.missing)) return missingDocsMessage(err.extra.missing);
  return err && err.isAppError ? messageOf(err.code) : messageOf('INTERNAL');
}

// ---------------------------------------------------------------- HTML ส่วนย่อย

const jsonScript = (id, obj) => `<script type="application/json" id="${id}">${JSON.stringify(obj).replace(/</g, '\\u003c')}</script>`;

function qrSvg(text, testid, label) {
  try {
    const m = QRCode.create(text, { errorCorrectionLevel: 'M' }).modules;
    let d = '';
    for (let r = 0; r < m.size; r++) for (let c = 0; c < m.size; c++) if (m.get(r, c)) d += `M${c + 4} ${r + 4}h1v1h-1z`;
    const n = m.size + 8;
    return `<svg${attrs({ 'data-testid': testid, xmlns: 'http://www.w3.org/2000/svg', viewBox: `0 0 ${n} ${n}`, width: 200, height: 200, role: 'img', 'aria-label': label, class: 'qr-image' })}><rect width="100%" height="100%" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
  } catch (_) {
    return `<div${attrs({ 'data-testid': testid, role: 'img', 'aria-label': label })}>${esc(text)}</div>`;
  }
}

function paymentStatusBadge(status) {
  return `<span${attrs({ class: `badge pay-${status}`, 'data-testid': 'payment-status', 'data-status': status })}>${esc(PAYMENT_STATUS_TH[status] || status)}</span>`;
}

const serviceLabel = (serviceId) => `${serviceId} ${SERVICES[serviceId] ? SERVICES[serviceId].name : ''}`.trim();

function inputSummary(row) {
  if (row.service_id === 'SV-01' && row.qty) return `จำนวน ${row.qty} ฉบับ`;
  if (row.service_id === 'SV-03' && row.area_sqm) return `พื้นที่ ${row.area_sqm} ตร.ม.`;
  return '';
}

// ขั้น 3: ส่วนชำระเงิน (render ฝั่งเซิร์ฟเวอร์ทั้งตอนเปิดหน้าและตอน JS โหลดซ้ำ)
function paymentPanelHtml(d) {
  const now = clock.now();
  if (d.status === 'SUBMITTED') {
    const c = d.case_id ? q.caseById().get(d.case_id) : null;
    const p = q.paidPayment().get(d.id);
    const amount = p ? p.amount : draftFee(d);
    return `<p>ยอดที่ต้องชำระ <strong data-testid="payment-amount">${esc(money(amount))}</strong></p>
<p>สถานะการชำระ ${paymentStatusBadge('PAID')}</p>
<section class="card receipt" aria-labelledby="receipt-h">
<h3 id="receipt-h">ใบเสร็จรับเงิน (ชำระสำเร็จ)</h3>
<dl class="kv">
<dt>เลขคำขอ</dt><dd data-testid="submitted-case-no">${esc(c ? c.case_no : (p && p.case_no) || '')}</dd>
<dt>เลขใบเสร็จ</dt><dd data-testid="receipt-no">${esc((p && p.receipt_no) || (c && c.receipt_no) || '')}</dd>
<dt>ยอดชำระ</dt><dd data-testid="receipt-amount">${esc(money(amount))}</dd>
<dt>วันเวลาชำระ</dt><dd>${dt('receipt-paid-at', (p && p.paid_at) || (c && c.paid_at))}</dd>
<dt>เลขอ้างอิง</dt><dd>${esc(p ? p.ref : '')}</dd>
</dl>
${c ? `<p><a class="btn" data-testid="go-case-btn" href="/citizen/cases/${esc(encodeURIComponent(c.case_no))}">ดูคำขอ</a></p>` : ''}
</section>`;
  }

  const amount = draftFee(d);
  let out = `<p>ยอดที่ต้องชำระ <strong data-testid="payment-amount">${esc(money(amount))}</strong></p>`;
  const p = q.latestPayment().get(d.id);
  if (!p) {
    return `${out}<p class="muted">กดสร้าง QR แล้วสแกนด้วยแอปธนาคาร (PromptPay จำลอง) · QR ใช้ได้ 15 นาที</p>
<p><button type="button" class="btn" data-testid="create-qr-btn" data-action="create-qr">สร้าง QR</button></p>`;
  }
  const st = paymentStatus(p, now);
  if (st === 'PENDING') {
    const payload = `PROMPTPAY-MOCK|ref=${p.ref}|amount=${p.amount}.00|biller=EGOV-DEMO`;
    out += `<div class="qr-box" data-poll="1">
${qrSvg(payload, 'qr-image', `QR PromptPay จำลอง เลขอ้างอิง ${p.ref}`)}
<p>เลขอ้างอิง <strong data-testid="qr-ref">${esc(p.ref)}</strong></p>
<p>${dt('qr-expires', p.qr_expires_at, { prefix: 'หมดอายุ ' })}</p>
<p>สถานะการชำระ ${paymentStatusBadge('PENDING')}</p>
<p><button type="button" class="btn btn-secondary" data-testid="refresh-payment-btn" data-action="refresh">ตรวจสอบการชำระเงิน</button></p>
</div>`;
    return out;
  }
  out += `<p class="msg msg-error" data-testid="qr-expired-msg">${esc(messageOf('QR_EXPIRED'))}</p>
<p class="muted">เลขอ้างอิงเดิม ${esc(p.ref)} · ${esc('หมดอายุ ' + format.thaiDateTime(p.qr_expires_at))}</p>
<p>สถานะการชำระ ${paymentStatusBadge('EXPIRED')}</p>
<p class="actions"><button type="button" class="btn" data-testid="regenerate-qr-btn" data-action="create-qr">สร้าง QR ใหม่</button>
<button type="button" class="btn btn-secondary" data-testid="refresh-payment-btn" data-action="refresh">ตรวจสอบการชำระเงิน</button></p>`;
  return out;
}

function fileItemHtml(f) {
  return `<li${attrs({ 'data-testid': 'file-item', 'data-name': f.name, 'data-doc-key': f.doc_key, 'data-file-id': f.id })}>
<span>${esc(docLabel(f.doc_key))}: ${esc(f.name)} (${esc(Math.max(1, Math.ceil(f.size / 1024)).toLocaleString('en-US'))} KB)</span>
<button type="button" class="btn btn-light" data-testid="file-remove-btn" data-file-id="${esc(f.id)}" aria-label="${esc(`ลบไฟล์ ${f.name}`)}">ลบ</button></li>`;
}

// ---------------------------------------------------------------- สคริปต์ฝั่งเบราว์เซอร์ (ไม่มีไฟล์ static ของบล็อกนี้ จึงฝังในหน้า)

const WIZARD_JS = String.raw`(function () {
  'use strict';
  var C = JSON.parse(document.getElementById('wizard-config').textContent);
  function tid(id, root) { return (root || document).querySelector('[data-testid="' + id + '"]'); }
  function money(n) { return '\u0E3F' + String(Math.round(Number(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function msgOf(r, fallback) { return (r && r.data && r.data.message) || fallback; }
  function setMsg(slotId, testid, text) {
    var slot = document.getElementById(slotId);
    var el = tid(testid);
    if (!text) { if (el) el.remove(); return; }
    if (!el) {
      el = document.createElement('p');
      el.setAttribute('data-testid', testid);
      el.setAttribute('role', 'alert');
      el.className = 'error-text';
      slot.appendChild(el);
    }
    el.textContent = text;
  }
  function draftUrl(step) {
    return '/citizen/new/' + C.service + '?draft=' + encodeURIComponent(C.draftId) + (step ? '&step=' + step : '');
  }

  // ---------- ขั้น 1 กรอกข้อมูล ----------
  if (C.step === 1) {
    var input = tid('qty-input') || tid('area-input');
    var feeEl = tid('fee-total');
    var toUpload = tid('to-upload-btn');
    var saveBtn = tid('save-draft-btn');
    var touched = !!(input && input.value !== '');
    var low = C.service === 'SV-01' ? 'INVALID_QTY' : 'INVALID_AREA';
    var high = C.service === 'SV-01' ? 'INVALID_QTY' : 'AREA_TOO_LARGE';
    var evaluate = function () {
      if (!input) return { ok: true, fee: C.feeTable.fee, body: {} };
      var raw = String(input.value).trim();
      if (!/^[+-]?\d+$/.test(raw)) return { ok: false, code: low };
      var v = parseInt(raw, 10);
      if (v < C.feeTable.min) return { ok: false, code: low };
      if (v > C.feeTable.max) return { ok: false, code: high };
      var body = {};
      body[C.service === 'SV-01' ? 'qty' : 'areaSqm'] = v;
      return { ok: true, fee: C.feeTable.fees[v], body: body };
    };
    var refresh = function () {
      var r = evaluate();
      feeEl.textContent = r.ok ? money(r.fee) : '\u2013';
      toUpload.disabled = !r.ok;
      if (input) input.setAttribute('aria-invalid', r.ok ? 'false' : 'true');
      setMsg('fee-error-slot', 'fee-error', r.ok || !touched ? '' : C.messages[r.code]);
      return r;
    };
    var showDraftId = function (id) {
      var el = tid('draft-id');
      if (!el) {
        var wrap = document.getElementById('draft-id-wrap');
        el = document.createElement('strong');
        el.setAttribute('data-testid', 'draft-id');
        wrap.appendChild(el);
        wrap.hidden = false;
      }
      el.textContent = id;
    };
    var busy = false;
    var save = async function () {
      touched = true;
      var r = refresh();
      if (!r.ok || busy) return null;
      busy = true;
      saveBtn.disabled = true;
      try {
        var res = C.draftId
          ? await eg.api('PUT', '/api/drafts/' + encodeURIComponent(C.draftId), r.body)
          : await eg.api('POST', '/api/drafts', Object.assign({ serviceId: C.service }, r.body));
        if (!res.ok) {
          if (res.data && C.feeCodes.indexOf(res.data.code) !== -1) setMsg('fee-error-slot', 'fee-error', res.data.message);
          else eg.showError(msgOf(res, 'บันทึกร่างไม่สำเร็จ'));
          return null;
        }
        C.draftId = res.data.draftId;
        showDraftId(C.draftId);
        feeEl.textContent = money(res.data.fee);
        history.replaceState(null, '', draftUrl(0));
        return res.data;
      } finally {
        busy = false;
        saveBtn.disabled = false;
      }
    };
    if (input) {
      input.addEventListener('input', function () { touched = true; refresh(); });
      input.addEventListener('change', function () { touched = true; refresh(); });
    }
    saveBtn.addEventListener('click', async function () {
      var d = await save();
      if (d) eg.showSuccess('บันทึกร่างแล้ว');
    });
    toUpload.addEventListener('click', async function () {
      if (toUpload.disabled) return;
      var d = await save();
      if (d) location.href = draftUrl(2);
    });
    refresh();
  }

  // ---------- ขั้น 2 แนบเอกสาร ----------
  if (C.step === 2) {
    var files = C.files.slice();
    var list = document.getElementById('file-list');
    var toPay = tid('to-payment-btn');
    var labelOf = function (key) { return C.docLabels[key] || key; };
    var render = function () {
      list.textContent = '';
      files.forEach(function (f) {
        var li = document.createElement('li');
        li.setAttribute('data-testid', 'file-item');
        li.setAttribute('data-name', f.name);
        li.setAttribute('data-doc-key', f.docKey);
        li.setAttribute('data-file-id', f.fileId);
        var span = document.createElement('span');
        span.textContent = labelOf(f.docKey) + ': ' + f.name + ' (' + Math.max(1, Math.ceil(f.size / 1024)).toLocaleString('en-US') + ' KB)';
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn-light';
        btn.setAttribute('data-testid', 'file-remove-btn');
        btn.setAttribute('data-file-id', f.fileId);
        btn.setAttribute('aria-label', 'ลบไฟล์ ' + f.name);
        btn.textContent = 'ลบ';
        li.appendChild(span);
        li.appendChild(document.createTextNode(' '));
        li.appendChild(btn);
        list.appendChild(li);
      });
      var have = {};
      files.forEach(function (f) { have[f.docKey] = true; });
      var missing = C.requiredDocs.filter(function (d) { return !have[d.key]; }).map(function (d) { return d.name; });
      var slot = document.getElementById('missing-docs-slot');
      var el = tid('missing-docs');
      if (!missing.length) { if (el) el.remove(); }
      else {
        if (!el) {
          el = document.createElement('p');
          el.setAttribute('data-testid', 'missing-docs');
          el.className = 'msg msg-info';
          slot.appendChild(el);
        }
        el.textContent = 'ยังขาดเอกสาร: ' + missing.join(', ');
      }
      toPay.disabled = missing.length > 0;
      var count = document.getElementById('file-count');
      if (count) count.textContent = String(files.length);
    };
    document.querySelectorAll('input[type="file"][data-doc-key]').forEach(function (inp) {
      inp.addEventListener('change', async function () {
        var picked = Array.prototype.slice.call(inp.files || []);
        inp.value = '';
        if (!picked.length) return;
        setMsg('upload-error-slot', 'upload-error', '');
        for (var i = 0; i < picked.length; i++) {
          var fd = new FormData();
          fd.append('docKey', inp.getAttribute('data-doc-key'));
          fd.append('file', picked[i], picked[i].name);
          var r = await eg.api('POST', '/api/drafts/' + encodeURIComponent(C.draftId) + '/files', fd);
          if (!r.ok) { setMsg('upload-error-slot', 'upload-error', msgOf(r, 'แนบไฟล์ไม่สำเร็จ')); break; }
          files.push(r.data);
          render();
        }
      });
    });
    list.addEventListener('click', async function (ev) {
      var btn = ev.target.closest('[data-testid="file-remove-btn"]');
      if (!btn) return;
      btn.disabled = true;
      var id = btn.getAttribute('data-file-id');
      var r = await eg.api('DELETE', '/api/drafts/' + encodeURIComponent(C.draftId) + '/files/' + encodeURIComponent(id));
      if (!r.ok && r.status !== 404) { btn.disabled = false; eg.showError(msgOf(r, 'ลบไฟล์ไม่สำเร็จ')); return; }
      files = files.filter(function (f) { return f.fileId !== id; });
      render();
    });
    toPay.addEventListener('click', function () { if (!toPay.disabled) location.href = draftUrl(3); });
    render();
  }

  // ---------- ขั้น 3 ชำระเงิน ----------
  if (C.step === 3) {
    var panel = document.getElementById('payment-panel');
    var version = 0;
    var timer = null;
    var schedule = function () {
      if (timer) { clearTimeout(timer); timer = null; }
      if (panel.querySelector('[data-poll="1"]')) timer = setTimeout(function () { reload(); }, 3000);
    };
    var reload = async function () {
      var my = ++version;
      try {
        var res = await fetch(C.panelUrl, { credentials: 'same-origin', headers: { Accept: 'text/html' } });
        if (!res.ok) return;
        var text = await res.text();
        if (my !== version) return;
        panel.innerHTML = text;
      } catch (e) { /* ลองใหม่รอบหน้า */ }
      schedule();
    };
    panel.addEventListener('click', async function (ev) {
      var btn = ev.target.closest('button[data-action]');
      if (!btn || btn.disabled) return;
      var action = btn.getAttribute('data-action');
      btn.disabled = true;
      if (action === 'create-qr') {
        var r = await eg.api('POST', '/api/drafts/' + encodeURIComponent(C.draftId) + '/payment');
        if (!r.ok) { btn.disabled = false; eg.showError(msgOf(r, 'สร้าง QR ไม่สำเร็จ')); return; }
        eg.clearMessages();
      }
      await reload();
    });
    schedule();
  }
})();`;

const CASE_JS = String.raw`(function () {
  'use strict';
  var open = document.getElementById('cancel-open');
  var box = document.getElementById('cancel-confirm');
  if (open && box) {
    open.addEventListener('click', function () {
      box.hidden = false;
      open.setAttribute('aria-expanded', 'true');
      var b = box.querySelector('button[type="submit"]');
      if (b) b.focus();
    });
    var close = box.querySelector('[data-cancel-dismiss]');
    if (close) close.addEventListener('click', function () { box.hidden = true; open.setAttribute('aria-expanded', 'false'); open.focus(); });
  }
  document.querySelectorAll('form[data-once]').forEach(function (f) {
    f.addEventListener('submit', function () {
      setTimeout(function () { f.querySelectorAll('button[type="submit"]').forEach(function (b) { b.disabled = true; }); }, 0);
    });
  });
})();`;

const LIST_JS = String.raw`(function () {
  'use strict';
  document.querySelectorAll('[data-delete-draft]').forEach(function (btn) {
    btn.addEventListener('click', async function () {
      var id = btn.getAttribute('data-delete-draft');
      if (!window.confirm('ลบร่าง ' + id + ' ?')) return;
      btn.disabled = true;
      var r = await eg.api('DELETE', '/api/drafts/' + encodeURIComponent(id));
      if (!r.ok) { btn.disabled = false; eg.showError((r.data && r.data.message) || 'ลบร่างไม่สำเร็จ'); return; }
      location.reload();
    });
  });
})();`;

// ---------------------------------------------------------------- หน้า

function listPage(req, res) {
  const user = req.user;
  const now = clock.now();
  const hol = holidays();
  const cases = q.casesOf().all(user.citizenId);
  const drafts = q.draftsOf().all(user.citizenId);

  const starts = Object.values(SERVICES).map((s) => {
    const row = serviceRow(s.id) || {};
    let feeText = money(row.fee);
    if (s.id === 'SV-01') feeText = `${money(row.fee)} ต่อฉบับ (1–5 ฉบับ)`;
    if (s.id === 'SV-03') feeText = `เริ่มต้น ${money(row.fee)} (พื้นที่ 1–500 ตร.ม.)`;
    return `<li><a class="btn"${attrs({ 'data-testid': `start-service-${s.id}`, href: `/citizen/new/${s.id}` })}>${esc(s.name)}</a>
<span class="muted">${esc(s.id)} · ค่าธรรมเนียม ${esc(feeText)} · ${esc(row.sla)} วันทำการ</span></li>`;
  }).join('\n');

  const draftRows = drafts.map((d) => `<tr${attrs({ 'data-testid': 'my-draft-row', 'data-draft-id': d.draft_no, 'data-status': d.status })}>
<td data-testid="row-draft-id">${esc(d.draft_no)}</td>
<td data-testid="row-service">${esc(SERVICES[d.service_id] ? SERVICES[d.service_id].name : d.service_id)}</td>
<td>${statusBadge('row-status', d.status)}</td>
<td>${esc(money(draftFee(d)))}</td>
<td class="actions"><a class="btn btn-secondary"${attrs({ 'data-testid': 'open-draft-btn', href: `/citizen/new/${d.service_id}?draft=${encodeURIComponent(d.draft_no)}` })}>เปิดร่าง</a>
<button type="button" class="btn btn-light"${attrs({ 'data-testid': 'delete-draft-btn', 'data-delete-draft': d.draft_no, 'aria-label': `ลบร่าง ${d.draft_no}` })}>ลบร่าง</button></td>
</tr>`).join('\n');

  const caseRows = cases.map((c) => `<tr${attrs({ 'data-testid': 'my-case-row', 'data-case-no': c.case_no, 'data-status': c.status })}>
<td data-testid="row-case-no"><a href="/citizen/cases/${esc(encodeURIComponent(c.case_no))}">${esc(c.case_no)}</a></td>
<td data-testid="row-service">${esc(SERVICES[c.service_id] ? SERVICES[c.service_id].name : c.service_id)}</td>
<td>${statusBadge('row-status', c.status)}</td>
<td>${dt('row-due', c.due_at)}</td>
<td>${levelBadge('row-sla-level', rules.slaLevel(now, c.due_at, hol, c.status))}</td>
</tr>`).join('\n');

  const body = `<h1>คำขอของฉัน</h1>
<p data-testid="citizen-welcome">${esc(`สวัสดี ${user.name}`)}</p>
<section class="card" aria-labelledby="start-h">
<h2 id="start-h">เริ่มยื่นคำขอ</h2>
<ul class="service-list">${starts}</ul>
</section>
<section class="card" aria-labelledby="drafts-h">
<h2 id="drafts-h">ร่างและรอชำระเงิน</h2>
${drafts.length ? `<div class="table-wrap"><table>
<caption class="muted">ร่างยังไม่มีเลขคำขอ · เลขคำขอออกเมื่อชำระเงินสำเร็จ</caption>
<thead><tr><th scope="col">รหัสร่าง</th><th scope="col">บริการ</th><th scope="col">สถานะ</th><th scope="col">ค่าธรรมเนียม</th><th scope="col">ดำเนินการ</th></tr></thead>
<tbody>${draftRows}</tbody></table></div>` : '<p class="muted">ไม่มีร่าง</p>'}
</section>
<section class="card" aria-labelledby="cases-h">
<h2 id="cases-h">คำขอที่ยื่นแล้ว</h2>
${cases.length ? `<div class="table-wrap"><table>
<thead><tr><th scope="col">เลขคำขอ</th><th scope="col">บริการ</th><th scope="col">สถานะ</th><th scope="col">กำหนดเสร็จ</th><th scope="col">ระดับเตือน</th></tr></thead>
<tbody>${caseRows}</tbody></table></div>` : '<p class="muted">ยังไม่มีคำขอ</p>'}
</section>`;
  return renderPage(req, res, { title: 'คำขอของฉัน', body, inlineScript: drafts.length ? LIST_JS : '' });
}

function wizardStepsNav(step) {
  const names = ['กรอกข้อมูล', 'แนบเอกสาร', 'ชำระเงิน'];
  return `<ol class="wizard-steps" aria-label="ขั้นตอนการยื่น">${names.map((n, i) => `<li${attrs({ 'aria-current': i + 1 === step ? 'step' : null, class: i + 1 === step ? 'current' : null })}>${esc(n)}</li>`).join('')}</ol>`;
}

function wizardPage(req, res) {
  const user = req.user;
  const svcId = req.params.service;
  const svc = SERVICES[svcId];
  if (!svc) return renderNotFound(req, res, 'ไม่พบบริการ');
  let d = null;
  if (req.query.draft !== undefined) {
    d = ownDraft(user, req.query.draft);
    if (!d) return renderNotFound(req, res);
    if (d.service_id !== svcId) return res.redirect(`/citizen/new/${d.service_id}?draft=${encodeURIComponent(d.draft_no)}`);
  }

  let step = [1, 2, 3].includes(Number(req.query.step)) ? Number(req.query.step) : 1;
  if (!d) step = 1;
  else if (d.status !== 'DRAFT') step = 3; // ยอดล็อกแล้ว/ชำระแล้ว แก้ข้อมูลและไฟล์ไม่ได้
  const draftFiles = d ? q.filesOfDraft().all(d.id) : [];
  const missing = d ? missingDocs(d.service_id, draftFiles) : [];
  if (step === 3 && d.status === 'DRAFT' && missing.length) step = 2;

  const row = serviceRow(svcId);
  const config = { service: svcId, step, draftId: d ? d.draft_no : null };
  const draftIdHtml = d
    ? `<p id="draft-id-wrap">รหัสร่าง <strong data-testid="draft-id">${esc(d.draft_no)}</strong></p>`
    : '<p id="draft-id-wrap" hidden>รหัสร่าง </p>';
  let main = '';

  if (step === 1) {
    const table = rules.feeTable(svcId, row);
    Object.assign(config, {
      feeTable: table,
      feeCodes: FEE_CODES,
      messages: Object.fromEntries(FEE_CODES.map((c) => [c, messageOf(c)])),
    });
    let field = '';
    let fee = null;
    if (svcId === 'SV-01') {
      const qty = d && d.qty ? d.qty : 1; // ค่าตั้งต้น 1 (A-56)
      fee = feeOf(svcId, { qty });
      field = `<div class="field"><label for="qty-input">จำนวนฉบับ (1–5 ฉบับ · ฉบับละ ${esc(money(row && row.fee))})</label>
<input id="qty-input" type="number" name="qty" inputmode="numeric" min="1" max="5" step="1" data-testid="qty-input" value="${esc(qty)}" aria-describedby="fee-error-slot"></div>`;
    } else if (svcId === 'SV-03') {
      const area = d && d.area_sqm ? d.area_sqm : '';
      fee = area === '' ? { ok: false } : feeOf(svcId, { areaSqm: area });
      field = `<div class="field"><label for="area-input">พื้นที่อาคาร (ตร.ม. · จำนวนเต็ม 1–500)</label>
<input id="area-input" type="number" name="areaSqm" inputmode="numeric" min="1" max="500" step="1" data-testid="area-input" value="${esc(area)}" aria-describedby="fee-error-slot"></div>
<p class="muted">1–100 ตร.ม. ${esc(money(row && row.fee))} · ส่วนที่เกิน 100 ตร.ม. คิดเพิ่ม ${esc(money(row && row.fee_per_sqm))} ต่อ ตร.ม.</p>`;
    } else {
      fee = feeOf(svcId, null);
    }
    main = `<form id="wizard-form" class="card" novalidate onsubmit="return false">
${field}
<p>ค่าธรรมเนียม <strong data-testid="fee-total" aria-live="polite">${esc(fee && fee.ok ? money(fee.fee) : '–')}</strong></p>
<div id="fee-error-slot"></div>
<p class="actions">
<button type="button" class="btn btn-secondary" data-testid="save-draft-btn">บันทึกร่าง</button>
<button type="button" class="btn" data-testid="to-upload-btn"${fee && fee.ok ? '' : ' disabled'}>ถัดไป: แนบเอกสาร</button>
</p>
</form>`;
  } else if (step === 2) {
    Object.assign(config, {
      files: draftFiles.map(fileJson),
      requiredDocs: svc.docs.filter((x) => x.required).map((x) => ({ key: x.key, name: x.name })),
      docLabels: Object.fromEntries(docKeysOf(svcId).map((k) => [k, docLabel(k)])),
    });
    const inputs = [...svc.docs, { key: EXTRA_KEY, name: EXTRA_NAME, required: false, multiple: true }].map((doc) => {
      const hint = doc.pdfOnly ? 'PDF เท่านั้น' : 'PDF, JPG, PNG';
      return `<div class="field"><label for="upload-${esc(doc.key)}">${esc(doc.name)}${doc.required ? ' ✱ (บังคับ)' : ' (ไม่บังคับ)'} · ${esc(hint)} ไม่เกิน 5 MB</label>
<input${attrs({ id: `upload-${doc.key}`, type: 'file', name: 'file', 'data-testid': `upload-input-${doc.key}`, 'data-doc-key': doc.key, multiple: !!doc.multiple, 'aria-describedby': 'upload-error-slot' })}></div>`;
    }).join('\n');
    main = `<section class="card" aria-labelledby="upload-h">
<h2 id="upload-h">แนบเอกสาร</h2>
<p class="muted">รองรับ PDF, JPG, PNG ไฟล์ละไม่เกิน 5 MB · แนบได้สูงสุด 5 ไฟล์ต่อคำขอ (แนบแล้ว <span id="file-count">${draftFiles.length}</span> ไฟล์)</p>
${inputs}
<div id="upload-error-slot" aria-live="assertive"></div>
<h3>ไฟล์ที่แนบแล้ว</h3>
<ul id="file-list" class="file-list">${draftFiles.map(fileItemHtml).join('')}</ul>
<div id="missing-docs-slot" aria-live="polite">${missing.length ? `<p class="msg msg-info" data-testid="missing-docs">${esc(missingDocsMessage(missing))}</p>` : ''}</div>
<p class="actions">
<a class="btn btn-light" href="/citizen/new/${esc(svcId)}?draft=${esc(encodeURIComponent(d.draft_no))}&amp;step=1">ย้อนกลับ</a>
<button type="button" class="btn" data-testid="to-payment-btn"${missing.length ? ' disabled' : ''}>ไปชำระเงิน</button>
</p>
</section>`;
  } else {
    config.panelUrl = `/citizen/new/${svcId}/payment-panel?draft=${encodeURIComponent(d.draft_no)}`;
    main = `<section class="card" aria-labelledby="pay-h">
<h2 id="pay-h">ชำระเงินด้วย PromptPay QR (จำลอง)</h2>
<div id="payment-panel" aria-live="polite">${paymentPanelHtml(d)}</div>
${d.status === 'DRAFT' ? `<p><a class="btn btn-light" href="/citizen/new/${esc(svcId)}?draft=${esc(encodeURIComponent(d.draft_no))}&amp;step=2">ย้อนกลับ</a></p>` : ''}
</section>`;
  }

  const summary = d && step !== 1
    ? `<p class="muted">${esc(inputSummary(d) || svc.name)}${inputSummary(d) ? ` · ค่าธรรมเนียม ${esc(money(draftFee(d)))}` : ''}</p>`
    : '';
  const body = `<p><a href="/citizen">← คำขอของฉัน</a></p>
<h1>ยื่นคำขอ <span data-testid="service-name">${esc(svc.name)}</span></h1>
${wizardStepsNav(step)}
<p class="wizard-step"><strong data-testid="wizard-step">${esc(STEP_TEXT[step])}</strong></p>
${draftIdHtml}
${summary}
${main}
${jsonScript('wizard-config', config)}`;
  return renderPage(req, res, { title: `ยื่นคำขอ ${svc.name}`, body, inlineScript: WIZARD_JS });
}

function eventText(e) {
  const data = (() => { try { return e.data ? JSON.parse(e.data) : {}; } catch (_) { return {}; } })();
  switch (e.type) {
    case 'PAID': return `ชำระค่าธรรมเนียมและส่งคำขอแล้ว${data.receiptNo ? ` (ใบเสร็จ ${data.receiptNo})` : ''}`;
    case 'CLAIM': return 'เจ้าหน้าที่รับเรื่อง';
    case 'RETURN': return `ตีกลับให้แก้ไขเอกสาร${e.note ? `: ${e.note}` : ''}`;
    case 'RESUBMIT': return 'ส่งแก้ไขเอกสารแล้ว';
    case 'FORWARD':
      if (e.to_status === 'PENDING_APPROVAL') return 'ผ่านการตรวจ ส่งหัวหน้าฝ่ายพิจารณา';
      return Number(data.toStep) === 2 ? 'ผ่านการตรวจ ส่งต่อฝ่ายโยธา' : 'ผ่านการตรวจ ส่งต่อขั้นถัดไป';
    case 'APPROVE': return 'อนุมัติ';
    case 'REJECT': return `ไม่อนุมัติ${e.note ? `: ${e.note}` : ''}`;
    case 'ISSUE': return `ออกเอกสารดิจิทัล${data.docNo ? ` ${data.docNo}` : ''}`;
    case 'CANCEL': return 'ผู้ยื่นยกเลิกคำขอ';
    case 'AUTO_CANCEL': return 'ระบบยกเลิกคำขออัตโนมัติ (เลยเวลาแก้ไข 168 ชั่วโมง)';
    default: return `${STATUS_TH[e.to_status] || e.type}${e.note ? `: ${e.note}` : ''}`;
  }
}

function caseFilesHtml(c) {
  const lib = documentsLib();
  if (lib && typeof lib.fileItemsHtml === 'function') return lib.fileItemsHtml(c.id);
  const files = q.filesOfCase().all(c.id);
  if (!files.length) return '<p>ไม่มีไฟล์แนบ</p>';
  return `<ul class="doc-list">${files.map((f) => `<li${attrs({ 'data-testid': 'doc-item', 'data-name': f.name, 'data-file-id': f.id, 'data-doc-key': f.doc_key })}>
${esc(docLabel(f.doc_key))}: <a data-testid="doc-download-link" href="/api/files/${esc(encodeURIComponent(f.id))}">${esc(f.name)}</a></li>`).join('')}</ul>`;
}

function caseDocumentHtml(c) {
  const doc = q.docOfCase().get(c.id);
  if (!doc) return '';
  const lib = documentsLib();
  if (lib && typeof lib.documentPanelHtml === 'function') return lib.documentPanelHtml(doc, { citizen: true });
  const url = `${require('../lib/config').BASE_URL}/verify/${doc.verify_code}`;
  return `<section class="card" aria-labelledby="doc-h"><h2 id="doc-h">เอกสารดิจิทัล</h2>
<dl class="kv"><dt>เลขเอกสาร</dt><dd data-testid="doc-no">${esc(doc.doc_no)}</dd><dt>รหัสตรวจสอบ</dt><dd data-testid="verify-code">${esc(doc.verify_code)}</dd></dl>
<div${attrs({ 'data-testid': 'doc-qr', 'data-url': url })}>${qrSvg(url, 'doc-qr-image', 'QR ตรวจสอบเอกสาร')}</div>
<p><a class="btn" data-testid="download-doc-btn" href="/api/documents/${esc(encodeURIComponent(doc.doc_no))}/pdf">ดาวน์โหลดเอกสาร</a></p></section>`;
}

function casePage(req, res) {
  // B06: ประชาชนเปิดคำขอของคนอื่นผ่าน URL ได้ (IDOR)
  const c = ownCase(req.user, req.params.caseNo, { allowOthers: bug('B06') });
  if (!c) return renderNotFound(req, res);
  const now = clock.now();
  const cz = q.citizen().get(c.citizen_id);
  const idNo = cz ? safeDecrypt(cz.id_enc) : '';
  const level = slaLevelOf(c, now);
  const caseUrl = `/citizen/cases/${encodeURIComponent(c.case_no)}`;
  const events = q.events().all(c.id);

  const details = [
    ['สถานะ', statusBadge('case-status', c.status)],
    ['บริการ', `<span data-testid="case-service">${esc(serviceLabel(c.service_id))}</span>`],
  ];
  if (c.service_id === 'SV-03') details.push(['ขั้นตอน', `<span data-testid="case-step">${esc(CASE_STEP_TEXT[Number(c.step) || 1] || CASE_STEP_TEXT[1])}</span>`]);
  if (inputSummary(c)) details.push(['ข้อมูลที่กรอก', esc(inputSummary(c))]);
  details.push(
    ['ค่าธรรมเนียม', `<span data-testid="case-fee">${esc(money(c.fee))}</span>`],
    ['เลขใบเสร็จ', `<span data-testid="case-receipt-no">${esc(c.receipt_no || '')}</span>`],
    ['ชำระเมื่อ', dt('case-paid-at', c.paid_at)],
    ['กำหนดเสร็จ', dt('sla-due', c.due_at)],
    ['ระดับเตือน', level ? levelBadge('sla-level', level) : '–'],
  );
  if (c.status === 'COMPLETED' || c.status === 'REJECTED') details.push(['ปิดงานเมื่อ', dt('closed-at', c.closed_at)]);
  if (c.status === 'CANCELLED' && c.cancelled_at) details.push(['ยกเลิกเมื่อ', dt('cancelled-at', c.cancelled_at)]);
  details.push(
    ['ผู้ยื่น', `<span data-testid="case-applicant">${esc(cz ? cz.name : '')}</span>`],
    ['เลขบัตรประชาชน', `<span data-testid="case-id-full">${esc(format.formatIdNo(idNo))}</span>`],
  );

  let actions = '';
  if (c.status === 'SUBMITTED' && !c.owner) {
    actions += `<section class="card" aria-labelledby="cancel-h">
<h2 id="cancel-h">ยกเลิกคำขอ</h2>
<p class="muted">ยกเลิกได้เฉพาะคำขอที่ยังไม่มีเจ้าหน้าที่รับเรื่อง</p>
<p><button type="button" id="cancel-open" class="btn btn-danger" data-testid="cancel-case-btn" aria-expanded="false" aria-controls="cancel-confirm">ยกเลิกคำขอ</button></p>
<div id="cancel-confirm" class="confirm-box" role="dialog" aria-labelledby="cancel-confirm-h" aria-describedby="cancel-confirm-text" hidden>
<h3 id="cancel-confirm-h">ยืนยันการยกเลิกคำขอ ${esc(c.case_no)}</h3>
<p id="cancel-confirm-text" class="msg msg-info" data-testid="cancel-confirm-text">${esc(NO_REFUND)}</p>
<form method="post" action="${esc(caseUrl)}/cancel" class="actions" data-once>
<button type="submit" class="btn btn-danger" data-testid="confirm-cancel-btn">ยืนยันยกเลิกคำขอ</button>
<button type="button" class="btn btn-light" data-cancel-dismiss>ไม่ยกเลิก</button>
</form>
</div>
</section>`;
  }
  if (c.status === 'NEED_FIX') {
    const deadline = fixDeadlineOf(c);
    const open = !fixWindowClosed(c, now);
    actions += `<section class="card" aria-labelledby="fix-h">
<h2 id="fix-h">คำขอถูกตีกลับให้แก้ไขเอกสาร</h2>
<p>เหตุผล: <span data-testid="return-reason-display">${esc(c.return_reason || '')}</span></p>
<p>ส่งแก้ไขได้ก่อน ${dt('fix-deadline', deadline)} (7 วันนับจากเวลาตีกลับ · เลยแล้วระบบยกเลิกคำขออัตโนมัติ)</p>
${open ? `<form method="post" action="${esc(caseUrl)}/resubmit" enctype="multipart/form-data" data-once>
<div class="field"><label for="fix-upload-input">แนบไฟล์ใหม่ (ไม่บังคับ · PDF, JPG, PNG ไม่เกิน 5 MB · รวมไม่เกิน 5 ไฟล์ต่อคำขอ)</label>
<input id="fix-upload-input" type="file" name="file" multiple data-testid="fix-upload-input"></div>
<input type="hidden" name="docKey" value="${EXTRA_KEY}">
<p><button type="submit" class="btn" data-testid="submit-fix-btn">ส่งแก้ไข</button></p>
</form>` : `<p class="msg msg-error">${esc(messageOf('FIX_WINDOW_EXPIRED'))}</p>`}
</section>`;
  }
  const noRefund = c.status === 'REJECTED' || c.status === 'CANCELLED'
    ? `<p class="msg msg-info" data-testid="no-refund-note">${esc(NO_REFUND)}</p>` : '';
  const rejectReason = c.status === 'REJECTED' && c.reject_reason
    ? `<p>เหตุผลที่ไม่อนุมัติ: <span data-testid="reject-reason-display">${esc(c.reject_reason)}</span></p>` : '';

  const timeline = events.map((e) => {
    const isoAt = format.iso(e.at);
    return `<li${attrs({ 'data-testid': 'timeline-item', 'data-iso': isoAt, 'data-event': e.type })}><time datetime="${esc(isoAt)}">${esc(format.thaiDateTime(e.at))}</time> · ${esc(eventText(e))}</li>`;
  }).join('\n');

  const body = `<p><a href="/citizen">← คำขอของฉัน</a></p>
<h1>คำขอ <span data-testid="case-no">${esc(c.case_no)}</span></h1>
${noRefund}
${rejectReason}
<section class="card" aria-labelledby="detail-h">
<h2 id="detail-h">รายละเอียดคำขอ</h2>
<dl class="kv">${details.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('\n')}</dl>
</section>
${actions}
${caseDocumentHtml(c)}
<section class="card" aria-labelledby="files-h">
<h2 id="files-h">เอกสารแนบ</h2>
${caseFilesHtml(c)}
</section>
<section class="card" aria-labelledby="timeline-h">
<h2 id="timeline-h">ไทม์ไลน์</h2>
<ul class="timeline" data-testid="case-timeline">${timeline}</ul>
</section>`;
  return renderPage(req, res, { title: `คำขอ ${c.case_no}`, body, inlineScript: CASE_JS });
}

// ---------------------------------------------------------------- ลงทะเบียน route

module.exports = function register(app, ctx = {}) {
  const router = express.Router();
  const upload = ctx.upload || require('multer')({ storage: require('multer').memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 20 } });
  const citizenOnly = auth.requireRole('citizen');

  // ---------- หน้า ----------
  router.get('/citizen', citizenOnly, listPage);
  router.get('/citizen/new/:service', citizenOnly, wizardPage);

  router.get('/citizen/new/:service/payment-panel', citizenOnly, (req, res) => {
    const d = ownDraft(req.user, req.query.draft);
    if (!d || d.service_id !== req.params.service) return res.status(404).type('html').send(`<p data-testid="not-found-msg">${esc(messageOf('NOT_FOUND'))}</p>`);
    return res.status(200).type('html').set('Cache-Control', 'no-store').send(paymentPanelHtml(d));
  });

  router.get('/citizen/cases/:caseNo', citizenOnly, casePage);

  router.post('/citizen/cases/:caseNo/cancel', citizenOnly, (req, res, next) => {
    const c = ownCase(req.user, req.params.caseNo);
    if (!c) return renderNotFound(req, res);
    try {
      cancelTx(c.id);
      setFlash(req, 'success', 'ยกเลิกคำขอแล้ว');
    } catch (err) {
      if (!err.isAppError) return next(err);
      setFlash(req, 'error', errorText(err));
    }
    return res.redirect(303, `/citizen/cases/${encodeURIComponent(c.case_no)}`);
  });

  router.post('/citizen/cases/:caseNo/resubmit', citizenOnly, upload.any(), (req, res, next) => {
    const c = ownCase(req.user, req.params.caseNo);
    if (!c) return renderNotFound(req, res);
    try {
      runResubmit(c.id, pickFiles(req), req.body && req.body.docKey);
      setFlash(req, 'success', 'ส่งแก้ไขแล้ว คำขอกลับไปตรวจสอบ');
    } catch (err) {
      if (!err.isAppError) return next(err);
      setFlash(req, 'error', errorText(err));
    }
    return res.redirect(303, `/citizen/cases/${encodeURIComponent(c.case_no)}`);
  });

  // ---------- API ร่าง ----------
  router.post('/api/drafts', citizenOnly, (req, res) => {
    const b = req.body || {};
    const serviceId = String(b.serviceId || '');
    if (!SERVICES[serviceId]) return sendError(res, 'BAD_REQUEST');
    const input = serviceId === 'SV-01' ? { qty: b.qty } : serviceId === 'SV-03' ? { areaSqm: b.areaSqm !== undefined ? b.areaSqm : b.area } : null;
    const r = feeOf(serviceId, input);
    if (!r.ok) return sendError(res, r.code);
    const nowIso = clock.nowIso();
    const draftNo = createDraftTx(req.user.citizenId, serviceId, r.fee,
      serviceId === 'SV-01' ? r.qty : null, serviceId === 'SV-03' ? r.areaSqm : null, nowIso);
    return res.status(201).json({ draftId: draftNo, fee: r.fee });
  });

  router.get('/api/drafts', citizenOnly, (req, res) => {
    res.json({ items: q.draftsOf().all(req.user.citizenId).map((d) => draftJson(d)) });
  });

  router.get('/api/drafts/:id', citizenOnly, (req, res) => {
    const d = ownDraft(req.user, req.params.id);
    if (!d) return sendError(res, 'NOT_FOUND');
    return res.json(draftJson(d, { full: true }));
  });

  router.put('/api/drafts/:id', citizenOnly, (req, res) => {
    const d = ownDraft(req.user, req.params.id);
    if (!d) return sendError(res, 'NOT_FOUND');
    if (d.status !== 'DRAFT') return sendError(res, 'INVALID_STATE');
    const b = req.body || {};
    const input = d.service_id === 'SV-01' ? { qty: b.qty } : d.service_id === 'SV-03' ? { areaSqm: b.areaSqm !== undefined ? b.areaSqm : b.area } : null;
    const r = feeOf(d.service_id, input);
    if (!r.ok) return sendError(res, r.code);
    db.prepare("UPDATE drafts SET qty = ?, area_sqm = ?, fee = ?, updated_at = ? WHERE id = ? AND status = 'DRAFT'").run(
      d.service_id === 'SV-01' ? r.qty : null, d.service_id === 'SV-03' ? r.areaSqm : null, r.fee, clock.nowIso(), d.id);
    return res.json({ draftId: d.draft_no, fee: r.fee });
  });

  router.delete('/api/drafts/:id', citizenOnly, (req, res) => {
    const d = ownDraft(req.user, req.params.id);
    if (!d) return sendError(res, 'NOT_FOUND');
    if (d.status !== 'DRAFT' && d.status !== 'PENDING_PAYMENT') return sendError(res, 'INVALID_STATE');
    db.transaction(() => {
      db.prepare('DELETE FROM files WHERE draft_id = ? AND case_id IS NULL').run(d.id);
      db.prepare('DELETE FROM payments WHERE draft_id = ?').run(d.id);
      db.prepare("DELETE FROM drafts WHERE id = ? AND status IN ('DRAFT','PENDING_PAYMENT')").run(d.id);
    })();
    return res.status(204).end();
  });

  router.post('/api/drafts/:id/files', citizenOnly, upload.any(), (req, res, next) => {
    const d = ownDraft(req.user, req.params.id);
    if (!d) return sendError(res, 'NOT_FOUND');
    const file = pickFiles(req)[0];
    if (!file) return sendError(res, 'BAD_REQUEST');
    const docKey = String((req.body && req.body.docKey) || EXTRA_KEY);
    if (!docKeysOf(d.service_id).includes(docKey)) return sendError(res, 'BAD_REQUEST');
    try {
      const f = addDraftFileTx(d.id, docKey, file);
      return res.status(201).json(fileJson(f));
    } catch (err) {
      return sendAppError(res, err, next);
    }
  });

  router.delete('/api/drafts/:id/files/:fileId', citizenOnly, (req, res) => {
    const d = ownDraft(req.user, req.params.id);
    if (!d) return sendError(res, 'NOT_FOUND');
    if (d.status !== 'DRAFT') return sendError(res, 'INVALID_STATE');
    const r = db.prepare('DELETE FROM files WHERE id = ? AND draft_id = ? AND case_id IS NULL').run(String(req.params.fileId), d.id);
    if (r.changes !== 1) return sendError(res, 'NOT_FOUND');
    db.prepare('UPDATE drafts SET updated_at = ? WHERE id = ?').run(clock.nowIso(), d.id);
    return res.status(204).end();
  });

  router.post('/api/drafts/:id/payment', citizenOnly, (req, res, next) => {
    const d = ownDraft(req.user, req.params.id);
    if (!d) return sendError(res, 'NOT_FOUND');
    try {
      return res.status(201).json(createPaymentTx(d.id));
    } catch (err) {
      return sendAppError(res, err, next);
    }
  });

  router.get('/api/payments/:ref', citizenOnly, (req, res) => {
    const p = q.paymentByRef().get(String(req.params.ref));
    const d = p ? q.draftById().get(p.draft_id) : null;
    if (!p || !d || d.citizen_id !== req.user.citizenId) return sendError(res, 'NOT_FOUND');
    return res.json(paymentJson(p));
  });

  // ---------- API คำขอ ----------
  router.get('/api/cases', citizenOnly, (req, res) => {
    const now = clock.now();
    const hol = holidays();
    res.json({
      items: q.casesOf().all(req.user.citizenId).map((c) => ({
        caseNo: c.case_no,
        serviceId: c.service_id,
        status: c.status,
        dueAt: c.due_at,
        slaLevel: rules.slaLevel(now, c.due_at, hol, c.status),
        fee: c.fee,
        paidAt: c.paid_at,
      })),
    });
  });

  router.get('/api/cases/:caseNo', auth.requireLogin, (req, res) => {
    const user = req.user;
    if (user.role === 'citizen') {
      // B06: ประชาชนเปิดคำขอของคนอื่นผ่าน URL ได้ (IDOR)
      const c = ownCase(user, req.params.caseNo, { allowOthers: bug('B06') });
      if (!c) return sendError(res, 'NOT_FOUND');
      return res.json(caseJson(c, user));
    }
    if (user.role !== 'officer' && user.role !== 'head') return sendError(res, 'FORBIDDEN');
    const c = q.caseByNo().get(String(req.params.caseNo));
    if (!c) return sendError(res, 'NOT_FOUND');
    return res.json(caseJson(c, user));
  });

  router.post('/api/cases/:caseNo/cancel', citizenOnly, (req, res, next) => {
    const c = ownCase(req.user, req.params.caseNo);
    if (!c) return sendError(res, 'NOT_FOUND');
    try {
      return res.status(200).json(cancelTx(c.id));
    } catch (err) {
      return sendAppError(res, err, next);
    }
  });

  router.post('/api/cases/:caseNo/resubmit', citizenOnly, upload.any(), (req, res, next) => {
    const c = ownCase(req.user, req.params.caseNo);
    if (!c) return sendError(res, 'NOT_FOUND');
    try {
      return res.status(200).json(runResubmit(c.id, pickFiles(req), req.body && req.body.docKey));
    } catch (err) {
      return sendAppError(res, err, next);
    }
  });

  // ---------- test hook: ธนาคารจำลองยิง callback (server.js ตอบ 404 ให้เองเมื่อไม่มี TEST_MODE) ----------
  router.post('/api/test/payments/:ref/pay', (req, res, next) => {
    try {
      return res.status(200).json(payTx(String(req.params.ref), req.body ? req.body.amount : undefined));
    } catch (err) {
      return sendAppError(res, err, next);
    }
  });

  return router;
};

Object.assign(module.exports, {
  caseJson, payByRef, autoCancelExpired, paymentPanelHtml, missingDocs, sniffMime, MAX_FILE_BYTES, MAX_FILES,
});
