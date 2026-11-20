'use strict';
// ข้อมูล seed ตาม TEST-DATA.md (B02) · เรียกโดย POST /api/test/reset หลัง DROP+สร้างตารางใหม่ (ใน db.transaction เดียว)
//
// หลักการ
// - ค่าทุกค่า (paidAt · dueAt · closedAt · owner · returnCount · ใบเสร็จ · PP-0001 · DOC-2569-000001) ใส่ตรงตามตาราง TEST-DATA
//   ไม่คำนวณใหม่และไม่อ่านนาฬิกา (A-35) → reset กี่ครั้งก็ได้ผลเหมือนเดิม (ต่างกันแค่ IV ของค่าที่เข้ารหัส)
// - เลขบัตร/เบอร์เก็บด้วย crypto.encrypt + crypto.lookupHash เท่านั้น (NFR-04) · อีเมลว่าง
// - seed ไม่สร้างแจ้งเตือนและ Audit (A-35 · TEST-DATA §10)
// - id ในตาราง: users 1–7 ตามลำดับ §1.2 · citizens 1 สมชาย 2 สมหญิง 3 มานะ 4 ปิติ · cases.id = ลำดับเลขคำขอ (1–30) · drafts 1–2
// - fileId ของ seed ตายตัว: `f_seed_<ลำดับ 6 หลัก>_<docKey>` (คำขอ) · `f_seed_DR-0002_<docKey>` (ร่าง)
//
// ข้อตกลงของ case_events ที่ seed ใช้ (บล็อก workflow ใช้ชนิดเดียวกันต่อได้)
//   PAID (actor citizen)                      · CLAIM (เจ้าหน้าที่รับเรื่อง · data.step สำหรับ SV-03)
//   RETURN (note = เหตุผล · data.fixDeadline) · RESUBMIT (actor citizen · data.pausedDays · data.dueBefore · data.dueAfter)
//   FORWARD (data.toStep หรือไปหัวหน้า)        · APPROVE / REJECT (note = เหตุผลไม่อนุมัติ) · ISSUE (data.docNo ถ้ามี) · CANCEL (actor citizen)

const PDF_HEAD = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n', 'latin1');
const PDF_TAIL = Buffer.from('\ntrailer<</Root 1 0 R>>\n%%EOF\n', 'latin1');
// PDF จริงขนาด n ไบต์ (เหมือน make_testfiles.py ใน TEST-DATA §11)
function pdf(n) {
  const pad = n - PDF_HEAD.length - PDF_TAIL.length;
  return Buffer.concat([PDF_HEAD, Buffer.alloc(pad, 0x20), PDF_TAIL]);
}
const SEED_PDF = pdf(1024);

// '2026-11-24 11:00' → '2026-11-24T11:00:00+07:00' · ค่าที่มีวินาทีอยู่แล้วส่งเป็น ISO ตรง ๆ
const T = (s) => (s === null || s === undefined ? null : (s.includes('T') ? s : `${s.replace(' ', 'T')}:00+07:00`));
// บวกนาทีให้เวลาไทยในรูป ISO +07:00 (ใช้สร้างเวลาเหตุการณ์ประกอบ เช่น รับเรื่องหลังชำระ 30 นาที)
function addMin(iso, minutes) {
  const ms = Date.parse(iso) + minutes * 60000 + 7 * 3600000;
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}+07:00`;
}

const SEED_CREATED = '2026-10-01T08:00:00+07:00';
const PASSWORD = 'Test@1234';

// TEST-DATA §1.2 · CONTRACT §3
const USERS = [
  ['off.reg1', 'เจ้าหน้าที่ทะเบียน 1', 'officer', 'registry'],
  ['off.reg2', 'เจ้าหน้าที่ทะเบียน 2', 'officer', 'registry'],
  ['off.works1', 'เจ้าหน้าที่โยธา 1', 'officer', 'works'],
  ['head1', 'หัวหน้าฝ่าย', 'head', null],
  ['exec1', 'ผู้บริหาร', 'executive', null],
  ['audit1', 'ผู้ตรวจสอบภายใน', 'auditor', null],
  ['admin1', 'ผู้ดูแลระบบ', 'admin', null],
];

// TEST-DATA §1.1 · DECISIONS §17
const CITIZENS = [
  { id: 1, idNo: '1101700123456', name: 'สมชาย ใจดี', mobile: '0812345678', registered: 1 },
  { id: 2, idNo: '3100600987659', name: 'สมหญิง รักไทย', mobile: '0823456789', registered: 1 },
  { id: 3, idNo: '5500400111221', name: 'มานะ ตั้งใจ', mobile: null, registered: 0 },
  { id: 4, idNo: '1909900555015', name: 'ปิติ มีสุข', mobile: '0834567890', registered: 1 },
];
const SOMCHAI = 1; const SOMYING = 2; const PITI = 4;

// TEST-DATA §2
const SERVICES = [
  { id: 'SV-01', name: 'ขอหนังสือรับรอง', fee: 20, feePerSqm: null, sla: 3 },
  { id: 'SV-02', name: 'ขออนุญาตประกอบกิจการ', fee: 500, feePerSqm: null, sla: 10 },
  { id: 'SV-03', name: 'ขออนุญาตก่อสร้าง/ต่อเติมอาคาร', fee: 1000, feePerSqm: 10, sla: 15 },
];
const SERVICE_DOCS = { 'SV-01': ['id-card'], 'SV-02': ['id-card', 'map'], 'SV-03': ['id-card', 'plan', 'deed'] };

// TEST-DATA §3
const HOLIDAYS = [
  ['2026-12-07', 'ชดเชยวันหยุดทดสอบ (สมมติ)'],
  ['2026-12-10', 'วันรัฐธรรมนูญทดสอบ (สมมติ)'],
  ['2026-12-31', 'วันสิ้นปีทดสอบ (สมมติ)'],
  ['2027-01-01', 'วันขึ้นปีใหม่ทดสอบ (สมมติ)'],
];

// TEST-DATA §4.4
const F01_REASON_1 = 'ภาพบัตรประชาชนไม่ชัด กรุณาถ่ายใหม่';
const F01_REASON_2 = 'ชื่อในเอกสารไม่ตรงกับบัตร กรุณาแก้ไข';
const F02_REASON_1 = 'ภาพเอกสารเบลอ อ่านเลขไม่ได้';
const F02_REASON_2 = 'ข้อมูลในแบบฟอร์มไม่ครบถ้วน';
const H04_REJECT_REASON = 'เอกสารประกอบไม่ครบถ้วนตามที่กำหนด';

// TEST-DATA §4.1 (ตรงตัว) · ev = ไทม์ไลน์หลังชำระ [เวลา, ชนิด, ผู้ทำ, จากสถานะ, เป็นสถานะ, หมายเหตุ, data]
//   tag · service · qty/area · fee · ผู้ยื่น · status · step · dept · owner · issuer · approver · approvedAt · paidAt · dueAt · closedAt · cancelledAt
const CASES = [
  { seq: 1, tag: 'H01', sv: 'SV-01', qty: 1, fee: 20, cz: SOMYING, status: 'COMPLETED', issuer: 'off.reg1', approver: 'off.reg1', approvedAt: '2026-10-16 13:30', paid: '2026-10-14 10:00', due: '2026-10-19 16:30', closed: '2026-10-16 14:00',
    ev: [['2026-10-14 10:30', 'CLAIM', 'off.reg1', 'SUBMITTED', 'IN_REVIEW'], ['2026-10-16 13:30', 'APPROVE', 'off.reg1', 'IN_REVIEW', 'APPROVED'], ['2026-10-16 14:00', 'ISSUE', 'off.reg1', 'APPROVED', 'COMPLETED']] },
  { seq: 2, tag: 'H05', sv: 'SV-03', area: 120, fee: 1200, cz: PITI, status: 'COMPLETED', step: 3, issuer: 'off.reg1', approver: 'head1', approvedAt: '2026-11-20 10:30', paid: '2026-11-02 09:00', due: '2026-11-23 16:30', closed: '2026-11-20 11:00',
    ev: [['2026-11-02 09:30', 'CLAIM', 'off.reg1', 'SUBMITTED', 'IN_REVIEW', null, { step: 1 }], ['2026-11-05 14:00', 'FORWARD', 'off.reg1', 'IN_REVIEW', 'IN_REVIEW', null, { toStep: 2 }],
      ['2026-11-06 09:00', 'CLAIM', 'off.works1', 'IN_REVIEW', 'IN_REVIEW', null, { step: 2 }], ['2026-11-13 14:00', 'FORWARD', 'off.works1', 'IN_REVIEW', 'PENDING_APPROVAL', null, { toStep: 3 }],
      ['2026-11-20 10:30', 'APPROVE', 'head1', 'PENDING_APPROVAL', 'APPROVED'], ['2026-11-20 11:00', 'ISSUE', 'off.reg1', 'APPROVED', 'COMPLETED']] },
  { seq: 3, tag: 'H02', sv: 'SV-01', qty: 2, fee: 40, cz: PITI, status: 'COMPLETED', issuer: 'off.reg1', approver: 'off.reg1', approvedAt: '2026-11-04 14:30', paid: '2026-11-02 09:30', due: '2026-11-05 16:30', closed: '2026-11-04 15:00',
    ev: [['2026-11-02 10:00', 'CLAIM', 'off.reg1', 'SUBMITTED', 'IN_REVIEW'], ['2026-11-04 14:30', 'APPROVE', 'off.reg1', 'IN_REVIEW', 'APPROVED'], ['2026-11-04 15:00', 'ISSUE', 'off.reg1', 'APPROVED', 'COMPLETED']] },
  { seq: 4, tag: 'H06', sv: 'SV-02', fee: 500, cz: SOMCHAI, status: 'COMPLETED', issuer: 'off.reg1', approver: 'head1', approvedAt: '2026-11-13 14:30', paid: '2026-11-02 14:00', due: '2026-11-16 16:30', closed: '2026-11-13 15:00',
    ev: [['2026-11-02 14:30', 'CLAIM', 'off.reg1', 'SUBMITTED', 'IN_REVIEW'], ['2026-11-09 10:00', 'FORWARD', 'off.reg1', 'IN_REVIEW', 'PENDING_APPROVAL'],
      ['2026-11-13 14:30', 'APPROVE', 'head1', 'PENDING_APPROVAL', 'APPROVED'], ['2026-11-13 15:00', 'ISSUE', 'off.reg1', 'APPROVED', 'COMPLETED']] },
  { seq: 5, tag: 'H03', sv: 'SV-01', qty: 1, fee: 20, cz: SOMCHAI, status: 'COMPLETED', issuer: 'off.reg1', approver: 'off.reg1', approvedAt: '2026-11-05 09:30', paid: '2026-11-03 11:00', due: '2026-11-06 16:30', closed: '2026-11-05 10:00',
    ev: [['2026-11-03 11:30', 'CLAIM', 'off.reg1', 'SUBMITTED', 'IN_REVIEW'], ['2026-11-05 09:30', 'APPROVE', 'off.reg1', 'IN_REVIEW', 'APPROVED'],
      ['2026-11-05 10:00', 'ISSUE', 'off.reg1', 'APPROVED', 'COMPLETED', null, { docNo: 'DOC-2569-000001' }]] },
  { seq: 6, tag: 'H08', sv: 'SV-02', fee: 500, cz: PITI, status: 'COMPLETED', issuer: 'off.reg1', approver: 'head1', approvedAt: '2026-11-19 09:30', paid: '2026-11-03 15:00', due: '2026-11-17 16:30', closed: '2026-11-19 10:00',
    ev: [['2026-11-03 15:30', 'CLAIM', 'off.reg1', 'SUBMITTED', 'IN_REVIEW'], ['2026-11-12 10:00', 'FORWARD', 'off.reg1', 'IN_REVIEW', 'PENDING_APPROVAL'],
      ['2026-11-19 09:30', 'APPROVE', 'head1', 'PENDING_APPROVAL', 'APPROVED'], ['2026-11-19 10:00', 'ISSUE', 'off.reg1', 'APPROVED', 'COMPLETED']] },
  { seq: 7, tag: 'H07', sv: 'SV-02', fee: 500, cz: SOMYING, status: 'COMPLETED', issuer: 'off.reg1', approver: 'head1', approvedAt: '2026-11-18 15:30', paid: '2026-11-04 10:00', due: '2026-11-18 16:30', closed: '2026-11-18 16:00',
    ev: [['2026-11-04 10:30', 'CLAIM', 'off.reg1', 'SUBMITTED', 'IN_REVIEW'], ['2026-11-11 10:00', 'FORWARD', 'off.reg1', 'IN_REVIEW', 'PENDING_APPROVAL'],
      ['2026-11-18 15:30', 'APPROVE', 'head1', 'PENDING_APPROVAL', 'APPROVED'], ['2026-11-18 16:00', 'ISSUE', 'off.reg1', 'APPROVED', 'COMPLETED']] },
  { seq: 8, tag: 'H04', sv: 'SV-01', qty: 1, fee: 20, cz: SOMYING, status: 'REJECTED', issuer: 'off.reg1', approver: 'off.reg1', rejectReason: H04_REJECT_REASON, paid: '2026-11-09 10:00', due: '2026-11-12 16:30', closed: '2026-11-11 09:00',
    ev: [['2026-11-09 10:30', 'CLAIM', 'off.reg1', 'SUBMITTED', 'IN_REVIEW'], ['2026-11-11 09:00', 'REJECT', 'off.reg1', 'IN_REVIEW', 'REJECTED', H04_REJECT_REASON]] },
  { seq: 9, tag: 'X01', sv: 'SV-01', qty: 1, fee: 20, cz: SOMCHAI, status: 'CANCELLED', paid: '2026-11-09 14:30', due: '2026-11-12 16:30', cancelled: '2026-11-09 15:00',
    ev: [['2026-11-09 15:00', 'CANCEL', 'citizen', 'SUBMITTED', 'CANCELLED']] },
  { seq: 10, tag: 'W01', sv: 'SV-03', area: 80, fee: 1000, cz: SOMYING, status: 'IN_REVIEW', step: 2, dept: 'works', issuer: 'off.reg1', paid: '2026-11-12 10:00', due: '2026-12-03 16:30',
    ev: [['2026-11-12 10:30', 'CLAIM', 'off.reg1', 'SUBMITTED', 'IN_REVIEW', null, { step: 1 }], ['2026-11-17 14:00', 'FORWARD', 'off.reg1', 'IN_REVIEW', 'IN_REVIEW', null, { toStep: 2 }]] },
  { seq: 11, tag: 'P02', sv: 'SV-03', area: 150, fee: 1500, cz: SOMCHAI, status: 'PENDING_APPROVAL', step: 3, issuer: 'off.reg1', paid: '2026-11-16 10:00', due: '2026-12-08 16:30',
    ev: [['2026-11-16 10:30', 'CLAIM', 'off.reg1', 'SUBMITTED', 'IN_REVIEW', null, { step: 1 }], ['2026-11-18 14:00', 'FORWARD', 'off.reg1', 'IN_REVIEW', 'IN_REVIEW', null, { toStep: 2 }],
      ['2026-11-19 09:00', 'CLAIM', 'off.works1', 'IN_REVIEW', 'IN_REVIEW', null, { step: 2 }], ['2026-11-26 14:00', 'FORWARD', 'off.works1', 'IN_REVIEW', 'PENDING_APPROVAL', null, { toStep: 3 }]] },
  { seq: 12, tag: 'R09', sv: 'SV-03', area: 101, fee: 1010, cz: PITI, status: 'IN_REVIEW', step: 1, dept: 'registry', owner: 'off.reg2', issuer: 'off.reg2', paid: '2026-11-18 10:00', due: '2026-12-11 16:30',
    ev: [['2026-11-18 10:30', 'CLAIM', 'off.reg2', 'SUBMITTED', 'IN_REVIEW', null, { step: 1 }]] },
  { seq: 13, tag: 'R01', sv: 'SV-02', fee: 500, cz: SOMCHAI, status: 'IN_REVIEW', dept: 'registry', owner: 'off.reg2', issuer: 'off.reg2', paid: '2026-11-20 10:00', due: '2026-12-04 16:30', claim: true },
  { seq: 14, tag: 'P01', sv: 'SV-02', fee: 500, cz: PITI, status: 'PENDING_APPROVAL', issuer: 'off.reg1', paid: '2026-11-20 11:00', due: '2026-12-04 16:30',
    ev: [['2026-11-20 11:30', 'CLAIM', 'off.reg1', 'SUBMITTED', 'IN_REVIEW'], ['2026-11-27 10:00', 'FORWARD', 'off.reg1', 'IN_REVIEW', 'PENDING_APPROVAL']] },
  { seq: 15, tag: 'R02', sv: 'SV-02', fee: 500, cz: SOMYING, status: 'IN_REVIEW', dept: 'registry', owner: 'off.reg2', issuer: 'off.reg2', paid: '2026-11-20 15:00', due: '2026-12-04 16:30', claim: true },
  { seq: 16, tag: 'R03', sv: 'SV-02', fee: 500, cz: PITI, status: 'IN_REVIEW', dept: 'registry', owner: 'off.reg2', issuer: 'off.reg2', paid: '2026-11-23 09:00', due: '2026-12-08 16:30', claim: true },
  { seq: 17, tag: 'F01', sv: 'SV-01', qty: 1, fee: 20, cz: SOMCHAI, status: 'NEED_FIX', dept: 'registry', owner: 'off.reg1', issuer: 'off.reg1', paid: '2026-11-23 10:00', due: '2026-11-27 16:30',
    returnCount: 2, returnedAt: '2026-11-27 14:00', returnReason: F01_REASON_2, fixDeadline: '2026-12-04 14:00',
    ev: [['2026-11-23 10:30', 'CLAIM', 'off.reg1', 'SUBMITTED', 'IN_REVIEW'],
      ['2026-11-24 11:00', 'RETURN', 'off.reg1', 'IN_REVIEW', 'NEED_FIX', F01_REASON_1, { returnNo: 1, fixDeadline: T('2026-12-01 11:00') }],
      ['2026-11-25 10:00', 'RESUBMIT', 'citizen', 'NEED_FIX', 'IN_REVIEW', null, { pausedDays: 1, dueBefore: T('2026-11-26 16:30'), dueAfter: T('2026-11-27 16:30') }],
      ['2026-11-27 14:00', 'RETURN', 'off.reg1', 'IN_REVIEW', 'NEED_FIX', F01_REASON_2, { returnNo: 2, fixDeadline: T('2026-12-04 14:00') }]] },
  { seq: 18, tag: 'R04', sv: 'SV-02', fee: 500, cz: SOMCHAI, status: 'IN_REVIEW', dept: 'registry', owner: 'off.reg2', issuer: 'off.reg2', paid: '2026-11-24 10:00', due: '2026-12-09 16:30', claim: true },
  { seq: 19, tag: 'A01', sv: 'SV-02', fee: 500, cz: SOMYING, status: 'APPROVED', dept: 'registry', issuer: 'off.reg1', approver: 'head1', approvedAt: '2026-11-30 15:00', paid: '2026-11-24 14:00', due: '2026-12-09 16:30',
    ev: [['2026-11-24 14:30', 'CLAIM', 'off.reg1', 'SUBMITTED', 'IN_REVIEW'], ['2026-11-27 11:00', 'FORWARD', 'off.reg1', 'IN_REVIEW', 'PENDING_APPROVAL'],
      ['2026-11-30 15:00', 'APPROVE', 'head1', 'PENDING_APPROVAL', 'APPROVED']] },
  { seq: 20, tag: 'O01', sv: 'SV-01', qty: 1, fee: 20, cz: SOMCHAI, status: 'IN_REVIEW', dept: 'registry', owner: 'off.reg1', issuer: 'off.reg1', paid: '2026-11-25 10:00', due: '2026-11-30 16:30', claim: true },
  { seq: 21, tag: 'R08', sv: 'SV-02', fee: 500, cz: SOMYING, status: 'IN_REVIEW', dept: 'registry', owner: 'off.reg2', issuer: 'off.reg2', paid: '2026-11-25 12:00', due: '2026-12-11 16:30', claim: true },
  { seq: 22, tag: 'N02', sv: 'SV-01', qty: 2, fee: 40, cz: SOMYING, status: 'IN_REVIEW', dept: 'registry', owner: 'off.reg1', issuer: 'off.reg1', paid: '2026-11-26 10:00', due: '2026-12-01 16:30', claim: true },
  { seq: 23, tag: 'F02', sv: 'SV-01', qty: 1, fee: 20, cz: SOMYING, status: 'IN_REVIEW', dept: 'registry', owner: 'off.reg1', issuer: 'off.reg1', paid: '2026-11-26 10:30', due: '2026-12-03 16:30',
    returnCount: 2, returnedAt: '2026-11-30 14:00', returnReason: F02_REASON_2,
    ev: [['2026-11-26 11:00', 'CLAIM', 'off.reg1', 'SUBMITTED', 'IN_REVIEW'],
      ['2026-11-27 10:00', 'RETURN', 'off.reg1', 'IN_REVIEW', 'NEED_FIX', F02_REASON_1, { returnNo: 1, fixDeadline: T('2026-12-04 10:00') }],
      ['2026-11-30 10:00', 'RESUBMIT', 'citizen', 'NEED_FIX', 'IN_REVIEW', null, { pausedDays: 1, dueBefore: T('2026-12-01 16:30'), dueAfter: T('2026-12-02 16:30') }],
      ['2026-11-30 14:00', 'RETURN', 'off.reg1', 'IN_REVIEW', 'NEED_FIX', F02_REASON_2, { returnNo: 2, fixDeadline: T('2026-12-07 14:00') }],
      ['2026-12-01 08:30', 'RESUBMIT', 'citizen', 'NEED_FIX', 'IN_REVIEW', null, { pausedDays: 1, dueBefore: T('2026-12-02 16:30'), dueAfter: T('2026-12-03 16:30') }]] },
  { seq: 24, tag: 'N01', sv: 'SV-01', qty: 1, fee: 20, cz: PITI, status: 'SUBMITTED', dept: 'registry', paid: '2026-11-27 11:00', due: '2026-12-02 16:30' },
  { seq: 25, tag: 'R05', sv: 'SV-01', qty: 3, fee: 60, cz: SOMYING, status: 'IN_REVIEW', dept: 'registry', owner: 'off.reg2', issuer: 'off.reg2', paid: '2026-11-30 10:00', due: '2026-12-03 16:30', claim: true },
  { seq: 26, tag: 'R07', sv: 'SV-01', qty: 5, fee: 100, cz: SOMCHAI, status: 'IN_REVIEW', dept: 'registry', owner: 'off.reg2', issuer: 'off.reg2', paid: '2026-11-30 16:29', due: '2026-12-03 16:30', claim: true },
  { seq: 27, tag: 'R06', sv: 'SV-01', qty: 1, fee: 20, cz: PITI, status: 'IN_REVIEW', dept: 'registry', owner: 'off.reg2', issuer: 'off.reg2', paid: '2026-11-30 16:30', due: '2026-12-04 16:30', claim: true },
  { seq: 28, tag: 'S01', sv: 'SV-01', qty: 1, fee: 20, cz: SOMYING, status: 'SUBMITTED', dept: 'registry', paid: '2026-12-01 08:10', due: '2026-12-04 16:30' },
  { seq: 29, tag: 'S02', sv: 'SV-01', qty: 1, fee: 20, cz: PITI, status: 'SUBMITTED', dept: 'registry', paid: '2026-12-01 08:20', due: '2026-12-04 16:30' },
  { seq: 30, tag: 'S03', sv: 'SV-01', qty: 1, fee: 20, cz: SOMCHAI, status: 'SUBMITTED', dept: 'registry', paid: '2026-12-01 08:30', due: '2026-12-04 16:30' },
];

// TEST-DATA §5
const DOC = {
  docNo: 'DOC-2569-000001', caseSeq: 5, caseNo: 'EG-2569-000005', applicant: 'สมชาย ใจดี', serviceId: 'SV-01',
  issuedAt: '2026-11-05T10:00:00+07:00', validUntil: '2027-02-02', signer: 'เจ้าหน้าที่ทะเบียน 1', signerUsername: 'off.reg1',
  issuedBy: 'off.reg1', verifyCode: 'K7M2Q9XA',
};

const seqNo = (seq) => String(seq).padStart(6, '0');

function seed(db, ctx = {}) {
  const crypto = (ctx && ctx.crypto) || require('./lib/crypto');

  // ---------- บัญชี ----------
  const insUser = db.prepare('INSERT INTO users (id, username, password_hash, name, role, dept, active, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)');
  USERS.forEach(([username, name, role, dept], i) => insUser.run(i + 1, username, crypto.hashPassword(PASSWORD), name, role, dept, SEED_CREATED));

  const insCitizen = db.prepare(`INSERT INTO citizens (id, id_hash, id_enc, name, mobile_enc, email, registered, consent_at, registered_at, created_at)
    VALUES (?, ?, ?, ?, ?, '', ?, ?, ?, ?)`);
  for (const c of CITIZENS) {
    const at = c.registered ? SEED_CREATED : null;
    insCitizen.run(c.id, crypto.lookupHash(c.idNo), crypto.encrypt(c.idNo), c.name, crypto.encrypt(c.mobile), c.registered, at, at, SEED_CREATED);
  }

  // ---------- บริการ · วันหยุด ----------
  const insService = db.prepare('INSERT INTO services (id, name, fee, fee_per_sqm, sla, sort_order) VALUES (?, ?, ?, ?, ?, ?)');
  SERVICES.forEach((s, i) => insService.run(s.id, s.name, s.fee, s.feePerSqm, s.sla, i + 1));

  const insHoliday = db.prepare('INSERT INTO holidays (date, name) VALUES (?, ?)');
  for (const [date, name] of HOLIDAYS) insHoliday.run(date, name);

  // ---------- คำขอ 30 ใบ ----------
  const insCase = db.prepare(`INSERT INTO cases (id, case_no, draft_id, citizen_id, service_id, qty, area_sqm, fee, status, step, dept, owner, issuer,
      approver, approved_at, return_count, returned_at, return_reason, fix_deadline, reject_reason, paid_at, receipt_no, due_at, closed_at,
      cancelled_at, created_at, updated_at)
    VALUES (@id, @case_no, NULL, @citizen_id, @service_id, @qty, @area_sqm, @fee, @status, @step, @dept, @owner, @issuer,
      @approver, @approved_at, @return_count, @returned_at, @return_reason, @fix_deadline, @reject_reason, @paid_at, @receipt_no, @due_at, @closed_at,
      @cancelled_at, @created_at, @updated_at)`);
  const insEvent = db.prepare(`INSERT INTO case_events (case_id, at, type, actor, from_status, to_status, note, data)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const insFile = db.prepare(`INSERT INTO files (id, draft_id, case_id, doc_key, name, mime, size, data, uploaded_by, created_at)
    VALUES (?, ?, ?, ?, ?, 'application/pdf', ?, ?, 'citizen', ?)`);

  for (const c of CASES) {
    const caseNo = `EG-2569-${seqNo(c.seq)}`;
    const paidAt = T(c.paid);
    const createdAt = addMin(paidAt, -15); // ร่างสร้างก่อนชำระ 15 นาที (ค่าประกอบ ไม่มีใน TEST-DATA)
    let events = (c.ev || []).map(([at, type, actor, from, to, note, data]) => ({ at: T(at), type, actor, from, to, note: note || null, data: data || null }));
    if (c.claim) events = [{ at: addMin(paidAt, 30), type: 'CLAIM', actor: c.owner, from: 'SUBMITTED', to: 'IN_REVIEW', note: null, data: null }];
    events.unshift({ at: paidAt, type: 'PAID', actor: 'citizen', from: 'PENDING_PAYMENT', to: 'SUBMITTED', note: null,
      data: { receiptNo: `RC-2569-${seqNo(c.seq)}`, amount: c.fee } });
    const updatedAt = events.reduce((m, e) => (e.at > m ? e.at : m), paidAt);

    insCase.run({
      id: c.seq,
      case_no: caseNo,
      citizen_id: c.cz,
      service_id: c.sv,
      qty: c.sv === 'SV-01' ? c.qty : null,
      area_sqm: c.sv === 'SV-03' ? c.area : null,
      fee: c.fee,
      status: c.status,
      step: c.sv === 'SV-03' ? c.step || 1 : null,
      dept: c.dept || null,
      owner: c.owner || null,
      issuer: c.issuer || null,
      approver: c.approver || null,
      approved_at: T(c.approvedAt),
      return_count: c.returnCount || 0,
      returned_at: T(c.returnedAt),
      return_reason: c.returnReason || null,
      fix_deadline: T(c.fixDeadline),
      reject_reason: c.rejectReason || null,
      paid_at: paidAt,
      receipt_no: `RC-2569-${seqNo(c.seq)}`,
      due_at: T(c.due),
      closed_at: T(c.closed),
      cancelled_at: T(c.cancelled),
      created_at: createdAt,
      updated_at: updatedAt,
    });

    for (const e of events) insEvent.run(c.seq, e.at, e.type, e.actor, e.from, e.to, e.note, e.data ? JSON.stringify(e.data) : null);

    for (const key of SERVICE_DOCS[c.sv]) {
      insFile.run(`f_seed_${seqNo(c.seq)}_${key}`, null, c.seq, key, `${key}.pdf`, SEED_PDF.length, SEED_PDF, createdAt);
    }
  }

  // ---------- ร่างของสมชาย (TEST-DATA §4.2) ----------
  const insDraft = db.prepare(`INSERT INTO drafts (id, draft_no, citizen_id, service_id, qty, area_sqm, fee, locked_fee, status, case_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL, ?, ?)`);
  insDraft.run(1, 'DR-0001', SOMCHAI, 'SV-01', 2, 40, null, 'DRAFT', '2026-11-30T15:00:00+07:00', '2026-11-30T15:00:00+07:00');
  insDraft.run(2, 'DR-0002', SOMCHAI, 'SV-02', null, 500, 500, 'PENDING_PAYMENT', '2026-12-01T08:40:00+07:00', '2026-12-01T08:55:00+07:00');
  for (const key of SERVICE_DOCS['SV-02']) {
    insFile.run(`f_seed_DR-0002_${key}`, 2, null, key, `${key}.pdf`, SEED_PDF.length, SEED_PDF, '2026-12-01T08:45:00+07:00');
  }

  // ---------- รายการชำระค้าง PP-0001 (TEST-DATA §4.2 §6) ----------
  db.prepare(`INSERT INTO payments (id, ref, draft_id, amount, status, qr_created_at, qr_expires_at, paid_at, case_no, receipt_no)
    VALUES (1, 'PP-0001', 2, 500, 'PENDING', '2026-12-01T08:55:00+07:00', '2026-12-01T09:10:00+07:00', NULL, NULL, NULL)`).run();

  // ---------- เอกสาร DOC-2569-000001 (TEST-DATA §5) · ลายเซ็นคำนวณจริงตามลำดับ CONTRACT §3 ----------
  const signature = crypto.sign([DOC.docNo, DOC.caseNo, DOC.applicant, DOC.serviceId, DOC.issuedAt, DOC.validUntil, DOC.signer]);
  db.prepare(`INSERT INTO documents (id, doc_no, case_id, case_no, applicant, service_id, issued_at, valid_until, signer, signer_username, issued_by, verify_code, signature)
    VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(DOC.docNo, DOC.caseSeq, DOC.caseNo, DOC.applicant, DOC.serviceId, DOC.issuedAt,
    DOC.validUntil, DOC.signer, DOC.signerUsername, DOC.issuedBy, DOC.verifyCode, signature);

  // ---------- ตัวนับถัดไป (TEST-DATA §12) ----------
  const setSeq = typeof db.setSeq === 'function'
    ? db.setSeq
    : (name, value) => db.prepare('INSERT INTO counters (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value').run(name, value);
  setSeq('draft', 2);         // → DR-0003
  setSeq('payment', 1);       // → PP-0002
  setSeq('case:2569', 30);    // → EG-2569-000031 (ปี 2570 ยังไม่มี → EG-2570-000001)
  setSeq('receipt:2569', 30); // → RC-2569-000031
  setSeq('doc:2569', 1);      // → DOC-2569-000002

  return { users: USERS.length, citizens: CITIZENS.length, cases: CASES.length, drafts: 2, documents: 1 };
}

module.exports = seed;
module.exports.seed = seed;
module.exports.SEED_PDF = SEED_PDF;
