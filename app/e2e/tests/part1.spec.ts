/**
 * part1.spec.ts · TEST-PLAN ชุด 1 (22 TC): AUTH FEE SUBMIT UPLOAD PAY QUEUE SLA NOTI
 *
 * - ทุก TC เริ่มด้วย reset() (POST /api/test/reset) แล้วล็อกอินใหม่ใน context ใหม่ทุกครั้งหลัง reset
 * - ค่าคาดหวังทุกตัวคัดจาก TEST-PLAN / TEST-DATA / CONTRACT (คิดจากกฎ ไม่ได้อ่านจากหน้าจอ)
 * - ส่วนที่เป็นสิทธิ์/บั๊ก (เช่น B08 รับเรื่องซ้อน) ยิง API ตรงเสมอ ไม่ตรวจแค่ปุ่มหาย
 */
import { test, expect, type Browser, type Page, type APIRequestContext } from '@playwright/test';
import {
  ID,
  MSG,
  STAFF,
  T0,
  OTP_BAD,
  OTP_OK,
  STATUS_TH,
  LEVEL_TH,
  type SlaLevel,
  type StaffUser,
  type PendingDraft,
  caseNo,
  receiptNo,
  ppRef,
  reset,
  setClock,
  cleanup,
  newApi,
  expectApi,
  bodyOf,
  pay,
  payRaw,
  loginCitizen,
  loginStaff,
  logout,
  newSession,
  citizenSession,
  staffSession,
  uiThaidStart,
  uiSubmitOtp,
  uiLoginCitizen,
  uiStaffSubmit,
  uiLogout,
  waitPath,
  createDraft,
  upload,
  uploadRaw,
  createQr,
  filePayload,
  newPending,
  newPaid,
  getCase,
  myCases,
  myDrafts,
  getPayment,
  claim,
  claimRaw,
  returnCase,
  resubmit,
  cancelRaw,
  queueItems,
  notificationKeys,
  auditItems,
  rowBy,
  queueRow,
  fileItem,
  attrs,
  texts,
  withMutation,
  fillField,
  uiWizardToUpload,
  uiUpload,
  uiRemoveFile,
  uiQueueFilter,
} from '../helpers';

test.afterEach(async () => {
  await cleanup();
});

/** ฿ + คั่นหลักพัน (CONTRACT 0.2) */
const baht = (n: number): string => `฿${n.toLocaleString('en-US')}`;
const tid = (p: Page, id: string) => p.getByTestId(id);

/** ตรวจ sla-due (ข้อความ + data-iso) */
async function expectDue(p: Page, text: string | null, iso: string): Promise<void> {
  const due = tid(p, 'sla-due');
  await expect(due).toHaveAttribute('data-iso', iso);
  if (text) await expect(due).toHaveText(text);
}

/** ตรวจ sla-level (ข้อความไทย + data-level) */
async function expectLevel(p: Page, level: SlaLevel): Promise<void> {
  const el = tid(p, 'sla-level');
  await expect(el).toHaveText(LEVEL_TH[level]);
  await expect(el).toHaveAttribute('data-level', level);
}

/** ตรวจ case-status (ข้อความไทย + data-status) */
async function expectStatus(p: Page, status: keyof typeof STATUS_TH): Promise<void> {
  const el = tid(p, 'case-status');
  await expect(el).toHaveText(STATUS_TH[status]);
  await expect(el).toHaveAttribute('data-status', status);
}

/** ลำดับ data-case-no ของแถวคิวบนจอ */
async function queueOrder(p: Page): Promise<string[]> {
  return (await attrs(tid(p, 'queue-row'), 'data-case-no')) as string[];
}

/** แถวคิวที่มี claim-btn */
async function claimableRows(p: Page): Promise<string[]> {
  return tid(p, 'queue-row').evaluateAll((els) =>
    els.filter((e) => e.querySelector('[data-testid="claim-btn"]')).map((e) => e.getAttribute('data-case-no') ?? ''),
  );
}

/** ชุดแจ้งเตือนบนหน้า /notifications: ['EG-…:near', …] เรียงแล้ว */
async function uiNotiKeys(p: Page): Promise<string[]> {
  return tid(p, 'noti-item').evaluateAll((els) =>
    els.map((e) => `${e.getAttribute('data-case-no')}:${e.getAttribute('data-level')}`).sort(),
  );
}

const keys = (pairs: Array<[number, 'near' | 'overdue']>): string[] => pairs.map(([n, l]) => `${caseNo(n)}:${l}`).sort();

/** กรองชุดแจ้งเตือนเฉพาะคำขอเดียว */
const only = (all: string[], n: number): string[] => all.filter((k) => k.startsWith(`${caseNo(n)}:`));

/** อ่าน workload-count บน /officer/queue */
async function expectWorkload(p: Page, n: number): Promise<void> {
  await p.goto('/officer/queue');
  await expect(tid(p, 'workload-count')).toHaveText(String(n));
}

// ═══════════════════════════════════ AUTH ═══════════════════════════════════

test('TC-AUTH-01 เลขบัตร 13 หลัก + checksum', async ({ browser }) => {
  await reset();
  const { page: p } = await newSession(browser);
  const api = await newApi();

  const invalid = ['110170012345', '11017001234567', ID.BAD_CHECKSUM, '11017001234ab'];
  for (const v of invalid) {
    await test.step(`ปฏิเสธ ${v}`, async () => {
      await p.goto('/login');
      await tid(p, 'login-tab-citizen').click();
      await tid(p, 'thaid-id-input').fill(v);
      await expect(tid(p, 'thaid-id-input')).toHaveValue(v); // ไม่จำกัด maxlength (A-45)
      await tid(p, 'thaid-submit').click();
      await expect(tid(p, 'thaid-error')).toHaveText(MSG.INVALID_ID);
      await expect(tid(p, 'otp-step')).toBeHidden();
      await expectApi(api.post('/api/auth/thaid/start', { data: { idNo: v } }), 400, 'INVALID_ID');
    });
  }

  const valid = [ID.SOMCHAI, ID.SOMYING, ID.PITI, ID.MANA];
  for (const v of valid) {
    await test.step(`รับ ${v}`, async () => {
      await p.goto('/login');
      await tid(p, 'login-tab-citizen').click();
      await tid(p, 'thaid-id-input').fill(v);
      await expect(tid(p, 'thaid-submit')).toHaveText('เข้าสู่ระบบด้วย ThaiD (จำลอง)');
      await tid(p, 'thaid-submit').click();
      await expect(tid(p, 'otp-step')).toBeVisible();
      await expect(tid(p, 'thaid-error')).toBeHidden();
      const body = await expectApi(api.post('/api/auth/thaid/start', { data: { idNo: v } }), 200);
      expect(body).toMatchObject({ status: 'OTP_SENT' });
    });
  }
});

test('TC-AUTH-02 OTP ผิด 3 ครั้งล็อก 15 นาที', async ({ browser }) => {
  test.setTimeout(300_000);
  const LOCK_UNTIL = '2026-12-01T09:15:00+07:00';

  /** กรอก OTP บนหน้า: ถ้าช่อง OTP ไม่แสดง (เช่น หลังล็อก) ให้เริ่มใหม่ด้วยเลขบัตร */
  async function uiTryOtp(p: Page, idNo: string, otp: string): Promise<void> {
    if (!(await tid(p, 'otp-input').isVisible())) {
      await uiThaidStart(p, idNo);
      await expect(tid(p, 'otp-step').or(tid(p, 'lock-message')).first()).toBeVisible();
    }
    const input = tid(p, 'otp-input');
    if ((await input.isVisible()) && (await input.isEnabled())) await uiSubmitOtp(p, otp);
  }

  await test.step('หน้าจอ: ขั้น 1–8', async () => {
    await reset();
    const { page: p } = await newSession(browser);
    await uiThaidStart(p, ID.PITI);
    await expect(tid(p, 'otp-step')).toBeVisible();
    // 1
    await uiSubmitOtp(p, OTP_BAD);
    await expect(tid(p, 'otp-error')).toHaveText(MSG.OTP_INVALID);
    await expect(tid(p, 'otp-attempts-left')).toHaveText('เหลือ 2 ครั้ง');
    // 2
    await uiTryOtp(p, ID.PITI, OTP_BAD);
    await expect(tid(p, 'otp-attempts-left')).toHaveText('เหลือ 1 ครั้ง');
    // 3
    await uiTryOtp(p, ID.PITI, OTP_BAD);
    await expect(tid(p, 'lock-message')).toHaveText(MSG.LOCKED);
    await expect(tid(p, 'lock-until')).toHaveAttribute('data-iso', LOCK_UNTIL);
    // 4 OTP ถูกทันที → ยังล็อก
    await uiTryOtp(p, ID.PITI, OTP_OK);
    await expect(tid(p, 'lock-message')).toHaveText(MSG.LOCKED);
    expect(new URL(p.url()).pathname).toBe('/login');
    // 5 สมชายล็อกอินได้ (ล็อกเฉพาะเลขบัตรที่ผิด)
    const other = await newSession(browser);
    await uiLoginCitizen(other.page, ID.SOMCHAI);
    await waitPath(other.page, '/citizen');
    // 6 ผ่านไป 14:59 → ยังล็อก
    await setClock('2026-12-01T09:14:59+07:00');
    await uiThaidStart(p, ID.PITI);
    await uiTryOtp(p, ID.PITI, OTP_OK);
    await expect(tid(p, 'lock-message')).toHaveText(MSG.LOCKED);
    expect(new URL(p.url()).pathname).toBe('/login');
    // 7 ครบ 15:00 → ปลดล็อก ตัวนับเริ่มใหม่
    await setClock(LOCK_UNTIL);
    await uiThaidStart(p, ID.PITI);
    await expect(tid(p, 'otp-step')).toBeVisible();
    await expect(tid(p, 'lock-message')).toBeHidden();
    await uiSubmitOtp(p, OTP_BAD);
    await expect(tid(p, 'otp-error')).toHaveText(MSG.OTP_INVALID);
    await expect(tid(p, 'otp-attempts-left')).toHaveText('เหลือ 2 ครั้ง');
    // 8
    await uiTryOtp(p, ID.PITI, OTP_OK);
    await waitPath(p, '/citizen');
  });

  await test.step('API: ขั้น 1–8 (RESET)', async () => {
    await reset();
    const api = await newApi();
    await expectApi(api.post('/api/auth/thaid/start', { data: { idNo: ID.PITI } }), 200);
    const verify = (otp: string) => api.post('/api/auth/thaid/verify', { data: { idNo: ID.PITI, otp } });
    let b = await expectApi(verify(OTP_BAD), 401, 'OTP_INVALID');
    expect(b.attemptsLeft).toBe(2);
    expect(b.message).toBe(MSG.OTP_INVALID);
    b = await expectApi(verify(OTP_BAD), 401, 'OTP_INVALID');
    expect(b.attemptsLeft).toBe(1);
    b = await expectApi(verify(OTP_BAD), 423, 'LOCKED');
    expect(b.lockedUntil).toBe(LOCK_UNTIL);
    expect(b.message).toBe(MSG.LOCKED);
    await expectApi(verify(OTP_OK), 423, 'LOCKED');
    await loginCitizen(ID.SOMCHAI); // 5
    await setClock('2026-12-01T09:14:59+07:00');
    await expectApi(verify(OTP_OK), 423, 'LOCKED'); // 6
    await setClock(LOCK_UNTIL);
    await expectApi(api.post('/api/auth/thaid/start', { data: { idNo: ID.PITI } }), 200);
    b = await expectApi(verify(OTP_BAD), 401, 'OTP_INVALID'); // 7
    expect(b.attemptsLeft).toBe(2);
    b = await expectApi(verify(OTP_OK), 200); // 8
    expect(b.registered).toBe(true);
  });

  await test.step('ขั้น 9 (RESET): OTP ถูกรีเซ็ตตัวนับ — API', async () => {
    await reset();
    const api = await newApi();
    const start = () => expectApi(api.post('/api/auth/thaid/start', { data: { idNo: ID.PITI } }), 200);
    const verify = (otp: string) => api.post('/api/auth/thaid/verify', { data: { idNo: ID.PITI, otp } });
    await start();
    expect((await expectApi(verify(OTP_BAD), 401, 'OTP_INVALID')).attemptsLeft).toBe(2);
    expect((await expectApi(verify(OTP_BAD), 401, 'OTP_INVALID')).attemptsLeft).toBe(1);
    await expectApi(verify(OTP_OK), 200);
    await logout(api);
    await start();
    expect((await expectApi(verify(OTP_BAD), 401, 'OTP_INVALID')).attemptsLeft).toBe(2);
    expect((await expectApi(verify(OTP_BAD), 401, 'OTP_INVALID')).attemptsLeft).toBe(1);
  });

  await test.step('ขั้น 9 (RESET): OTP ถูกรีเซ็ตตัวนับ — หน้าจอ', async () => {
    await reset();
    const { page: p } = await newSession(browser);
    await uiThaidStart(p, ID.PITI);
    await uiSubmitOtp(p, OTP_BAD);
    await expect(tid(p, 'otp-attempts-left')).toHaveText('เหลือ 2 ครั้ง');
    await uiTryOtp(p, ID.PITI, OTP_BAD);
    await expect(tid(p, 'otp-attempts-left')).toHaveText('เหลือ 1 ครั้ง');
    await uiTryOtp(p, ID.PITI, OTP_OK);
    await waitPath(p, '/citizen');
    await uiLogout(p);
    await uiThaidStart(p, ID.PITI);
    await uiSubmitOtp(p, OTP_BAD);
    await expect(tid(p, 'otp-attempts-left')).toHaveText('เหลือ 2 ครั้ง');
    await uiTryOtp(p, ID.PITI, OTP_BAD);
    await expect(tid(p, 'otp-attempts-left')).toHaveText('เหลือ 1 ครั้ง');
    await expect(tid(p, 'lock-message')).toBeHidden();
  });
});

test('TC-AUTH-03 ลงทะเบียนครั้งแรก', async ({ browser }) => {
  await reset();
  const { page: p } = await newSession(browser);
  await uiLoginCitizen(p, ID.MANA);
  await waitPath(p, '/register');

  // 1 ชื่อจาก ThaiD แก้ไม่ได้
  const name = tid(p, 'reg-name');
  await expect(name).toHaveValue('มานะ ตั้งใจ');
  expect(await name.evaluate((e) => (e as HTMLInputElement).readOnly)).toBe(true);
  await name.click();
  await p.keyboard.type('abc');
  await expect(name).toHaveValue('มานะ ตั้งใจ');

  async function submitReg(mobile: string, consent: boolean): Promise<void> {
    await p.goto('/register');
    await tid(p, 'reg-mobile').fill(mobile);
    await tid(p, 'reg-email').fill('');
    await tid(p, 'reg-consent').setChecked(consent);
    await expect(tid(p, 'reg-submit')).toHaveText('ลงทะเบียน');
    await tid(p, 'reg-submit').click();
  }

  // 2–4 เบอร์ผิดรูปแบบ
  for (const mobile of ['081234567', '08123456789', '1812345678', '08123abcde']) {
    await test.step(`เบอร์ ${mobile}`, async () => {
      await submitReg(mobile, true);
      await expect(tid(p, 'reg-error-mobile')).toHaveText(MSG.INVALID_MOBILE);
      expect(new URL(p.url()).pathname).toBe('/register');
    });
  }
  // 5 ไม่ติ๊กยินยอม
  await submitReg('0845678901', false);
  await expect(tid(p, 'reg-error-consent')).toHaveText(MSG.CONSENT_REQUIRED);
  expect(new URL(p.url()).pathname).toBe('/register');
  // 6 ถูกต้อง อีเมลว่าง
  await submitReg('0845678901', true);
  await waitPath(p, '/citizen');
  await expect(tid(p, 'citizen-welcome')).toHaveText('สวัสดี มานะ ตั้งใจ');
  // 7 ออกแล้วเข้าใหม่ → /citizen ตรง ๆ
  await uiLogout(p);
  await uiLoginCitizen(p, ID.MANA);
  await waitPath(p, '/citizen');

  // 8 API (RESET)
  await reset();
  const api = await newApi();
  await expectApi(api.post('/api/auth/thaid/start', { data: { idNo: ID.MANA } }), 200);
  const v = await expectApi(api.post('/api/auth/thaid/verify', { data: { idNo: ID.MANA, otp: OTP_OK } }), 200);
  expect(v.registered).toBe(false);
  const b1 = await expectApi(
    api.post('/api/auth/register', { data: { mobile: '081234567', email: '', consent: true } }),
    400,
    'INVALID_MOBILE',
  );
  expect(b1.message).toBe(MSG.INVALID_MOBILE);
  const b2 = await expectApi(
    api.post('/api/auth/register', { data: { mobile: '0845678901', email: '', consent: false } }),
    400,
    'CONSENT_REQUIRED',
  );
  expect(b2.message).toBe(MSG.CONSENT_REQUIRED);
});

test('TC-AUTH-04 เจ้าหน้าที่ SSO จำลองและหน้าตั้งต้นตามบทบาท', async ({ browser }) => {
  await reset();
  const { page: p } = await newSession(browser);

  for (const [username, info] of Object.entries(STAFF) as Array<[StaffUser, (typeof STAFF)[StaffUser]]>) {
    await test.step(username, async () => {
      await p.goto('/login');
      await tid(p, 'login-tab-staff').click();
      await expect(tid(p, 'staff-submit')).toHaveText('เข้าสู่ระบบเจ้าหน้าที่ (SSO ภาครัฐ จำลอง)');
      await tid(p, 'staff-username').fill(username);
      await tid(p, 'staff-password').fill('Test@1234');
      await tid(p, 'staff-submit').click();
      await waitPath(p, info.landing);
      await expect(tid(p, 'user-name')).toHaveText(info.name);
      const role = tid(p, 'user-role');
      await expect(role).toHaveText(info.roleText);
      await expect(role).toHaveAttribute('data-role', info.role);
      if (info.dept) await expect(role).toHaveAttribute('data-dept', info.dept);
      await uiLogout(p);
    });
  }

  await test.step('API: role / dept / landing', async () => {
    for (const [username, info] of Object.entries(STAFF) as Array<[StaffUser, (typeof STAFF)[StaffUser]]>) {
      const api = await newApi();
      const b = await expectApi(api.post('/api/auth/staff/login', { data: { username, password: 'Test@1234' } }), 200);
      expect(b.role).toBe(info.role);
      expect(b.landing).toBe(info.landing);
      if (info.dept) expect(b.dept).toBe(info.dept);
    }
  });

  for (const [username, password] of [
    ['off.reg1', 'wrong'],
    ['nobody', 'Test@1234'],
    [ID.SOMCHAI, 'Test@1234'],
  ]) {
    await test.step(`ล็อกอินไม่ได้: ${username} / ${password}`, async () => {
      await uiStaffSubmit(p, username, password);
      await expect(tid(p, 'staff-error')).toHaveText(MSG.INVALID_CREDENTIALS);
      expect(new URL(p.url()).pathname).toBe('/login');
      const api = await newApi();
      const b = await expectApi(api.post('/api/auth/staff/login', { data: { username, password } }), 401, 'INVALID_CREDENTIALS');
      expect(b.message).toBe(MSG.INVALID_CREDENTIALS);
    });
  }

  await test.step('หลังออกจากระบบเปิด /officer/queue → /login', async () => {
    await p.goto('/officer/queue');
    await waitPath(p, '/login');
  });
});

// ═══════════════════════════════════ FEE ═══════════════════════════════════

test('TC-FEE-01 ค่าธรรมเนียม SV-01 / SV-02 / SV-03', async ({ browser }) => {
  await reset();
  const { page: p, api } = await citizenSession(browser, ID.SOMCHAI);

  type Row = { v: number; fee?: number; err?: string; code?: string };
  async function check(input: 'area-input' | 'qty-input', r: Row): Promise<void> {
    await fillField(tid(p, input), String(r.v));
    if (r.fee !== undefined) {
      await expect(tid(p, 'fee-total')).toHaveText(baht(r.fee));
      await expect(tid(p, 'fee-error')).toBeHidden();
      await expect(tid(p, 'to-upload-btn')).toBeEnabled();
    } else {
      await expect(tid(p, 'fee-total')).toHaveText('–');
      await expect(tid(p, 'fee-error')).toHaveText(r.err!);
      await expect(tid(p, 'to-upload-btn')).toBeDisabled();
    }
  }
  async function checkApi(data: Record<string, unknown>, r: Row): Promise<void> {
    if (r.fee !== undefined) {
      const b = await expectApi(api.post('/api/drafts', { data }), 201);
      expect(b.fee).toBe(r.fee);
    } else {
      const b = await expectApi(api.post('/api/drafts', { data }), 400, r.code);
      expect(b.message).toBe(r.err);
    }
  }

  // SV-03: 1–100 = ฿1,000 · 101–500 = 1,000 + 10 × (พื้นที่ − 100)
  const sv03: Row[] = [
    { v: 0, err: MSG.INVALID_AREA, code: 'INVALID_AREA' },
    { v: -1, err: MSG.INVALID_AREA, code: 'INVALID_AREA' },
    { v: 1, fee: 1000 },
    { v: 100, fee: 1000 },
    { v: 101, fee: 1010 },
    { v: 102, fee: 1020 },
    { v: 250, fee: 2500 },
    { v: 300, fee: 3000 },
    { v: 499, fee: 4990 },
    { v: 500, fee: 5000 },
    { v: 501, err: MSG.AREA_TOO_LARGE, code: 'AREA_TOO_LARGE' },
  ];
  await p.goto('/citizen/new/SV-03');
  for (const r of sv03) {
    await test.step(`SV-03 พื้นที่ ${r.v}`, async () => {
      await check('area-input', r);
      await checkApi({ serviceId: 'SV-03', areaSqm: r.v }, r);
    });
  }

  // SV-01: ฿20 ต่อฉบับ 1–5
  const sv01: Row[] = [
    { v: 0, err: MSG.INVALID_QTY, code: 'INVALID_QTY' },
    { v: 1, fee: 20 },
    { v: 2, fee: 40 },
    { v: 3, fee: 60 },
    { v: 4, fee: 80 },
    { v: 5, fee: 100 },
    { v: 6, err: MSG.INVALID_QTY, code: 'INVALID_QTY' },
  ];
  await p.goto('/citizen/new/SV-01');
  for (const r of sv01) {
    await test.step(`SV-01 จำนวน ${r.v}`, async () => {
      await check('qty-input', r);
      await checkApi({ serviceId: 'SV-01', qty: r.v }, r);
    });
  }

  await test.step('SV-02 ไม่มีช่องกรอก ฿500', async () => {
    await p.goto('/citizen/new/SV-02');
    await expect(tid(p, 'fee-total')).toHaveText('฿500');
    await expect(tid(p, 'qty-input')).toHaveCount(0);
    await expect(tid(p, 'area-input')).toHaveCount(0);
    const b = await expectApi(api.post('/api/drafts', { data: { serviceId: 'SV-02' } }), 201);
    expect(b.fee).toBe(500);
  });
});

// ═══════════════════════════════════ SUBMIT ═══════════════════════════════════

test('TC-SUBMIT-01 ยื่นคำขอ SV-01 ครบวงจร', async ({ browser }) => {
  await reset();
  const { page: p } = await citizenSession(browser, ID.SOMCHAI);
  const NO = caseNo(31);

  await test.step('1 กรอกข้อมูล', async () => {
    await p.goto('/citizen');
    await tid(p, 'start-service-SV-01').click();
    await waitPath(p, '/citizen/new/SV-01');
    await expect(tid(p, 'wizard-step')).toHaveText('1/3 กรอกข้อมูล');
    await fillField(tid(p, 'qty-input'), '2');
    await expect(tid(p, 'fee-total')).toHaveText('฿40');
    await tid(p, 'to-upload-btn').click();
  });

  await test.step('2 แนบเอกสาร', async () => {
    await expect(tid(p, 'wizard-step')).toHaveText('2/3 แนบเอกสาร');
    await expect(tid(p, 'to-payment-btn')).toBeDisabled();
    await uiUpload(p, 'id-card', 'id-card.pdf');
    await expect(tid(p, 'file-item')).toHaveCount(1);
    await expect(tid(p, 'file-item')).toHaveAttribute('data-doc-key', 'id-card');
    await expect(tid(p, 'to-payment-btn')).toBeEnabled();
    await tid(p, 'to-payment-btn').click();
  });

  await test.step('3 ชำระเงิน สร้าง QR', async () => {
    await expect(tid(p, 'wizard-step')).toHaveText('3/3 ชำระเงิน');
    await expect(tid(p, 'payment-amount')).toHaveText('฿40');
    await tid(p, 'create-qr-btn').click();
    await expect(tid(p, 'qr-ref')).toHaveText('PP-0002');
    await expect(tid(p, 'qr-expires')).toHaveAttribute('data-iso', '2026-12-01T09:15:00+07:00');
    await expect(tid(p, 'payment-status')).toHaveText('รอชำระ');
  });

  await test.step('4 ชำระ (callback) แล้วตรวจสอบการชำระเงิน', async () => {
    const b = await expectApi(payRaw('PP-0002', 40), 200);
    expect(b).toMatchObject({ status: 'PAID', caseNo: NO, receiptNo: receiptNo(31), duplicate: false });
    await tid(p, 'refresh-payment-btn').click();
    await expect(tid(p, 'payment-status')).toHaveText('ชำระแล้ว');
    await expect(tid(p, 'payment-status')).toHaveAttribute('data-status', 'PAID');
    await expect(tid(p, 'submitted-case-no')).toHaveText(NO);
    await expect(tid(p, 'receipt-no')).toHaveText(receiptNo(31));
    await expect(tid(p, 'receipt-amount')).toHaveText('฿40');
    await expect(tid(p, 'receipt-paid-at')).toHaveAttribute('data-iso', T0);
  });

  await test.step('5 หน้าคำขอ', async () => {
    await tid(p, 'go-case-btn').click();
    await waitPath(p, `/citizen/cases/${NO}`);
    await expectStatus(p, 'SUBMITTED');
    await expect(tid(p, 'case-fee')).toHaveText('฿40');
    await expectDue(p, '4 ธ.ค. 2569 16:30', '2026-12-04T16:30:00+07:00');
    await expectLevel(p, 'normal');
    await expect(tid(p, 'cancel-case-btn')).toHaveCount(1);
    await expect(tid(p, 'case-step')).toHaveCount(0);
  });

  await test.step('คิว off.reg1: แถวใหม่ท้ายกลุ่ม 4 ธ.ค.', async () => {
    const o = await staffSession(browser, 'off.reg1');
    await o.page.goto('/officer/queue');
    const row = queueRow(o.page, NO);
    await expect(row).toHaveCount(1);
    await expect(row.getByTestId('row-owner')).toHaveText('');
    await expect(row.getByTestId('claim-btn')).toHaveCount(1);
    const order = await queueOrder(o.page);
    const i = order.indexOf(NO);
    expect(order[i - 1]).toBe(caseNo(30));
    expect(order[i + 1]).toBe(caseNo(16));
  });
});

test('TC-SUBMIT-02 เอกสารบังคับครบก่อนชำระ', async ({ browser }) => {
  await reset();
  const { page: p, api } = await citizenSession(browser, ID.SOMCHAI);
  const payBtn = tid(p, 'to-payment-btn');
  const missing = tid(p, 'missing-docs');

  await test.step('SV-02', async () => {
    await uiWizardToUpload(p, 'SV-02');
    await uiUpload(p, 'id-card', 'id-card.pdf');
    await expect(tid(p, 'file-item')).toHaveCount(1);
    await expect(payBtn).toBeDisabled();
    await expect(missing).toHaveText('ยังขาดเอกสาร: แผนที่ตั้ง');

    await uiUpload(p, 'map', 'map.pdf');
    await expect(tid(p, 'file-item')).toHaveCount(2);
    await expect(payBtn).toBeEnabled();
    await expect(missing).toBeHidden(); // ภาพสถานที่ไม่บังคับ

    await uiRemoveFile(p, 'map.pdf');
    await expect(payBtn).toBeDisabled();
    await expect(missing).toHaveText('ยังขาดเอกสาร: แผนที่ตั้ง');
  });

  await test.step('SV-03 พื้นที่ 100', async () => {
    await uiWizardToUpload(p, 'SV-03', { area: 100 });
    await uiUpload(p, 'id-card', 'id-card.pdf');
    await expect(payBtn).toBeDisabled();
    await expect(missing).toHaveText('ยังขาดเอกสาร: แบบแปลน, โฉนด');

    await uiUpload(p, 'deed', 'deed.pdf');
    await expect(tid(p, 'file-item')).toHaveCount(2);
    await expect(payBtn).toBeDisabled();
    await expect(missing).toHaveText('ยังขาดเอกสาร: แบบแปลน');

    await uiUpload(p, 'plan', 'plan-as-jpg.jpg');
    await expect(tid(p, 'upload-error')).toHaveText(MSG.PLAN_NOT_PDF);
    await expect(tid(p, 'file-item')).toHaveCount(2);
    await expect(payBtn).toBeDisabled();
    await expect(missing).toHaveText('ยังขาดเอกสาร: แบบแปลน');

    await uiUpload(p, 'plan', 'plan.pdf');
    await expect(tid(p, 'file-item')).toHaveCount(3);
    await expect(payBtn).toBeEnabled();
    await expect(missing).toBeHidden();
  });

  await test.step('API: 409 MISSING_DOCS แล้วครบ → 201', async () => {
    const sv02 = await createDraft(api, 'SV-02');
    await upload(api, sv02.draftId, 'id-card', 'id-card.pdf');
    const m2 = await expectApi(api.post(`/api/drafts/${sv02.draftId}/payment`), 409, 'MISSING_DOCS');
    expect(m2.missing).toEqual(['แผนที่ตั้ง']);

    const d = await createDraft(api, 'SV-03', { areaSqm: 100 });
    const m0 = await expectApi(api.post(`/api/drafts/${d.draftId}/payment`), 409, 'MISSING_DOCS');
    expect(m0.missing).toEqual(['บัตรประชาชน', 'แบบแปลน', 'โฉนด']);
    await upload(api, d.draftId, 'id-card', 'id-card.pdf');
    await upload(api, d.draftId, 'deed', 'deed.pdf');
    const m1 = await expectApi(api.post(`/api/drafts/${d.draftId}/payment`), 409, 'MISSING_DOCS');
    expect(m1.missing).toEqual(['แบบแปลน']);
    const bad = await expectApi(uploadRaw(api, d.draftId, 'plan', 'plan-as-jpg.jpg'), 400, 'PLAN_NOT_PDF');
    expect(bad.message).toBe(MSG.PLAN_NOT_PDF);
    await upload(api, d.draftId, 'plan', 'plan.pdf');
    const qr = await createQr(api, d.draftId);
    expect(qr.amount).toBe(1000);
  });
});

test('TC-SUBMIT-03 ร่าง การลบร่าง และการยกเลิก', async ({ browser }) => {
  test.setTimeout(300_000);
  const S03 = caseNo(30);

  await test.step('ส่วน A ร่าง', async () => {
    await reset();
    const { page: p, api } = await citizenSession(browser, ID.SOMCHAI);
    await p.goto('/citizen');
    await expect(tid(p, 'my-case-row')).toHaveCount(10);
    await expect(tid(p, 'my-draft-row')).toHaveCount(2);
    await expect(rowBy(p, 'my-draft-row', 'data-draft-id', 'DR-0001')).toHaveAttribute('data-status', 'DRAFT');
    await expect(rowBy(p, 'my-draft-row', 'data-draft-id', 'DR-0002')).toHaveAttribute('data-status', 'PENDING_PAYMENT');
    for (const t of await texts(tid(p, 'my-draft-row'))) expect(t).not.toContain('EG-');

    await rowBy(p, 'my-draft-row', 'data-draft-id', 'DR-0001').getByTestId('open-draft-btn').click();
    await p.waitForURL((u) => u.pathname === '/citizen/new/SV-01' && u.searchParams.get('draft') === 'DR-0001');
    await expect(tid(p, 'qty-input')).toHaveValue('2');
    await expect(tid(p, 'fee-total')).toHaveText('฿40');

    await p.goto('/citizen/new/SV-01');
    await fillField(tid(p, 'qty-input'), '3');
    await expect(tid(p, 'fee-total')).toHaveText('฿60');
    await tid(p, 'save-draft-btn').click();
    await expect(tid(p, 'draft-id')).toHaveText('DR-0003');

    await p.goto('/citizen');
    await expect(tid(p, 'my-case-row')).toHaveCount(10);
    expect(await myCases(api)).toHaveLength(10);
    expect(await myDrafts(api)).toHaveLength(3);
  });

  await test.step('ส่วน B ยกเลิก (RESET)', async () => {
    await reset();
    const { page: p } = await citizenSession(browser, ID.SOMCHAI);
    await p.goto(`/citizen/cases/${S03}`);
    await expect(tid(p, 'cancel-case-btn')).toHaveCount(1);
    await tid(p, 'cancel-case-btn').click();
    await expect(tid(p, 'cancel-confirm-text')).toHaveText(MSG.NO_REFUND);
    await tid(p, 'confirm-cancel-btn').click();
    await expectStatus(p, 'CANCELLED');
    await expect(tid(p, 'no-refund-note')).toHaveText(MSG.NO_REFUND);
    await expect(tid(p, 'cancel-case-btn')).toHaveCount(0);

    const o = await staffSession(browser, 'off.reg1');
    await o.page.goto('/officer/queue');
    await expect(tid(o.page, 'queue-row')).toHaveCount(16);
    await expect(queueRow(o.page, S03)).toHaveCount(0);

    const e = await staffSession(browser, 'exec1');
    await e.page.goto('/dashboard');
    await expect(tid(e.page, 'kpi-backlog')).toHaveText('20');
    await expect(tid(e.page, 'kpi-received')).toHaveText('3');
  });

  await test.step('ส่วน C ยกเลิกไม่ได้เมื่อมีผู้รับ (RESET)', async () => {
    await reset();
    const reg1 = await loginStaff('off.reg1');
    await claim(reg1, S03);
    const { page: p, api } = await citizenSession(browser, ID.SOMCHAI);
    await p.goto(`/citizen/cases/${S03}`);
    await expectStatus(p, 'IN_REVIEW');
    await expect(tid(p, 'cancel-case-btn')).toHaveCount(0);
    const b = await expectApi(cancelRaw(api, S03), 409, 'CANNOT_CANCEL');
    expect(b.message).toBe(MSG.CANNOT_CANCEL);
    await expectApi(cancelRaw(api, caseNo(13)), 409, 'CANNOT_CANCEL');
    expect((await getCase(api, S03)).status).toBe('IN_REVIEW');
    expect((await getCase(api, caseNo(13))).status).toBe('IN_REVIEW');
  });

  await test.step('ส่วน E ลบร่าง (RESET)', async () => {
    await reset();
    const { page: p, api } = await citizenSession(browser, ID.SOMCHAI);
    await expectApi(api.delete('/api/drafts/DR-0001'), 204);
    await expectApi(api.get('/api/drafts/DR-0001'), 404, 'NOT_FOUND');
    await p.goto('/citizen');
    await expect(tid(p, 'my-draft-row')).toHaveCount(1);
    await expect(tid(p, 'my-draft-row')).toHaveAttribute('data-draft-id', 'DR-0002');
    await expectApi(api.delete('/api/drafts/DR-0002'), 204);
    await expectApi(api.get('/api/payments/PP-0001'), 404);
    await expectApi(payRaw('PP-0001', 500), 404);
    expect(await myCases(api)).toHaveLength(10);
  });

  await test.step('ส่วน F ยกเลิกชนกับรับเรื่อง (RESET · คนละ context)', async () => {
    await reset();
    const citizen = await loginCitizen(ID.SOMCHAI);
    const reg1 = await loginStaff('off.reg1');
    const [rc, rl] = await Promise.all([cancelRaw(citizen, S03), claimRaw(reg1, S03)]);
    const cs = rc.status();
    const ls = rl.status();
    const cb = await bodyOf(rc);
    const lb = await bodyOf(rl);
    expect([cs, ls].filter((s) => s === 200), `cancel=${cs} ${JSON.stringify(cb)} claim=${ls} ${JSON.stringify(lb)}`).toHaveLength(1);
    const c = await getCase(reg1, S03);
    const mine = await queueItems(reg1, 'mine');
    if (cs === 200) {
      expect(ls).toBe(409);
      expect(lb.code).toBe('INVALID_STATE');
      expect(c.status).toBe('CANCELLED');
      expect(c.owner || null).toBeNull();
      expect(mine).toHaveLength(3);
    } else {
      expect(ls).toBe(200);
      expect(cs).toBe(409);
      expect(cb.code).toBe('CANNOT_CANCEL');
      expect(c.status).toBe('IN_REVIEW');
      expect(c.owner).toBe('off.reg1');
      expect(mine).toHaveLength(4);
    }
  });
});

// ═══════════════════════════════════ UPLOAD ═══════════════════════════════════

test('TC-UPLOAD-01 ขนาดและจำนวนไฟล์', async ({ browser }) => {
  test.setTimeout(240_000);
  await reset();
  const { page: p, api } = await citizenSession(browser, ID.SOMCHAI);
  const items = tid(p, 'file-item');

  await test.step('ขนาด (หน้าจอ)', async () => {
    await uiWizardToUpload(p, 'SV-01', { qty: 1 });
    await uiUpload(p, 'id-card', 'size-5242879.pdf');
    await expect(items).toHaveCount(1);
    await uiRemoveFile(p, 'size-5242879.pdf');

    await uiUpload(p, 'id-card', 'size-5242880.pdf');
    await expect(items, 'size-5242880.pdf (5,242,880 ไบต์ = ขอบ ≤ 5 MB) ต้องถูกรับ: จำนวน file-item').toHaveCount(1); // B02
    await expect(tid(p, 'upload-error')).toBeHidden();
    await uiRemoveFile(p, 'size-5242880.pdf');

    await uiUpload(p, 'id-card', 'size-5242881.pdf');
    await expect(tid(p, 'upload-error')).toHaveText(MSG.FILE_TOO_LARGE);
    await expect(items).toHaveCount(0);
  });

  await test.step('ขนาด (API)', async () => {
    const d = await createDraft(api, 'SV-01', { qty: 1 });
    const a = await upload(api, d.draftId, 'id-card', 'size-5242879.pdf');
    expect(a.size).toBe(5242879);
    const b = await upload(api, d.draftId, 'extra', 'size-5242880.pdf');
    expect(b.size).toBe(5242880);
    const c = await expectApi(uploadRaw(api, d.draftId, 'extra', 'size-5242881.pdf'), 400, 'FILE_TOO_LARGE');
    expect(c.message).toBe(MSG.FILE_TOO_LARGE);
  });

  await test.step('จำนวน (หน้าจอ)', async () => {
    await uiWizardToUpload(p, 'SV-01', { qty: 1 });
    await uiUpload(p, 'id-card', 'id-card.pdf');
    await expect(items).toHaveCount(1);
    for (let i = 1; i <= 4; i++) {
      await uiUpload(p, 'extra', `multi-${i}.pdf`);
      await expect(items).toHaveCount(1 + i);
    }
    await expect(tid(p, 'upload-error')).toBeHidden();
    await uiUpload(p, 'extra', 'multi-5.pdf');
    await expect(tid(p, 'upload-error')).toHaveText(MSG.FILE_COUNT);
    await expect(items).toHaveCount(5);
    await expect(fileItem(p, 'multi-5.pdf')).toHaveCount(0);

    await uiRemoveFile(p, 'multi-4.pdf');
    await uiUpload(p, 'extra', 'multi-5.pdf');
    await expect(items).toHaveCount(5);
    await expect(fileItem(p, 'multi-5.pdf')).toHaveCount(1);
  });

  await test.step('จำนวน (API) 400 FILE_COUNT', async () => {
    const d = await createDraft(api, 'SV-01', { qty: 1 });
    await upload(api, d.draftId, 'id-card', 'id-card.pdf');
    for (let i = 1; i <= 4; i++) await upload(api, d.draftId, 'extra', `multi-${i}.pdf`);
    const b = await expectApi(uploadRaw(api, d.draftId, 'extra', 'multi-5.pdf'), 400, 'FILE_COUNT');
    expect(b.message).toBe(MSG.FILE_COUNT);
  });
});

test('TC-UPLOAD-02 ชนิดไฟล์จากเนื้อไฟล์', async ({ browser }) => {
  await reset();
  const { page: p, api } = await citizenSession(browser, ID.SOMCHAI);
  const items = tid(p, 'file-item');
  const rejected = [
    filePayload('fake-text.pdf'),
    filePayload('fake-text.jpg'),
    filePayload('exe-as.png'),
    filePayload('notes.txt'),
    filePayload('fake-text.pdf', 'application/pdf'), // ไม่เชื่อ Content-Type (A-49)
  ];

  await test.step('หน้าจอ', async () => {
    await uiWizardToUpload(p, 'SV-01', { qty: 1 });
    for (const name of ['ok-id.pdf', 'real.jpg', 'real.png']) {
      await uiUpload(p, 'id-card', name);
      await expect(items).toHaveCount(1);
      await expect(fileItem(p, name)).toHaveCount(1);
      await uiRemoveFile(p, name);
    }
    for (const f of rejected) {
      await uiUpload(p, 'id-card', f);
      await expect(tid(p, 'upload-error')).toHaveText(MSG.FILE_TYPE);
      await expect(items).toHaveCount(0);
    }
  });

  await test.step('API: รับ PDF JPG PNG', async () => {
    for (const name of ['ok-id.pdf', 'real.jpg', 'real.png']) {
      const d = await createDraft(api, 'SV-01', { qty: 1 });
      const b = await upload(api, d.draftId, 'id-card', name);
      expect(b.docKey).toBe('id-card');
      expect(b.size).toBe(1024);
    }
  });

  await test.step('API: ปฏิเสธ 400 FILE_TYPE และไม่ถูกเก็บ', async () => {
    const d = await createDraft(api, 'SV-01', { qty: 1 });
    const before = await expectApi(api.get(`/api/drafts/${d.draftId}`), 200);
    for (const f of rejected) {
      const b = await expectApi(uploadRaw(api, d.draftId, 'id-card', f), 400, 'FILE_TYPE');
      expect(b.message).toBe(MSG.FILE_TYPE);
    }
    const after = await expectApi(api.get(`/api/drafts/${d.draftId}`), 200);
    if (Array.isArray(before.files) || Array.isArray(after.files)) expect(after.files ?? []).toHaveLength((before.files ?? []).length);
    // ไฟล์ที่ถูกปฏิเสธไม่ถูกนับ: แนบไฟล์ถูกได้อีกครบ 5
    await upload(api, d.draftId, 'id-card', 'id-card.pdf');
    for (let i = 1; i <= 4; i++) await upload(api, d.draftId, 'extra', `multi-${i}.pdf`);
    await expectApi(api.post(`/api/drafts/${d.draftId}/payment`), 201);
  });
});

// ═══════════════════════════════════ PAY ═══════════════════════════════════

test('TC-PAY-01 อายุ QR 15:00', async ({ browser }) => {
  test.setTimeout(240_000);
  // PP-0001 ของ DR-0002 (SV-02 ฿500) สร้าง 08:55:00 · อายุ = เวลาชำระ − 08:55:00

  await test.step('รอบ 1 09:00:00 (อายุ 5:00) → 200', async () => {
    await reset();
    const api = await loginCitizen(ID.SOMCHAI);
    const b = await pay('PP-0001', 500);
    expect(b.caseNo).toBe(caseNo(31));
    expect((await getPayment(api, 'PP-0001')).status).toBe('PAID');
  });

  await test.step('รอบ 2 09:09:59 (อายุ 14:59) → 200', async () => {
    await reset();
    await setClock('2026-12-01T09:09:59+07:00');
    await loginCitizen(ID.SOMCHAI);
    const b = await pay('PP-0001', 500);
    expect(b.caseNo).toBe(caseNo(31));
  });

  await test.step('รอบ 3 09:10:00 (อายุ 15:00 พอดี) → 410', async () => {
    await reset();
    await setClock('2026-12-01T09:10:00+07:00');
    const { page: p, api } = await citizenSession(browser, ID.SOMCHAI);
    const b = await expectApi(payRaw('PP-0001', 500), 410, 'QR_EXPIRED');
    expect(b.message).toBe(MSG.QR_EXPIRED);
    expect((await getPayment(api, 'PP-0001')).status).toBe('EXPIRED');
    expect(await myCases(api)).toHaveLength(10);

    await p.goto('/citizen/new/SV-02?draft=DR-0002');
    await expect(tid(p, 'qr-expired-msg')).toHaveText(MSG.QR_EXPIRED);
    await expect(tid(p, 'payment-status')).toHaveText('QR หมดอายุ');
    await expect(tid(p, 'payment-status')).toHaveAttribute('data-status', 'EXPIRED');
    await expect(tid(p, 'regenerate-qr-btn')).toHaveCount(1);
    await tid(p, 'regenerate-qr-btn').click();
    await expect(tid(p, 'qr-ref')).toHaveText('PP-0002');
    await expect(tid(p, 'qr-expires')).toHaveAttribute('data-iso', '2026-12-01T09:25:00+07:00');
    const ok = await pay('PP-0002', 500);
    expect(ok.caseNo).toBe(caseNo(31));
  });

  await test.step('รอบ 4 09:10:01 (อายุ 15:01) → 410', async () => {
    await reset();
    await setClock('2026-12-01T09:10:01+07:00');
    const api = await loginCitizen(ID.SOMCHAI);
    await expectApi(payRaw('PP-0001', 500), 410, 'QR_EXPIRED');
    expect(await myCases(api)).toHaveLength(10);
  });
});

test('TC-PAY-02 ยอดเงินและ callback ซ้ำ', async () => {
  await reset();
  const d = await newPending({ idNo: ID.SOMCHAI, service: 'SV-01', qty: 1 });
  expect(d.ref).toBe('PP-0002');
  expect(d.amount).toBe(20);
  const api = d.api;

  // 1 ขาด ฿1
  const b1 = await expectApi(payRaw(d.ref, 19), 422, 'AMOUNT_MISMATCH');
  expect(b1.message).toBe(MSG.AMOUNT_MISMATCH);
  expect((await getPayment(api, d.ref)).status).toBe('PENDING');
  expect(await myCases(api)).toHaveLength(10);
  // 2 เกิน ฿1
  await expectApi(payRaw(d.ref, 21), 422, 'AMOUNT_MISMATCH');
  expect((await getPayment(api, d.ref)).status).toBe('PENDING');
  // 3 ครบยอด
  const b3 = await pay(d.ref, 20);
  expect(b3).toMatchObject({ status: 'PAID', caseNo: caseNo(31), receiptNo: receiptNo(31), duplicate: false });
  expect(await myCases(api)).toHaveLength(11);
  // 4 callback ซ้ำ ref เดิม → idempotent
  const b4 = await pay(d.ref, 20);
  expect(b4).toMatchObject({ status: 'PAID', caseNo: caseNo(31), receiptNo: receiptNo(31), duplicate: true });
  expect(await myCases(api)).toHaveLength(11);
  // 5 ใบถัดไปไม่มีเลขข้าม
  const next = await newPaid({ api, service: 'SV-01', qty: 1 });
  expect(next.caseNo).toBe(caseNo(32));
  expect(next.receiptNo).toBe(receiptNo(32));
});

test('TC-PAY-03 ชำระพร้อมกัน เลขไม่ซ้ำ', async () => {
  await reset();
  const somchai = await loginCitizen(ID.SOMCHAI);
  const somying = await loginCitizen(ID.SOMYING);
  const drafts: PendingDraft[] = [];
  for (const api of [somchai, somchai, somchai, somying, somying, somying]) {
    drafts.push(await newPending({ api, service: 'SV-01', qty: 1 }));
  }
  expect(drafts.map((d) => d.ref)).toEqual([2, 3, 4, 5, 6, 7].map(ppRef));

  const results = await Promise.all(drafts.map((d) => payRaw(d.ref, 20)));
  const bodies = await Promise.all(results.map((r) => bodyOf(r)));
  results.forEach((r, i) => expect(r.status(), JSON.stringify(bodies[i])).toBe(200));
  const caseNos = bodies.map((b) => b.caseNo);
  const receipts = bodies.map((b) => b.receiptNo);
  expect(new Set(caseNos).size).toBe(6);
  expect([...caseNos].sort()).toEqual([31, 32, 33, 34, 35, 36].map((n) => caseNo(n)));
  expect([...receipts].sort()).toEqual([31, 32, 33, 34, 35, 36].map((n) => receiptNo(n)));
  bodies.forEach((b, i) => expect(receipts[i].slice(3)).toBe(b.caseNo.slice(3))); // ใบเสร็จลำดับเดียวกับเลขคำขอ

  const mine = (await myCases(somchai)).map((c) => c.caseNo);
  const hers = (await myCases(somying)).map((c) => c.caseNo);
  expect(mine).toHaveLength(13);
  expect(hers).toHaveLength(14);
  for (let i = 0; i < 3; i++) expect(mine).toContain(caseNos[i]);
  for (let i = 3; i < 6; i++) expect(hers).toContain(caseNos[i]);
  for (let i = 0; i < 6; i++) {
    const owner = i < 3 ? somchai : somying;
    expect((await getPayment(owner, drafts[i].ref)).caseNo).toBe(caseNos[i]);
  }

  const next = await newPaid({ api: somchai, service: 'SV-01', qty: 1 });
  expect(next.caseNo).toBe(caseNo(37));
});

test('TC-PAY-04 เลขคำขอข้ามปี 2569 → 2570', async ({ browser }) => {
  await reset();
  await setClock('2026-12-31T23:58:00+07:00');
  const { page: p, api } = await citizenSession(browser, ID.SOMCHAI);

  // 1 สร้างร่าง SV-01 + QR ที่ 23:58 (ผ่านหน้าจอ)
  await uiWizardToUpload(p, 'SV-01', { qty: 1 });
  await uiUpload(p, 'id-card', 'id-card.pdf');
  await tid(p, 'to-payment-btn').click();
  await expect(tid(p, 'wizard-step')).toHaveText('3/3 ชำระเงิน');
  await tid(p, 'create-qr-btn').click();
  await expect(tid(p, 'qr-ref')).toHaveText(/^PP-\d{4}$/);
  const ref = (await tid(p, 'qr-ref').innerText()).trim();
  const pending = await getPayment(api, ref);
  expect(pending.status).toBe('PENDING');
  expect(pending.caseNo || null).toBeNull();

  // 2 ชำระ 23:59
  await setClock('2026-12-31T23:59:00+07:00');
  const b2 = await pay(ref, 20);
  expect(b2.caseNo).toBe(caseNo(31));
  expect(b2.receiptNo).toBe(receiptNo(31));
  await tid(p, 'refresh-payment-btn').click();
  await expect(tid(p, 'submitted-case-no')).toHaveText(caseNo(31));
  await expect(tid(p, 'receipt-paid-at')).toHaveAttribute('data-iso', '2026-12-31T23:59:00+07:00');

  // 3–4 ปีใหม่ 2570 เริ่ม 000001
  await setClock('2027-01-01T00:00:00+07:00');
  const c3 = await newPaid({ api, service: 'SV-01', qty: 1 });
  expect(c3.caseNo).toBe(caseNo(1, 2570));
  expect(c3.receiptNo).toBe(receiptNo(1, 2570));
  const c4 = await newPaid({ api, service: 'SV-01', qty: 1 });
  expect(c4.caseNo).toBe(caseNo(2, 2570));

  // 5 ใบเดิมไม่ถูกแก้
  const old = await getCase(api, caseNo(31));
  expect(old.caseNo).toBe(caseNo(31));
  expect(old.paidAt).toBe('2026-12-31T23:59:00+07:00');
});

// ═══════════════════════════════════ QUEUE ═══════════════════════════════════

const REGISTRY_ORDER = [20, 22, 24, 23, 25, 26, 13, 15, 27, 28, 29, 30, 16, 18, 19, 12, 21].map((n) => caseNo(n));

test('TC-QUEUE-01 ลำดับคิวและขอบเขตแผนก', async ({ browser }) => {
  await reset();

  await test.step('off.reg1 filter all', async () => {
    const { page: p, api } = await staffSession(browser, 'off.reg1');
    await p.goto('/officer/queue');
    await expect(tid(p, 'queue-filter')).toHaveValue('all');
    await expect(tid(p, 'queue-row')).toHaveCount(17);
    expect(await queueOrder(p)).toEqual(REGISTRY_ORDER);
    const levels = await texts(tid(p, 'row-sla-level'));
    expect(levels.slice(0, 3)).toEqual(['เกินกำหนด', 'ใกล้ครบกำหนด', 'ใกล้ครบกำหนด']);
    const masked = await texts(tid(p, 'row-id-masked'));
    expect(masked).toHaveLength(17);
    for (const m of masked) expect(m).toMatch(/^X-XXXX-XXXXX-\d{2}-\d$/);
    await expect(tid(p, 'claim-btn')).toHaveCount(4);
    expect(await claimableRows(p)).toEqual([24, 28, 29, 30].map((n) => caseNo(n)));
    await expect(tid(p, 'workload-count')).toHaveText('3');
    for (const n of [17, 11, 14, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) await expect(queueRow(p, caseNo(n))).toHaveCount(0);

    await uiQueueFilter(p, 'unclaimed');
    await expect(tid(p, 'queue-row')).toHaveCount(4);
    expect(await queueOrder(p)).toEqual([24, 28, 29, 30].map((n) => caseNo(n)));
    await uiQueueFilter(p, 'mine');
    await expect(tid(p, 'queue-row')).toHaveCount(3);
    expect(await queueOrder(p)).toEqual([20, 22, 23].map((n) => caseNo(n)));
    await expect(tid(p, 'workload-count')).toHaveText('3');

    expect((await queueItems(api, 'all')).map((i) => i.caseNo)).toEqual(REGISTRY_ORDER);
    expect((await queueItems(api, 'unclaimed')).map((i) => i.caseNo)).toEqual([24, 28, 29, 30].map((n) => caseNo(n)));
    expect((await queueItems(api, 'mine')).map((i) => i.caseNo)).toEqual([20, 22, 23].map((n) => caseNo(n)));
  });

  await test.step('off.reg2 filter mine', async () => {
    const { page: p, api } = await staffSession(browser, 'off.reg2');
    await p.goto('/officer/queue');
    await uiQueueFilter(p, 'mine');
    const mine = [25, 26, 13, 15, 27, 16, 18, 12, 21].map((n) => caseNo(n));
    await expect(tid(p, 'queue-row')).toHaveCount(9);
    expect(await queueOrder(p)).toEqual(mine);
    await expect(tid(p, 'workload-count')).toHaveText('9');
    expect((await queueItems(api, 'mine')).map((i) => i.caseNo)).toEqual(mine);
  });

  await test.step('off.works1 เห็นเฉพาะโยธา', async () => {
    const { page: p, api } = await staffSession(browser, 'off.works1');
    await p.goto('/officer/queue');
    await expect(tid(p, 'queue-row')).toHaveCount(1);
    expect(await queueOrder(p)).toEqual([caseNo(10)]);
    expect((await queueItems(api, 'all')).map((i) => i.caseNo)).toEqual([caseNo(10)]);
  });

  await test.step('head1 เห็นทุกแผนก อ่านอย่างเดียว', async () => {
    const { page: p, api } = await staffSession(browser, 'head1');
    await p.goto('/officer/queue');
    await expect(tid(p, 'queue-row')).toHaveCount(18);
    const order = await queueOrder(p);
    const i = order.indexOf(caseNo(10));
    expect(order.slice(i, i + 4)).toEqual([10, 23, 25, 26].map((n) => caseNo(n)));
    expect(order).toEqual([20, 22, 24, 10, 23, 25, 26, 13, 15, 27, 28, 29, 30, 16, 18, 19, 12, 21].map((n) => caseNo(n)));
    await expect(tid(p, 'claim-btn')).toHaveCount(0);
    expect(await queueItems(api, 'all')).toHaveLength(18);
  });
});

test('TC-QUEUE-02 รับเรื่องซ้อน (พร้อมกันและต่อกัน)', async ({ browser }) => {
  test.setTimeout(240_000);

  /** จำนวนแถว CLAIM ใน Audit ของคำขอ (ตรวจผ่าน audit1) */
  async function claimAuditCount(no: string): Promise<number> {
    const auditor = await loginStaff('audit1');
    return (await auditItems(auditor, { event: 'CLAIM' })).filter((a) => a.caseNo === no).length;
  }

  await test.step('ส่วน 1 พร้อมกัน (UI 2 context)', async () => {
    await reset();
    const NO = caseNo(28);
    const A = await staffSession(browser, 'off.reg1');
    const B = await staffSession(browser, 'off.reg2');
    await Promise.all([A.page.goto('/officer/queue'), B.page.goto('/officer/queue')]);
    const btnA = queueRow(A.page, NO).getByTestId('claim-btn');
    const btnB = queueRow(B.page, NO).getByTestId('claim-btn');
    await expect(btnA).toBeVisible();
    await expect(btnB).toBeVisible();

    await Promise.all([withMutation(A.page, () => btnA.click()), withMutation(B.page, () => btnB.click())]);

    // ผลบนจอของทั้งสองคนต้องเป็น สำเร็จ 1 + ALREADY_CLAIMED 1 (ตรวจเป็นค่า → B08 ล้มที่ค่า ไม่ใช่หา action-error ไม่เจอ)
    const outcome = async (p: Page): Promise<string> => {
      await expect(tid(p, 'action-error').or(tid(p, 'action-success'))).toBeVisible();
      return (await tid(p, 'action-error').count()) ? `error: ${(await tid(p, 'action-error').innerText()).trim()}` : 'success';
    };
    const outcomes = [await outcome(A.page), await outcome(B.page)].sort();
    expect(outcomes, 'กดรับเรื่องพร้อมกัน 2 คน: สำเร็จ 1 และได้ ALREADY_CLAIMED 1').toEqual([`error: ${MSG.ALREADY_CLAIMED}`, 'success']);

    const c = await getCase(A.api, NO);
    expect(['off.reg1', 'off.reg2']).toContain(c.owner);
    expect(c.status).toBe('IN_REVIEW');
    const [win, lose] = c.owner === 'off.reg1' ? [A, B] : [B, A];
    const winner = c.owner as StaffUser;
    await expect(tid(lose.page, 'action-error')).toHaveText(MSG.ALREADY_CLAIMED);
    await win.page.goto('/officer/queue');
    await expect(queueRow(win.page, NO)).toHaveAttribute('data-owner', winner);
    await expect(queueRow(win.page, NO).getByTestId('row-owner')).toHaveText(new RegExp(`${winner}|${STAFF[winner].name}`));
    expect(await claimAuditCount(NO)).toBe(1);
  });

  await test.step('ส่วน 2 พร้อมกัน 10 ครั้ง (API · RESET)', async () => {
    await reset();
    const NO = caseNo(29);
    const reg1 = await loginStaff('off.reg1');
    const reg2 = await loginStaff('off.reg2');
    const calls = [reg1, reg2, reg1, reg2, reg1, reg2, reg1, reg2, reg1, reg2].map((api) => claimRaw(api, NO));
    const res = await Promise.all(calls);
    const bodies = await Promise.all(res.map((r) => bodyOf(r)));
    const ok = res.filter((r) => r.status() === 200);
    expect(ok, JSON.stringify(res.map((r, i) => [r.status(), bodies[i].code]))).toHaveLength(1);
    bodies.forEach((b, i) => {
      if (res[i].status() !== 200) {
        expect(res[i].status()).toBe(409);
        expect(b.code).toBe('ALREADY_CLAIMED');
      }
    });
    const winnerBody = bodies[res.findIndex((r) => r.status() === 200)];
    const c = await getCase(reg1, NO);
    expect(c.owner).toBe(winnerBody.owner);
    expect(c.status).toBe('IN_REVIEW');
    expect(await claimAuditCount(NO)).toBe(1);
  });

  await test.step('ส่วน 3 ต่อกัน (API · RESET) — จับ B08', async () => {
    await reset();
    const NO = caseNo(29);
    const reg1 = await loginStaff('off.reg1');
    const reg2 = await loginStaff('off.reg2');
    const first = await claim(reg1, NO);
    expect(first.owner).toBe('off.reg1');
    const second = await expectApi(claimRaw(reg2, NO), 409, 'ALREADY_CLAIMED');
    expect(second.message).toBe(MSG.ALREADY_CLAIMED);
    expect((await getCase(reg2, NO)).owner).toBe('off.reg1');
    expect(await queueItems(reg2, 'mine')).toHaveLength(9);
    const s2 = await staffSession(browser, 'off.reg2');
    await expectWorkload(s2.page, 9);
    await expectApi(claimRaw(reg1, NO), 409, 'ALREADY_CLAIMED');
    expect((await getCase(reg1, NO)).owner).toBe('off.reg1');
    expect(await claimAuditCount(NO)).toBe(1);
  });
});

test('TC-QUEUE-03 งานในมือสูงสุด 10', async ({ browser }) => {
  test.setTimeout(240_000);
  await reset();
  let s = await staffSession(browser, 'off.reg2');
  let p = s.page;
  const claimUi = async (n: number) => {
    await p.goto('/officer/queue');
    await withMutation(p, () => queueRow(p, caseNo(n)).getByTestId('claim-btn').click());
  };

  // 1
  await expectWorkload(p, 9);
  // 2 ครั้งที่ 10
  await claimUi(28);
  await expect(tid(p, 'action-error')).toBeHidden();
  await expectWorkload(p, 10);
  expect((await getCase(s.api, caseNo(28))).owner).toBe('off.reg2');
  // 3 ครั้งที่ 11 → เพดาน
  await claimUi(29);
  await expect(tid(p, 'action-error')).toHaveText(MSG.WORKLOAD_LIMIT);
  const lim = await expectApi(claimRaw(s.api, caseNo(29)), 409, 'WORKLOAD_LIMIT');
  expect(lim.message).toBe(MSG.WORKLOAD_LIMIT);
  const c29 = await getCase(s.api, caseNo(29));
  expect(c29.status).toBe('SUBMITTED');
  expect(c29.owner || null).toBeNull();
  await expectWorkload(p, 10);
  // 4 อนุมัติ …000025 (SV-01 ของตัวเอง) → APPROVED ไม่นับ
  await p.goto(`/officer/cases/${caseNo(25)}`);
  await tid(p, 'approve-btn').click();
  await expectStatus(p, 'APPROVED');
  await expectWorkload(p, 9);
  // 5
  await claimUi(29);
  await expectWorkload(p, 10);
  expect((await getCase(s.api, caseNo(29))).owner).toBe('off.reg2');
  // 6 off.reg1 (งานในมือ 3) ไม่ติดเพดาน
  const reg1 = await loginStaff('off.reg1');
  expect((await claim(reg1, caseNo(30))).owner).toBe('off.reg1');

  // 7 RESET · ตีกลับ …000025 → NEED_FIX ไม่นับ
  await reset();
  s = await staffSession(browser, 'off.reg2');
  p = s.page;
  await p.goto(`/officer/cases/${caseNo(25)}`);
  await tid(p, 'return-btn').click();
  await tid(p, 'return-reason').fill('xxxxxxxxxx');
  await tid(p, 'return-submit').click();
  await expectStatus(p, 'NEED_FIX');
  await expectWorkload(p, 8);
  // 8
  await claimUi(28);
  await claimUi(29);
  await expectWorkload(p, 10);
  // 9 สมหญิงส่งแก้ → คืนผู้ถือเดิมแม้เกิน 10
  const c = await citizenSession(browser, ID.SOMYING);
  await c.page.goto(`/citizen/cases/${caseNo(25)}`);
  await tid(c.page, 'submit-fix-btn').click();
  await expect(tid(c.page, 'action-error')).toBeHidden();
  await expectStatus(c.page, 'IN_REVIEW');
  expect((await getCase(s.api, caseNo(25))).owner).toBe('off.reg2');
  await expectWorkload(p, 11);
  // 10 รับเพิ่มไม่ได้
  const b10 = await expectApi(claimRaw(s.api, caseNo(30)), 409, 'WORKLOAD_LIMIT');
  expect(b10.message).toBe(MSG.WORKLOAD_LIMIT);
  await expectWorkload(p, 11);
});

// ═══════════════════════════════════ SLA ═══════════════════════════════════

test('TC-SLA-01 กำหนดเสร็จตามตารางวันที่', async ({ browser }) => {
  test.setTimeout(360_000);
  const rows: Array<{ row: string; service: 'SV-01' | 'SV-02' | 'SV-03'; at: string; due: string; text: string }> = [
    { row: 'a', service: 'SV-01', at: '2026-12-01T09:00:00+07:00', due: '2026-12-04T16:30:00+07:00', text: '4 ธ.ค. 2569 16:30' },
    { row: 'b', service: 'SV-01', at: '2026-12-01T16:29:00+07:00', due: '2026-12-04T16:30:00+07:00', text: '4 ธ.ค. 2569 16:30' },
    { row: 'c', service: 'SV-01', at: '2026-12-01T16:30:00+07:00', due: '2026-12-08T16:30:00+07:00', text: '8 ธ.ค. 2569 16:30' },
    { row: 'd', service: 'SV-01', at: '2026-12-04T10:00:00+07:00', due: '2026-12-11T16:30:00+07:00', text: '11 ธ.ค. 2569 16:30' },
    { row: 'e', service: 'SV-01', at: '2026-12-05T10:00:00+07:00', due: '2026-12-14T16:30:00+07:00', text: '14 ธ.ค. 2569 16:30' },
    { row: 'f', service: 'SV-02', at: '2026-12-01T09:00:00+07:00', due: '2026-12-17T16:30:00+07:00', text: '17 ธ.ค. 2569 16:30' },
    { row: 'g', service: 'SV-03', at: '2026-12-01T09:00:00+07:00', due: '2026-12-24T16:30:00+07:00', text: '24 ธ.ค. 2569 16:30' },
    { row: 'h', service: 'SV-01', at: '2026-12-29T10:00:00+07:00', due: '2027-01-05T16:30:00+07:00', text: '5 ม.ค. 2570 16:30' },
    { row: 'i', service: 'SV-01', at: '2026-12-31T23:59:00+07:00', due: '2027-01-07T16:30:00+07:00', text: '7 ม.ค. 2570 16:30' },
  ];
  for (const r of rows) {
    await test.step(`แถว ${r.row}: ${r.service} ชำระ ${r.at}`, async () => {
      await reset();
      await setClock(r.at);
      const s = await citizenSession(browser, ID.SOMCHAI);
      const paid = await newPaid({ api: s.api, service: r.service, qty: 1, areaSqm: 100 });
      expect(paid.caseNo).toBe(caseNo(31));
      const c = await getCase(s.api, paid.caseNo);
      expect(c.dueAt).toBe(r.due);
      await s.page.goto(`/citizen/cases/${paid.caseNo}`);
      await expectDue(s.page, r.text, r.due);
    });
  }
});

test('TC-SLA-02 หยุดนับ SLA ระหว่างรอแก้ไข', async ({ browser }) => {
  test.setTimeout(360_000);
  const NEW = caseNo(31);
  const F01 = caseNo(17);

  await test.step('ส่วน 1 ตีกลับ 2 ธ.ค. ส่งแก้ 3 ธ.ค. (หยุด 1 วัน)', async () => {
    await reset();
    const c = await citizenSession(browser, ID.SOMCHAI);
    const paid = await newPaid({ api: c.api, service: 'SV-01', qty: 1 });
    expect(paid.caseNo).toBe(NEW);
    expect((await getCase(c.api, NEW)).dueAt).toBe('2026-12-04T16:30:00+07:00');

    await setClock('2026-12-02T11:00:00+07:00');
    const o = await staffSession(browser, 'off.reg1');
    await claim(o.api, NEW);
    await returnCase(o.api, NEW, 'xxxxxxxxxx');
    await o.page.goto(`/officer/cases/${NEW}`);
    await expectStatus(o.page, 'NEED_FIX');
    await c.page.goto(`/citizen/cases/${NEW}`);
    await expectStatus(c.page, 'NEED_FIX');
    await expectLevel(c.page, 'paused');
    await expect(tid(c.page, 'fix-deadline')).toHaveAttribute('data-iso', '2026-12-09T11:00:00+07:00');

    await setClock('2026-12-03T10:00:00+07:00');
    await c.page.goto(`/citizen/cases/${NEW}`);
    await tid(c.page, 'submit-fix-btn').click();
    await expectStatus(c.page, 'IN_REVIEW');
    await expectDue(c.page, '8 ธ.ค. 2569 16:30', '2026-12-08T16:30:00+07:00');
    await expectLevel(c.page, 'normal');
    const got = await getCase(o.api, NEW);
    expect(got.dueAt).toBe('2026-12-08T16:30:00+07:00');
    expect(got.owner).toBe('off.reg1');
    await o.page.goto(`/officer/cases/${NEW}`);
    await expect(tid(o.page, 'case-owner')).toHaveText('off.reg1');
  });

  await test.step('ส่วน 2 seed …000017 ส่งแก้ 1 ธ.ค. 09:00 (หยุด 2 วัน)', async () => {
    await reset();
    const c = await citizenSession(browser, ID.SOMCHAI);
    await c.page.goto(`/citizen/cases/${F01}`);
    await expectLevel(c.page, 'paused');
    await expect(tid(c.page, 'sla-due')).toHaveAttribute('data-iso', '2026-11-27T16:30:00+07:00');
    await tid(c.page, 'submit-fix-btn').click();
    await expectStatus(c.page, 'IN_REVIEW');
    await expectDue(c.page, '1 ธ.ค. 2569 16:30', '2026-12-01T16:30:00+07:00');
    await expectLevel(c.page, 'near');
    const reg1 = await loginStaff('off.reg1');
    const got = await getCase(reg1, F01);
    expect(got.dueAt).toBe('2026-12-01T16:30:00+07:00');
    expect(got.owner).toBe('off.reg1');
  });

  await test.step('ส่วน 3 ส่งแก้ …000017 วันที่ 4 ธ.ค. 10:00 (หยุด 5 วัน)', async () => {
    await reset();
    await setClock('2026-12-04T10:00:00+07:00');
    const c = await citizenSession(browser, ID.SOMCHAI);
    const r = await resubmit(c.api, F01);
    expect(r.dueAt).toBe('2026-12-04T16:30:00+07:00');
    const got = await getCase(c.api, F01);
    expect(got.dueAt).toBe('2026-12-04T16:30:00+07:00');
    expect(got.slaLevel).toBe('near');
    await c.page.goto(`/citizen/cases/${F01}`);
    await expectLevel(c.page, 'near');
  });

  await test.step('ส่วน 4 ตีกลับและส่งแก้วันเดียวกัน (หยุด 0 วัน)', async () => {
    await reset();
    const paid = await newPaid({ idNo: ID.SOMCHAI, service: 'SV-01', qty: 1 });
    expect(paid.caseNo).toBe(NEW);
    await setClock('2026-12-02T09:00:00+07:00');
    const reg1 = await loginStaff('off.reg1');
    await claim(reg1, NEW);
    await returnCase(reg1, NEW);
    await setClock('2026-12-02T15:00:00+07:00');
    const r = await resubmit(paid.api, NEW);
    expect(r.dueAt).toBe('2026-12-04T16:30:00+07:00');
    expect((await getCase(paid.api, NEW)).dueAt).toBe('2026-12-04T16:30:00+07:00');
  });

  await test.step('ส่วน 5 คร่อมสุดสัปดาห์/วันหยุด ส่งแก้หลัง 16:30', async () => {
    await reset();
    const c = await citizenSession(browser, ID.SOMCHAI);
    const paid = await newPaid({ api: c.api, service: 'SV-01', qty: 1 });
    expect(paid.caseNo).toBe(NEW);
    await setClock('2026-12-04T10:00:00+07:00');
    const reg1 = await loginStaff('off.reg1');
    await claim(reg1, NEW);
    await returnCase(reg1, NEW);
    await setClock('2026-12-08T17:00:00+07:00');
    const r = await resubmit(c.api, NEW);
    expect(r.dueAt).toBe('2026-12-08T16:30:00+07:00');
    const got = await getCase(c.api, NEW);
    expect(got.dueAt).toBe('2026-12-08T16:30:00+07:00');
    expect(got.slaLevel).toBe('overdue');
    await c.page.goto(`/citizen/cases/${NEW}`);
    await expectDue(c.page, '8 ธ.ค. 2569 16:30', '2026-12-08T16:30:00+07:00');
    await expectLevel(c.page, 'overdue');
  });
});

test('TC-SLA-03 ระดับเตือน ปกติ / ใกล้ครบกำหนด / เกินกำหนด', async ({ browser }) => {
  test.setTimeout(300_000);

  async function levelAt(s: { page: Page; api: APIRequestContext }, no: string, clock: string, level: SlaLevel): Promise<void> {
    await test.step(`${no} @ ${clock} → ${level}`, async () => {
      await setClock(clock);
      expect((await getCase(s.api, no)).slaLevel).toBe(level);
      await s.page.goto(`/citizen/cases/${no}`);
      await expectLevel(s.page, level);
    });
  }

  await test.step('ส่วน A คำขอใหม่ กำหนด ศ. 4 ธ.ค. 16:30', async () => {
    await reset();
    const s = await citizenSession(browser, ID.SOMCHAI);
    const paid = await newPaid({ api: s.api, service: 'SV-01', qty: 1 });
    expect(paid.caseNo).toBe(caseNo(31));
    const rows: Array<[string, SlaLevel]> = [
      ['2026-12-01T09:00:00+07:00', 'normal'],
      ['2026-12-02T09:00:00+07:00', 'normal'],
      ['2026-12-03T09:00:00+07:00', 'near'],
      ['2026-12-04T16:30:00+07:00', 'near'],
      ['2026-12-04T16:30:01+07:00', 'overdue'],
      ['2026-12-04T16:31:00+07:00', 'overdue'],
      ['2026-12-05T10:00:00+07:00', 'overdue'],
    ];
    for (const [clock, level] of rows) await levelAt(s, paid.caseNo, clock, level);
  });

  await test.step('ส่วน B seed …000016 กำหนด อ. 8 ธ.ค. 16:30', async () => {
    await reset();
    const s = await citizenSession(browser, ID.PITI);
    const rows: Array<[string, SlaLevel]> = [
      ['2026-12-03T09:00:00+07:00', 'normal'],
      ['2026-12-04T09:00:00+07:00', 'near'],
      ['2026-12-08T16:30:00+07:00', 'near'],
      ['2026-12-08T16:31:00+07:00', 'overdue'],
    ];
    for (const [clock, level] of rows) await levelAt(s, caseNo(16), clock, level);
  });

  await test.step('ส่วน C seed ที่ 09:00 (คิว + หน้าเคส)', async () => {
    await reset();
    const o = await staffSession(browser, 'off.reg1');
    await o.page.goto('/officer/queue');
    const expected: Array<[number, SlaLevel]> = [
      [20, 'overdue'],
      [22, 'near'],
      [24, 'near'],
      [25, 'normal'],
    ];
    for (const [n, level] of expected) {
      const row = queueRow(o.page, caseNo(n));
      await expect(row.getByTestId('row-sla-level')).toHaveText(LEVEL_TH[level]);
      await expect(row).toHaveAttribute('data-sla-level', level);
    }
    for (const [n, level] of expected) {
      await o.page.goto(`/officer/cases/${caseNo(n)}`);
      await expectLevel(o.page, level);
      expect((await getCase(o.api, caseNo(n))).slaLevel).toBe(level);
    }
    const somchai = await citizenSession(browser, ID.SOMCHAI);
    await somchai.page.goto(`/citizen/cases/${caseNo(17)}`);
    await expectLevel(somchai.page, 'paused');
    const somying = await citizenSession(browser, ID.SOMYING);
    await somying.page.goto(`/citizen/cases/${caseNo(1)}`);
    await expectLevel(somying.page, 'closed');

    await setClock('2026-12-01T16:30:00+07:00');
    await o.page.goto('/officer/queue');
    await expect(queueRow(o.page, caseNo(22)).getByTestId('row-sla-level')).toHaveText('ใกล้ครบกำหนด');
    await setClock('2026-12-01T16:31:00+07:00');
    await o.page.goto('/officer/queue');
    await expect(queueRow(o.page, caseNo(22)).getByTestId('row-sla-level')).toHaveText('เกินกำหนด');
    await expect(queueRow(o.page, caseNo(22))).toHaveAttribute('data-sla-level', 'overdue');
  });
});

// ═══════════════════════════════════ NOTI ═══════════════════════════════════

/**
 * TC-NOTI-01 ทั้งชุด: RESET → off.reg1 ล็อกอินที่ 09:00 (request แรก) → ตรวจผู้รับ 4 คน → CLOCK 16:31 → ตรวจเพิ่ม
 * คืน session ของทุกคนเพื่อให้ TC-NOTI-02 ส่วน A ใช้ต่อ
 */
async function notiBaseline(browser: Browser): Promise<Record<'off.reg1' | 'off.reg2' | 'head1' | 'off.works1', { page: Page; api: APIRequestContext }>> {
  await reset();
  const reg1 = await staffSession(browser, 'off.reg1'); // request แรกหลัง reset ที่ 09:00
  const reg2 = await staffSession(browser, 'off.reg2');
  const head = await staffSession(browser, 'head1');
  const works = await staffSession(browser, 'off.works1');

  const expected: Array<[{ page: Page; api: APIRequestContext }, string[], number]> = [
    [reg1, keys([[24, 'near'], [22, 'near'], [20, 'overdue']]), 3],
    [reg2, keys([[24, 'near']]), 1],
    [head, keys([[20, 'overdue']]), 1],
    [works, [], 0],
  ];
  for (const [s, exp, count] of expected) {
    expect(await notificationKeys(s.api)).toEqual(exp);
    await s.page.goto('/notifications');
    await expect(tid(s.page, 'bell-count')).toHaveText(String(count));
    await expect(tid(s.page, 'noti-item')).toHaveCount(count);
    expect(await uiNotiKeys(s.page)).toEqual(exp);
  }
  await expect(rowBy(reg1.page, 'noti-item', 'data-case-no', caseNo(24))).toContainText('คำขอ EG-2569-000024 ใกล้ครบกำหนด');
  await expect(rowBy(reg1.page, 'noti-item', 'data-case-no', caseNo(20))).toContainText('คำขอ EG-2569-000020 เกินกำหนด');
  await expect(tid(works.page, 'noti-empty')).toHaveText(MSG.NOTI_EMPTY);
  const apiItems = (await expectApi(reg1.api.get('/api/notifications'), 200)).items as any[];
  expect(apiItems.find((n) => n.caseNo === caseNo(24))?.text).toBe('คำขอ EG-2569-000024 ใกล้ครบกำหนด');
  expect(apiItems.find((n) => n.caseNo === caseNo(20))?.text).toBe('คำขอ EG-2569-000020 เกินกำหนด');

  // ต่อ: 16:31 + request ใด ๆ → …000022 เกินกำหนด
  await setClock('2026-12-01T16:31:00+07:00');
  await expectApi(reg1.api.get('/api/me'), 200);
  expect(await notificationKeys(reg1.api)).toEqual(keys([[24, 'near'], [22, 'near'], [22, 'overdue'], [20, 'overdue']]));
  expect(await notificationKeys(head.api)).toEqual(keys([[20, 'overdue'], [22, 'overdue']]));
  expect(await notificationKeys(reg2.api)).toEqual(keys([[24, 'near']]));
  for (const [s, n] of [[reg1, 4], [head, 2], [reg2, 1]] as const) {
    await s.page.goto('/notifications');
    await expect(tid(s.page, 'bell-count')).toHaveText(String(n));
    await expect(tid(s.page, 'noti-item')).toHaveCount(n);
  }
  return { 'off.reg1': reg1, 'off.reg2': reg2, head1: head, 'off.works1': works };
}

test('TC-NOTI-01 ผู้รับแจ้งเตือนตามระดับ', async ({ browser }) => {
  await notiBaseline(browser);
});

test('TC-NOTI-02 ไม่แจ้งซ้ำ ข้ามระดับ และขั้นรออนุมัติ/รอออกเอกสาร', async ({ browser }) => {
  test.setTimeout(360_000);

  await test.step('ส่วน A ไม่แจ้งซ้ำ', async () => {
    const s = await notiBaseline(browser);
    const reg1 = s['off.reg1'];
    const head = s.head1;
    for (const x of [reg1, head]) {
      for (let i = 0; i < 3; i++) await x.page.goto('/notifications');
      for (let i = 0; i < 3; i++) await notificationKeys(x.api);
      for (let i = 0; i < 2; i++) await x.page.goto('/officer/queue');
    }
    for (const [x, n] of [[reg1, 4], [head, 2]] as const) {
      const k = await notificationKeys(x.api);
      expect(k).toHaveLength(n);
      expect(new Set(k).size).toBe(n); // (คำขอ, ระดับ, ผู้ใช้) มีได้ 1 รายการ
      await x.page.goto('/notifications');
      await expect(tid(x.page, 'bell-count')).toHaveText(String(n));
    }
  });

  await test.step('ส่วน B ข้ามระดับ (request แรกที่ ส. 5 ธ.ค. 10:00)', async () => {
    await reset();
    await setClock('2026-12-05T10:00:00+07:00');
    const reg1 = await staffSession(browser, 'off.reg1'); // request แรก
    const reg2 = await staffSession(browser, 'off.reg2');
    const works = await staffSession(browser, 'off.works1');
    const head = await staffSession(browser, 'head1');
    const ov = (ns: number[]) => ns.map((n) => [n, 'overdue'] as [number, 'overdue']);
    const expected: Array<[{ page: Page; api: APIRequestContext }, string[]]> = [
      [reg1, keys(ov([20, 22, 23, 24, 28, 29, 30]))],
      [reg2, keys([...ov([13, 15, 24, 25, 26, 27, 28, 29, 30]), [16, 'near']])],
      [works, keys(ov([10]))],
      [head, keys([...ov([10, 13, 14, 15, 20, 22, 23, 24, 25, 26, 27, 28, 29, 30]), [11, 'near']])],
    ];
    for (const [x, exp] of expected) expect(await notificationKeys(x.api)).toEqual(exp);
    // ไม่มี near ย้อนหลังของ …000024 · ผู้ถือ off.reg1 ของ 000020/000022 มีเฉพาะ overdue
    for (const x of [reg1, reg2, head]) expect(only(await notificationKeys(x.api), 24)).toEqual(keys([[24, 'overdue']]));
    for (const x of [reg1, head]) {
      const k = await notificationKeys(x.api);
      expect(only(k, 20)).toEqual(keys([[20, 'overdue']]));
      expect(only(k, 22)).toEqual(keys([[22, 'overdue']]));
    }
    for (const [x, n] of [[reg1, 7], [reg2, 10], [works, 1], [head, 15]] as const) {
      await x.page.goto('/notifications');
      await expect(tid(x.page, 'bell-count')).toHaveText(String(n));
      await expect(tid(x.page, 'noti-item')).toHaveCount(n);
    }
  });

  await test.step('ส่วน C ขั้นรออนุมัติ (…000014) และรอออกเอกสาร (…000019)', async () => {
    await reset();
    await setClock('2026-12-04T09:00:00+07:00');
    const head = await loginStaff('head1');
    const reg1 = await loginStaff('off.reg1');
    const reg2 = await loginStaff('off.reg2');
    expect(only(await notificationKeys(head), 14)).toEqual(keys([[14, 'near']]));
    expect(only(await notificationKeys(reg1), 14)).toEqual([]);
    expect(only(await notificationKeys(reg2), 14)).toEqual([]);

    // 1
    await setClock('2026-12-04T16:31:00+07:00');
    await expectApi(head.get('/api/me'), 200);
    expect(only(await notificationKeys(head), 14)).toEqual(keys([[14, 'near'], [14, 'overdue']]));
    expect(only(await notificationKeys(reg1), 14)).toEqual([]);
    expect(only(await notificationKeys(reg2), 14)).toEqual([]);

    // 2
    await setClock('2026-12-08T09:00:00+07:00');
    await expectApi(head.get('/api/me'), 200);
    expect(only(await notificationKeys(reg1), 19)).toEqual(keys([[19, 'near']]));
    expect(only(await notificationKeys(reg2), 19)).toEqual([]);
    expect(only(await notificationKeys(head), 19)).toEqual([]);

    // 3
    await setClock('2026-12-09T16:31:00+07:00');
    await expectApi(head.get('/api/me'), 200);
    expect(only(await notificationKeys(reg1), 19)).toEqual(keys([[19, 'near'], [19, 'overdue']]));
    expect(only(await notificationKeys(head), 19)).toEqual(keys([[19, 'overdue']]));
    expect(only(await notificationKeys(reg2), 19)).toEqual([]);
  });
});
