'use strict';
// รูปแบบแสดงผล (CONTRACT §0 · NFR-10 · A-04 A-51) และตารางรหัส → ข้อความไทย (CONTRACT §4)
// วันที่บนจอ `4 ธ.ค. 2569 16:30` · วันที่อย่างเดียว `2 ก.พ. 2570` · เงิน `฿1,010` · ค่าใน API/`data-iso` = ISO +07:00

const { toIso, parseIso, BKK_OFFSET_MS } = require('./clock');

const TH_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];

const STATUS_TH = {
  DRAFT: 'ร่าง',
  PENDING_PAYMENT: 'รอชำระเงิน',
  SUBMITTED: 'ส่งคำขอแล้ว',
  IN_REVIEW: 'กำลังตรวจสอบ',
  NEED_FIX: 'รอแก้ไขเอกสาร',
  PENDING_APPROVAL: 'รออนุมัติ',
  APPROVED: 'อนุมัติ',
  COMPLETED: 'เสร็จสิ้น',
  REJECTED: 'ไม่อนุมัติ',
  CANCELLED: 'ยกเลิก',
};

const LEVEL_TH = {
  normal: 'ปกติ',
  near: 'ใกล้ครบกำหนด',
  overdue: 'เกินกำหนด',
  paused: 'หยุดนับ',
  closed: 'ปิดแล้ว',
};

const ROLE_TH = {
  citizen: 'ประชาชน',
  officer: 'เจ้าหน้าที่',
  head: 'หัวหน้าฝ่าย',
  executive: 'ผู้บริหาร',
  auditor: 'ผู้ตรวจสอบภายใน',
  admin: 'ผู้ดูแลระบบ',
};

const DEPT_TH = { registry: 'ฝ่ายทะเบียน', works: 'ฝ่ายโยธา' };

const PAYMENT_STATUS_TH = { PENDING: 'รอชำระ', PAID: 'ชำระแล้ว', EXPIRED: 'QR หมดอายุ' };

// ตาราง 4.3 · docs เรียงตามลำดับที่ใช้ใน `missing-docs`
const SERVICES = {
  'SV-01': {
    id: 'SV-01', name: 'ขอหนังสือรับรอง',
    docs: [{ key: 'id-card', name: 'บัตรประชาชน', required: true }],
  },
  'SV-02': {
    id: 'SV-02', name: 'ขออนุญาตประกอบกิจการ',
    docs: [
      { key: 'id-card', name: 'บัตรประชาชน', required: true },
      { key: 'map', name: 'แผนที่ตั้ง', required: true },
      { key: 'site-photo', name: 'ภาพสถานที่', required: false },
    ],
  },
  'SV-03': {
    id: 'SV-03', name: 'ขออนุญาตก่อสร้าง/ต่อเติมอาคาร',
    docs: [
      { key: 'id-card', name: 'บัตรประชาชน', required: true },
      { key: 'plan', name: 'แบบแปลน', required: true, pdfOnly: true },
      { key: 'deed', name: 'โฉนด', required: true },
    ],
  },
};

const pad = (n, w = 2) => String(n).padStart(w, '0');

// Date | ms | ISO(+offset) | 'YYYY-MM-DD' → ms (UTC epoch) · 'YYYY-MM-DD' ตีความเป็นเที่ยงคืนเวลาไทย
function toMs(x) {
  if (x instanceof Date) return x.getTime();
  if (typeof x === 'number') return x;
  if (typeof x === 'string') {
    const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(x);
    if (dateOnly) return Date.UTC(+dateOnly[1], +dateOnly[2] - 1, +dateOnly[3]) - BKK_OFFSET_MS;
    const d = parseIso(x);
    if (d) return d.getTime();
  }
  return NaN;
}

// ส่วนประกอบเวลาไทย · weekday 0=อา. … 6=ส. · beYear = ปี พ.ศ.
function bkkParts(x) {
  const ms = toMs(x);
  if (Number.isNaN(ms)) return null;
  const t = new Date(ms + BKK_OFFSET_MS);
  const year = t.getUTCFullYear();
  return {
    year, beYear: year + 543, month: t.getUTCMonth() + 1, day: t.getUTCDate(),
    hour: t.getUTCHours(), minute: t.getUTCMinutes(), second: t.getUTCSeconds(), weekday: t.getUTCDay(),
  };
}

// เวลาไทย (ปี ค.ศ., เดือน 1–12, …) → Date
function fromBkk(year, month, day, hour = 0, minute = 0, second = 0) {
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second) - BKK_OFFSET_MS);
}

// → `2026-12-04T16:30:00+07:00` · ค่าว่าง/ไม่ถูกต้อง → null
function iso(x) {
  if (x === null || x === undefined || x === '') return null;
  const ms = toMs(x);
  return Number.isNaN(ms) ? null : toIso(ms);
}

// → `2026-12-04` (วันที่ตามเวลาไทย ค.ศ.)
function ymd(x) {
  const p = bkkParts(x);
  return p ? `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}` : null;
}

// → `4 ธ.ค. 2569 16:30`
function thaiDateTime(x) {
  const p = bkkParts(x);
  if (!p) return '';
  return `${p.day} ${TH_MONTHS[p.month - 1]} ${p.beYear} ${pad(p.hour)}:${pad(p.minute)}`;
}

// → `2 ก.พ. 2570`
function thaiDate(x) {
  const p = bkkParts(x);
  if (!p) return '';
  return `${p.day} ${TH_MONTHS[p.month - 1]} ${p.beYear}`;
}

// ปี พ.ศ. ตามเวลาไทย (ใช้ออกเลข EG-/RC-/DOC-)
function beYear(x) {
  const p = bkkParts(x);
  return p ? p.beYear : null;
}

// 1010 → `฿1,010` · ค่าไม่ใช่จำนวน → `–`
function money(n) {
  if (n === null || n === undefined || n === '' || !Number.isFinite(Number(n))) return '–';
  const v = Math.round(Number(n));
  return (v < 0 ? '-' : '') + '฿' + Math.abs(v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// เลขบัตร 13 หลัก → `1-1017-00123-45-6`
function formatIdNo(idNo) {
  const s = String(idNo || '');
  if (!/^\d{13}$/.test(s)) return s;
  return `${s[0]}-${s.slice(1, 5)}-${s.slice(5, 10)}-${s.slice(10, 12)}-${s[12]}`;
}

// เลขลำดับรูปแบบต่าง ๆ (ตัวนับใน db.nextSeq)
const numbers = {
  caseNo: (be, seq) => `EG-${be}-${pad(seq, 6)}`,
  receiptNo: (be, seq) => `RC-${be}-${pad(seq, 6)}`,
  docNo: (be, seq) => `DOC-${be}-${pad(seq, 6)}`,
  draftNo: (seq) => `DR-${pad(seq, 4)}`,
  paymentRef: (seq) => `PP-${pad(seq, 4)}`,
};

module.exports = {
  TH_MONTHS, STATUS_TH, LEVEL_TH, ROLE_TH, DEPT_TH, PAYMENT_STATUS_TH, SERVICES,
  pad, toMs, bkkParts, fromBkk, iso, ymd, thaiDateTime, thaiDate, beYear, money, formatIdNo, numbers,
};
