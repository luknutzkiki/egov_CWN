'use strict';
// Audit Trail · เพิ่มได้อย่างเดียว (DECISIONS §13 · CONTRACT §6.8 · REQUIREMENTS BR-27)
// ไฟล์นี้มีแต่ INSERT · ไม่มีฟังก์ชันแก้/ลบ (ตาราง audit มี trigger ห้าม UPDATE/DELETE ใน db.js อีกชั้น)
//
// ใช้:
//   const { writeAudit } = require('../lib/audit');
//   writeAudit({ username: 'off.reg2', role: 'officer', event: 'CLAIM', caseNo: 'EG-2569-000028',
//                fromStatus: 'SUBMITTED', toStatus: 'IN_REVIEW', detail: '' });
//   writeAudit({ user: req.user, event: 'EXPORT', detail: 'xlsx 2026-11 ALL' });   // ส่ง user แทน username/role ได้
// - เวลา = นาฬิกาทดสอบ (clock.nowIso()) เสมอ · ส่ง time เองได้ถ้าต้องการเวลาเดียวกับรายการอื่นใน transaction
// - เรียกใน db.transaction เดียวกับการเปลี่ยนสถานะ → ทำรายการไม่สำเร็จ = ไม่มีแถว audit (A-36)
// - คืน id ของแถวที่เพิ่ม

const db = require('../db');
const clock = require('./clock');

const EVENTS = new Set(db.AUDIT_EVENTS || [
  'STAFF_LOGIN', 'CLAIM', 'RETURN', 'FORWARD', 'APPROVE', 'REJECT', 'ISSUE', 'UNMASK', 'EXPORT', 'ADMIN_CHANGE',
]);

function writeAudit({ user = null, username, role, event, caseNo = null, fromStatus = null, toStatus = null, detail = '', time } = {}) {
  const who = username || (user && user.username);
  const as = role || (user && user.role);
  if (!who || !as) throw new TypeError('writeAudit: ต้องมี username และ role');
  if (!EVENTS.has(event)) throw new TypeError(`writeAudit: เหตุการณ์ไม่รู้จัก ${event}`);
  const r = db.prepare(`INSERT INTO audit (time, username, role, event, case_no, from_status, to_status, detail)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    time || clock.nowIso(), who, as, event, caseNo || null, fromStatus || null, toStatus || null,
    detail === null || detail === undefined ? '' : String(detail),
  );
  return Number(r.lastInsertRowid);
}

module.exports = { writeAudit, EVENTS };
