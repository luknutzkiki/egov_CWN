'use strict';
// BUG_MODE ตาม BUGS.md · เช่น BUG_MODE=B03,B07 · ไม่ตั้ง/ว่าง = เว็บถูกต้อง 100%
// ใช้: const { bug } = require('../lib/bugs'); if (bug('B07')) { /* พฤติกรรมผิดตาม BUGS.md */ }
// บั๊กแต่ละตัวใส่ในโค้ดของบล็อกที่ดูแลกฎนั้น · กระทบเฉพาะการคำนวณ/ตรวจสิทธิ์ใหม่ ไม่กระทบ seed (A-35)

function normalize(id) {
  const m = /^B0*(\d{1,2})$/i.exec(String(id).trim());
  return m ? 'B' + m[1].padStart(2, '0') : null;
}

function parse(value) {
  return new Set(String(value || '').split(',').map(normalize).filter(Boolean));
}

let active = parse(process.env.BUG_MODE);

// true เมื่อบั๊กรหัสนี้ถูกเปิด · รับ 'B07' / 'b7' / 'B007'
function bug(id) {
  const key = normalize(id);
  return key !== null && active.has(key);
}

function enabledBugs() {
  return [...active].sort();
}

// สำหรับ unit test เท่านั้น (node --test) · เว็บจริงอ่านจาก env ครั้งเดียวตอนเริ่ม
function _setBugMode(value) {
  active = parse(value);
}

module.exports = { bug, enabledBugs, _setBugMode };
