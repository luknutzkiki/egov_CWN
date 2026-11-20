'use strict';
// นาฬิกาของระบบ · กฎเวลาทุกข้อ (SLA, อายุ QR, ล็อก OTP, 168 ชม., อายุเอกสาร, เวลาใน Audit/ไทม์ไลน์)
// ต้องอ่านจากโมดูลนี้เท่านั้น ห้ามเรียก Date.now() / new Date() ตรง ๆ ในกฎธุรกิจ
//
// TEST_MODE=1 → นาฬิกาแช่แข็ง (ไม่เดินเอง) เริ่มที่ DEFAULT_NOW และเปลี่ยนได้ด้วย PUT /api/test/clock (A-37)
// ไม่ตั้ง TEST_MODE → เวลาจริงของเครื่อง
// เขตเวลา Asia/Bangkok (+07:00 ตายตัว ไม่มี DST)

const DEFAULT_NOW = '2026-12-01T09:00:00+07:00';
const BKK_OFFSET_MS = 7 * 60 * 60 * 1000;

const TEST_MODE = process.env.TEST_MODE === '1' || process.env.TEST_MODE === 'true';

// ISO 8601 ที่ต้องมี offset: 2026-12-01T09:00:00+07:00 · 2026-12-01T09:00+07:00 · 2026-12-01T02:00:00.000Z
const ISO_WITH_OFFSET = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3})\d*)?)?(Z|[+-]\d{2}:?\d{2})$/;

// แปลงสตริง ISO ที่มี offset เป็น Date · ไม่ถูกต้อง/ไม่มี offset → null
function parseIso(s) {
  if (typeof s !== 'string') return null;
  const m = ISO_WITH_OFFSET.exec(s.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, sec = '0', ms = '0', off] = m;
  const Y = +y, M = +mo, D = +d, H = +h, MI = +mi, S = +sec;
  if (M < 1 || M > 12 || D < 1 || D > 31 || H > 23 || MI > 59 || S > 59) return null;
  let offMin = 0;
  if (off !== 'Z') {
    const sign = off[0] === '-' ? -1 : 1;
    const digits = off.slice(1).replace(':', '');
    const oh = +digits.slice(0, 2), om = +digits.slice(2, 4);
    if (oh > 14 || om > 59) return null;
    offMin = sign * (oh * 60 + om);
  }
  const utc = Date.UTC(Y, M - 1, D, H, MI, S, +ms.padEnd(3, '0')) - offMin * 60000;
  // ตรวจวันที่มีจริง (เช่น 2026-02-30 ไม่ผ่าน)
  const local = new Date(utc + offMin * 60000);
  if (local.getUTCFullYear() !== Y || local.getUTCMonth() !== M - 1 || local.getUTCDate() !== D) return null;
  return new Date(utc);
}

let frozenMs = TEST_MODE ? parseIso(DEFAULT_NOW).getTime() : null;

// เวลาปัจจุบันของระบบเป็น Date (คืนอ็อบเจ็กต์ใหม่ทุกครั้ง แก้ได้โดยไม่กระทบนาฬิกา)
function now() {
  return new Date(frozenMs !== null ? frozenMs : Date.now());
}

function nowMs() {
  return frozenMs !== null ? frozenMs : Date.now();
}

// Date | ms | ISO → `2026-12-01T09:00:00+07:00` (ตัดมิลลิวินาที)
function toIso(x) {
  const ms = x instanceof Date ? x.getTime() : typeof x === 'number' ? x : parseIso(x).getTime();
  const t = new Date(ms + BKK_OFFSET_MS);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(t.getUTCFullYear(), 4)}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}T${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:${p(t.getUTCSeconds())}+07:00`;
}

function nowIso() {
  return toIso(nowMs());
}

// ตั้งนาฬิกาแช่แข็ง · รับ ISO ที่มี offset หรือ Date · คืน ISO +07:00 · ไม่ถูกต้อง → throw (err.code = 'INVALID_TIME')
function set(value) {
  const d = value instanceof Date ? value : parseIso(value);
  if (!d || Number.isNaN(d.getTime())) {
    const err = new Error('INVALID_TIME');
    err.code = 'INVALID_TIME';
    throw err;
  }
  frozenMs = d.getTime();
  return toIso(frozenMs);
}

// กลับค่าเริ่มต้น (เรียกโดย POST /api/test/reset) · TEST_MODE → แช่แข็งที่ DEFAULT_NOW · ไม่ใช่ → เวลาจริง
function reset() {
  frozenMs = TEST_MODE ? parseIso(DEFAULT_NOW).getTime() : null;
  return nowIso();
}

function isFrozen() {
  return frozenMs !== null;
}

module.exports = { DEFAULT_NOW, BKK_OFFSET_MS, TEST_MODE, now, nowMs, nowIso, toIso, parseIso, set, reset, isFrozen };
