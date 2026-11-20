'use strict';
/*
 * บล็อก B06 · เจ้าหน้าที่/หัวหน้า: คิว · รับเรื่อง · ตีกลับ · ส่งต่อ · อนุมัติ/ไม่อนุมัติ · แจ้งเตือน
 * CONTRACT §1 §2.6 (ฝั่ง officer) §2.7 §2.8 §2.12 §5 §6.3 §6.8 · REQUIREMENTS FR-12..16 FR-19 FR-20 BR-14..19 BR-21
 * DECISIONS §1 §5 §8 §9 §18 · A-19 A-20 A-27 A-28 A-30 A-31 A-34 A-40 A-44
 *
 * หน้า
 *   GET  /officer/queue                       officer (คิวแผนกตัวเอง) · head (ทุกแผนก อ่านอย่างเดียว) · ?filter=all|unclaimed|mine
 *   GET  /officer/cases/:caseNo               officer · head · ไม่มีเลข → 404 `not-found-msg`
 *   GET  /head/approvals                      head · PENDING_APPROVAL เรียงตาม BR-16
 *   GET  /notifications                       officer · head · กระดิ่งของผู้ใช้นั้น
 *   POST /officer/cases/:caseNo/claim|return|forward|approve|reject   ฟอร์มหน้า → redirect + flash (ออกเอกสารอยู่ที่ documents.js)
 *
 * API (CONTRACT §6.3)
 *   GET  /api/officer/queue?filter=all        → {items:[{caseNo,serviceId,applicantName,idMasked,status,step,owner,dueAt,slaLevel}]} (ห้ามมี idNo · B09)
 *   POST /api/officer/cases/:caseNo/claim     → {owner} · ลำดับตรวจ สิทธิ์ 403 → ALREADY_CLAIMED 409 → WORKLOAD_LIMIT 409 (B08)
 *   POST /api/officer/cases/:caseNo/return    {reason} → {status:'NEED_FIX', returnCount} · REASON_TOO_SHORT · RETURN_LIMIT (B12) · 403 · INVALID_STATE
 *   POST /api/officer/cases/:caseNo/forward   {note?} → {status:'IN_REVIEW', step:2} | {status:'PENDING_APPROVAL'} · 403 · INVALID_STATE
 *   POST /api/cases/:caseNo/approve           SV-01 ผู้ถือเรื่อง · SV-02/03 head ที่ PENDING_APPROVAL → {status:'APPROVED'} · 403 (B07) · 409
 *   POST /api/cases/:caseNo/reject            เหมือน approve + {reason} → {status:'REJECTED', closedAt} · 400 · 403 · 409
 *   GET  /api/notifications                   → {items:[{id,caseNo,level,text,createdAt}]} ของผู้ใช้นั้นเท่านั้น
 *
 * กฎสำคัญ
 *   - คิว = SUBMITTED + IN_REVIEW + APPROVED (รอออกเอกสาร) ที่ cases.dept = แผนกของเจ้าหน้าที่ (A-34) · เรียง due_at แล้ว case_no (BR-16)
 *   - รับเรื่องใช้ UPDATE แบบมีเงื่อนไข owner IS NULL → ชนกันสำเร็จคนเดียว · ชนกับประชาชนยกเลิก → 409 INVALID_STATE (A-62)
 *   - งานในมือ = IN_REVIEW ที่ตัวเองถือ · ตรวจเพดาน 10 เฉพาะตอนรับเรื่อง (BR-18) · รับเรื่องแรกที่ทะเบียนตั้ง issuer (A-27)
 *   - ตีกลับคงผู้ถือ/ขั้น/แผนกเดิม (ส่งแก้แล้วกลับผู้ถือเดิม A-29) · ส่งต่อล้างผู้ถือ · อนุมัติแล้วคิวทะเบียนเห็นแถว APPROVED ที่ data-owner ว่าง
 *   - ระดับเตือน rules.slaLevel · เลขบัตร rules.maskId · เหตุผล ≥ 10 ตัวหลังตัดช่องว่างหัวท้าย (A-44)
 *   - hook 'sla-notify' (order 50) ประเมินแจ้งเตือนทุก request: 1 ครั้งต่อระดับต่อคำขอต่อคน (INSERT OR IGNORE · BR-15 A-30 A-31)
 *   - Audit ผ่าน lib/audit.js writeAudit ใน transaction เดียวกับการเปลี่ยนสถานะ (CLAIM RETURN FORWARD APPROVE REJECT)
 *   - BUG_MODE: B07 เจ้าหน้าที่อนุมัติ SV-02/03 เองได้ (API) · B08 รับเรื่องข้ามการตรวจผู้ถือ · B09 API คิวส่ง idNo · B12 ตีกลับครั้งที่ 3 ได้
 *
 * export เพิ่ม (require('./officer')): queueItems(user, filter) · workloadOf(username) · evaluateNotifications(now) · expectedIssuer(caseRow)
 */

const express = require('express');
const db = require('../db');
const clock = require('../lib/clock');
const { bug } = require('../lib/bugs');
const auth = require('../lib/auth');
const { sendError, messageOf } = require('../lib/errors');
const format = require('../lib/format');
const cryptoLib = require('../lib/crypto');
const rules = require('../lib/rules');
const hooks = require('../lib/hooks');
const { writeAudit } = require('../lib/audit');
const layout = require('../views/layout');

const { esc, attrs, dt, statusBadge, levelBadge, renderPage, renderNotFound, setFlash } = layout;
const { SERVICES, LEVEL_TH, DEPT_TH, money } = format;

const MAX_WORKLOAD = 10;      // BR-18 · A-19
const MAX_RETURNS = 2;        // BR-19 · A-20
const MIN_REASON_CHARS = 10;  // BR-19 · A-12 A-44
const CLAIMABLE = new Set(['SUBMITTED', 'IN_REVIEW']);
const QUEUE_STATUSES = ['SUBMITTED', 'IN_REVIEW', 'APPROVED'];                       // A-34
const NOTIFY_STATUSES = ['SUBMITTED', 'IN_REVIEW', 'PENDING_APPROVAL', 'APPROVED'];  // NEED_FIX/ปิดแล้วไม่ประเมิน
const FILTERS = { all: 'ทั้งหมด', unclaimed: 'ยังไม่มีผู้รับ', mine: 'ของฉัน' };
const CASE_STEP_TEXT = { 1: 'ขั้นตอน 1/3 · ฝ่ายทะเบียน', 2: 'ขั้นตอน 2/3 · ฝ่ายโยธา', 3: 'ขั้นตอน 3/3 · หัวหน้าฝ่าย' };
const NO_OWNER_TEXT = 'ยังไม่มีผู้รับ';

// บล็อก B07 (documents.js) มีตัวช่วย render เอกสาร/เลขบัตร/ไฟล์แนบ · โหลดตอนใช้ (โหลดไม่ขึ้น → ของสำรองแบบย่อ)
function documentsLib() {
  try { return require('./documents'); } catch (_) { return null; }
}

// ---------------------------------------------------------------- ข้อมูล

const q = {
  caseByNo: () => db.prepare('SELECT * FROM cases WHERE case_no = ?'),
  caseById: () => db.prepare('SELECT * FROM cases WHERE id = ?'),
  citizen: () => db.prepare('SELECT id, name, id_enc FROM citizens WHERE id = ?'),
  queueCases: () => db.prepare(`SELECT c.*, z.name AS applicant_name, z.id_enc AS applicant_id_enc
    FROM cases c LEFT JOIN citizens z ON z.id = c.citizen_id
    WHERE c.status IN (${QUEUE_STATUSES.map(() => '?').join(',')})
    ORDER BY c.due_at, c.case_no`),
  approvals: () => db.prepare(`SELECT c.*, z.name AS applicant_name FROM cases c LEFT JOIN citizens z ON z.id = c.citizen_id
    WHERE c.status = 'PENDING_APPROVAL' ORDER BY c.due_at, c.case_no`),
  notifyCases: () => db.prepare(`SELECT id, case_no, service_id, status, dept, owner, issuer, approver, due_at FROM cases
    WHERE status IN (${NOTIFY_STATUSES.map(() => '?').join(',')})`),
  staff: () => db.prepare("SELECT username, role, dept FROM users WHERE active = 1 AND role IN ('officer', 'head') ORDER BY id"),
  workload: () => db.prepare("SELECT COUNT(*) AS n FROM cases WHERE status = 'IN_REVIEW' AND owner = ?"),
  insNoti: () => db.prepare(`INSERT OR IGNORE INTO notifications (username, case_id, case_no, level, text, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`),
  notisOf: () => db.prepare('SELECT * FROM notifications WHERE username = ? ORDER BY created_at DESC, id DESC'),
  events: () => db.prepare('SELECT * FROM case_events WHERE case_id = ? ORDER BY at, id'),
  insEvent: () => db.prepare(`INSERT INTO case_events (case_id, at, type, actor, from_status, to_status, note, data)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
  userName: () => db.prepare('SELECT name FROM users WHERE username = ?'),
};

const holidays = () => rules.holidaysFrom(db);
const levelOf = (c, now, hol) => rules.slaLevel(now, c.due_at, hol, c.status);
const serviceLabel = (id) => (SERVICES[id] ? `${id} ${SERVICES[id].name}` : id);
const isSv03 = (c) => c.service_id === 'SV-03';
const stepOf = (c) => (isSv03(c) ? (Number(c.step) || 1) : null);

function safeDecrypt(blob) {
  try { return cryptoLib.decrypt(blob) || ''; } catch (_) { return ''; }
}

function addEvent(caseId, at, type, actor, from, to, note = null, data = null) {
  q.insEvent().run(caseId, at, type, actor, from, to, note, data ? JSON.stringify(data) : null);
}

// แผนกที่คำขออยู่ตอนนี้ (seed/B05 ตั้ง cases.dept ให้แล้ว · ค่าว่างของ SUBMITTED/APPROVED ถือเป็นทะเบียน)
function deptOf(c) {
  if (c.dept) return c.dept;
  if (c.status === 'SUBMITTED' || c.status === 'APPROVED') return 'registry';
  return null;
}

// ผู้ออกเอกสาร (A-27): SV-01 = ผู้ถือเรื่องที่อนุมัติ · SV-02/03 = เจ้าหน้าที่ทะเบียนที่รับเรื่องขั้นแรก (ตรงกับ documents.js)
function expectedIssuer(c) {
  if (c.service_id === 'SV-01') return c.approver || c.issuer || c.owner || null;
  return c.issuer || null;
}

function workloadOf(username) {
  return username ? q.workload().get(username).n : 0;
}

function displayName(username) {
  if (!username) return '';
  const row = q.userName().get(username);
  return row ? row.name : username;
}

// เหตุผลตีกลับ/ไม่อนุมัติ: นับหลังตัดช่องว่างหัวท้าย (A-44) · นับเป็นอักขระ (code point)
function cleanText(v) {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}
const reasonTooShort = (s) => Array.from(s).length < MIN_REASON_CHARS;

// ---------------------------------------------------------------- คิว (BR-16 · A-34)

function normalizeFilter(f) {
  return Object.prototype.hasOwnProperty.call(FILTERS, f) ? f : 'all';
}

// แถวที่ผู้ใช้เห็น (ก่อนกรอง) · officer = แผนกตัวเอง · head = ทุกแผนก
function queueRows(user) {
  return q.queueCases().all(...QUEUE_STATUSES).filter((c) => {
    const dept = deptOf(c);
    if (!dept) return false;
    if (user.role === 'head') return true;
    return user.role === 'officer' && dept === user.dept;
  });
}

const isUnclaimed = (c) => CLAIMABLE.has(c.status) && !c.owner;
const isMine = (c, user) => c.status === 'IN_REVIEW' && !!c.owner && c.owner === user.username;

function matchFilter(c, filter, user) {
  if (filter === 'unclaimed') return isUnclaimed(c);
  if (filter === 'mine') return isMine(c, user);
  return true;
}

// เจ้าหน้าที่คนนี้กด "รับเรื่อง" ได้ไหม (ไม่ดูเพดาน 10 · ตรวจตอนกด)
function canClaim(user, c) {
  return !!user && user.role === 'officer' && isUnclaimed(c) && deptOf(c) === user.dept;
}

function queueItems(user, filter = 'all') {
  const f = normalizeFilter(filter);
  const now = clock.now();
  const hol = holidays();
  return queueRows(user).filter((c) => matchFilter(c, f, user)).map((c) => {
    const idNo = safeDecrypt(c.applicant_id_enc);
    const item = {
      caseNo: c.case_no,
      serviceId: c.service_id,
      applicantName: c.applicant_name || '',
      idMasked: rules.maskId(idNo),
      status: c.status,
      step: stepOf(c),
      owner: c.owner || null,
      dueAt: c.due_at,
      slaLevel: levelOf(c, now, hol),
    };
    // B09: API คิวเจ้าหน้าที่ส่งเลขบัตรเต็ม (บนจอยังปิดบัง)
    if (bug('B09')) item.idNo = idNo;
    return item;
  });
}

// ---------------------------------------------------------------- ทำรายการ (คืน { body } หรือ { error })

const fail = (code) => ({ error: code });

// รับเรื่อง (BR-17 BR-18 · A-27 A-28 A-62)
const claimTx = db.transaction((user, caseNo) => {
  if (!user || user.role !== 'officer') return fail('FORBIDDEN');
  const c = q.caseByNo().get(String(caseNo));
  if (!c) return fail('NOT_FOUND');
  const dept = deptOf(c);
  if (dept && dept !== user.dept) return fail('FORBIDDEN'); // ข้ามแผนก
  if (!CLAIMABLE.has(c.status)) return fail(c.status === 'NEED_FIX' && c.owner ? 'ALREADY_CLAIMED' : 'INVALID_STATE');
  if (!dept) return fail('FORBIDDEN');
  // B08: รับเรื่องข้ามการตรวจว่ามีผู้ถือแล้ว (คนที่ 2 ได้ 200 และเป็นผู้ถือแทน)
  const skipOwnerCheck = bug('B08');
  if (c.owner && !skipOwnerCheck) return fail('ALREADY_CLAIMED');
  if (workloadOf(user.username) >= MAX_WORKLOAD) return fail('WORKLOAD_LIMIT');

  const nowIso = clock.nowIso();
  const step = stepOf(c);
  const r = db.prepare(`UPDATE cases SET status = 'IN_REVIEW', owner = ?, dept = ?,
      issuer = CASE WHEN issuer IS NULL AND ? = 'registry' THEN ? ELSE issuer END,
      step = ?, updated_at = ?
    WHERE id = ? AND status IN ('SUBMITTED', 'IN_REVIEW') ${skipOwnerCheck ? '' : 'AND owner IS NULL'}`)
    .run(user.username, dept, dept, user.username, step, nowIso, c.id);
  if (r.changes !== 1) {
    const now = q.caseById().get(c.id);
    return fail(now && CLAIMABLE.has(now.status) ? 'ALREADY_CLAIMED' : 'INVALID_STATE');
  }
  addEvent(c.id, nowIso, 'CLAIM', user.username, c.status, 'IN_REVIEW', null, step ? { step } : null);
  writeAudit({ user, event: 'CLAIM', caseNo: c.case_no, fromStatus: c.status, toStatus: 'IN_REVIEW', detail: '', time: nowIso });
  return { body: { owner: user.username, status: 'IN_REVIEW' } };
});

// ตีกลับ (BR-19 BR-20 · A-20 A-29) · ผู้ถือ ขั้น และแผนกคงเดิม
const returnTx = db.transaction((user, caseNo, reasonRaw) => {
  if (!user || user.role !== 'officer') return fail('FORBIDDEN');
  const c = q.caseByNo().get(String(caseNo));
  if (!c) return fail('NOT_FOUND');
  if (!c.owner || c.owner !== user.username) return fail('FORBIDDEN');
  if (c.status !== 'IN_REVIEW') return fail('INVALID_STATE');
  // B12: ตีกลับครั้งที่ 3 ได้
  if ((c.return_count || 0) >= MAX_RETURNS && !bug('B12')) return fail('RETURN_LIMIT');
  const reason = cleanText(reasonRaw);
  if (reasonTooShort(reason)) return fail('REASON_TOO_SHORT');

  const nowIso = clock.nowIso();
  const returnCount = (c.return_count || 0) + 1;
  const fixDeadline = rules.fixDeadline(nowIso);
  const r = db.prepare(`UPDATE cases SET status = 'NEED_FIX', return_count = ?, returned_at = ?, return_reason = ?,
      fix_deadline = ?, updated_at = ?
    WHERE id = ? AND status = 'IN_REVIEW' AND owner = ?`)
    .run(returnCount, nowIso, reason, fixDeadline, nowIso, c.id, user.username);
  if (r.changes !== 1) return fail('INVALID_STATE');
  addEvent(c.id, nowIso, 'RETURN', user.username, 'IN_REVIEW', 'NEED_FIX', reason, { returnNo: returnCount, fixDeadline });
  writeAudit({ user, event: 'RETURN', caseNo: c.case_no, fromStatus: 'IN_REVIEW', toStatus: 'NEED_FIX', detail: reason, time: nowIso });
  return { body: { status: 'NEED_FIX', returnCount, fixDeadline } };
});

// ส่งต่ออัตโนมัติตามเส้นทาง (FR-15 · BR-21): SV-02 ทะเบียน → หัวหน้า · SV-03 ทะเบียน → โยธา → หัวหน้า · ผู้ใช้เลือกปลายทางไม่ได้
const forwardTx = db.transaction((user, caseNo, noteRaw) => {
  if (!user || user.role !== 'officer') return fail('FORBIDDEN');
  const c = q.caseByNo().get(String(caseNo));
  if (!c) return fail('NOT_FOUND');
  if (!c.owner || c.owner !== user.username) return fail('FORBIDDEN');
  if (c.status !== 'IN_REVIEW' || c.service_id === 'SV-01') return fail('INVALID_STATE');

  const note = cleanText(noteRaw).slice(0, 2000);
  const nowIso = clock.nowIso();
  let to;
  if (c.service_id === 'SV-03' && stepOf(c) === 1) to = { status: 'IN_REVIEW', step: 2, dept: 'works' };
  else if (c.service_id === 'SV-03') to = { status: 'PENDING_APPROVAL', step: 3, dept: null };
  else to = { status: 'PENDING_APPROVAL', step: null, dept: null };

  const r = db.prepare(`UPDATE cases SET status = ?, step = ?, dept = ?, owner = NULL, updated_at = ?
    WHERE id = ? AND status = 'IN_REVIEW' AND owner = ?`)
    .run(to.status, to.step, to.dept, nowIso, c.id, user.username);
  if (r.changes !== 1) return fail('INVALID_STATE');
  addEvent(c.id, nowIso, 'FORWARD', user.username, 'IN_REVIEW', to.status, note || null, to.step ? { toStep: to.step } : null);
  writeAudit({ user, event: 'FORWARD', caseNo: c.case_no, fromStatus: 'IN_REVIEW', toStatus: to.status, detail: note, time: nowIso });
  const body = { status: to.status };
  if (to.step) body.step = to.step;
  return { body };
});

// สิทธิ์ตัดสิน (FR-16 · BR-21 · A-28): SV-01 ผู้ถือเรื่อง (IN_REVIEW) · SV-02/03 head ที่ PENDING_APPROVAL
function decisionCheck(user, c, kind) {
  if (!user || (user.role !== 'officer' && user.role !== 'head')) return 'FORBIDDEN';
  if (!c) return 'NOT_FOUND';
  if (c.service_id === 'SV-01') {
    if (user.role !== 'officer' || !c.owner || c.owner !== user.username) return 'FORBIDDEN';
    return c.status === 'IN_REVIEW' ? null : 'INVALID_STATE';
  }
  if (user.role === 'head') return c.status === 'PENDING_APPROVAL' ? null : 'INVALID_STATE';
  // B07: เจ้าหน้าที่อนุมัติ SV-02/03 ได้เองโดยไม่ผ่านหัวหน้า (API ไม่เช็กสิทธิ์ · ปุ่มบนหน้ายังซ่อน)
  if (kind === 'approve' && bug('B07')) {
    if (c.status === 'PENDING_APPROVAL') return null;
    if (c.status === 'IN_REVIEW' && c.owner === user.username) return null;
    return 'INVALID_STATE';
  }
  return 'FORBIDDEN';
}

const approveTx = db.transaction((user, caseNo) => {
  const c = user && (user.role === 'officer' || user.role === 'head') ? q.caseByNo().get(String(caseNo)) : null;
  const err = decisionCheck(user, c, 'approve');
  if (err) return fail(err);
  const nowIso = clock.nowIso();
  // SV-01 อยู่ทะเบียนรอผู้ถือเดิมออกเอกสาร · SV-02/03 กลับทะเบียนให้ผู้รับเรื่องขั้นแรกออกเอกสาร (A-27) · แถว APPROVED ไม่มีผู้ถือ (A-34)
  const r = db.prepare(`UPDATE cases SET status = 'APPROVED', approver = ?, approved_at = ?, owner = NULL, dept = 'registry',
      issuer = COALESCE(issuer, CASE WHEN service_id = 'SV-01' THEN ? ELSE NULL END), updated_at = ?
    WHERE id = ? AND status = ?`)
    .run(user.username, nowIso, user.username, nowIso, c.id, c.status);
  if (r.changes !== 1) return fail('INVALID_STATE');
  addEvent(c.id, nowIso, 'APPROVE', user.username, c.status, 'APPROVED');
  writeAudit({ user, event: 'APPROVE', caseNo: c.case_no, fromStatus: c.status, toStatus: 'APPROVED', detail: '', time: nowIso });
  return { body: { status: 'APPROVED' } };
});

const rejectTx = db.transaction((user, caseNo, reasonRaw) => {
  const c = user && (user.role === 'officer' || user.role === 'head') ? q.caseByNo().get(String(caseNo)) : null;
  const err = decisionCheck(user, c, 'reject');
  if (err) return fail(err);
  const reason = cleanText(reasonRaw);
  if (reasonTooShort(reason)) return fail('REASON_TOO_SHORT');
  const nowIso = clock.nowIso();
  const r = db.prepare(`UPDATE cases SET status = 'REJECTED', reject_reason = ?, approver = ?, closed_at = ?,
      owner = NULL, dept = NULL, updated_at = ?
    WHERE id = ? AND status = ?`)
    .run(reason, user.username, nowIso, nowIso, c.id, c.status);
  if (r.changes !== 1) return fail('INVALID_STATE');
  addEvent(c.id, nowIso, 'REJECT', user.username, c.status, 'REJECTED', reason);
  writeAudit({ user, event: 'REJECT', caseNo: c.case_no, fromStatus: c.status, toStatus: 'REJECTED', detail: reason, time: nowIso });
  return { body: { status: 'REJECTED', closedAt: nowIso } };
});

const ACTIONS = {
  claim: { run: (user, no) => claimTx(user, no), ok: (no) => `รับเรื่อง ${no} แล้ว` },
  return: {
    run: (user, no, body) => returnTx(user, no, body.reason),
    ok: (no, b) => `ตีกลับคำขอ ${no} ให้ผู้ยื่นแก้ไขแล้ว (ครั้งที่ ${b.returnCount})`,
    field: 'return',
  },
  forward: {
    run: (user, no, body) => forwardTx(user, no, body.note),
    ok: (no, b) => (b.status === 'PENDING_APPROVAL' ? `ส่งต่อคำขอ ${no} ให้หัวหน้าฝ่ายพิจารณาแล้ว` : `ส่งต่อคำขอ ${no} ไปฝ่ายโยธาแล้ว`),
  },
  approve: { run: (user, no) => approveTx(user, no), ok: (no) => `อนุมัติคำขอ ${no} แล้ว` },
  reject: {
    run: (user, no, body) => rejectTx(user, no, body.reason),
    ok: (no) => `บันทึกไม่อนุมัติคำขอ ${no} แล้ว`,
    field: 'reject',
  },
};

// ---------------------------------------------------------------- แจ้งเตือน (BR-15 · A-30 A-31)

// ประเมินระดับปัจจุบันของทุกคำขอที่ยังเปิดอยู่ (ไม่ย้อนแจ้งระดับที่ข้ามไป) · ผู้รับ:
//   PENDING_APPROVAL → head · APPROVED → ผู้ออกเอกสาร · มีผู้ถือ → ผู้ถือ · ไม่มีผู้ถือ → เจ้าหน้าที่ทุกคนของแผนก
//   ระดับ overdue แจ้ง head เพิ่มเสมอ (Set กันซ้ำ) · UNIQUE(username, case_id, level) + INSERT OR IGNORE = ไม่แจ้งซ้ำ
function evaluateNotifications(now = clock.now()) {
  const nowIso = clock.toIso(now);
  const hol = holidays();
  const staff = q.staff().all();
  const heads = staff.filter((u) => u.role === 'head').map((u) => u.username);
  const officersOf = (dept) => staff.filter((u) => u.role === 'officer' && u.dept === dept).map((u) => u.username);
  const ins = q.insNoti();
  let added = 0;
  for (const c of q.notifyCases().all(...NOTIFY_STATUSES)) {
    const level = levelOf(c, now, hol);
    if (level !== 'near' && level !== 'overdue') continue;
    const to = new Set();
    if (c.status === 'PENDING_APPROVAL') heads.forEach((u) => to.add(u));
    else if (c.status === 'APPROVED' && expectedIssuer(c)) to.add(expectedIssuer(c));
    else if (c.owner) to.add(c.owner);
    else officersOf(deptOf(c)).forEach((u) => to.add(u));
    if (level === 'overdue') heads.forEach((u) => to.add(u));
    const text = `คำขอ ${c.case_no} ${LEVEL_TH[level]}`;
    for (const username of to) added += ins.run(username, c.id, c.case_no, level, text, nowIso).changes;
  }
  return added;
}

hooks.onRequest('sla-notify', ({ now }) => { evaluateNotifications(now); }, { order: 50 });

function notificationItems(username) {
  return q.notisOf().all(username).map((n) => ({
    id: n.id, caseNo: n.case_no, level: n.level, text: n.text, createdAt: n.created_at,
  }));
}

// ---------------------------------------------------------------- HTML

const caseUrl = (no) => `/officer/cases/${encodeURIComponent(no)}`;

// หน้าที่ redirect กลับได้หลังทำรายการจากฟอร์ม (กัน open redirect)
function safeBack(v, fallback) {
  const s = String(v || '');
  if (/^\/officer\/(queue(\?filter=(all|unclaimed|mine))?|cases\/[A-Za-z0-9-]+)$/.test(s)) return s;
  return fallback;
}

function claimFormHtml(c, back) {
  return `<form method="post" action="${esc(caseUrl(c.case_no))}/claim" class="inline" data-once>
<input type="hidden" name="back" value="${esc(back)}">
<button type="submit" class="btn" data-testid="claim-btn" aria-label="รับเรื่อง ${esc(c.case_no)}">รับเรื่อง</button>
</form>`;
}

function queueRowHtml(c, user, filter, now, hol) {
  const level = levelOf(c, now, hol);
  const back = `/officer/queue?filter=${filter}`;
  return `<tr${attrs({
    'data-testid': 'queue-row',
    'data-case-no': c.case_no,
    'data-owner': c.owner || '',
    'data-status': c.status,
    'data-sla-level': level || '',
    'data-unclaimed': isUnclaimed(c) ? '1' : '0',
    'data-mine': isMine(c, user) ? '1' : '0',
  })}>
<td data-testid="row-case-no"><a href="${esc(caseUrl(c.case_no))}">${esc(c.case_no)}</a></td>
<td data-testid="row-service">${esc(serviceLabel(c.service_id))}${isSv03(c) ? `<br><span class="muted">${esc(CASE_STEP_TEXT[stepOf(c)] || '')}</span>` : ''}</td>
<td data-testid="row-applicant">${esc(c.applicant_name || '')}</td>
<td data-testid="row-id-masked">${esc(rules.maskId(safeDecrypt(c.applicant_id_enc)))}</td>
<td>${statusBadge('row-status', c.status)}</td>
<td>${dt('row-due', c.due_at)}</td>
<td>${level ? levelBadge('row-sla-level', level) : '<span data-testid="row-sla-level">–</span>'}</td>
<td data-testid="row-owner">${esc(c.owner || '')}</td>
<td>${canClaim(user, c) ? claimFormHtml(c, back) : ''}</td>
</tr>`;
}

const ONCE_JS = `document.addEventListener('submit',function(e){var f=e.target;if(!f||!f.hasAttribute||!f.hasAttribute('data-once'))return;
setTimeout(function(){f.querySelectorAll('button[type="submit"]').forEach(function(b){b.disabled=true;});},0);});`;

// queue-filter เปลี่ยนแล้วกรองทันทีในหน้า (สร้างแถวใหม่จาก <template> ทุกแถว · แถวที่ไม่ตรงไม่อยู่ใน DOM)
const QUEUE_JS = String.raw`(function () {
  var sel = document.getElementById('queue-filter');
  var body = document.getElementById('queue-body');
  var tpl = document.getElementById('queue-all-rows');
  var wrap = document.getElementById('queue-wrap');
  var apply = document.querySelector('[data-filter-apply]');
  if (!sel || !body || !tpl || !wrap) return;
  if (apply) apply.hidden = true;
  function match(tr, f) {
    if (f === 'unclaimed') return tr.getAttribute('data-unclaimed') === '1';
    if (f === 'mine') return tr.getAttribute('data-mine') === '1';
    return true;
  }
  sel.addEventListener('change', function () {
    var f = sel.value;
    var rows = Array.prototype.slice.call(tpl.content.cloneNode(true).querySelectorAll('tr'));
    while (body.firstChild) body.removeChild(body.firstChild);
    rows.forEach(function (tr) { if (match(tr, f)) body.appendChild(tr); });
    body.querySelectorAll('input[name="back"]').forEach(function (i) { i.value = '/officer/queue?filter=' + f; });
    var empty = document.querySelector('[data-testid="queue-empty"]');
    if (!body.children.length) {
      if (!empty) {
        empty = document.createElement('p');
        empty.setAttribute('data-testid', 'queue-empty');
        empty.className = 'msg msg-info';
        empty.textContent = 'ไม่มีงานในคิว';
        wrap.parentNode.insertBefore(empty, wrap.nextSibling);
      }
    } else if (empty) {
      empty.parentNode.removeChild(empty);
    }
    if (window.history && history.replaceState) history.replaceState(null, '', '/officer/queue' + (f === 'all' ? '' : '?filter=' + f));
  });
})();`;

function queuePage(req, res) {
  const user = req.user;
  const filter = normalizeFilter(req.query.filter);
  const now = clock.now();
  const hol = holidays();
  const all = queueRows(user);
  const shown = all.filter((c) => matchFilter(c, filter, user));
  const isOfficer = user.role === 'officer';
  const scope = isOfficer
    ? `คิวงาน${esc(DEPT_TH[user.dept] || '')}`
    : 'คิวงานทุกแผนก (หัวหน้าฝ่ายดูได้อย่างเดียว)';
  const head = `<tr><th scope="col">เลขคำขอ</th><th scope="col">บริการ</th><th scope="col">ผู้ยื่น</th><th scope="col">เลขบัตร</th>
<th scope="col">สถานะ</th><th scope="col">กำหนดเสร็จ</th><th scope="col">ระดับเตือน</th><th scope="col">ผู้ถือเรื่อง</th><th scope="col">ดำเนินการ</th></tr>`;
  const rowsOf = (list) => list.map((c) => queueRowHtml(c, user, filter, now, hol)).join('\n');
  const body = `<h1>คิวงาน</h1>
<p class="muted">${scope} · เรียงตามกำหนดเสร็จเร็วสุดก่อน (เท่ากันเรียงเลขคำขอ)</p>
${isOfficer ? `<p>งานในมือของฉัน: <strong data-testid="workload-count">${workloadOf(user.username)}</strong> / ${MAX_WORKLOAD} เรื่อง</p>` : ''}
<form method="get" action="/officer/queue" class="actions">
<div class="field"><label for="queue-filter">แสดงรายการ</label>
<select id="queue-filter" name="filter" data-testid="queue-filter">
${Object.entries(FILTERS).map(([v, label]) => `<option value="${v}"${v === filter ? ' selected' : ''}>${esc(label)}</option>`).join('')}
</select></div>
<div class="field"><button type="submit" class="btn btn-secondary" data-filter-apply>กรอง</button></div>
</form>
<div class="table-wrap" id="queue-wrap" role="region" aria-label="ตารางคิวงาน" tabindex="0">
<table data-testid="queue-table">
<thead>${head}</thead>
<tbody id="queue-body">${rowsOf(shown)}</tbody>
</table>
</div>
${shown.length ? '' : '<p class="msg msg-info" data-testid="queue-empty">ไม่มีงานในคิว</p>'}
<template id="queue-all-rows">${rowsOf(all)}</template>`;
  return renderPage(req, res, { title: 'คิวงาน', body, inlineScript: QUEUE_JS + '\n' + ONCE_JS });
}

function approvalsPage(req, res) {
  const now = clock.now();
  const hol = holidays();
  const rows = q.approvals().all();
  const body = `<h1>รายการรออนุมัติ</h1>
<p class="muted">คำขอที่ผ่านการตรวจของแผนกแล้ว รอหัวหน้าฝ่ายพิจารณา · เรียงตามกำหนดเสร็จเร็วสุดก่อน</p>
${rows.length ? `<div class="table-wrap" role="region" aria-label="ตารางรายการรออนุมัติ" tabindex="0">
<table data-testid="approval-table">
<thead><tr><th scope="col">เลขคำขอ</th><th scope="col">บริการ</th><th scope="col">ผู้ยื่น</th><th scope="col">กำหนดเสร็จ</th><th scope="col">ระดับเตือน</th><th scope="col">ดำเนินการ</th></tr></thead>
<tbody>${rows.map((c) => {
    const level = levelOf(c, now, hol);
    return `<tr${attrs({ 'data-testid': 'approval-row', 'data-case-no': c.case_no, 'data-status': c.status, 'data-sla-level': level || '' })}>
<td data-testid="row-case-no">${esc(c.case_no)}</td>
<td data-testid="row-service">${esc(serviceLabel(c.service_id))}</td>
<td data-testid="row-applicant">${esc(c.applicant_name || '')}</td>
<td>${dt('row-due', c.due_at)}</td>
<td>${level ? levelBadge('row-sla-level', level) : ''}</td>
<td><a class="btn btn-secondary" data-testid="approval-open" href="${esc(caseUrl(c.case_no))}" aria-label="เปิดคำขอ ${esc(c.case_no)}">เปิดคำขอ</a></td>
</tr>`;
  }).join('\n')}</tbody>
</table>
</div>` : '<p class="msg msg-info" data-testid="approval-empty">ไม่มีคำขอรออนุมัติ</p>'}`;
  return renderPage(req, res, { title: 'รายการรออนุมัติ', body });
}

function notificationsPage(req, res) {
  const items = q.notisOf().all(req.user.username);
  const body = `<h1>แจ้งเตือน</h1>
<p class="muted">แจ้งเมื่อคำขอที่เกี่ยวกับคุณเข้าระดับ "ใกล้ครบกำหนด" หรือ "เกินกำหนด" (ระดับละ 1 ครั้งต่อคำขอ)</p>
${items.length ? `<ul class="noti-list">${items.map((n) => `<li${attrs({
    'data-testid': 'noti-item', 'data-case-no': n.case_no, 'data-level': n.level, 'data-iso': n.created_at, class: `noti lv-${n.level}`,
  })}><a href="${esc(caseUrl(n.case_no))}">${esc(n.text)}</a></li>`).join('\n')}</ul>`
    : '<p class="msg msg-info" data-testid="noti-empty">ไม่มีแจ้งเตือน</p>'}`;
  return renderPage(req, res, { title: 'แจ้งเตือน', body });
}

function eventText(e) {
  const data = (() => { try { return e.data ? JSON.parse(e.data) : {}; } catch (_) { return {}; } })();
  const who = e.actor && e.actor !== 'citizen' && e.actor !== 'system' ? `${e.actor} ` : '';
  switch (e.type) {
    case 'PAID': return `ชำระค่าธรรมเนียมและส่งคำขอแล้ว${data.receiptNo ? ` (ใบเสร็จ ${data.receiptNo})` : ''}`;
    case 'CLAIM': return `${who}รับเรื่อง${data.step ? ` (${CASE_STEP_TEXT[data.step] || ''})` : ''}`;
    case 'RETURN': return `${who}ตีกลับ${data.returnNo ? ` ครั้งที่ ${data.returnNo}` : ''}${e.note ? `: ${e.note}` : ''}`;
    case 'RESUBMIT': return `ผู้ยื่นส่งแก้ไขเอกสาร${Number.isInteger(data.pausedDays) ? ` (หยุดนับ ${data.pausedDays} วันทำการ)` : ''}`;
    case 'FORWARD': {
      const where = e.to_status === 'PENDING_APPROVAL' ? 'หัวหน้าฝ่าย' : (Number(data.toStep) === 2 ? 'ฝ่ายโยธา' : 'ขั้นถัดไป');
      return `${who}ส่งต่อ${where}${e.note ? `: ${e.note}` : ''}`;
    }
    case 'APPROVE': return `${who}อนุมัติ`;
    case 'REJECT': return `${who}ไม่อนุมัติ${e.note ? `: ${e.note}` : ''}`;
    case 'ISSUE': return `${who}ออกเอกสารดิจิทัล${data.docNo ? ` ${data.docNo}` : ''}`;
    case 'CANCEL': return 'ผู้ยื่นยกเลิกคำขอ';
    case 'AUTO_CANCEL': return 'ระบบยกเลิกคำขออัตโนมัติ (เลยเวลาแก้ไข 168 ชั่วโมง)';
    default: return `${format.STATUS_TH[e.to_status] || e.type}${e.note ? `: ${e.note}` : ''}`;
  }
}

function takeFieldError(req, caseNo) {
  const fe = req.session && req.session.officerFieldError;
  if (!fe) return null;
  delete req.session.officerFieldError;
  return fe.caseNo === caseNo ? fe : null;
}

// ฟอร์มเหตุผล (ตีกลับ/ไม่อนุมัติ): <summary> = ปุ่มเปิด · ข้อผิดพลาดของช่องแสดงใต้ช่อง (return-reason-error / reject-reason-error)
function reasonFormHtml(c, kind, fieldError) {
  const t = kind === 'return'
    ? { btn: 'ตีกลับ', label: 'เหตุผลที่ตีกลับให้ผู้ยื่นแก้ไข (อย่างน้อย 10 ตัวอักษร)', submit: 'ยืนยันตีกลับ', cls: 'btn-secondary' }
    : { btn: 'ไม่อนุมัติ', label: 'เหตุผลที่ไม่อนุมัติ (อย่างน้อย 10 ตัวอักษร)', submit: 'ยืนยันไม่อนุมัติ', cls: 'btn-danger' };
  const err = fieldError && fieldError.form === kind ? fieldError : null;
  const errId = `${kind}-reason-error`;
  return `<details class="reason-box"${err ? ' open' : ''}>
<summary class="btn ${t.cls}" data-testid="${kind}-btn">${t.btn}</summary>
<form method="post" action="${esc(caseUrl(c.case_no))}/${kind}" novalidate data-once>
<div class="field"><label for="${kind}-reason">${esc(t.label)}</label>
<textarea id="${kind}-reason" name="reason" data-testid="${kind}-reason"${err ? ` aria-invalid="true" aria-describedby="${errId}"` : ''}>${esc(err ? err.value : '')}</textarea>
${err ? `<p id="${errId}" class="error-text" data-testid="${errId}" role="alert">${esc(err.message)}</p>` : ''}</div>
<button type="submit" class="btn ${t.cls}" data-testid="${kind}-submit">${t.submit}</button>
</form>
</details>`;
}

function actionsHtml(user, c, doc, fieldError) {
  const isOfficer = user.role === 'officer';
  const isOwner = isOfficer && !!c.owner && c.owner === user.username && c.status === 'IN_REVIEW';
  const parts = [];
  if (canClaim(user, c)) parts.push(`<div class="actions">${claimFormHtml(c, caseUrl(c.case_no))}</div>`);
  if (isOwner) {
    if (c.service_id === 'SV-01') {
      parts.push(`<div class="actions"><form method="post" action="${esc(caseUrl(c.case_no))}/approve" class="inline" data-once>
<button type="submit" class="btn" data-testid="approve-btn">อนุมัติ</button></form></div>`);
    } else {
      const dest = isSv03(c) && stepOf(c) === 1 ? 'ฝ่ายโยธา (ตรวจแบบ)' : 'หัวหน้าฝ่าย (อนุมัติ)';
      parts.push(`<form method="post" action="${esc(caseUrl(c.case_no))}/forward" class="forward-box" data-once>
<div class="field"><label for="forward-note">หมายเหตุส่งต่อ (ไม่บังคับ)</label>
<textarea id="forward-note" name="note" data-testid="forward-note"></textarea></div>
<p class="muted">ปลายทางตามเส้นทางของบริการ: ${esc(dest)}</p>
<button type="submit" class="btn" data-testid="forward-btn">ผ่าน/ส่งต่อ</button>
</form>`);
    }
    // B12: ตีกลับครั้งที่ 3 ได้ (ปุ่มยังแสดง)
    if ((c.return_count || 0) < MAX_RETURNS || bug('B12')) parts.push(reasonFormHtml(c, 'return', fieldError));
    else parts.push(`<p class="muted">ตีกลับครบ ${MAX_RETURNS} ครั้งแล้ว${c.service_id === 'SV-01' ? '' : ' · ส่งต่อพร้อมหมายเหตุให้หัวหน้าฝ่ายพิจารณา'}</p>`);
    if (c.service_id === 'SV-01') parts.push(reasonFormHtml(c, 'reject', fieldError));
  }
  if (user.role === 'head' && c.status === 'PENDING_APPROVAL' && c.service_id !== 'SV-01') {
    parts.push(`<div class="actions"><form method="post" action="${esc(caseUrl(c.case_no))}/approve" class="inline" data-once>
<button type="submit" class="btn" data-testid="approve-btn">อนุมัติ</button></form></div>`);
    parts.push(reasonFormHtml(c, 'reject', fieldError));
  }
  if (isOfficer && c.status === 'APPROVED' && !doc && expectedIssuer(c) === user.username) {
    parts.push(`<div class="actions"><form method="post" action="${esc(caseUrl(c.case_no))}/issue" class="inline" data-once>
<button type="submit" class="btn" data-testid="issue-btn">ออกเอกสาร</button></form></div>`);
  }
  if (!parts.length) return '';
  return `<section class="card" aria-labelledby="act-h"><h2 id="act-h">ดำเนินการ</h2>
${parts.join('\n')}
</section>`;
}

function casePage(req, res) {
  const user = req.user;
  const c = q.caseByNo().get(String(req.params.caseNo));
  if (!c) return renderNotFound(req, res);
  const lib = documentsLib();
  const now = clock.now();
  const level = levelOf(c, now, holidays());
  const cz = q.citizen().get(c.citizen_id);
  const masked = rules.maskId(cz ? safeDecrypt(cz.id_enc) : '');
  const doc = lib && lib.documentForCase ? lib.documentForCase(c.id) : null;
  const fieldError = takeFieldError(req, c.case_no);

  const details = [
    ['สถานะ', statusBadge('case-status', c.status)],
    ['บริการ', `<span data-testid="case-service">${esc(serviceLabel(c.service_id))}</span>`],
  ];
  if (isSv03(c)) details.push(['ขั้นตอน', `<span data-testid="case-step">${esc(CASE_STEP_TEXT[stepOf(c)] || CASE_STEP_TEXT[1])}</span>`]);
  if (c.service_id === 'SV-01' && c.qty) details.push(['จำนวน', `${esc(c.qty)} ฉบับ`]);
  if (isSv03(c) && c.area_sqm) details.push(['พื้นที่', `${esc(c.area_sqm)} ตร.ม.`]);
  details.push(
    ['ค่าธรรมเนียม', `<span data-testid="case-fee">${esc(money(c.fee))}</span>`],
    ['ผู้ยื่น', `<span data-testid="applicant-name">${esc(cz ? cz.name : '')}</span>`],
    ['เลขบัตรประชาชน', lib && lib.unmaskWidgetHtml ? lib.unmaskWidgetHtml(c.case_no, masked) : `<span data-testid="applicant-id">${esc(masked)}</span>`],
    ['ชำระเมื่อ', dt('case-paid-at', c.paid_at)],
    ['กำหนดเสร็จ', dt('sla-due', c.due_at)],
    ['ระดับเตือน', level ? levelBadge('sla-level', level) : '–'],
  );
  if (c.status === 'COMPLETED' || c.status === 'REJECTED') details.push(['ปิดงานเมื่อ', dt('closed-at', c.closed_at)]);
  if (c.status === 'CANCELLED' && c.cancelled_at) details.push(['ยกเลิกเมื่อ', dt('cancelled-at', c.cancelled_at)]);
  details.push(
    ['ผู้ถือเรื่อง', `<span data-testid="case-owner">${esc(c.owner || NO_OWNER_TEXT)}</span>`],
    ['ตีกลับแล้ว', `<span data-testid="return-count">${esc(c.return_count || 0)}</span> ครั้ง (สูงสุด ${MAX_RETURNS})`],
  );
  if (expectedIssuer(c)) details.push(['ผู้ออกเอกสาร', esc(displayName(expectedIssuer(c)))]);
  if (c.status === 'NEED_FIX') {
    if (c.return_reason) details.push(['เหตุผลที่ตีกลับ', esc(c.return_reason)]);
    const deadline = c.returned_at ? rules.fixDeadline(c.returned_at) : c.fix_deadline;
    if (deadline) details.push(['เส้นตายแก้ไข', dt('fix-deadline', deadline)]);
  }
  if (c.status === 'REJECTED' && c.reject_reason) details.push(['เหตุผลที่ไม่อนุมัติ', esc(c.reject_reason)]);

  let filesHtml;
  const access = lib && lib.canAccessCaseFiles ? lib.canAccessCaseFiles(user, c) : 'ok';
  if (access !== 'ok') filesHtml = '<p class="muted">เปิดดูไฟล์แนบได้เฉพาะเจ้าหน้าที่ของแผนกที่คำขออยู่หรือเคยผ่าน</p>';
  else if (lib && lib.fileItemsHtml) filesHtml = lib.fileItemsHtml(c.id);
  else filesHtml = '<p>ไม่มีไฟล์แนบ</p>';

  const timeline = q.events().all(c.id).map((e) => {
    const at = format.iso(e.at);
    return `<li${attrs({ 'data-testid': 'timeline-item', 'data-iso': at, 'data-event': e.type })}><time datetime="${esc(at)}">${esc(format.thaiDateTime(e.at))}</time> · ${esc(eventText(e))}</li>`;
  }).join('\n');

  const back = user.role === 'head'
    ? '<p><a href="/head/approvals">← รายการรออนุมัติ</a> · <a href="/officer/queue">คิวงาน</a></p>'
    : '<p><a href="/officer/queue">← คิวงาน</a></p>';
  const body = `${back}
<h1>คำขอ <span data-testid="case-no">${esc(c.case_no)}</span></h1>
<section class="card" aria-labelledby="detail-h">
<h2 id="detail-h">รายละเอียดคำขอ</h2>
<dl class="kv">${details.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('\n')}</dl>
</section>
${actionsHtml(user, c, doc, fieldError)}
${doc && lib && lib.documentPanelHtml ? lib.documentPanelHtml(doc, { citizen: false }) : ''}
<section class="card" aria-labelledby="files-h">
<h2 id="files-h">เอกสารแนบ</h2>
${filesHtml}
</section>
<section class="card" aria-labelledby="timeline-h">
<h2 id="timeline-h">ไทม์ไลน์</h2>
<ul class="timeline" data-testid="case-timeline">${timeline}</ul>
</section>`;
  return renderPage(req, res, { title: `คำขอ ${c.case_no}`, body, inlineScript: ONCE_JS });
}

// ฟอร์มหน้า → ทำรายการ → redirect (PRG) · ข้อผิดพลาดของเหตุผลแสดงใต้ช่อง · อื่น ๆ เป็น action-error
function formAction(name) {
  const a = ACTIONS[name];
  return (req, res) => {
    const caseNo = String(req.params.caseNo);
    const fallback = caseUrl(caseNo);
    const back = safeBack(req.body && req.body.back, fallback);
    const r = a.run(req.user, caseNo, req.body || {});
    if (r.error === 'NOT_FOUND') return renderNotFound(req, res);
    if (r.error === 'REASON_TOO_SHORT' && a.field) {
      req.session.officerFieldError = {
        caseNo, form: a.field, message: messageOf('REASON_TOO_SHORT'), value: String((req.body && req.body.reason) || ''),
      };
      return res.redirect(303, fallback);
    }
    if (r.error) setFlash(req, 'error', messageOf(r.error));
    else setFlash(req, 'success', a.ok(caseNo, r.body));
    return res.redirect(303, back);
  };
}

function apiAction(name) {
  const a = ACTIONS[name];
  return (req, res) => {
    const r = a.run(req.user, String(req.params.caseNo), req.body || {});
    if (r.error) return sendError(res, r.error);
    return res.status(200).json(r.body);
  };
}

// ---------------------------------------------------------------- ลงทะเบียน route

module.exports = function register() {
  const router = express.Router();
  const staffPages = auth.requireRole('officer', 'head');

  // ----- หน้า -----
  router.get('/officer/queue', staffPages, queuePage);
  router.get('/officer/cases/:caseNo', staffPages, casePage);
  router.get('/head/approvals', auth.requireRole('head'), approvalsPage);
  router.get('/notifications', staffPages, notificationsPage);
  for (const name of ['claim', 'return', 'forward', 'approve', 'reject']) {
    router.post(`/officer/cases/:caseNo/${name}`, staffPages, formAction(name));
  }

  // ----- API (ไม่ล็อกอิน 401 · บทบาท/สิทธิ์ไม่ตรง 403 ตรวจในแต่ละรายการ) -----
  router.get('/api/officer/queue', auth.requireRole('officer', 'head'), (req, res) => {
    const filter = normalizeFilter(req.query.filter);
    const out = { items: queueItems(req.user, filter), filter };
    if (req.user.role === 'officer') out.workload = workloadOf(req.user.username);
    return res.status(200).json(out);
  });
  router.post('/api/officer/cases/:caseNo/claim', auth.requireLogin, apiAction('claim'));
  router.post('/api/officer/cases/:caseNo/return', auth.requireLogin, apiAction('return'));
  router.post('/api/officer/cases/:caseNo/forward', auth.requireLogin, apiAction('forward'));
  router.post('/api/cases/:caseNo/approve', auth.requireLogin, apiAction('approve'));
  router.post('/api/cases/:caseNo/reject', auth.requireLogin, apiAction('reject'));
  router.get('/api/notifications', auth.requireRole('officer', 'head'), (req, res) => (
    res.status(200).json({ items: notificationItems(req.user.username) })
  ));

  return router;
};

Object.assign(module.exports, {
  queueItems, workloadOf, evaluateNotifications, expectedIssuer, notificationItems, MAX_WORKLOAD, MAX_RETURNS,
});
