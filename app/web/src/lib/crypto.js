'use strict';
// เข้ารหัสข้อมูลส่วนบุคคล at rest (NFR-04 · DECISIONS §11): เลขบัตร + เบอร์มือถือ ด้วย AES-256-GCM
// ในฐานข้อมูลต้องไม่มีเลขบัตร 13 หลัก/เบอร์ 10 หลักตรง ๆ (รวมตาราง OTP/ล็อก/audit/session) → ค้นหาด้วย lookupHash()
// คีย์มาจาก env (DATA_KEY · LOOKUP_KEY · SIGN_KEY) ถ้าไม่ตั้งใช้คีย์ทดสอบคงที่ (ฐานข้อมูลที่ mount ไว้ถอดได้หลัง restart)

const crypto = require('crypto');

function keyFrom(envName, label) {
  const v = process.env[envName];
  if (v && /^[0-9a-f]{64}$/i.test(v)) return Buffer.from(v, 'hex');
  if (v) return crypto.createHash('sha256').update(v).digest();
  return crypto.createHash('sha256').update('egov-eservice-test-key:' + label).digest();
}

const DATA_KEY = keyFrom('DATA_KEY', 'data');     // AES-256-GCM (32 ไบต์)
const LOOKUP_KEY = keyFrom('LOOKUP_KEY', 'lookup'); // HMAC สำหรับดัชนีค้นหา
const SIGN_KEY = keyFrom('SIGN_KEY', 'doc-sign');   // HMAC-SHA256 ลายเซ็นเอกสารจำลอง (A-22)

// 'v1:' + base64(iv[12] | tag[16] | ciphertext) · null/undefined → null
function encrypt(plain) {
  if (plain === null || plain === undefined) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', DATA_KEY, iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return 'v1:' + Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
}

function decrypt(blob) {
  if (blob === null || blob === undefined || blob === '') return null;
  const s = String(blob);
  if (!s.startsWith('v1:')) throw new Error('decrypt: unknown format');
  const raw = Buffer.from(s.slice(3), 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', DATA_KEY, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}

// ดัชนีค้นหาแบบกำหนดได้ (HMAC-SHA256 hex) ใช้แทนค่าจริงใน WHERE / UNIQUE / ตารางตัวนับ OTP
function lookupHash(value) {
  return crypto.createHmac('sha256', LOOKUP_KEY).update(String(value)).digest('hex');
}

// HMAC-SHA256 hex ของฟิลด์ที่ต่อกันด้วย '|' ตามลำดับที่ส่งมา (CONTRACT §3)
function sign(fields) {
  const data = Array.isArray(fields) ? fields.map((f) => (f === null || f === undefined ? '' : String(f))).join('|') : String(fields);
  return crypto.createHmac('sha256', SIGN_KEY).update(data, 'utf8').digest('hex');
}

function verifySignature(fields, signatureHex) {
  const expected = Buffer.from(sign(fields), 'hex');
  const got = Buffer.from(String(signatureHex || ''), 'hex');
  return got.length === expected.length && crypto.timingSafeEqual(got, expected);
}

// รหัสผ่านเจ้าหน้าที่: scrypt · 'scrypt$<salt hex>$<hash hex>'
const hashCache = new Map(); // seed สร้างรหัสเดิมซ้ำทุก reset → เก็บผลไว้ให้ reset เร็ว
function hashPassword(password) {
  const pw = String(password);
  if (hashCache.has(pw)) return hashCache.get(pw);
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 32);
  const out = `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
  hashCache.set(pw, out);
  return out;
}

function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const expected = Buffer.from(parts[2], 'hex');
  const got = crypto.scryptSync(String(password), Buffer.from(parts[1], 'hex'), expected.length);
  return crypto.timingSafeEqual(got, expected);
}

const CODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
// สุ่มรหัส เช่น รหัสตรวจสอบเอกสาร 8 ตัว [A-Z0-9]{8}
function randomCode(length = 8, alphabet = CODE_ALPHABET) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

// id สุ่มสำหรับไฟล์แนบ ฯลฯ
function randomId(prefix = '') {
  return prefix + crypto.randomBytes(12).toString('hex');
}

module.exports = {
  encrypt, decrypt, lookupHash, sign, verifySignature,
  hashPassword, verifyPassword, randomCode, randomId,
};
