// สร้างไฟล์ทดสอบอัปโหลดตาม TEST-DATA §11 (พอร์ตจาก make_testfiles.py เป็น Node)
// ตัวตรวจของเว็บดูที่ magic bytes จึงสร้างด้วยหัวไฟล์จริง + เติมให้ขนาดตรงไบต์
// ใช้: node fixtures/make-fixtures.js  (หรือถูกเรียกอัตโนมัติจาก global-setup.ts / helpers.ts)
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const FIXTURE_DIR = path.join(__dirname, 'files');

// PDF จริงขนาด n ไบต์ (หัว %PDF + เติมช่องว่างแล้วปิดด้วย %%EOF)
function pdf(n) {
  const head = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n', 'latin1');
  const tail = Buffer.from('\ntrailer<</Root 1 0 R>>\n%%EOF\n', 'latin1');
  const pad = n - head.length - tail.length;
  if (pad < 0) throw new Error(`pdf(${n}) too small`);
  return Buffer.concat([head, Buffer.alloc(pad, 0x20), tail]);
}

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

// PNG จริง 1x1 + เติม chunk tEXt ให้ครบขนาด
function png(n) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr.writeUInt8(8, 8);
  ihdr.writeUInt8(2, 9);
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const iend = chunk('IEND', Buffer.alloc(0));
  const base = Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.from([0x00, 0xff, 0x00, 0x00]))),
    iend,
  ]);
  const pad = n - base.length - 12; // chunk tEXt: 12 ไบต์ overhead
  const text = Buffer.concat([Buffer.from('k\0', 'latin1'), Buffer.alloc(pad - 2, 0x78)]);
  return Buffer.concat([base.subarray(0, base.length - 12), chunk('tEXt', text), iend]);
}

// JPEG จริงแบบย่อ: SOI + APP0 + เติม COM + EOI
function jpg(n) {
  const soi = Buffer.from([0xff, 0xd8]);
  const app0 = Buffer.from([
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
  ]);
  const pad = n - soi.length - app0.length - 2 - 4;
  const comLen = Buffer.alloc(2);
  comLen.writeUInt16BE(pad + 2);
  return Buffer.concat([soi, app0, Buffer.from([0xff, 0xfe]), comLen, Buffer.alloc(pad, 0x78), Buffer.from([0xff, 0xd9])]);
}

/** ขนาดที่คาดหวังของทุกไฟล์ (ใช้ตรวจว่าไฟล์ที่มีอยู่ถูกต้อง) */
const SPEC = {};
for (const n of ['ok-id.pdf', 'id-card.pdf', 'map.pdf', 'plan.pdf', 'deed.pdf']) SPEC[n] = () => pdf(1024);
for (let i = 1; i <= 6; i++) SPEC[`multi-${i}.pdf`] = () => pdf(1024);
SPEC['real.jpg'] = () => jpg(1024);
SPEC['real.png'] = () => png(1024);
SPEC['plan-as-jpg.jpg'] = () => jpg(1024);
for (const n of [5242879, 5242880, 5242881]) SPEC[`size-${n}.pdf`] = () => pdf(n);
SPEC['fake-text.pdf'] = () => Buffer.from('hello');
SPEC['fake-text.jpg'] = () => Buffer.from('hello');
SPEC['notes.txt'] = () => Buffer.from('hello');
SPEC['exe-as.png'] = () => Buffer.concat([Buffer.from('MZ', 'latin1'), Buffer.alloc(1022, 0)]);

const SIZES = {
  'ok-id.pdf': 1024, 'id-card.pdf': 1024, 'map.pdf': 1024, 'plan.pdf': 1024, 'deed.pdf': 1024,
  'real.jpg': 1024, 'real.png': 1024, 'plan-as-jpg.jpg': 1024,
  'size-5242879.pdf': 5242879, 'size-5242880.pdf': 5242880, 'size-5242881.pdf': 5242881,
  'fake-text.pdf': 5, 'fake-text.jpg': 5, 'notes.txt': 5, 'exe-as.png': 1024,
};
for (let i = 1; i <= 6; i++) SIZES[`multi-${i}.pdf`] = 1024;

function makeFixtures(dir = FIXTURE_DIR, { verbose = false } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, make] of Object.entries(SPEC)) {
    const p = path.join(dir, name);
    if (fs.existsSync(p) && fs.statSync(p).size === SIZES[name]) continue;
    const data = make();
    if (data.length !== SIZES[name]) throw new Error(`${name}: ${data.length} != ${SIZES[name]}`);
    fs.writeFileSync(p, data);
  }
  if (verbose) {
    for (const f of fs.readdirSync(dir).sort()) console.log(f, fs.statSync(path.join(dir, f)).size);
  }
  return dir;
}

module.exports = { makeFixtures, FIXTURE_DIR, SIZES };

if (require.main === module) makeFixtures(FIXTURE_DIR, { verbose: true });
