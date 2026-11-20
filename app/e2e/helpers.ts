/**
 * helpers.ts · ตัวช่วยกลางของชุด Playwright (TEST-PLAN §0 สูตรกลาง)
 *
 *   RESET            → reset()
 *   CLOCK(t)         → setClock(t) · getClock()
 *   LOGIN_C(เลขบัตร) → loginCitizen(idNo)  (API)  · uiLoginCitizen(page, idNo)  (หน้า /login)
 *   LOGIN_S(user)    → loginStaff(username) (API) · uiLoginStaff(page, username) (แท็บเจ้าหน้าที่)
 *   NEW_PAID(...)    → newPaid({ idNo, service, at, qty, areaSqm })
 *   pay              → pay(ref, amount) (คาด 200) · payRaw(ref, amount) (ตรวจ status เอง)
 *
 * กติกา: reset ล้าง session ทุกคน (CONTRACT 0.9) → หลัง reset() ทุกครั้งต้องสร้าง request/browser context ใหม่
 * แล้วล็อกอินใหม่ · ใช้ cleanup() ใน test.afterEach เพื่อปิด context ที่เปิดผ่าน helper
 */
import {
  expect,
  request as pwRequest,
  type APIRequestContext,
  type APIResponse,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { makeFixtures, FIXTURE_DIR } from './fixtures/make-fixtures';

// ───────────────────────── ค่าคงที่จาก TEST-DATA ─────────────────────────

export const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000';
/** นาฬิกาหลัง reset (อังคาร 1 ธ.ค. 2569 09:00) */
export const T0 = '2026-12-01T09:00:00+07:00';
export const OTP_OK = '123456';
export const OTP_BAD = '000000';
export const PASSWORD = 'Test@1234';

/** เลขบัตรประชาชน (TEST-DATA 1.1) */
export const ID = {
  SOMCHAI: '1101700123456',
  SOMYING: '3100600987659',
  MANA: '5500400111221',
  PITI: '1909900555015',
  BAD_CHECKSUM: '1101700123457',
} as const;

export const CITIZENS = {
  [ID.SOMCHAI]: { name: 'สมชาย ใจดี', full: '1-1017-00123-45-6', masked: 'X-XXXX-XXXXX-45-6', registered: true },
  [ID.SOMYING]: { name: 'สมหญิง รักไทย', full: '3-1006-00987-65-9', masked: 'X-XXXX-XXXXX-65-9', registered: true },
  [ID.MANA]: { name: 'มานะ ตั้งใจ', full: '5-5004-00111-22-1', masked: 'X-XXXX-XXXXX-22-1', registered: false },
  [ID.PITI]: { name: 'ปิติ มีสุข', full: '1-9099-00555-01-5', masked: 'X-XXXX-XXXXX-01-5', registered: true },
} as const;

/** บัญชีเจ้าหน้าที่/บทบาทอื่น (TEST-DATA 1.2 · CONTRACT 2.1) */
export const STAFF = {
  'off.reg1': { name: 'เจ้าหน้าที่ทะเบียน 1', role: 'officer', dept: 'registry', roleText: 'เจ้าหน้าที่', landing: '/officer/queue' },
  'off.reg2': { name: 'เจ้าหน้าที่ทะเบียน 2', role: 'officer', dept: 'registry', roleText: 'เจ้าหน้าที่', landing: '/officer/queue' },
  'off.works1': { name: 'เจ้าหน้าที่โยธา 1', role: 'officer', dept: 'works', roleText: 'เจ้าหน้าที่', landing: '/officer/queue' },
  head1: { name: 'หัวหน้าฝ่าย', role: 'head', dept: null, roleText: 'หัวหน้าฝ่าย', landing: '/head/approvals' },
  exec1: { name: 'ผู้บริหาร', role: 'executive', dept: null, roleText: 'ผู้บริหาร', landing: '/dashboard' },
  audit1: { name: 'ผู้ตรวจสอบภายใน', role: 'auditor', dept: null, roleText: 'ผู้ตรวจสอบภายใน', landing: '/audit' },
  admin1: { name: 'ผู้ดูแลระบบ', role: 'admin', dept: null, roleText: 'ผู้ดูแลระบบ', landing: '/admin/services' },
} as const;
export type StaffUser = keyof typeof STAFF;

export type ServiceId = 'SV-01' | 'SV-02' | 'SV-03';

/** เอกสารบังคับต่อบริการ (CONTRACT 4.3 · TEST-DATA 11) → [docKey, ไฟล์] */
export const REQUIRED_DOCS: Record<ServiceId, Array<[string, string]>> = {
  'SV-01': [['id-card', 'id-card.pdf']],
  'SV-02': [['id-card', 'id-card.pdf'], ['map', 'map.pdf']],
  'SV-03': [['id-card', 'id-card.pdf'], ['plan', 'plan.pdf'], ['deed', 'deed.pdf']],
};

/** ข้อความตรงตัวอักษร (CONTRACT ตาราง 4 และ 5) */
export const MSG = {
  INVALID_ID: 'เลขบัตรประชาชนไม่ถูกต้อง',
  OTP_INVALID: 'รหัส OTP ไม่ถูกต้อง',
  LOCKED: 'ผิดเกินกำหนด เลขบัตรนี้ถูกล็อก 15 นาที',
  INVALID_CREDENTIALS: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง',
  INVALID_MOBILE: 'เบอร์มือถือต้องเป็นตัวเลข 10 หลักขึ้นต้นด้วย 0',
  CONSENT_REQUIRED: 'กรุณายินยอมการประมวลผลข้อมูลส่วนบุคคล (PDPA)',
  INVALID_QTY: 'จำนวนฉบับต้อง 1–5 ฉบับ',
  INVALID_AREA: 'กรุณาระบุพื้นที่ 1–500 ตร.ม.',
  AREA_TOO_LARGE: 'พื้นที่เกิน 500 ตร.ม. กรุณายื่นที่สำนักงาน',
  FILE_TOO_LARGE: 'ไฟล์ใหญ่เกิน 5 MB',
  FILE_TYPE: 'รองรับเฉพาะไฟล์ PDF, JPG, PNG',
  FILE_COUNT: 'แนบได้สูงสุด 5 ไฟล์ต่อคำขอ',
  PLAN_NOT_PDF: 'แบบแปลนต้องเป็นไฟล์ PDF เท่านั้น',
  QR_EXPIRED: 'QR หมดอายุ กรุณาสร้าง QR ใหม่',
  AMOUNT_MISMATCH: 'ยอดเงินไม่ตรงกับค่าธรรมเนียม',
  NOT_FOUND: 'ไม่พบคำขอ',
  CANNOT_CANCEL: 'ยกเลิกไม่ได้ คำขอมีเจ้าหน้าที่รับเรื่องแล้ว',
  FIX_WINDOW_EXPIRED: 'หมดเวลาแก้ไขแล้ว คำขอถูกยกเลิก',
  ALREADY_CLAIMED: 'มีเจ้าหน้าที่รับเรื่องนี้แล้ว',
  WORKLOAD_LIMIT: 'รับงานได้สูงสุด 10 เรื่อง',
  RETURN_LIMIT: 'ตีกลับได้สูงสุด 2 ครั้ง',
  REASON_TOO_SHORT: 'กรุณากรอกเหตุผลอย่างน้อย 10 ตัวอักษร',
  REASON_REQUIRED: 'กรุณากรอกเหตุผล',
  INVALID_STATE: 'สถานะคำขอไม่ถูกต้องสำหรับรายการนี้',
  FORBIDDEN: 'ไม่มีสิทธิ์ทำรายการนี้',
  FORBIDDEN_PAGE: 'ไม่มีสิทธิ์เข้าถึงหน้านี้',
  UNAUTHENTICATED: 'กรุณาเข้าสู่ระบบ',
  NO_REFUND: 'ค่าธรรมเนียมที่ชำระแล้วไม่คืน',
  NOTI_EMPTY: 'ไม่มีแจ้งเตือน',
  QUEUE_EMPTY: 'ไม่มีงานในคิว',
} as const;

export const STATUS_TH = {
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
} as const;

export const LEVEL_TH = {
  normal: 'ปกติ',
  near: 'ใกล้ครบกำหนด',
  overdue: 'เกินกำหนด',
  paused: 'หยุดนับ',
  closed: 'ปิดแล้ว',
} as const;
export type SlaLevel = keyof typeof LEVEL_TH;

/** เลขคำขอ: caseNo(25) → 'EG-2569-000025' */
export const caseNo = (n: number, year = 2569): string => `EG-${year}-${String(n).padStart(6, '0')}`;
export const receiptNo = (n: number, year = 2569): string => `RC-${year}-${String(n).padStart(6, '0')}`;
/** ref ชำระ: ppRef(2) → 'PP-0002' */
export const ppRef = (n: number): string => `PP-${String(n).padStart(4, '0')}`;
export const draftId = (n: number): string => `DR-${String(n).padStart(4, '0')}`;

// ───────────────────────── ไฟล์ทดสอบ (TEST-DATA §11) ─────────────────────────

let fixturesReady = false;
/** path ของไฟล์ทดสอบใน e2e/fixtures/files (สร้างอัตโนมัติถ้ายังไม่มี) */
export function fixturePath(name: string): string {
  if (!fixturesReady) {
    makeFixtures();
    fixturesReady = true;
  }
  const p = path.join(FIXTURE_DIR, name);
  if (!fs.existsSync(p)) throw new Error(`ไม่มีไฟล์ทดสอบ ${name}`);
  return p;
}
export function fixtureBuffer(name: string): Buffer {
  return fs.readFileSync(fixturePath(name));
}
export function mimeOf(name: string): string {
  const ext = path.extname(name).toLowerCase();
  return ext === '.pdf' ? 'application/pdf' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.png' ? 'image/png' : 'text/plain';
}
export interface FilePayload {
  name: string;
  mimeType: string;
  buffer: Buffer;
}
export function filePayload(name: string, mimeType = mimeOf(name)): FilePayload {
  return { name, mimeType, buffer: fixtureBuffer(name) };
}

// ───────────────────────── context ที่เปิด + ปิดท้าย test ─────────────────────────

const openedApis: APIRequestContext[] = [];
const openedContexts: BrowserContext[] = [];

/** request context ใหม่ (cookie แยก) */
export async function newApi(): Promise<APIRequestContext> {
  const api = await pwRequest.newContext({ baseURL: BASE_URL });
  openedApis.push(api);
  return api;
}

/** ปิดทุก context ที่เปิดผ่าน helper (เรียกใน test.afterEach) */
export async function cleanup(): Promise<void> {
  while (openedContexts.length) await openedContexts.pop()!.close().catch(() => {});
  while (openedApis.length) await openedApis.pop()!.dispose().catch(() => {});
}

let hookApi: APIRequestContext | null = null;
/** context สำหรับ /api/test/* (ไม่ต้องล็อกอิน · ไม่ถูกปิดโดย cleanup) */
async function hooks(): Promise<APIRequestContext> {
  if (!hookApi) hookApi = await pwRequest.newContext({ baseURL: BASE_URL });
  return hookApi;
}

// ───────────────────────── ตรวจ response ─────────────────────────

/** อ่าน body เป็น JSON (ถ้าไม่ใช่ JSON คืน { _raw }) */
export async function bodyOf(res: APIResponse): Promise<any> {
  const text = await res.text().catch(() => '');
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: text };
  }
}

/** ตรวจ HTTP status (+ code ของ error) แล้วคืน body */
export async function expectApi(res: APIResponse | Promise<APIResponse>, status: number, code?: string): Promise<any> {
  const r = await res;
  const body = await bodyOf(r);
  const info = `${r.url()} → ${r.status()} ${JSON.stringify(body).slice(0, 400)}`;
  expect(r.status(), info).toBe(status);
  if (code !== undefined) expect(body.code, info).toBe(code);
  return body;
}

// ───────────────────────── test hook: RESET / CLOCK / pay ─────────────────────────

/** RESET: POST /api/test/reset → 200 {"ok":true,"now":T0} (ล้าง session ทุกคน) */
export async function reset(): Promise<void> {
  const body = await expectApi((await hooks()).post('/api/test/reset'), 200);
  expect(body.ok).toBe(true);
  expect(body.now).toBe(T0);
}

/** CLOCK(t): PUT /api/test/clock {"now":t} (นาฬิกาแช่แข็ง) */
export async function setClock(now: string): Promise<void> {
  const body = await expectApi((await hooks()).put('/api/test/clock', { data: { now } }), 200);
  expect(body.now).toBe(now);
}

export async function getClock(): Promise<string> {
  const body = await expectApi((await hooks()).get('/api/test/clock'), 200);
  return body.now;
}

/** POST /api/test/payments/<ref>/pay — คืน response ดิบ */
export async function payRaw(ref: string, amount: number): Promise<APIResponse> {
  return (await hooks()).post(`/api/test/payments/${ref}/pay`, { data: { amount } });
}

/** ชำระสำเร็จ (คาด 200 PAID) คืน { status, caseNo, receiptNo, duplicate } */
export async function pay(ref: string, amount: number): Promise<{ status: string; caseNo: string; receiptNo: string; duplicate: boolean }> {
  const body = await expectApi(payRaw(ref, amount), 200);
  expect(body.status).toBe('PAID');
  return body;
}

// ───────────────────────── ล็อกอินผ่าน API ─────────────────────────

/** LOGIN_C ผ่าน API: thaid/start + thaid/verify OTP 123456 (ใช้ api ที่ส่งมา หรือสร้างใหม่) */
export async function loginCitizen(idNo: string = ID.SOMCHAI, api?: APIRequestContext): Promise<APIRequestContext> {
  const ctx = api ?? (await newApi());
  const s = await expectApi(ctx.post('/api/auth/thaid/start', { data: { idNo } }), 200);
  expect(s.status).toBe('OTP_SENT');
  await expectApi(ctx.post('/api/auth/thaid/verify', { data: { idNo, otp: OTP_OK } }), 200);
  return ctx;
}

/** LOGIN_S ผ่าน API: POST /api/auth/staff/login รหัสผ่าน Test@1234 */
export async function loginStaff(username: StaffUser | string, api?: APIRequestContext, password = PASSWORD): Promise<APIRequestContext> {
  const ctx = api ?? (await newApi());
  const body = await expectApi(ctx.post('/api/auth/staff/login', { data: { username, password } }), 200);
  const info = STAFF[username as StaffUser];
  if (info) {
    expect(body.role).toBe(info.role);
    expect(body.landing).toBe(info.landing);
  }
  return ctx;
}

export async function logout(api: APIRequestContext): Promise<void> {
  await expectApi(api.post('/api/auth/logout'), 204);
}

// ───────────────────────── session ของ browser (หน้า + API cookie เดียวกัน) ─────────────────────────

export interface Session {
  context: BrowserContext;
  page: Page;
  /** context.request — ใช้ cookie เดียวกับหน้า */
  api: APIRequestContext;
}

/** browser context ใหม่ที่ยังไม่ล็อกอิน */
export async function newSession(browser: Browser): Promise<Session> {
  const context = await browser.newContext({
    baseURL: BASE_URL,
    locale: 'th-TH',
    timezoneId: 'Asia/Bangkok',
    viewport: { width: 1280, height: 900 },
  });
  openedContexts.push(context);
  const page = await context.newPage();
  page.on('dialog', (d) => d.accept().catch(() => {}));
  return { context, page, api: context.request };
}

/** browser context ที่ล็อกอินประชาชนแล้ว (ล็อกอินผ่าน API ของ context เดียวกัน) */
export async function citizenSession(browser: Browser, idNo: string = ID.SOMCHAI): Promise<Session> {
  const s = await newSession(browser);
  await loginCitizen(idNo, s.api);
  return s;
}

/** browser context ที่ล็อกอินเจ้าหน้าที่/บทบาทอื่นแล้ว */
export async function staffSession(browser: Browser, username: StaffUser): Promise<Session> {
  const s = await newSession(browser);
  await loginStaff(username, s.api);
  return s;
}

// ───────────────────────── ล็อกอินผ่านหน้าจอ ─────────────────────────

/** เปิด /login แท็บประชาชน กรอกเลขบัตร กด thaid-submit (ไม่รอผล) */
export async function uiThaidStart(page: Page, idNo: string): Promise<void> {
  await page.goto('/login');
  await page.getByTestId('login-tab-citizen').click();
  await page.getByTestId('thaid-id-input').fill(idNo);
  await page.getByTestId('thaid-submit').click();
}

/** กรอก OTP ใน otp-step แล้วกด otp-submit (ไม่รอผล) */
export async function uiSubmitOtp(page: Page, otp: string): Promise<void> {
  await page.getByTestId('otp-input').fill(otp);
  await page.getByTestId('otp-submit').click();
}

/** LOGIN_C ผ่านหน้า /login → รอไป /citizen หรือ /register */
export async function uiLoginCitizen(page: Page, idNo: string = ID.SOMCHAI): Promise<void> {
  await uiThaidStart(page, idNo);
  await expect(page.getByTestId('otp-step')).toBeVisible();
  await uiSubmitOtp(page, OTP_OK);
  await page.waitForURL((u) => u.pathname === '/citizen' || u.pathname === '/register');
}

/** กรอกแท็บเจ้าหน้าที่แล้วกด staff-submit (ไม่รอผล) */
export async function uiStaffSubmit(page: Page, username: string, password = PASSWORD): Promise<void> {
  await page.goto('/login');
  await page.getByTestId('login-tab-staff').click();
  await page.getByTestId('staff-username').fill(username);
  await page.getByTestId('staff-password').fill(password);
  await page.getByTestId('staff-submit').click();
}

/** LOGIN_S ผ่านแท็บเจ้าหน้าที่ → รอไปหน้าตั้งต้นของบทบาท */
export async function uiLoginStaff(page: Page, username: StaffUser, password = PASSWORD): Promise<void> {
  await uiStaffSubmit(page, username, password);
  await waitPath(page, STAFF[username].landing);
}

/** กด logout-btn → /login */
export async function uiLogout(page: Page): Promise<void> {
  await page.getByTestId('logout-btn').click();
  await waitPath(page, '/login');
}

export async function waitPath(page: Page, pathname: string): Promise<void> {
  await page.waitForURL((u) => u.pathname === pathname);
}

// ───────────────────────── ประชาชน: ร่าง ไฟล์ QR (API) ─────────────────────────

export async function createDraft(
  api: APIRequestContext,
  serviceId: ServiceId,
  opts: { qty?: number; areaSqm?: number } = {},
): Promise<{ draftId: string; fee: number }> {
  const data: Record<string, unknown> = { serviceId };
  if (serviceId === 'SV-01') data.qty = opts.qty ?? 1;
  if (serviceId === 'SV-03') data.areaSqm = opts.areaSqm ?? 100;
  const body = await expectApi(api.post('/api/drafts', { data }), 201);
  expect(body.draftId).toMatch(/^DR-\d{4}$/);
  return { draftId: body.draftId, fee: body.fee };
}

/** POST /api/drafts/:id/files (multipart: file, docKey) — คืน response ดิบ */
export async function uploadRaw(
  api: APIRequestContext,
  draft: string,
  docKey: string,
  file: string | FilePayload,
): Promise<APIResponse> {
  const f = typeof file === 'string' ? filePayload(file) : file;
  return api.post(`/api/drafts/${draft}/files`, { multipart: { file: f, docKey }, timeout: 60_000 });
}

export async function upload(api: APIRequestContext, draft: string, docKey: string, file: string | FilePayload): Promise<any> {
  return expectApi(uploadRaw(api, draft, docKey, file), 201);
}

export async function uploadRequiredDocs(api: APIRequestContext, draft: string, serviceId: ServiceId): Promise<void> {
  for (const [docKey, name] of REQUIRED_DOCS[serviceId]) await upload(api, draft, docKey, name);
}

/** POST /api/drafts/:id/payment → 201 { ref, amount, qrCreatedAt, qrExpiresAt } */
export async function createQr(api: APIRequestContext, draft: string): Promise<{ ref: string; amount: number; qrCreatedAt: string; qrExpiresAt: string }> {
  const body = await expectApi(api.post(`/api/drafts/${draft}/payment`), 201);
  expect(body.ref).toMatch(/^PP-\d{4}$/);
  return body;
}

export interface NewPaidOptions {
  /** ผู้ยื่น (ค่าเริ่มต้น สมชาย) */
  idNo?: string;
  service?: ServiceId;
  /** CLOCK(at) ก่อนเริ่ม */
  at?: string;
  qty?: number;
  areaSqm?: number;
  /** ใช้ context ที่ล็อกอินแล้ว (ไม่ล็อกอินใหม่) */
  api?: APIRequestContext;
}

export interface PendingDraft {
  api: APIRequestContext;
  draftId: string;
  fee: number;
  ref: string;
  amount: number;
  qrExpiresAt: string;
}

/** ร่าง + แนบไฟล์บังคับ + สร้าง QR (ยังไม่ชำระ) */
export async function newPending(o: NewPaidOptions = {}): Promise<PendingDraft> {
  if (o.at) await setClock(o.at);
  const api = o.api ?? (await loginCitizen(o.idNo ?? ID.SOMCHAI));
  const service = o.service ?? 'SV-01';
  const d = await createDraft(api, service, { qty: o.qty, areaSqm: o.areaSqm });
  await uploadRequiredDocs(api, d.draftId, service);
  const qr = await createQr(api, d.draftId);
  expect(qr.amount).toBe(d.fee);
  return { api, draftId: d.draftId, fee: d.fee, ref: qr.ref, amount: qr.amount, qrExpiresAt: qr.qrExpiresAt };
}

export interface PaidCase extends PendingDraft {
  caseNo: string;
  receiptNo: string;
}

/** NEW_PAID: CLOCK → LOGIN_C → ร่าง → ไฟล์บังคับ → QR → pay ครบยอด → GET /api/payments/<ref> ได้ caseNo */
export async function newPaid(o: NewPaidOptions = {}): Promise<PaidCase> {
  const p = await newPending(o);
  const paid = await pay(p.ref, p.amount);
  expect(paid.duplicate).toBe(false);
  const got = await expectApi(p.api.get(`/api/payments/${p.ref}`), 200);
  expect(got.status).toBe('PAID');
  expect(got.caseNo).toBe(paid.caseNo);
  return { ...p, caseNo: paid.caseNo, receiptNo: paid.receiptNo };
}

// ───────────────────────── API อ่าน/ทำรายการคำขอ ─────────────────────────

export async function getCase(api: APIRequestContext, no: string): Promise<any> {
  return expectApi(api.get(`/api/cases/${no}`), 200);
}

export async function myCases(api: APIRequestContext): Promise<any[]> {
  return (await expectApi(api.get('/api/cases'), 200)).items;
}

export async function myDrafts(api: APIRequestContext): Promise<any[]> {
  return (await expectApi(api.get('/api/drafts'), 200)).items;
}

export async function getPayment(api: APIRequestContext, ref: string): Promise<any> {
  return expectApi(api.get(`/api/payments/${ref}`), 200);
}

export const claimRaw = (api: APIRequestContext, no: string) => api.post(`/api/officer/cases/${no}/claim`);
export const returnRaw = (api: APIRequestContext, no: string, reason: string) => api.post(`/api/officer/cases/${no}/return`, { data: { reason } });
export const forwardRaw = (api: APIRequestContext, no: string, note?: string) =>
  api.post(`/api/officer/cases/${no}/forward`, { data: note === undefined ? {} : { note } });
export const approveRaw = (api: APIRequestContext, no: string) => api.post(`/api/cases/${no}/approve`);
export const rejectRaw = (api: APIRequestContext, no: string, reason: string) => api.post(`/api/cases/${no}/reject`, { data: { reason } });
export const issueRaw = (api: APIRequestContext, no: string) => api.post(`/api/officer/cases/${no}/issue`);
export const cancelRaw = (api: APIRequestContext, no: string) => api.post(`/api/cases/${no}/cancel`);
export const resubmitRaw = (api: APIRequestContext, no: string) => api.post(`/api/cases/${no}/resubmit`);

export async function claim(api: APIRequestContext, no: string): Promise<any> {
  return expectApi(claimRaw(api, no), 200);
}
export async function returnCase(api: APIRequestContext, no: string, reason = 'xxxxxxxxxx'): Promise<any> {
  const body = await expectApi(returnRaw(api, no, reason), 200);
  expect(body.status).toBe('NEED_FIX');
  return body;
}
export async function resubmit(api: APIRequestContext, no: string): Promise<any> {
  const body = await expectApi(resubmitRaw(api, no), 200);
  expect(body.status).toBe('IN_REVIEW');
  return body;
}

/** GET /api/officer/queue?filter=… → items */
export async function queueItems(api: APIRequestContext, filter: 'all' | 'unclaimed' | 'mine' = 'all'): Promise<any[]> {
  return (await expectApi(api.get(`/api/officer/queue?filter=${filter}`), 200)).items;
}

/** GET /api/notifications → items */
export async function notifications(api: APIRequestContext): Promise<any[]> {
  return (await expectApi(api.get('/api/notifications'), 200)).items;
}

/** ชุดแจ้งเตือนแบบเรียงแล้ว: ['EG-2569-000020:overdue', ...] */
export async function notificationKeys(api: APIRequestContext): Promise<string[]> {
  return (await notifications(api)).map((n) => `${n.caseNo}:${n.level}`).sort();
}

/** GET /api/audit?… (auditor) → items */
export async function auditItems(api: APIRequestContext, q: { actor?: string; event?: string; from?: string; to?: string } = {}): Promise<any[]> {
  const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined) as [string, string][]).toString();
  return (await expectApi(api.get(`/api/audit${qs ? `?${qs}` : ''}`), 200)).items;
}

// ───────────────────────── ตัวช่วยหน้าจอ ─────────────────────────

/** แถวที่มี data-testid + data-* ตรงค่า เช่น rowBy(page, 'queue-row', 'data-case-no', caseNo(28)) */
export function rowBy(scope: Page | Locator, testid: string, attr: string, value: string): Locator {
  return scope.locator(`[data-testid="${testid}"][${attr}="${value}"]`);
}
export const queueRow = (page: Page, no: string) => rowBy(page, 'queue-row', 'data-case-no', no);
export const fileItem = (page: Page, name: string) => rowBy(page, 'file-item', 'data-name', name);

/** อ่านค่า attribute ของทุก element ที่ตรง locator */
export async function attrs(loc: Locator, attr: string): Promise<(string | null)[]> {
  return loc.evaluateAll((els, a) => els.map((e) => e.getAttribute(a)), attr);
}

/** ข้อความ (trim) ของทุก element */
export async function texts(loc: Locator): Promise<string[]> {
  return (await loc.allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
}

/** ทำ action ที่น่าจะส่งข้อมูลขึ้นเซิร์ฟเวอร์ แล้วรอ response แรกที่ไม่ใช่ GET (ไม่เกิน timeout) + รอหน้าโหลด */
export async function withMutation(page: Page, action: () => Promise<unknown>, timeout = 8_000): Promise<void> {
  const waiter = page.waitForResponse((r) => r.request().method() !== 'GET', { timeout }).catch(() => null);
  await action();
  await waiter;
  await page.waitForLoadState('domcontentloaded').catch(() => {});
}

/** กรอกช่องแล้วออกจากช่อง (ให้ทั้ง input และ change ทำงาน) */
export async function fillField(loc: Locator, value: string): Promise<void> {
  await loc.fill(value);
  await loc.press('Tab').catch(() => {});
}

/** เปิด /citizen/new/:service ขั้น 1 กรอกจำนวน/พื้นที่ แล้วไปขั้น 2 แนบเอกสาร */
export async function uiWizardToUpload(page: Page, service: ServiceId, opts: { qty?: number; area?: number } = {}): Promise<void> {
  await page.goto(`/citizen/new/${service}`);
  await expect(page.getByTestId('wizard-step')).toHaveText('1/3 กรอกข้อมูล');
  if (service === 'SV-01') await fillField(page.getByTestId('qty-input'), String(opts.qty ?? 1));
  if (service === 'SV-03') await fillField(page.getByTestId('area-input'), String(opts.area ?? 100));
  await expect(page.getByTestId('to-upload-btn')).toBeEnabled();
  await page.getByTestId('to-upload-btn').click();
  await expect(page.getByTestId('wizard-step')).toHaveText('2/3 แนบเอกสาร');
}

/** แนบไฟล์ในช่อง upload-input-<docKey> (รอให้เซิร์ฟเวอร์ตอบ) */
export async function uiUpload(page: Page, docKey: string, file: string | FilePayload): Promise<void> {
  const payload = typeof file === 'string' ? fixturePath(file) : file;
  await withMutation(page, () => page.getByTestId(`upload-input-${docKey}`).setInputFiles(payload), 30_000);
}

/** กด file-remove-btn ในแถว file-item ที่ data-name ตรง */
export async function uiRemoveFile(page: Page, name: string): Promise<void> {
  const before = await page.getByTestId('file-item').count();
  await withMutation(page, () => fileItem(page, name).getByTestId('file-remove-btn').click());
  await expect(page.getByTestId('file-item')).toHaveCount(before - 1);
}

/** ตั้ง queue-filter (all / unclaimed / mine) */
export async function uiQueueFilter(page: Page, value: 'all' | 'unclaimed' | 'mine'): Promise<void> {
  await page.getByTestId('queue-filter').selectOption(value);
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await expect(page.getByTestId('queue-filter')).toHaveValue(value);
}
