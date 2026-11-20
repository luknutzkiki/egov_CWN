'use strict';
// กฎตัวเลข (บล็อก B03) · ฟังก์ชันบริสุทธิ์ทั้งหมด: เวลา "ตอนนี้" และตารางวันหยุดรับเป็นพารามิเตอร์เสมอ
// ห้ามเรียกนาฬิกาในไฟล์นี้ · ผู้เรียกส่ง clock.now() / clock.nowIso() และ holidaysFrom(db) เข้ามาเอง
//
// ที่มา: REQUIREMENTS BR-01 04 05 10 12 13 14 20 23 24 25 · DECISIONS §0 §3 §7 §8 §10 §11 §12 §18 · BUGS B01 B03 B04 B05
//
// ค่าเวลาที่รับ: Date | ms | ISO มี offset ('2026-12-01T09:00:00+07:00') · ค่าวันที่: 'YYYY-MM-DD' (ตีความเป็นวันตามเวลาไทย)
// ค่าเวลาที่คืน: ISO +07:00 (clock.toIso) · วันที่คืนเป็น 'YYYY-MM-DD' (ค.ศ.)
// holidays: Set<'YYYY-MM-DD'> (แนะนำ ใช้ holidaysFrom(db)) | array ของ 'YYYY-MM-DD' หรือ { date } | null = ไม่มีวันหยุด
//
// ใช้ (ตัวอย่าง):
//   const rules = require('../lib/rules');
//   const r = rules.feeFor('SV-03', { areaSqm: 101 }, serviceRow);     // { ok:true, fee:1010 } | { ok:false, code:'INVALID_AREA' }
//   const hol = rules.holidaysFrom(db);
//   const due = rules.dueAt(paidAtIso, serviceRow.sla, hol);             // '2026-12-04T16:30:00+07:00' (คำนวณครั้งเดียวตอนชำระ · A-42)
//   const newDue = rules.dueAfterResubmit(c.due_at, returnedAt, nowIso, hol);   // ตอนประชาชนส่งแก้ (BR-13)
//   const level = rules.slaLevel(clock.now(), c.due_at, hol, c.status);  // 'normal' | 'near' | 'overdue' | 'paused' | 'closed' | null
//   rules.qrValid(qrCreatedAt, clock.now())                              // false → 410 QR_EXPIRED
//   rules.fixDeadline(returnedAt) · rules.fixWindowOpen(returnedAt, now) // 168 ชม. (BR-20)
//   rules.docValidUntil(issuedAt, 'SV-01') · rules.docExpired(validUntil, now)
//   rules.maskId('3100600987659') → 'X-XXXX-XXXXX-65-9' · rules.maskApplicantName('สมชาย ใจดี') → 'สมชาย ใ***'
//   rules.pct1(6, 7) → 85.7 · rules.formatPct(0, 0) → '–'
//
// บั๊ก (BUG_MODE): B01 ใน feeFor · B03 ใน isWorkingDay (ฟังก์ชันวันทำการตัวเดียว → กระทบ dueAt, daysLeft, pausedExtension)
//                  B04 ใน pausedExtension · B05 ใน qrValid

const { parseIso, toIso, BKK_OFFSET_MS } = require('./clock');
const { bug } = require('./bugs');

const DAY_MS = 24 * 60 * 60 * 1000;
const CUTOFF_SEC = 16 * 3600 + 30 * 60;            // 16:30:00 (A-03)
const DUE_TIME = '16:30:00';
const QR_TTL_MS = 15 * 60 * 1000;                  // BR-10 · A-15
const FIX_WINDOW_MS = 168 * 60 * 60 * 1000;        // BR-20 · A-21
const DOC_SV01_DAYS = 90;                          // BR-23 · A-23
const MAX_SCAN_DAYS = 3700;                        // กันวนไม่จบเมื่อทุกวันเป็นวันหยุด

// ค่าตั้งต้นตาม DECISIONS §3 (ผู้ดูแลแก้ได้ → ส่งแถวจากตาราง services เป็น config)
const SERVICE_DEFAULTS = {
  'SV-01': { fee: 20, sla: 3, qtyMin: 1, qtyMax: 5 },
  'SV-02': { fee: 500, sla: 10 },
  'SV-03': { fee: 1000, feePerSqm: 10, sla: 15, areaMin: 1, areaMax: 500, baseArea: 100 },
};

const CLOSED_STATUSES = new Set(['COMPLETED', 'REJECTED', 'CANCELLED']);
const NO_SLA_STATUSES = new Set(['DRAFT', 'PENDING_PAYMENT']);

// ---------------------------------------------------------------- เวลา/วันที่ (ภายใน)

// Date | ms | ISO | 'YYYY-MM-DD' → ms · ไม่ถูกต้อง → NaN
function toMs(x) {
  if (x instanceof Date) return x.getTime();
  if (typeof x === 'number') return x;
  if (typeof x === 'string') {
    const s = x.trim();
    const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (dateOnly) return Date.UTC(+dateOnly[1], +dateOnly[2] - 1, +dateOnly[3]) - BKK_OFFSET_MS;
    const d = parseIso(s);
    if (d) return d.getTime();
  }
  return NaN;
}

function mustMs(x, name) {
  const ms = toMs(x);
  if (Number.isNaN(ms)) throw new TypeError(`rules: ${name} ต้องเป็นเวลา (Date | ms | ISO มี offset) ได้รับ ${String(x)}`);
  return ms;
}

// เทียบระดับวินาที (ค่าใน DB เป็น ISO ไม่มีมิลลิวินาที) → ms ปัดลงเป็นวินาที
const sec = (ms) => Math.floor(ms / 1000);

// เลขวันตามปฏิทินไทย (0 = 1970-01-01) · ใช้เลขวันแทนวันที่ภายในไฟล์นี้
const dayOf = (ms) => Math.floor((ms + BKK_OFFSET_MS) / DAY_MS);
const ymdOfDay = (day) => new Date(day * DAY_MS).toISOString().slice(0, 10);
const weekdayOfDay = (day) => (((day + 4) % 7) + 7) % 7; // 0 = อา. … 6 = ส. (1970-01-01 = พฤ.)
const secOfDay = (ms) => Math.floor((((ms + BKK_OFFSET_MS) % DAY_MS) + DAY_MS) % DAY_MS / 1000);

function dayOfInput(x, name) {
  return dayOf(mustMs(x, name));
}

// 'YYYY-MM-DD' + เวลา → ISO +07:00
const isoAt = (day, hms) => `${ymdOfDay(day)}T${hms}+07:00`;

function hmsOf(ms) {
  const s = secOfDay(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
}

// ---------------------------------------------------------------- วันหยุด

const YMD_RE = /^(\d{4}-\d{2}-\d{2})/;

// → Set<'YYYY-MM-DD'> · Set ที่ส่งมาใช้ตามนั้น (ถือว่าเป็นรูป YYYY-MM-DD แล้ว)
function normalizeHolidays(holidays) {
  if (holidays instanceof Set) return holidays;
  const out = new Set();
  if (!holidays) return out;
  const list = Array.isArray(holidays) ? holidays : holidays instanceof Map ? [...holidays.keys()] : [holidays];
  for (const h of list) {
    const raw = h && typeof h === 'object' && !(h instanceof Date) ? h.date : h;
    if (raw instanceof Date || typeof raw === 'number') {
      out.add(ymdOfDay(dayOf(toMs(raw))));
    } else if (typeof raw === 'string') {
      const m = YMD_RE.exec(raw.trim());
      if (m) out.add(m[1]);
    }
  }
  return out;
}

// อ่านตารางวันหยุดปัจจุบันจากฐานข้อมูล (better-sqlite3) → Set<'YYYY-MM-DD'>
function holidaysFrom(db) {
  return new Set(db.prepare('SELECT date FROM holidays').all().map((r) => String(r.date).slice(0, 10)));
}

// ---------------------------------------------------------------- วันทำการ (ฟังก์ชันเดียวที่ทุกการนับใช้ · DECISIONS §18 B03)

// วันทำการ = จันทร์–ศุกร์ ที่ไม่อยู่ในตารางวันหยุด (A-02)
// date: 'YYYY-MM-DD' | ISO | Date | ms (ใช้วันที่ตามเวลาไทย)
function isWorkingDay(date, holidays) {
  const day = dayOfInput(date, 'date');
  const wd = weekdayOfDay(day);
  if (wd === 0 || wd === 6) return false;
  // B03: SLA ไม่ข้ามวันหยุดในตาราง (ข้ามแค่เสาร์-อาทิตย์)
  if (bug('B03')) return true;
  return !normalizeHolidays(holidays).has(ymdOfDay(day));
}

const isWorkingDayNum = (day, hol) => isWorkingDay(ymdOfDay(day), hol);

// วันทำการที่ n (n ≥ 1) หลังเลขวัน day → เลขวัน · n = 0 → day เดิม
function addWorkingDaysNum(day, n, hol) {
  let d = day;
  let left = n;
  for (let i = 0; left > 0; i++) {
    if (i > MAX_SCAN_DAYS) throw new RangeError('rules: หาวันทำการไม่พบ (วันหยุดครอบทุกวัน?)');
    d += 1;
    if (isWorkingDayNum(d, hol)) left -= 1;
  }
  return d;
}

// จำนวนวันทำการในช่วง (fromDay, toDay] (ไม่นับวันแรก นับวันสุดท้าย) · toDay ≤ fromDay → 0
function countWorkingDaysNum(fromDay, toDay, hol) {
  if (toDay - fromDay > MAX_SCAN_DAYS) throw new RangeError('rules: ช่วงวันยาวเกินไป');
  let n = 0;
  for (let d = fromDay + 1; d <= toDay; d++) if (isWorkingDayNum(d, hol)) n += 1;
  return n;
}

// วันทำการที่ n หลังวันที่ date → 'YYYY-MM-DD'
function addWorkingDays(date, n, holidays) {
  return ymdOfDay(addWorkingDaysNum(dayOfInput(date, 'date'), toCount(n, 'n'), normalizeHolidays(holidays)));
}

// วันทำการถัดไป (หลัง date) → 'YYYY-MM-DD'
function nextWorkingDay(date, holidays) {
  return addWorkingDays(date, 1, holidays);
}

// จำนวนวันทำการใน (from, to] ตามวันที่ (ไม่ขึ้นกับเวลา)
function workingDaysBetween(from, to, holidays) {
  return countWorkingDaysNum(dayOfInput(from, 'from'), dayOfInput(to, 'to'), normalizeHolidays(holidays));
}

function toCount(n, name) {
  const v = Number(n);
  if (!Number.isInteger(v) || v < 0) throw new TypeError(`rules: ${name} ต้องเป็นจำนวนเต็ม ≥ 0 ได้รับ ${String(n)}`);
  return v;
}

// ---------------------------------------------------------------- SLA (BR-12 BR-13 BR-14)

// D0 = วันที่ชำระ ถ้าเป็นวันทำการและก่อน 16:30:00 ไม่เช่นนั้นวันทำการถัดไป → 'YYYY-MM-DD'
function d0(paidAt, holidays) {
  return ymdOfDay(d0Num(mustMs(paidAt, 'paidAt'), normalizeHolidays(holidays)));
}

function d0Num(paidMs, hol) {
  const day = dayOf(paidMs);
  if (isWorkingDayNum(day, hol) && secOfDay(paidMs) < CUTOFF_SEC) return day;
  return addWorkingDaysNum(day, 1, hol);
}

// กำหนดเสร็จ = วันทำการที่ N หลัง D0 เวลา 16:30 → ISO +07:00
// เรียกครั้งเดียวตอนชำระสำเร็จ แล้วเก็บผล (ไม่คำนวณใหม่เมื่อวันหยุดเปลี่ยน · A-42)
function dueAt(paidAt, N, holidays) {
  const hol = normalizeHolidays(holidays);
  const start = d0Num(mustMs(paidAt, 'paidAt'), hol);
  return isoAt(addWorkingDaysNum(start, toCount(N, 'N'), hol), DUE_TIME);
}

// จำนวนวันทำการที่หยุดนับ = วันทำการใน (วันที่ตีกลับ, วันที่ส่งแก้] (ตามวันที่ ไม่ขึ้นกับเวลา)
// ใช้ตารางวันหยุด ณ เวลาที่ส่งแก้ (A-42)
function pausedExtension(returnedAt, resubmittedAt, holidays) {
  // B04: SLA ไม่หยุดนับระหว่างรอแก้ไขเอกสาร
  if (bug('B04')) return 0;
  return countWorkingDaysNum(dayOfInput(returnedAt, 'returnedAt'), dayOfInput(resubmittedAt, 'resubmittedAt'), normalizeHolidays(holidays));
}

// กำหนดเสร็จเดิม + k วันทำการ (คงเวลาเดิม 16:30) → ISO +07:00
function extendDue(due, k, holidays) {
  const ms = mustMs(due, 'dueAt');
  const days = toCount(k, 'k');
  if (days === 0) return toIso(ms);
  return isoAt(addWorkingDaysNum(dayOf(ms), days, normalizeHolidays(holidays)), hmsOf(ms));
}

// กำหนดเสร็จใหม่ตอนประชาชนส่งแก้ไข (BR-13) → ISO +07:00
function dueAfterResubmit(due, returnedAt, resubmittedAt, holidays) {
  const hol = normalizeHolidays(holidays);
  return extendDue(due, pausedExtension(returnedAt, resubmittedAt, hol), hol);
}

// วันคงเหลือ = จำนวนวันทำการหลังวันนี้ถึงวันกำหนดเสร็จ (รวมวันกำหนด) · วันกำหนดผ่านไปแล้ว/วันนี้ → 0
function daysLeft(now, due, holidays) {
  return countWorkingDaysNum(dayOfInput(now, 'now'), dayOfInput(due, 'dueAt'), normalizeHolidays(holidays));
}

// ระดับเตือน → 'normal' | 'near' | 'overdue' | 'paused' (NEED_FIX) | 'closed' (COMPLETED/REJECTED/CANCELLED) | null (ยังไม่มีกำหนด)
// รับได้ 2 แบบ: slaLevel(now, dueAt, holidays, status?) หรือ slaLevel({ now, dueAt, holidays, status })
function slaLevel(now, due, holidays, status) {
  if (now && typeof now === 'object' && !(now instanceof Date)) {
    ({ now, dueAt: due, holidays, status } = now);
  }
  if (status === 'NEED_FIX') return 'paused';
  if (CLOSED_STATUSES.has(status)) return 'closed';
  if (NO_SLA_STATUSES.has(status) || due === null || due === undefined || due === '') return null;
  const nowMs = mustMs(now, 'now');
  const dueMs = mustMs(due, 'dueAt');
  if (sec(nowMs) > sec(dueMs)) return 'overdue';
  return daysLeft(nowMs, dueMs, holidays) <= 1 ? 'near' : 'normal';
}

// ทันกำหนด ⇔ closed_at ≤ กำหนดเสร็จ (รวมวินาทีที่ 16:30:00 · BR-25 · DECISIONS §18)
function isOnTime(closedAt, due) {
  return sec(mustMs(closedAt, 'closedAt')) <= sec(mustMs(due, 'dueAt'));
}

// ---------------------------------------------------------------- QR (BR-10)

// ใช้ได้ถ้า (เวลาชำระ − เวลาสร้าง) < 15:00 นาที
function qrValid(createdAt, paidAt) {
  const age = mustMs(paidAt, 'paidAt') - mustMs(createdAt, 'createdAt');
  // B05: QR อายุ 15:00 พอดียังจ่ายได้ (ใช้ ≤ แทน <)
  return bug('B05') ? age <= QR_TTL_MS : age < QR_TTL_MS;
}

const qrExpired = (createdAt, now) => !qrValid(createdAt, now);

// เวลาหมดอายุที่แสดง (`qr-expires` / qrExpiresAt) = สร้าง + 15 นาที → ISO +07:00
function qrExpiresAt(createdAt) {
  return toIso(mustMs(createdAt, 'createdAt') + QR_TTL_MS);
}

// ---------------------------------------------------------------- เวลาแก้ไข 168 ชม. (BR-20)

// เส้นตายส่งแก้ไข = เวลาตีกลับ + 168 ชม. → ISO +07:00 (`fix-deadline` · fixDeadline · เวลายกเลิกในไทม์ไลน์ A-46)
function fixDeadline(returnedAt) {
  return toIso(mustMs(returnedAt, 'returnedAt') + FIX_WINDOW_MS);
}

// ส่งแก้ได้ถ้าตอนนี้ < เส้นตาย (167:59 ✓ · 168:00 ✗ → ยกเลิกอัตโนมัติ)
function fixWindowOpen(returnedAt, now) {
  return sec(mustMs(now, 'now')) < sec(mustMs(returnedAt, 'returnedAt') + FIX_WINDOW_MS);
}

const fixWindowExpired = (returnedAt, now) => !fixWindowOpen(returnedAt, now);

// ---------------------------------------------------------------- อายุเอกสาร (BR-23)

// วันสุดท้ายที่ใช้ได้ → 'YYYY-MM-DD'
// SV-01: ออก + 89 วัน · SV-02/03: วันครบรอบปีถัดไป − 1 วัน (ครบรอบไม่มีจริง เช่นออก 29 ก.พ. → ใช้ 28 ก.พ.)
function docValidUntil(issuedAt, serviceId) {
  const day = dayOfInput(issuedAt, 'issuedAt');
  if (serviceId === 'SV-01') return ymdOfDay(day + DOC_SV01_DAYS - 1);
  if (serviceId !== 'SV-02' && serviceId !== 'SV-03') throw new TypeError(`rules: ไม่รู้จักบริการ ${String(serviceId)}`);
  const d = new Date(day * DAY_MS);
  const y = d.getUTCFullYear() + 1;
  const m = d.getUTCMonth();
  const lastOfMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const anniversary = Date.UTC(y, m, Math.min(d.getUTCDate(), lastOfMonth)) / DAY_MS;
  return ymdOfDay(anniversary - 1);
}

// หมดอายุตั้งแต่ 00:00 ของวันถัดจากวันสุดท้ายที่ใช้ได้ (A-43)
function docExpired(validUntil, now) {
  return dayOfInput(now, 'now') > dayOfInput(validUntil, 'validUntil');
}

// ---------------------------------------------------------------- เลขบัตร / ชื่อ (BR-01 BR-24 · A-54 A-58)

// ตัวเลข 13 หลักพอดี และหลักที่ 13 = (11 − (Σ dᵢ×(13−i), i=1..12) mod 11) mod 10
function validateThaiId(idNo) {
  if (typeof idNo !== 'string' && typeof idNo !== 'number') return false;
  const s = String(idNo).trim();
  if (!/^\d{13}$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(s[i]) * (13 - i);
  return (11 - (sum % 11)) % 10 === Number(s[12]);
}

// เลขบัตรบนจอเจ้าหน้าที่ `X-XXXX-XXXXX-45-6` (เห็น 3 หลักท้าย) · รับเลขดิบหรือแบบมีขีด
function maskId(idNo) {
  const digits = String(idNo === null || idNo === undefined ? '' : idNo).replace(/\D/g, '');
  const t = digits.length >= 3 ? digits.slice(-3) : 'XXX';
  return `X-XXXX-XXXXX-${t.slice(0, 2)}-${t[2]}`;
}

// ชื่อผู้ยื่นแบบปิดบัง = ชื่อเต็ม + อักษรแรกของนามสกุล + `***` · ไม่มีนามสกุล → ชื่อ + ` ***`
// คำสุดท้ายถือเป็นนามสกุล ('สมชาย ใจดี' → 'สมชาย ใ***' · 'มานะ' → 'มานะ ***')
function maskApplicantName(name) {
  const parts = String(name === null || name === undefined ? '' : name).trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '***';
  if (parts.length === 1) return `${parts[0]} ***`;
  const last = parts.pop();
  return `${parts.join(' ')} ${Array.from(last)[0]}***`;
}

// ---------------------------------------------------------------- ค่าธรรมเนียม (BR-04 BR-05)

function serviceFees(serviceId, config) {
  const def = SERVICE_DEFAULTS[serviceId];
  const c = config || {};
  const pick = (...vals) => {
    for (const v of vals) if (v !== undefined && v !== null && v !== '' && Number.isFinite(Number(v))) return Number(v);
    return undefined;
  };
  if (serviceId === 'SV-03') {
    return { base: pick(c.feeBase, c.fee_base, c.fee, def.fee), perSqm: pick(c.feePerSqm, c.fee_per_sqm, def.feePerSqm) };
  }
  return { fee: pick(c.fee, def.fee) };
}

// จำนวนเต็ม (รับตัวเลขหรือสตริงตัวเลข) · อื่น ๆ → null
function toInt(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? v : null;
  if (typeof v === 'string' && /^\s*[+-]?\d+\s*$/.test(v)) return Number(v);
  return null;
}

// ค่าธรรมเนียม → { ok:true, fee } | { ok:false, code } (code ตาม CONTRACT §5: INVALID_QTY · INVALID_AREA · AREA_TOO_LARGE)
// input: ตัวเลข (SV-01 = จำนวนฉบับ · SV-03 = พื้นที่ ตร.ม.) หรือ { qty } / { areaSqm } · SV-02 ไม่ใช้ input
// config: แถว services จากฐานข้อมูล ({ fee, fee_per_sqm }) หรือ { fee } / { feeBase, feePerSqm } · ไม่ส่ง = ค่าตั้งต้น §3
function feeFor(serviceId, input, config) {
  if (!SERVICE_DEFAULTS[serviceId]) return { ok: false, code: 'BAD_REQUEST' };
  const fees = serviceFees(serviceId, config);
  const obj = input !== null && typeof input === 'object' ? input : null;

  if (serviceId === 'SV-01') {
    const qty = toInt(obj ? obj.qty : input);
    const { qtyMin, qtyMax } = SERVICE_DEFAULTS['SV-01'];
    if (qty === null || qty < qtyMin || qty > qtyMax) return { ok: false, code: 'INVALID_QTY' };
    return { ok: true, fee: fees.fee * qty, qty };
  }

  if (serviceId === 'SV-02') return { ok: true, fee: fees.fee };

  const area = toInt(obj ? (obj.areaSqm !== undefined ? obj.areaSqm : obj.area) : input);
  const { areaMin, areaMax, baseArea } = SERVICE_DEFAULTS['SV-03'];
  if (area === null || area < areaMin) return { ok: false, code: 'INVALID_AREA' };
  if (area > areaMax) return { ok: false, code: 'AREA_TOO_LARGE' };
  // B01: พื้นที่ 101 คิดราคาฐาน (ใช้ > 101 แทน ≥ 101)
  const surcharge = bug('B01') ? area > baseArea + 1 : area >= baseArea + 1;
  return { ok: true, fee: surcharge ? fees.base + fees.perSqm * (area - baseArea) : fees.base, areaSqm: area };
}

// ตารางค่าธรรมเนียมทุกค่าที่ใช้ได้ (ให้หน้าฟอร์มฝังลง JS เพื่อแสดง `fee-total` ทันที โดยผลมาจาก feeFor ฝั่งเซิร์ฟเวอร์ · รวมผล BUG_MODE)
// → { min, max, fees: { '<ค่า>': fee } } · SV-02 → { fee }
function feeTable(serviceId, config) {
  if (serviceId === 'SV-02') return { fee: feeFor('SV-02', null, config).fee };
  const [min, max] = serviceId === 'SV-01' ? [1, 5] : serviceId === 'SV-03' ? [1, 500] : [0, -1];
  const fees = {};
  for (let v = min; v <= max; v++) fees[v] = feeFor(serviceId, v, config).fee;
  return { min, max, fees };
}

// SLA (วันทำการ) ของบริการ จาก config (แถว services) หรือค่าตั้งต้น
function slaDaysOf(serviceId, config) {
  const v = config && config.sla !== undefined && config.sla !== null ? Number(config.sla) : undefined;
  if (Number.isInteger(v)) return v;
  return SERVICE_DEFAULTS[serviceId] ? SERVICE_DEFAULTS[serviceId].sla : undefined;
}

// ---------------------------------------------------------------- เปอร์เซ็นต์ (BR-25 BR-26)

// ปัดทศนิยม 1 ตำแหน่งแบบปัดครึ่งขึ้น (ครึ่งออกจากศูนย์สำหรับค่าลบ) · ทนต่อความคลาดเคลื่อนทศนิยมฐานสอง
function roundHalfUp1(x) {
  const v = Number(x);
  if (!Number.isFinite(v)) return NaN;
  const sign = v < 0 ? -1 : 1;
  const scaled = Number((Math.abs(v) * 10).toPrecision(12));
  return (sign * Math.floor(scaled + 0.5)) / 10;
}

// num ÷ den × 100 ทศนิยม 1 ตำแหน่ง ปัดครึ่งขึ้น (คิดด้วยจำนวนเต็ม ไม่มีปัญหาทศนิยม) · den = 0 → null
function pct1(num, den) {
  const n = Number(num);
  const d = Number(den);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return null;
  if (Number.isInteger(n) && Number.isInteger(d) && n >= 0 && d > 0) {
    return Math.floor((2 * n * 1000 + d) / (2 * d)) / 10;
  }
  return roundHalfUp1((n / d) * 100);
}

// → '85.7%' · '100.0%' · den = 0 → '–' (ห้าม NaN/0%)
function formatPct(num, den) {
  const p = pct1(num, den);
  return p === null ? '–' : `${p.toFixed(1)}%`;
}

module.exports = {
  // ค่าคงที่
  SERVICE_DEFAULTS, CUTOFF_SEC, QR_TTL_MS, FIX_WINDOW_MS, DOC_SV01_DAYS,
  // วันทำการ
  normalizeHolidays, holidaysFrom, isWorkingDay, addWorkingDays, nextWorkingDay, workingDaysBetween,
  // SLA
  d0, dueAt, pausedExtension, extendDue, dueAfterResubmit, daysLeft, slaLevel, isOnTime,
  // QR · 168 ชม. · เอกสาร
  qrValid, qrExpired, qrExpiresAt, fixDeadline, fixWindowOpen, fixWindowExpired, docValidUntil, docExpired,
  // เลขบัตร · ชื่อ
  validateThaiId, maskId, maskApplicantName,
  // ค่าธรรมเนียม
  feeFor, feeTable, slaDaysOf,
  // เปอร์เซ็นต์
  roundHalfUp1, pct1, formatPct,
};
