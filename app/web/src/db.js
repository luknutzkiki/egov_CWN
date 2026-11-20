'use strict';
// ฐานข้อมูล SQLite (better-sqlite3 · ทำงานแบบ synchronous) · ไฟล์อยู่ที่ env DB_PATH (CONTRACT §0 ข้อ 11 · TC-NFR-04)
//
// ข้อตกลงที่ทุกบล็อกต้องใช้ร่วมกัน
// - เวลาทุกคอลัมน์ *_at / time / at เก็บเป็น TEXT ISO `2026-12-04T16:30:00+07:00` (ใช้ clock.toIso / format.iso)
//   offset +07:00 เสมอ → เปรียบเทียบแบบสตริง (<, <=, ORDER BY) ได้ตรงลำดับเวลา · วันที่อย่างเดียวเก็บ `YYYY-MM-DD`
// - เงินเป็นจำนวนเต็มบาท (INTEGER)
// - ผู้ใช้อ้างด้วย username (TEXT) ในคอลัมน์ owner / issuer / approver / actor / audit.username / notifications.username
// - เลขบัตรและเบอร์มือถือเก็บด้วย crypto.encrypt() เท่านั้น · ค้นหาด้วย crypto.lookupHash() (ห้ามมีค่าจริงที่ใดในฐานข้อมูล)
// - foreign key ประกาศไว้เพื่อเอกสาร ไม่บังคับ (PRAGMA foreign_keys ปิด)
// - audit เพิ่มได้อย่างเดียว: มี trigger ห้าม UPDATE/DELETE (reset ล้างโดย DROP ตาราง)
// - ตัวนับเลขเอกสาร: nextSeq(name) ใน transaction เดียวกับ INSERT · ชื่อตัวนับ:
//     'draft' → DR-0001 · 'payment' → PP-0001 · 'case:2569' → EG-2569-000001 · 'receipt:2569' → RC-2569-000001 · 'doc:2569' → DOC-2569-000001
//   seed ต้องตั้งค่าตัวนับให้ค่าถัดไปตรง TEST-DATA §12 (draft=2 · payment=1 · case:2569=30 · receipt:2569=30 · doc:2569=1)

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'app.db');

const CASE_STATUSES = ['DRAFT', 'PENDING_PAYMENT', 'SUBMITTED', 'IN_REVIEW', 'NEED_FIX', 'PENDING_APPROVAL', 'APPROVED', 'COMPLETED', 'REJECTED', 'CANCELLED'];
const ROLES = ['citizen', 'officer', 'head', 'executive', 'auditor', 'admin'];
const DEPTS = ['registry', 'works'];
const AUDIT_EVENTS = ['STAFF_LOGIN', 'CLAIM', 'RETURN', 'FORWARD', 'APPROVE', 'REJECT', 'ISSUE', 'UNMASK', 'EXPORT', 'ADMIN_CHANGE'];

const inList = (arr) => arr.map((v) => `'${v}'`).join(',');

const TABLES = [
  'audit', 'notifications', 'documents', 'case_events', 'files', 'payments', 'cases', 'drafts',
  'otp_attempts', 'citizens', 'users', 'services', 'holidays', 'counters',
];

const SCHEMA = `
-- บัญชีเจ้าหน้าที่และบทบาทอื่น (ล็อกอิน SSO จำลองด้วย username/รหัสผ่าน)
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,              -- off.reg1
  password_hash TEXT NOT NULL,                     -- crypto.hashPassword()
  name          TEXT NOT NULL,                     -- ชื่อแสดง (user-name) เช่น เจ้าหน้าที่ทะเบียน 1
  role          TEXT NOT NULL CHECK (role IN (${inList(ROLES)})),
  dept          TEXT CHECK (dept IS NULL OR dept IN (${inList(DEPTS)})),  -- officer เท่านั้น
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT
);

-- ประชาชน (ThaiD จำลอง) · registered = 0 → ยังไม่ลงทะเบียน (เข้าครั้งแรกไป /register)
CREATE TABLE IF NOT EXISTS citizens (
  id            INTEGER PRIMARY KEY,
  id_hash       TEXT NOT NULL UNIQUE,              -- crypto.lookupHash(idNo 13 หลัก)
  id_enc        TEXT NOT NULL,                     -- crypto.encrypt(idNo)
  name          TEXT NOT NULL,                     -- ชื่อ-สกุลจาก ThaiD
  mobile_enc    TEXT,                              -- crypto.encrypt(mobile) · ยังไม่ลงทะเบียน = NULL
  email         TEXT NOT NULL DEFAULT '',
  registered    INTEGER NOT NULL DEFAULT 0,
  consent_at    TEXT,
  registered_at TEXT,
  created_at    TEXT
);

-- ตัวนับ OTP ผิด/การล็อกต่อเลขบัตร (BR-02 · reset ล้าง)
CREATE TABLE IF NOT EXISTS otp_attempts (
  id_hash       TEXT PRIMARY KEY,                  -- crypto.lookupHash(idNo)
  fail_count    INTEGER NOT NULL DEFAULT 0,
  last_fail_at  TEXT,
  locked_until  TEXT
);

-- แคตตาล็อกบริการ (admin แก้ fee/fee_per_sqm/sla ได้)
CREATE TABLE IF NOT EXISTS services (
  id            TEXT PRIMARY KEY,                  -- SV-01
  name          TEXT NOT NULL,                     -- ขอหนังสือรับรอง
  fee           INTEGER NOT NULL,                  -- SV-01 ต่อฉบับ · SV-02 คงที่ · SV-03 ฐาน (feeBase)
  fee_per_sqm   INTEGER,                           -- SV-03 เท่านั้น (฿ ต่อ ตร.ม. ส่วนเกิน 100)
  sla           INTEGER NOT NULL,                  -- วันทำการ
  sort_order    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS holidays (
  date          TEXT PRIMARY KEY,                  -- YYYY-MM-DD (ค.ศ.)
  name          TEXT NOT NULL
);

-- ตัวนับเลขรัน (ดู nextSeq)
CREATE TABLE IF NOT EXISTS counters (
  name          TEXT PRIMARY KEY,
  value         INTEGER NOT NULL
);

-- ร่างคำขอก่อนชำระ (DRAFT / PENDING_PAYMENT) · ชำระสำเร็จแล้ว status = 'SUBMITTED' และ case_id ชี้คำขอ
CREATE TABLE IF NOT EXISTS drafts (
  id            INTEGER PRIMARY KEY,
  draft_no      TEXT NOT NULL UNIQUE,              -- DR-0001
  citizen_id    INTEGER NOT NULL REFERENCES citizens(id),
  service_id    TEXT NOT NULL REFERENCES services(id),
  qty           INTEGER,                           -- SV-01
  area_sqm      INTEGER,                           -- SV-03
  fee           INTEGER NOT NULL,                  -- ยอดคำนวณล่าสุด
  locked_fee    INTEGER,                           -- ยอดที่ล็อกตอนเข้า PENDING_PAYMENT (A-42)
  status        TEXT NOT NULL DEFAULT 'DRAFT',     -- DRAFT | PENDING_PAYMENT | SUBMITTED
  case_id       INTEGER REFERENCES cases(id),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- ไฟล์แนบ (เนื้อไฟล์เก็บใน data) · ระหว่างร่าง draft_id มีค่า · หลังชำระ case_id มีค่า
CREATE TABLE IF NOT EXISTS files (
  id            TEXT PRIMARY KEY,                  -- crypto.randomId('f_') หรือรหัสใดก็ได้
  draft_id      INTEGER REFERENCES drafts(id),
  case_id       INTEGER REFERENCES cases(id),
  doc_key       TEXT NOT NULL,                     -- id-card | map | site-photo | plan | deed | extra
  name          TEXT NOT NULL,                     -- ชื่อไฟล์เดิม
  mime          TEXT NOT NULL,                     -- จาก magic bytes: application/pdf | image/jpeg | image/png
  size          INTEGER NOT NULL,
  data          BLOB NOT NULL,
  uploaded_by   TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_files_draft ON files(draft_id);
CREATE INDEX IF NOT EXISTS idx_files_case ON files(case_id);

-- รายการชำระ (PromptPay QR จำลอง) · สถานะ EXPIRED คำนวณจากนาฬิกา (qr_expires_at) ตอนอ่าน
CREATE TABLE IF NOT EXISTS payments (
  id            INTEGER PRIMARY KEY,
  ref           TEXT NOT NULL UNIQUE,              -- PP-0001
  draft_id      INTEGER NOT NULL REFERENCES drafts(id),
  amount        INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'PENDING',   -- PENDING | PAID | VOID (ถูกแทนด้วย QR ใหม่)
  qr_created_at TEXT NOT NULL,
  qr_expires_at TEXT NOT NULL,                     -- created + 15 นาที
  paid_at       TEXT,
  case_no       TEXT,
  receipt_no    TEXT
);
CREATE INDEX IF NOT EXISTS idx_payments_draft ON payments(draft_id);

-- คำขอที่มีเลขแล้ว (หลังชำระสำเร็จ)
CREATE TABLE IF NOT EXISTS cases (
  id            INTEGER PRIMARY KEY,
  case_no       TEXT NOT NULL UNIQUE,              -- EG-2569-000001
  draft_id      INTEGER REFERENCES drafts(id),
  citizen_id    INTEGER NOT NULL REFERENCES citizens(id),
  service_id    TEXT NOT NULL REFERENCES services(id),
  qty           INTEGER,
  area_sqm      INTEGER,
  fee           INTEGER NOT NULL,
  status        TEXT NOT NULL CHECK (status IN (${inList(CASE_STATUSES)})),
  step          INTEGER,                           -- SV-03: 1 ทะเบียน · 2 โยธา · 3 หัวหน้า · บริการอื่น NULL
  dept          TEXT,                              -- แผนกที่คำขออยู่ตอนนี้ registry | works · ขั้นหัวหน้า/ปิดแล้ว = NULL
  owner         TEXT,                              -- username ผู้ถือเรื่องขั้นปัจจุบัน (IN_REVIEW / NEED_FIX) · ไม่มี = NULL
  issuer        TEXT,                              -- username ผู้ออกเอกสาร (A-27: เจ้าหน้าที่ทะเบียนที่รับเรื่องขั้นแรก)
  approver      TEXT,                              -- username ผู้อนุมัติ/ไม่อนุมัติ (= ผู้ลงนาม)
  approved_at   TEXT,
  return_count  INTEGER NOT NULL DEFAULT 0,
  returned_at   TEXT,                              -- เวลาตีกลับครั้งล่าสุด
  return_reason TEXT,                              -- เหตุผลตีกลับครั้งล่าสุด (return-reason-display)
  fix_deadline  TEXT,                              -- returned_at + 168 ชม. (NEED_FIX)
  reject_reason TEXT,
  paid_at       TEXT NOT NULL,
  receipt_no    TEXT UNIQUE,                       -- RC-2569-000001
  due_at        TEXT NOT NULL,                     -- กำหนดเสร็จ (เก็บค่า ไม่คำนวณใหม่ · A-35 A-42)
  closed_at     TEXT,                              -- COMPLETED / REJECTED
  cancelled_at  TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cases_citizen ON cases(citizen_id);
CREATE INDEX IF NOT EXISTS idx_cases_status ON cases(status);

-- ไทม์ไลน์คำขอ (timeline-item) และประวัติตีกลับ/ส่งแก้ (ใช้คำนวณหยุดนับ)
CREATE TABLE IF NOT EXISTS case_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id       INTEGER NOT NULL REFERENCES cases(id),
  at            TEXT NOT NULL,
  type          TEXT NOT NULL,                     -- PAID CLAIM RETURN RESUBMIT FORWARD APPROVE REJECT ISSUE CANCEL AUTO_CANCEL …
  actor         TEXT,                              -- username · ประชาชน = 'citizen' · ระบบ = 'system'
  from_status   TEXT,
  to_status     TEXT,
  note          TEXT,                              -- เหตุผล/หมายเหตุ
  data          TEXT                               -- JSON เพิ่มเติม
);
CREATE INDEX IF NOT EXISTS idx_case_events_case ON case_events(case_id, at);

-- เอกสารดิจิทัลที่ออกแล้ว · signature = crypto.sign([doc_no, case_no, applicant, service_id, issued_at, valid_until, signer])
CREATE TABLE IF NOT EXISTS documents (
  id            INTEGER PRIMARY KEY,
  doc_no        TEXT NOT NULL UNIQUE,              -- DOC-2569-000001
  case_id       INTEGER NOT NULL REFERENCES cases(id),
  case_no       TEXT NOT NULL,
  applicant     TEXT NOT NULL,                     -- ชื่อผู้ยื่นเต็ม
  service_id    TEXT NOT NULL,
  issued_at     TEXT NOT NULL,                     -- ISO +07:00
  valid_until   TEXT NOT NULL,                     -- YYYY-MM-DD วันสุดท้ายที่ใช้ได้ (A-43)
  signer        TEXT NOT NULL,                     -- ชื่อแสดงผู้ลงนาม
  signer_username TEXT,
  issued_by     TEXT,                              -- username ผู้กดออกเอกสาร
  verify_code   TEXT NOT NULL UNIQUE,              -- [A-Z0-9]{8}
  signature     TEXT NOT NULL
);

-- แจ้งเตือนในระบบ · 1 ครั้งต่อระดับต่อคำขอต่อคน (BR-15) → INSERT OR IGNORE
CREATE TABLE IF NOT EXISTS notifications (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL,
  case_id       INTEGER NOT NULL REFERENCES cases(id),
  case_no       TEXT NOT NULL,
  level         TEXT NOT NULL CHECK (level IN ('near','overdue')),
  text          TEXT NOT NULL,                     -- คำขอ EG-2569-000024 ใกล้ครบกำหนด
  created_at    TEXT NOT NULL,
  read_at       TEXT,
  UNIQUE (username, case_id, level)
);

-- Audit Trail (เพิ่มได้อย่างเดียว · DECISIONS §13)
CREATE TABLE IF NOT EXISTS audit (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  time          TEXT NOT NULL,                     -- ISO +07:00 จากนาฬิกาทดสอบ
  username      TEXT NOT NULL,
  role          TEXT NOT NULL,
  event         TEXT NOT NULL CHECK (event IN (${inList(AUDIT_EVENTS)})),
  case_no       TEXT,
  from_status   TEXT,
  to_status     TEXT,
  detail        TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit(time);

CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit
BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit
BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;
`;

function openDatabase(file = DB_PATH) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const conn = new Database(file);
  conn.pragma('journal_mode = WAL');
  conn.pragma('synchronous = NORMAL');
  conn.pragma('busy_timeout = 5000');
  conn.pragma('foreign_keys = OFF'); // better-sqlite3 เปิดเป็นค่าเริ่มต้น · drafts↔cases อ้างกันไปมา จึงไม่บังคับ
  conn.pragma('secure_delete = ON'); // ข้อมูลที่ลบ (เช่นไฟล์แนบหลัง reset) ไม่ค้างในไฟล์ฐานข้อมูล
  conn.exec(SCHEMA);
  return conn;
}

const db = openDatabase();

// ล้างทุกตาราง (DROP แล้วสร้างใหม่ → AUTOINCREMENT เริ่ม 1 ใหม่ และข้าม trigger ห้ามลบของ audit)
// ใช้โดย POST /api/test/reset เท่านั้น
function resetSchema() {
  db.transaction(() => {
    db.exec('DROP TRIGGER IF EXISTS audit_no_update; DROP TRIGGER IF EXISTS audit_no_delete;');
    for (const t of TABLES) db.exec(`DROP TABLE IF EXISTS ${t}`);
    db.exec(SCHEMA);
  })();
}

// ตัวนับเลขรันแบบอะตอม: คืนค่าถัดไป (เริ่ม 1 ถ้ายังไม่มี) · เรียกใน db.transaction เดียวกับ INSERT
const stmtNextSeq = () => db.prepare(
  'INSERT INTO counters (name, value) VALUES (?, 1) ON CONFLICT(name) DO UPDATE SET value = value + 1 RETURNING value'
);
function nextSeq(name) {
  return stmtNextSeq().get(name).value;
}

// ตั้งค่าตัวนับ (seed) · value = เลขล่าสุดที่ใช้แล้ว (ค่าถัดไป = value + 1)
function setSeq(name, value) {
  db.prepare('INSERT INTO counters (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value').run(name, value);
}

function isEmpty() {
  return db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0;
}

function checkpoint() {
  try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch (_) { /* ไม่สำคัญ */ }
}

module.exports = db;
Object.assign(module.exports, {
  db, DB_PATH, SCHEMA, TABLES, CASE_STATUSES, ROLES, DEPTS, AUDIT_EVENTS,
  openDatabase, resetSchema, nextSeq, setSeq, isEmpty, checkpoint,
});
