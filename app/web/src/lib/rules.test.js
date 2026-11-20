'use strict';
// node --test src/lib/rules.test.js · ค่าคาดหวังคิดจาก REQUIREMENTS / DECISIONS / TEST-PLAN / BUGS (ไม่ได้อ่านจากเว็บ)

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const rules = require('./rules');
const { _setBugMode } = require('./bugs');

// วันหยุด seed (DECISIONS §0)
const HOL = ['2026-12-07', '2026-12-10', '2026-12-31', '2027-01-01'];
const T = (s) => `${s}+07:00`;

// รันโค้ดภายใต้ BUG_MODE ชั่วคราว แล้วกลับเป็นเว็บถูกต้อง
function withBugs(mode, fn) {
  _setBugMode(mode);
  try {
    fn();
  } finally {
    _setBugMode('');
  }
}

beforeEach(() => _setBugMode(''));

// ---------------------------------------------------------------- BR-01
test('BR-01 validateThaiId: 13 หลักพอดี + checksum (TC-AUTH-01)', () => {
  assert.equal(rules.validateThaiId('110170012345'), false, '12 หลัก');
  assert.equal(rules.validateThaiId('1101700123456'), true, '13 หลักถูก');
  assert.equal(rules.validateThaiId('11017001234567'), false, '14 หลัก');
  assert.equal(rules.validateThaiId('1101700123457'), false, 'checksum ผิด');
  assert.equal(rules.validateThaiId('11017001234ab'), false, 'ไม่ใช่ตัวเลขล้วน');
  for (const id of ['3100600987659', '1909900555015', '5500400111221']) assert.equal(rules.validateThaiId(id), true, id);
  for (const bad of ['', null, undefined, '1-1017-00123-45-6', ' 110170012345 ', {}, 1101700123457]) {
    assert.equal(rules.validateThaiId(bad), false, String(bad));
  }
  // checksum (11 − 0) mod 10 = 1 และ (11 − 1) mod 10 = 0 ใช้ mod 10 ถูก
  assert.equal(rules.validateThaiId('1000000000001'), false);
});

// ---------------------------------------------------------------- BR-04 BR-05 · TC-FEE-01
test('BR-04 SV-01 ฿20 ต่อฉบับ 1–5 ฉบับ', () => {
  assert.deepEqual(rules.feeFor('SV-01', 0), { ok: false, code: 'INVALID_QTY' });
  const expect = { 1: 20, 2: 40, 3: 60, 4: 80, 5: 100 };
  for (const [q, fee] of Object.entries(expect)) {
    assert.equal(rules.feeFor('SV-01', Number(q)).fee, fee, `qty ${q}`);
    assert.equal(rules.feeFor('SV-01', { qty: q }).fee, fee, `qty '${q}' (สตริงจากฟอร์ม)`);
  }
  assert.deepEqual(rules.feeFor('SV-01', 6), { ok: false, code: 'INVALID_QTY' });
  for (const bad of [-1, 2.5, '', 'abc', null, undefined, { qty: null }]) {
    assert.equal(rules.feeFor('SV-01', bad).code, 'INVALID_QTY', String(bad));
  }
});

test('BR-05 SV-03 ค่าธรรมเนียมตามพื้นที่ · SV-02 ฿500 คงที่', () => {
  const table = { 1: 1000, 100: 1000, 101: 1010, 102: 1020, 250: 2500, 300: 3000, 499: 4990, 500: 5000 };
  for (const [a, fee] of Object.entries(table)) {
    assert.deepEqual(rules.feeFor('SV-03', { areaSqm: Number(a) }).fee, fee, `area ${a}`);
    assert.equal(rules.feeFor('SV-03', Number(a)).fee, fee, `area ${a} (ตัวเลขตรง)`);
  }
  assert.deepEqual(rules.feeFor('SV-03', { areaSqm: 0 }), { ok: false, code: 'INVALID_AREA' });
  assert.deepEqual(rules.feeFor('SV-03', { areaSqm: -1 }), { ok: false, code: 'INVALID_AREA' });
  assert.deepEqual(rules.feeFor('SV-03', { areaSqm: 501 }), { ok: false, code: 'AREA_TOO_LARGE' });
  assert.equal(rules.feeFor('SV-03', { areaSqm: '' }).code, 'INVALID_AREA');
  assert.equal(rules.feeFor('SV-03', { areaSqm: 100.5 }).code, 'INVALID_AREA');
  assert.equal(rules.feeFor('SV-03', { areaSqm: '101' }).fee, 1010);
  assert.deepEqual(rules.feeFor('SV-02'), { ok: true, fee: 500 });
  assert.equal(rules.feeFor('SV-99', 1).ok, false);
});

test('BR-05/BR-11 ค่าธรรมเนียมจาก config ที่ admin แก้ (TC-RBAC-04)', () => {
  // แถวจากตาราง services
  assert.equal(rules.feeFor('SV-01', 5, { fee: 25, sla: 3 }).fee, 125);
  assert.equal(rules.feeFor('SV-01', 1, { fee: 25 }).fee, 25);
  assert.equal(rules.feeFor('SV-02', null, { fee: 600 }).fee, 600);
  assert.equal(rules.feeFor('SV-03', 101, { fee: 1000, fee_per_sqm: 10 }).fee, 1010);
  assert.equal(rules.feeFor('SV-03', 150, { feeBase: 2000, feePerSqm: 20 }).fee, 3000);
  assert.equal(rules.feeFor('SV-02', null, { fee: 0 }).fee, 0, 'ค่าธรรมเนียม 0 ใช้ได้ (BR-28)');
  assert.equal(rules.slaDaysOf('SV-01', { sla: 5 }), 5);
  assert.equal(rules.slaDaysOf('SV-02'), 10);
  assert.equal(rules.slaDaysOf('SV-03', null), 15);
});

test('feeTable ให้หน้าฟอร์มใช้ (ผลเดียวกับ feeFor)', () => {
  const t3 = rules.feeTable('SV-03');
  assert.equal(t3.min, 1);
  assert.equal(t3.max, 500);
  assert.equal(t3.fees[101], 1010);
  assert.equal(t3.fees[500], 5000);
  assert.equal(t3.fees[501], undefined);
  assert.deepEqual(rules.feeTable('SV-01', { fee: 25 }).fees, { 1: 25, 2: 50, 3: 75, 4: 100, 5: 125 });
  assert.deepEqual(rules.feeTable('SV-02'), { fee: 500 });
});

test('B01: SV-03 พื้นที่ 101 คิด ฿1,000 (102 ยัง ฿1,020)', () => {
  withBugs('B01', () => {
    assert.equal(rules.feeFor('SV-03', 101).fee, 1000);
    assert.equal(rules.feeFor('SV-03', 102).fee, 1020);
    assert.equal(rules.feeFor('SV-03', 100).fee, 1000);
    assert.equal(rules.feeFor('SV-03', 500).fee, 5000);
    assert.equal(rules.feeTable('SV-03').fees[101], 1000);
    assert.equal(rules.feeFor('SV-01', 1).fee, 20, 'SV-01 ไม่กระทบ');
  });
  assert.equal(rules.feeFor('SV-03', 101).fee, 1010, 'ปิดบั๊กแล้วกลับมาถูก');
});

// ---------------------------------------------------------------- วันทำการ
test('isWorkingDay: จ.–ศ. ที่ไม่อยู่ในตารางวันหยุด', () => {
  assert.equal(rules.isWorkingDay('2026-12-01', HOL), true, 'อ.1');
  assert.equal(rules.isWorkingDay('2026-12-05', HOL), false, 'ส.5');
  assert.equal(rules.isWorkingDay('2026-12-06', HOL), false, 'อา.6');
  assert.equal(rules.isWorkingDay('2026-12-07', HOL), false, 'จ.7 วันหยุด');
  assert.equal(rules.isWorkingDay('2026-12-10', HOL), false, 'พฤ.10 วันหยุด');
  assert.equal(rules.isWorkingDay('2026-12-08', HOL), true, 'อ.8');
  // เวลาเป็นตามเวลาไทย: 2026-12-06T17:30Z = จ.7 00:30 ไทย (วันหยุด)
  assert.equal(rules.isWorkingDay('2026-12-06T17:30:00Z', HOL), false);
  assert.equal(rules.isWorkingDay(T('2026-12-08T23:59:59'), HOL), true);
  // รูปแบบตารางวันหยุดหลายแบบ
  assert.equal(rules.isWorkingDay('2026-12-07', new Set(HOL)), false);
  assert.equal(rules.isWorkingDay('2026-12-07', HOL.map((date) => ({ date, name: 'x' }))), false);
  assert.equal(rules.isWorkingDay('2026-12-07', null), true, 'ไม่มีวันหยุด → จ. เป็นวันทำการ');
  assert.equal(rules.nextWorkingDay('2026-12-04', HOL), '2026-12-08');
  assert.equal(rules.addWorkingDays('2026-12-04', 0, HOL), '2026-12-04');
  assert.equal(rules.workingDaysBetween('2026-12-04', '2026-12-11', HOL), 3, 'อ.8 พ.9 ศ.11');
});

test('holidaysFrom(db) อ่านตาราง holidays', () => {
  const fakeDb = { prepare: () => ({ all: () => HOL.map((date) => ({ date, name: 'x' })) }) };
  const set = rules.holidaysFrom(fakeDb);
  assert.ok(set instanceof Set);
  assert.deepEqual([...set].sort(), HOL);
});

// ---------------------------------------------------------------- BR-12 · TC-SLA-01
const SLA01 = [
  // [แถว, SLA, ชำระเมื่อ, D0, dueAt ที่คาดหวัง, dueAt เมื่อเปิด B03]
  ['a', 3, '2026-12-01T09:00:00', '2026-12-01', '2026-12-04T16:30:00+07:00', '2026-12-04T16:30:00+07:00'],
  ['b', 3, '2026-12-01T16:29:00', '2026-12-01', '2026-12-04T16:30:00+07:00', '2026-12-04T16:30:00+07:00'],
  ['b2', 3, '2026-12-01T16:29:59', '2026-12-01', '2026-12-04T16:30:00+07:00', '2026-12-04T16:30:00+07:00'],
  ['c', 3, '2026-12-01T16:30:00', '2026-12-02', '2026-12-08T16:30:00+07:00', '2026-12-07T16:30:00+07:00'],
  ['d', 3, '2026-12-04T10:00:00', '2026-12-04', '2026-12-11T16:30:00+07:00', '2026-12-09T16:30:00+07:00'],
  ['e', 3, '2026-12-05T10:00:00', '2026-12-08', '2026-12-14T16:30:00+07:00', '2026-12-10T16:30:00+07:00'],
  ['f', 10, '2026-12-01T09:00:00', '2026-12-01', '2026-12-17T16:30:00+07:00', null],
  ['g', 15, '2026-12-01T09:00:00', '2026-12-01', '2026-12-24T16:30:00+07:00', null],
  ['h', 3, '2026-12-29T10:00:00', '2026-12-29', '2027-01-05T16:30:00+07:00', '2027-01-01T16:30:00+07:00'],
  ['i', 3, '2026-12-31T23:59:00', '2027-01-04', '2027-01-07T16:30:00+07:00', '2027-01-06T16:30:00+07:00'],
];

test('BR-12 d0 และ dueAt ตาราง TC-SLA-01 (a–i) + ขอบวินาที 16:29:59 / 16:30:00', () => {
  for (const [row, n, paid, expD0, expDue] of SLA01) {
    assert.equal(rules.d0(T(paid), HOL), expD0, `แถว ${row} D0`);
    assert.equal(rules.dueAt(T(paid), n, HOL), expDue, `แถว ${row} dueAt`);
  }
  // รับ Date ได้ และผลเหมือนกัน
  assert.equal(rules.dueAt(new Date('2026-12-01T02:00:00Z'), 3, HOL), '2026-12-04T16:30:00+07:00');
  // วันที่ชำระเป็นวันหยุด (จ.7) ก่อน 16:30 → D0 = อ.8
  assert.equal(rules.d0(T('2026-12-07T09:00:00'), HOL), '2026-12-08');
});

test('BR-12 เพิ่มวันหยุด 2 ธ.ค. แล้วชำระใหม่ → อ.8 ธ.ค. (TC-RBAC-04 ขั้น 7)', () => {
  assert.equal(rules.dueAt(T('2026-12-01T09:00:00'), 3, [...HOL, '2026-12-02']), '2026-12-08T16:30:00+07:00');
});

test('B03: SLA ไม่ข้ามวันหยุดในตาราง (ข้ามแค่ ส.-อา.)', () => {
  withBugs('B03', () => {
    for (const [row, n, paid, , , bugDue] of SLA01) {
      if (bugDue) assert.equal(rules.dueAt(T(paid), n, HOL), bugDue, `แถว ${row} (B03)`);
    }
    assert.equal(rules.isWorkingDay('2026-12-07', HOL), true, 'จ.7 กลายเป็นวันทำการ');
    assert.equal(rules.isWorkingDay('2026-12-05', HOL), false, 'ส. ยังข้าม');
    // TC-RBAC-04 ขั้น 7: วันหยุดที่เพิ่ม 2 ธ.ค. ไม่ถูกนับ
    assert.equal(rules.dueAt(T('2026-12-01T09:00:00'), 3, [...HOL, '2026-12-02']), '2026-12-04T16:30:00+07:00');
  });
  assert.equal(rules.dueAt(T('2026-12-01T16:30:00'), 3, HOL), '2026-12-08T16:30:00+07:00', 'ปิดบั๊กแล้วกลับมาถูก');
});

// ---------------------------------------------------------------- BR-13 · TC-SLA-02
test('BR-13 หยุดนับระหว่าง NEED_FIX (TC-SLA-02 ส่วน 1–5)', () => {
  // ส่วน 1: ชำระ อ.1 09:00 (due ศ.4) · ตีกลับ พ.2 11:00 · ส่งแก้ พฤ.3 10:00 → หยุด 1 → อ.8
  const due1 = rules.dueAt(T('2026-12-01T09:00:00'), 3, HOL);
  assert.equal(rules.pausedExtension(T('2026-12-02T11:00:00'), T('2026-12-03T10:00:00'), HOL), 1);
  assert.equal(rules.dueAfterResubmit(due1, T('2026-12-02T11:00:00'), T('2026-12-03T10:00:00'), HOL), '2026-12-08T16:30:00+07:00');
  assert.equal(rules.slaLevel(T('2026-12-03T10:00:00'), '2026-12-08T16:30:00+07:00', HOL, 'IN_REVIEW'), 'normal', 'เหลือ ศ.4 อ.8 = 2');

  // ส่วน 2: seed …000017 due 27 พ.ย. 16:30 ตีกลับ 27 พ.ย. 14:00 ส่งแก้ 1 ธ.ค. 09:00 → หยุด 2 (30 พ.ย., 1 ธ.ค.) → 1 ธ.ค.
  const seedDue = '2026-11-27T16:30:00+07:00';
  const seedRet = T('2026-11-27T14:00:00');
  assert.equal(rules.pausedExtension(seedRet, T('2026-12-01T09:00:00'), HOL), 2);
  const due2 = rules.dueAfterResubmit(seedDue, seedRet, T('2026-12-01T09:00:00'), HOL);
  assert.equal(due2, '2026-12-01T16:30:00+07:00');
  assert.equal(rules.slaLevel(T('2026-12-01T09:00:00'), due2, HOL, 'IN_REVIEW'), 'near', 'เหลือ 0');

  // ส่วน 3: ส่งแก้ ศ.4 10:00 → หยุด 5 (30 พ.ย., 1, 2, 3, 4) → 4 ธ.ค.
  const due3 = rules.dueAfterResubmit(seedDue, seedRet, T('2026-12-04T10:00:00'), HOL);
  assert.equal(due3, '2026-12-04T16:30:00+07:00');
  assert.equal(rules.slaLevel(T('2026-12-04T10:00:00'), due3, HOL, 'IN_REVIEW'), 'near');

  // ส่วน 4: ตีกลับและส่งแก้วันเดียวกัน → หยุด 0 → due เดิม
  assert.equal(rules.pausedExtension(T('2026-12-02T09:00:00'), T('2026-12-02T15:00:00'), HOL), 0);
  assert.equal(rules.dueAfterResubmit(due1, T('2026-12-02T09:00:00'), T('2026-12-02T15:00:00'), HOL), '2026-12-04T16:30:00+07:00');

  // ส่วน 5: ตีกลับ ศ.4 10:00 ส่งแก้ อ.8 17:00 → หยุด 1 (อ.8 · ส. อา. จ.7 ไม่นับ) → อ.8 16:30 → เกินกำหนดทันที
  assert.equal(rules.pausedExtension(T('2026-12-04T10:00:00'), T('2026-12-08T17:00:00'), HOL), 1);
  const due5 = rules.dueAfterResubmit(due1, T('2026-12-04T10:00:00'), T('2026-12-08T17:00:00'), HOL);
  assert.equal(due5, '2026-12-08T16:30:00+07:00');
  assert.equal(rules.slaLevel(T('2026-12-08T17:00:00'), due5, HOL, 'IN_REVIEW'), 'overdue');

  // extendDue คงเวลาเดิม และ k = 0 คืนค่าเดิม
  assert.equal(rules.extendDue('2026-12-04T16:30:00+07:00', 0, HOL), '2026-12-04T16:30:00+07:00');
  assert.equal(rules.extendDue('2026-12-04T16:30:00+07:00', 2, HOL), '2026-12-09T16:30:00+07:00');
});

test('B04: SLA ไม่หยุดนับระหว่างรอแก้ไข', () => {
  withBugs('B04', () => {
    assert.equal(rules.pausedExtension(T('2026-12-02T11:00:00'), T('2026-12-03T10:00:00'), HOL), 0);
    assert.equal(
      rules.dueAfterResubmit('2026-12-04T16:30:00+07:00', T('2026-12-02T11:00:00'), T('2026-12-03T10:00:00'), HOL),
      '2026-12-04T16:30:00+07:00',
    );
    const seedDue = rules.dueAfterResubmit('2026-11-27T16:30:00+07:00', T('2026-11-27T14:00:00'), T('2026-12-01T09:00:00'), HOL);
    assert.equal(seedDue, '2026-11-27T16:30:00+07:00');
    assert.equal(rules.slaLevel(T('2026-12-01T09:00:00'), seedDue, HOL, 'IN_REVIEW'), 'overdue');
    // B04 ไม่กระทบกำหนดเสร็จตอนชำระ
    assert.equal(rules.dueAt(T('2026-12-01T16:30:00'), 3, HOL), '2026-12-08T16:30:00+07:00');
  });
});

test('B03 + หยุดนับ: แถวที่ 6 ได้ 7 ธ.ค. แทน 8 ธ.ค.', () => {
  withBugs('B03', () => {
    assert.equal(
      rules.dueAfterResubmit('2026-12-04T16:30:00+07:00', T('2026-12-02T11:00:00'), T('2026-12-03T10:00:00'), HOL),
      '2026-12-07T16:30:00+07:00',
    );
  });
});

test('รวมบั๊ก B03,B04: ผลเป็น union (ไม่ชนกัน)', () => {
  withBugs('B03,B04', () => {
    assert.equal(rules.dueAt(T('2026-12-01T16:30:00'), 3, HOL), '2026-12-07T16:30:00+07:00');
    assert.equal(rules.pausedExtension(T('2026-12-02T11:00:00'), T('2026-12-03T10:00:00'), HOL), 0);
  });
});

// ---------------------------------------------------------------- BR-14 · TC-SLA-03
test('BR-14 ระดับเตือน ส่วน A (กำหนด ศ.4 ธ.ค. 16:30)', () => {
  const due = '2026-12-04T16:30:00+07:00';
  const rows = [
    ['2026-12-01T09:00:00', 3, 'normal'],
    ['2026-12-02T09:00:00', 2, 'normal'],
    ['2026-12-03T09:00:00', 1, 'near'],
    ['2026-12-04T16:30:00', 0, 'near'],
    ['2026-12-04T16:30:01', 0, 'overdue'],
    ['2026-12-04T16:31:00', 0, 'overdue'],
    ['2026-12-05T10:00:00', 0, 'overdue'],
  ];
  for (const [now, left, level] of rows) {
    assert.equal(rules.daysLeft(T(now), due, HOL), left, `${now} วันคงเหลือ`);
    assert.equal(rules.slaLevel(T(now), due, HOL, 'SUBMITTED'), level, `${now} ระดับ`);
  }
  // รูปแบบ object
  assert.equal(rules.slaLevel({ now: T('2026-12-03T09:00:00'), dueAt: due, holidays: HOL, status: 'IN_REVIEW' }), 'near');
  // รับ Date (เช่น clock.now())
  assert.equal(rules.slaLevel(new Date('2026-12-04T09:30:01Z'), due, HOL), 'overdue');
});

test('BR-14 ระดับเตือน ส่วน B (กำหนด อ.8 ธ.ค. · คั่น ส.-อา. และ จ.7)', () => {
  const due = '2026-12-08T16:30:00+07:00';
  assert.equal(rules.daysLeft(T('2026-12-03T09:00:00'), due, HOL), 2);
  assert.equal(rules.slaLevel(T('2026-12-03T09:00:00'), due, HOL), 'normal');
  assert.equal(rules.daysLeft(T('2026-12-04T09:00:00'), due, HOL), 1);
  assert.equal(rules.slaLevel(T('2026-12-04T09:00:00'), due, HOL), 'near');
  assert.equal(rules.slaLevel(T('2026-12-08T16:30:00'), due, HOL), 'near');
  assert.equal(rules.slaLevel(T('2026-12-08T16:31:00'), due, HOL), 'overdue');
});

test('BR-14 ระดับเตือน ส่วน C (seed ที่ 1 ธ.ค. 09:00) + paused/closed', () => {
  const now = T('2026-12-01T09:00:00');
  assert.equal(rules.slaLevel(now, '2026-11-30T16:30:00+07:00', HOL, 'IN_REVIEW'), 'overdue', '…000020');
  assert.equal(rules.slaLevel(now, '2026-12-01T16:30:00+07:00', HOL, 'IN_REVIEW'), 'near', '…000022 เหลือ 0');
  assert.equal(rules.slaLevel(now, '2026-12-02T16:30:00+07:00', HOL, 'SUBMITTED'), 'near', '…000024 เหลือ 1');
  assert.equal(rules.slaLevel(now, '2026-12-03T16:30:00+07:00', HOL, 'SUBMITTED'), 'normal', '…000025 เหลือ 2');
  assert.equal(rules.slaLevel(now, '2026-11-27T16:30:00+07:00', HOL, 'NEED_FIX'), 'paused', '…000017');
  for (const s of ['COMPLETED', 'REJECTED', 'CANCELLED']) {
    assert.equal(rules.slaLevel(now, '2026-11-01T16:30:00+07:00', HOL, s), 'closed', s);
  }
  assert.equal(rules.slaLevel(now, null, HOL, 'DRAFT'), null);
  assert.equal(rules.slaLevel(now, null, HOL), null);
  assert.equal(rules.slaLevel(T('2026-12-01T16:30:00'), '2026-12-01T16:30:00+07:00', HOL, 'IN_REVIEW'), 'near');
  assert.equal(rules.slaLevel(T('2026-12-01T16:31:00'), '2026-12-01T16:30:00+07:00', HOL, 'IN_REVIEW'), 'overdue');
  // ระดับ PENDING_APPROVAL / APPROVED ยังคิดตามเวลา
  assert.equal(rules.slaLevel(now, '2026-11-30T16:30:00+07:00', HOL, 'APPROVED'), 'overdue');
});

test('B03 กระทบวันคงเหลือ (TC-SLA-03 ส่วน B อาจล้ม): ศ.4 09:00 → ปกติ', () => {
  withBugs('B03', () => {
    assert.equal(rules.daysLeft(T('2026-12-04T09:00:00'), '2026-12-08T16:30:00+07:00', HOL), 2);
    assert.equal(rules.slaLevel(T('2026-12-04T09:00:00'), '2026-12-08T16:30:00+07:00', HOL), 'normal');
  });
});

test('BR-25 ทันกำหนด: closed_at ≤ กำหนดเสร็จ (16:29:59 / 16:30:00 / 16:30:01)', () => {
  const due = '2026-12-03T16:30:00+07:00';
  assert.equal(rules.isOnTime(T('2026-12-03T16:29:59'), due), true);
  assert.equal(rules.isOnTime(T('2026-12-03T16:30:00'), due), true);
  assert.equal(rules.isOnTime(T('2026-12-03T16:30:01'), due), false);
  assert.equal(rules.isOnTime(T('2026-12-03T16:31:00'), due), false);
});

// ---------------------------------------------------------------- BR-10 · TC-PAY-01
test('BR-10 QR ใช้ได้ถ้าอายุ < 15:00 (PP-0001 สร้าง 08:55:00)', () => {
  const created = T('2026-12-01T08:55:00');
  assert.equal(rules.qrValid(created, T('2026-12-01T09:00:00')), true, '5:00');
  assert.equal(rules.qrValid(created, T('2026-12-01T09:09:59')), true, '14:59');
  assert.equal(rules.qrValid(created, T('2026-12-01T09:10:00')), false, '15:00');
  assert.equal(rules.qrValid(created, T('2026-12-01T09:10:01')), false, '15:01');
  assert.equal(rules.qrExpired(created, T('2026-12-01T09:10:00')), true);
  assert.equal(rules.qrExpiresAt(created), '2026-12-01T09:10:00+07:00');
  assert.equal(rules.qrExpiresAt(T('2026-12-01T09:10:00')), '2026-12-01T09:25:00+07:00', 'PP-0002');
});

test('B05: QR อายุ 15:00 พอดียังจ่ายได้ (15:01 ยังหมดอายุ)', () => {
  withBugs('B05', () => {
    const created = T('2026-12-01T08:55:00');
    assert.equal(rules.qrValid(created, T('2026-12-01T09:10:00')), true);
    assert.equal(rules.qrValid(created, T('2026-12-01T09:10:01')), false);
    assert.equal(rules.qrValid(created, T('2026-12-01T09:09:59')), true);
  });
});

// ---------------------------------------------------------------- BR-20 · TC-WORKFLOW-06
test('BR-20 เวลาแก้ไข 168 ชม. นับจากตีกลับ', () => {
  const ret = T('2026-11-27T14:00:00');
  assert.equal(rules.fixDeadline(ret), '2026-12-04T14:00:00+07:00');
  assert.equal(rules.fixWindowOpen(ret, T('2026-12-04T13:59:00')), true, '167:59');
  assert.equal(rules.fixWindowOpen(ret, T('2026-12-04T13:59:59')), true);
  assert.equal(rules.fixWindowOpen(ret, T('2026-12-04T14:00:00')), false, '168:00');
  assert.equal(rules.fixWindowExpired(ret, T('2026-12-04T14:00:00')), true);
  assert.equal(rules.fixDeadline(T('2026-12-02T11:00:00')), '2026-12-09T11:00:00+07:00', 'TC-SLA-02 fix-deadline');
  assert.equal(rules.fixDeadline(T('2026-12-04T10:00:00')), '2026-12-11T10:00:00+07:00', 'TC-SLA-02 ส่วน 5');
});

// ---------------------------------------------------------------- BR-23 · TC-DOC-01..03
test('BR-23 อายุเอกสาร docValidUntil', () => {
  assert.equal(rules.docValidUntil(T('2026-12-01T09:00:00'), 'SV-01'), '2027-02-28', 'SV-01 ออก 1 ธ.ค. 69');
  assert.equal(rules.docValidUntil(T('2026-11-05T10:00:00'), 'SV-01'), '2027-02-02', 'seed K7M2Q9XA');
  assert.equal(rules.docValidUntil(T('2026-12-01T09:00:00'), 'SV-02'), '2027-11-30');
  assert.equal(rules.docValidUntil(T('2026-12-01T09:00:00'), 'SV-03'), '2027-11-30');
  assert.equal(rules.docValidUntil(T('2028-02-29T10:00:00'), 'SV-01'), '2028-05-28', '29 ก.พ. 2571 + 89 วัน');
  assert.equal(rules.docValidUntil(T('2028-02-29T10:00:00'), 'SV-02'), '2029-02-27', 'ครบรอบใช้ 28 ก.พ. − 1');
  assert.equal(rules.docValidUntil(T('2027-03-01T10:00:00'), 'SV-02'), '2028-02-29', 'ครบรอบ 1 มี.ค. 2028 − 1 = 29 ก.พ.');
  // วันที่ตามเวลาไทย: 2026-11-30T17:30Z = 1 ธ.ค. 00:30 ไทย
  assert.equal(rules.docValidUntil('2026-11-30T17:30:00Z', 'SV-01'), '2027-02-28');
  assert.throws(() => rules.docValidUntil(T('2026-12-01T09:00:00'), 'SV-09'));
});

test('BR-23 หมดอายุตั้งแต่ 00:00 ของวันถัดไป (TC-DOC-03)', () => {
  assert.equal(rules.docExpired('2027-02-28', T('2027-02-28T23:59:00')), false);
  assert.equal(rules.docExpired('2027-02-28', T('2027-03-01T00:00:00')), true);
  assert.equal(rules.docExpired('2027-11-30', T('2027-11-30T23:59:00')), false);
  assert.equal(rules.docExpired('2027-11-30', T('2027-12-01T00:00:00')), true);
  assert.equal(rules.docExpired('2027-02-02', T('2027-02-02T23:59:00')), false);
  assert.equal(rules.docExpired('2027-02-02', T('2027-02-03T00:00:00')), true);
  assert.equal(rules.docExpired('2028-05-28', T('2028-05-28T23:59:00')), false);
  assert.equal(rules.docExpired('2028-05-28', T('2028-05-29T00:00:00')), true);
  assert.equal(rules.docExpired('2029-02-27', T('2029-02-27T23:59:00')), false);
  assert.equal(rules.docExpired('2029-02-27', T('2029-02-28T00:00:00')), true);
});

test('BR-23 ชื่อผู้ยื่นปิดบัง', () => {
  assert.equal(rules.maskApplicantName('สมชาย ใจดี'), 'สมชาย ใ***');
  assert.equal(rules.maskApplicantName('สมหญิง รักไทย'), 'สมหญิง ร***');
  assert.equal(rules.maskApplicantName('มานะ'), 'มานะ ***');
  assert.equal(rules.maskApplicantName('  ปิติ   มีสุข '), 'ปิติ ม***');
  assert.equal(rules.maskApplicantName('สมชาย ใจดี').includes('ใจดี'), false);
});

// ---------------------------------------------------------------- BR-24
test('BR-24 maskId: X-XXXX-XXXXX-45-6 (เห็น 3 หลักท้าย)', () => {
  assert.equal(rules.maskId('1101700123456'), 'X-XXXX-XXXXX-45-6');
  assert.equal(rules.maskId('3100600987659'), 'X-XXXX-XXXXX-65-9');
  assert.equal(rules.maskId('3-1006-00987-65-9'), 'X-XXXX-XXXXX-65-9');
  assert.match(rules.maskId('1909900555015'), /^X-XXXX-XXXXX-\d{2}-\d$/);
  assert.doesNotMatch(rules.maskId('1101700123456'), /\d{13}/);
  assert.equal(rules.maskId(null), 'X-XXXX-XXXXX-XX-X');
});

// ---------------------------------------------------------------- BR-25 BR-26 เปอร์เซ็นต์
test('roundHalfUp1 / pct1 / formatPct (TEST-DATA ตาราง 7)', () => {
  assert.equal(rules.pct1(6, 7), 85.7, 'พ.ย.');
  assert.equal(rules.pct1(2, 3), 66.7, 'SV-02 พ.ย.');
  assert.equal(rules.pct1(1, 1), 100, 'ต.ค.');
  assert.equal(rules.pct1(7, 8), 87.5, 'ปี 2569');
  assert.equal(rules.pct1(0, 0), null, 'ปิดงาน 0');
  assert.equal(rules.pct1(1, 8), 12.5);
  assert.equal(rules.pct1(1, 40), 2.5, 'x.x5 → ปัดขึ้น');
  assert.equal(rules.pct1(1, 400), 0.3, '0.25 → 0.3');
  assert.equal(rules.formatPct(6, 7), '85.7%');
  assert.equal(rules.formatPct(1, 1), '100.0%');
  assert.equal(rules.formatPct(0, 3), '0.0%');
  assert.equal(rules.formatPct(0, 0), '–');
  assert.equal(rules.roundHalfUp1(12.25), 12.3);
  assert.equal(rules.roundHalfUp1(85.71428), 85.7);
  assert.equal(rules.roundHalfUp1(0.15), 0.2);
  assert.equal(rules.roundHalfUp1(1.04999), 1);
  assert.equal(rules.roundHalfUp1(-12.25), -12.3);
});

test('ฟังก์ชันบริสุทธิ์: ไม่อ่านนาฬิกาเอง (เรียกซ้ำผลเดิม)', () => {
  const a = rules.dueAt(T('2026-12-01T09:00:00'), 3, HOL);
  const b = rules.dueAt(T('2026-12-01T09:00:00'), 3, HOL);
  assert.equal(a, b);
  assert.throws(() => rules.dueAt('not-a-date', 3, HOL), TypeError);
  assert.throws(() => rules.dueAt(T('2026-12-01T09:00:00'), -1, HOL), TypeError);
});
