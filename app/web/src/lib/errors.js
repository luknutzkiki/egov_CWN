'use strict';
// ข้อความ error ตรงตัวอักษรตาม CONTRACT §5 · รูปแบบ API {"code":"…","message":"…", ...extra}
// ใช้: const { sendError, AppError } = require('../lib/errors');
//   return sendError(res, 'ALREADY_CLAIMED');                    // 409 {"code":"ALREADY_CLAIMED","message":"มีเจ้าหน้าที่รับเรื่องนี้แล้ว"}
//   return sendError(res, 'OTP_INVALID', { attemptsLeft: 2 });  // 401 + attemptsLeft
//   throw new AppError('INVALID_STATE');                         // ตัวจัดการ error กลางใน server.js แปลงเป็น JSON (API) ให้

const ERRORS = {
  INVALID_ID: [400, 'เลขบัตรประชาชนไม่ถูกต้อง'],
  OTP_INVALID: [401, 'รหัส OTP ไม่ถูกต้อง'],
  LOCKED: [423, 'ผิดเกินกำหนด เลขบัตรนี้ถูกล็อก 15 นาที'],
  INVALID_CREDENTIALS: [401, 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง'],
  INVALID_MOBILE: [400, 'เบอร์มือถือต้องเป็นตัวเลข 10 หลักขึ้นต้นด้วย 0'],
  CONSENT_REQUIRED: [400, 'กรุณายินยอมการประมวลผลข้อมูลส่วนบุคคล (PDPA)'],
  INVALID_QTY: [400, 'จำนวนฉบับต้อง 1–5 ฉบับ'],
  INVALID_AREA: [400, 'กรุณาระบุพื้นที่ 1–500 ตร.ม.'],
  AREA_TOO_LARGE: [400, 'พื้นที่เกิน 500 ตร.ม. กรุณายื่นที่สำนักงาน'],
  FILE_TOO_LARGE: [400, 'ไฟล์ใหญ่เกิน 5 MB'],
  FILE_TYPE: [400, 'รองรับเฉพาะไฟล์ PDF, JPG, PNG'],
  FILE_COUNT: [400, 'แนบได้สูงสุด 5 ไฟล์ต่อคำขอ'],
  PLAN_NOT_PDF: [400, 'แบบแปลนต้องเป็นไฟล์ PDF เท่านั้น'],
  MISSING_DOCS: [409, 'ยังขาดเอกสาร: '], // ใช้ missingDocsMessage(names) แทนข้อความนี้
  QR_EXPIRED: [410, 'QR หมดอายุ กรุณาสร้าง QR ใหม่'],
  AMOUNT_MISMATCH: [422, 'ยอดเงินไม่ตรงกับค่าธรรมเนียม'],
  NOT_FOUND: [404, 'ไม่พบคำขอ'],
  CANNOT_CANCEL: [409, 'ยกเลิกไม่ได้ คำขอมีเจ้าหน้าที่รับเรื่องแล้ว'],
  FIX_WINDOW_EXPIRED: [409, 'หมดเวลาแก้ไขแล้ว คำขอถูกยกเลิก'],
  ALREADY_CLAIMED: [409, 'มีเจ้าหน้าที่รับเรื่องนี้แล้ว'],
  WORKLOAD_LIMIT: [409, 'รับงานได้สูงสุด 10 เรื่อง'],
  RETURN_LIMIT: [409, 'ตีกลับได้สูงสุด 2 ครั้ง'],
  REASON_TOO_SHORT: [400, 'กรุณากรอกเหตุผลอย่างน้อย 10 ตัวอักษร'],
  REASON_REQUIRED: [400, 'กรุณากรอกเหตุผล'],
  INVALID_STATE: [409, 'สถานะคำขอไม่ถูกต้องสำหรับรายการนี้'],
  FORBIDDEN: [403, 'ไม่มีสิทธิ์ทำรายการนี้'],
  UNAUTHENTICATED: [401, 'กรุณาเข้าสู่ระบบ'],
  INVALID_FEE: [400, 'ค่าธรรมเนียมต้องเป็นจำนวนเต็ม 0–100,000 บาท'],
  INVALID_SLA: [400, 'SLA ต้องเป็นจำนวนเต็ม 1–60 วันทำการ'],
  DUPLICATE_HOLIDAY: [409, 'มีวันหยุดนี้อยู่แล้ว'],
  SELF_ROLE_CHANGE: [409, 'ไม่สามารถเปลี่ยนบทบาทของตัวเองได้'],
  METHOD_NOT_ALLOWED: [405, 'Method Not Allowed'],
  // นอกตาราง 5 (ไม่มีข้อความที่ test assert)
  INVALID_TIME: [400, 'รูปแบบเวลาไม่ถูกต้อง ต้องเป็น ISO 8601 พร้อม offset เช่น 2026-12-01T09:00:00+07:00'],
  BAD_REQUEST: [400, 'คำขอไม่ถูกต้อง'],
  INTERNAL: [500, 'เกิดข้อผิดพลาดภายในระบบ'],
};

// ข้อความหน้า (ไม่ใช่ API) ตาม §2.1
const PAGE_MESSAGES = {
  FORBIDDEN_PAGE: 'ไม่มีสิทธิ์เข้าถึงหน้านี้',
  NOT_FOUND_PAGE: 'ไม่พบคำขอ',
};

function messageOf(code) {
  return (ERRORS[code] || ERRORS.INTERNAL)[1];
}

function statusOf(code) {
  return (ERRORS[code] || ERRORS.INTERNAL)[0];
}

// `ยังขาดเอกสาร: แบบแปลน, โฉนด`
function missingDocsMessage(names) {
  return 'ยังขาดเอกสาร: ' + names.join(', ');
}

function errorBody(code, extra = {}) {
  let message = messageOf(code);
  if (code === 'MISSING_DOCS' && Array.isArray(extra.missing)) message = missingDocsMessage(extra.missing);
  return { code, message, ...extra };
}

// ส่ง error JSON · status มาจากตาราง (ส่ง status เองได้ทาง opts.status)
function sendError(res, code, extra = {}, opts = {}) {
  return res.status(opts.status || statusOf(code)).json(errorBody(code, extra));
}

class AppError extends Error {
  constructor(code, extra = {}, status) {
    super(messageOf(code));
    this.code = code;
    this.status = status || statusOf(code);
    this.extra = extra;
    this.isAppError = true;
  }
}

module.exports = { ERRORS, PAGE_MESSAGES, messageOf, statusOf, missingDocsMessage, errorBody, sendError, AppError };
