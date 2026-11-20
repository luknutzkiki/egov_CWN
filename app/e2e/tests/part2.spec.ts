/**
 * part2.spec.ts · TEST-PLAN ชุด 2 (29 TC): WORKFLOW DOC PDPA DASH AUDIT RBAC NFR
 *
 * - ทุก TC เริ่มด้วย reset() (POST /api/test/reset) แล้วล็อกอินใหม่ใน context ใหม่ทุกครั้งหลัง reset (CONTRACT 0.9)
 * - ค่าคาดหวังทุกตัวคัดจาก TEST-PLAN / TEST-DATA / CONTRACT (คิดจากกฎ ไม่ได้อ่านจากหน้าจอ)
 * - สิทธิ์ (B06 B07 B09 B11 …) ยิง API ตรงเสมอ ไม่เชื่อว่าปุ่มหาย = ปลอดภัย
 * - TC ที่นับแถว Audit ล็อกอินบัญชีละครั้งเท่าที่ TEST-PLAN กำหนด (เปิดหน้าจาก cookie เดิมด้วย pageFromApi)
 * - TC-NFR-02 ใช้ @axe-core/playwright · TC-NFR-04 อ่านไฟล์ฐานข้อมูลที่ DB_PATH
 */
import { test, expect, type APIRequestContext, type APIResponse, type Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import {
  BASE_URL,
  ID,
  MSG,
  STAFF,
  T0,
  STATUS_TH,
  type StaffUser,
  caseNo,
  reset,
  setClock,
  getClock,
  cleanup,
  newApi,
  expectApi,
  bodyOf,
  pay,
  payRaw,
  loginCitizen,
  loginStaff,
  newSession,
  citizenSession,
  staffSession,
  uiLoginCitizen,
  uiStaffSubmit,
  waitPath,
  createDraft,
  newPaid,
  getCase,
  getPayment,
  claim,
  claimRaw,
  returnRaw,
  returnCase,
  resubmit,
  resubmitRaw,
  forwardRaw,
  approveRaw,
  rejectRaw,
  issueRaw,
  queueItems,
  auditItems,
  rowBy,
  queueRow,
  attrs,
  withMutation,
  fillField,
  fixturePath,
  uiUpload,
} from '../helpers';
import {
  tid,
  pathOf,
  expectStatus,
  expectLevel,
  tamper,
  cleanup2,
  pageFromApi,
  act,
  settle,
  uiReturn,
  uiReject,
  uiUnmask,
  uiForward,
  getDashboard,
  uiDashboard,
  expectKpis,
  pctValue,
  uiAudit,
  uiAuditExpect,
  auditRowsUi,
  grabDownload,
  pdfText,
  pdfHasLine,
  xlsxSheets,
  xlsxAllText,
  parseCsv,
  deepKeys,
  piiHits,
  overflowX,
  axeSerious,
  unlabeledControls,
  focusInfo,
  tabTo,
  statusTextProblems,
  countInFile,
  type Kpis,
  type AuditRowUi,
} from '../helpers2';

test.afterEach(async () => {
  await cleanup2();
  await cleanup();
});

// ───────────────────────── ค่าคงที่และตัวช่วยเฉพาะไฟล์นี้ ─────────────────────────

const CODE_RE = /^[A-Z0-9]{8}$/;
const MASK_RE = /^X-XXXX-XXXXX-\d{2}-\d$/;
const ORIGIN = BASE_URL.replace(/\/+$/, '');
const R10 = 'xxxxxxxxxx'; // เหตุผล 10 ตัว (A-44)
const R9 = 'xxxxxxxxx'; // 9 ตัว
const SPACES10 = ' '.repeat(10);

const VERIFY_TH = { VALID: 'เอกสารถูกต้อง', EXPIRED: 'เอกสารหมดอายุ', TAMPERED: 'ลายเซ็นไม่ถูกต้อง', NOT_FOUND: 'ไม่พบเอกสาร' } as const;
type VerifyResult = keyof typeof VERIFY_TH;

/** เปิด /officer/cases/:no (officer/head) */
async function openOfficer(p: Page, no: string): Promise<void> {
  await p.goto(`/officer/cases/${no}`);
  await expect(tid(p, 'case-no')).toHaveText(no);
}

/** เปิด /citizen/cases/:no (ประชาชนเจ้าของ) */
async function openCitizen(p: Page, no: string): Promise<void> {
  await p.goto(`/citizen/cases/${no}`);
  await expect(tid(p, 'case-no')).toHaveText(no);
}

async function apiApprove(api: APIRequestContext, no: string): Promise<void> {
  const b = await expectApi(approveRaw(api, no), 200);
  expect(b.status).toBe('APPROVED');
}

async function apiIssue(api: APIRequestContext, no: string, docNo?: string): Promise<{ docNo: string; verifyCode: string }> {
  const b = await expectApi(issueRaw(api, no), 200);
  expect(b.status).toBe('COMPLETED');
  expect(b.verifyCode).toMatch(CODE_RE);
  if (docNo) expect(b.docNo).toBe(docNo);
  return b;
}

async function apiReject(api: APIRequestContext, no: string, reason = R10): Promise<void> {
  const b = await expectApi(rejectRaw(api, no, reason), 200);
  expect(b.status).toBe('REJECTED');
}

/** เปิด /verify/:code แล้วตรวจ HTTP + verify-result (ข้อความ + data-result) */
async function expectVerify(p: Page, code: string, result: VerifyResult): Promise<void> {
  const res = await p.goto(`/verify/${code}`);
  expect(res?.status(), `/verify/${code}`).toBe(result === 'NOT_FOUND' ? 404 : 200);
  expect(pathOf(p)).toBe(`/verify/${code}`);
  const el = tid(p, 'verify-result');
  await expect(el).toHaveText(VERIFY_TH[result]);
  await expect(el).toHaveAttribute('data-result', result);
}

/** ตั้งนาฬิกาแล้วเปิด /verify/:code */
async function verifyAt(p: Page, code: string, clock: string, result: VerifyResult, expires?: string): Promise<void> {
  await setClock(clock);
  await expectVerify(p, code, result);
  if (expires) await expect(tid(p, 'verify-expires')).toHaveAttribute('data-iso', expires);
}

/** verify-code บนหน้าเคส (8 ตัว) */
async function verifyCodeOnPage(p: Page): Promise<string> {
  await expect(tid(p, 'verify-code')).toHaveText(CODE_RE);
  return (await tid(p, 'verify-code').innerText()).trim();
}

/** เปิด /verify/<code> แบบไม่ล็อกอินแล้วตรวจผู้ลงนาม */
async function expectSigner(browser: import('@playwright/test').Browser, code: string, signer: string): Promise<void> {
  const { page } = await newSession(browser);
  await expectVerify(page, code, 'VALID');
  await expect(tid(page, 'verify-signer')).toHaveText(signer);
}

/** ลำดับ data-case-no ของแถว */
async function caseOrder(p: Page, testid: string): Promise<string[]> {
  return (await attrs(tid(p, testid), 'data-case-no')) as string[];
}

/** ตรวจผล API ของ Dashboard (เฉพาะช่องที่ส่งมา) */
function expectDash(d: any, k: Partial<Kpis> & { onTime?: number }, label = ''): void {
  if (k.received !== undefined) expect(d.received, `${label} received`).toBe(k.received);
  if (k.closed !== undefined) expect(d.closed, `${label} closed`).toBe(k.closed);
  if (k.onTime !== undefined) expect(d.onTime, `${label} onTime`).toBe(k.onTime);
  if (k.pct !== undefined) expect(d.ontimePct, `${label} ontimePct`).toBe(pctValue(k.pct));
  if (k.backlog !== undefined) expect(d.backlog, `${label} backlog`).toBe(k.backlog);
  if (k.overdue !== undefined) expect(d.overdue, `${label} overdue`).toBe(k.overdue);
}

/** งานคงค้าง/เกินกำหนด "ณ ตอนนี้" ตามบริการ (TEST-DATA 7.2 · A-41) */
const NOW_BY_SERVICE: Record<string, { backlog: number; overdue: number }> = {
  ALL: { backlog: 21, overdue: 1 },
  'SV-01': { backlog: 11, overdue: 1 },
  'SV-02': { backlog: 7, overdue: 0 },
  'SV-03': { backlog: 3, overdue: 0 },
};

// ═══════════════════════════════════ WORKFLOW ═══════════════════════════════════

test('TC-WORKFLOW-01 SV-01 อนุมัติ + ออกเอกสาร', async ({ browser }) => {
  await reset();
  const NO = caseNo(25);
  const { page: p } = await staffSession(browser, 'off.reg2');

  await test.step('1 ปุ่มของผู้ถือเรื่อง SV-01', async () => {
    await openOfficer(p, NO);
    await expectStatus(p, 'IN_REVIEW');
    await expect(tid(p, 'approve-btn')).toHaveCount(1);
    await expect(tid(p, 'return-btn')).toHaveCount(1);
    await expect(tid(p, 'reject-btn')).toHaveCount(1);
    await expect(tid(p, 'forward-btn')).toHaveCount(0);
    await expect(tid(p, 'issue-btn')).toHaveCount(0);
    await expect(tid(p, 'case-fee')).toHaveText('฿60');
  });

  await test.step('2 off.reg1 อนุมัติ …000026 ที่ off.reg2 ถือ → 403', async () => {
    const reg1 = await loginStaff('off.reg1');
    await expectApi(approveRaw(reg1, caseNo(26)), 403, 'FORBIDDEN');
    expect((await getCase(reg1, caseNo(26))).status).toBe('IN_REVIEW');
  });

  await test.step('3 อนุมัติ', async () => {
    await act(p, () => tid(p, 'approve-btn').click());
    await expectStatus(p, 'APPROVED');
    await expect(tid(p, 'issue-btn')).toHaveCount(1);
    await expect(tid(p, 'approve-btn')).toHaveCount(0);
  });

  await test.step('4 ออกเอกสาร', async () => {
    await act(p, () => tid(p, 'issue-btn').click());
    await expectStatus(p, 'COMPLETED');
    await expect(tid(p, 'doc-no')).toHaveText('DOC-2569-000002');
    await verifyCodeOnPage(p);
    await expect(tid(p, 'closed-at')).toHaveAttribute('data-iso', T0);
    await expectLevel(p, 'closed');
  });

  await test.step('5 สมหญิงดาวน์โหลดเอกสาร PDF', async () => {
    const { page: c, api } = await citizenSession(browser, ID.SOMYING);
    await openCitizen(c, NO);
    await expectStatus(c, 'COMPLETED');
    await expect(tid(c, 'download-doc-btn')).toHaveCount(1);
    const f = await grabDownload(c, () => tid(c, 'download-doc-btn').click(), /pdf/i);
    expect(f.status).toBe(200);
    expect(f.contentType).toContain('application/pdf');
    expect(f.filename).toBe('DOC-2569-000002.pdf');
    expect(f.body.subarray(0, 4).toString('latin1')).toBe('%PDF');
    expect(pdfHasLine(pdfText(f.body), `docNo=DOC-2569-000002 caseNo=${NO}`), 'บรรทัด ASCII docNo/caseNo ใน PDF').toBe(true);

    const r = await api.get('/api/documents/DOC-2569-000002/pdf');
    expect(r.status()).toBe(200);
    expect(r.headers()['content-type']).toContain('application/pdf');
    expect(r.headers()['content-disposition'] ?? '').toContain('DOC-2569-000002.pdf');
  });

  await test.step('6 Dashboard ธ.ค. ALL', async () => {
    const ex = await loginStaff('exec1');
    expectDash(await getDashboard(ex, '2026-12'), { closed: 1, onTime: 1, received: 3, backlog: 20 });
  });
});

test('TC-WORKFLOW-02 SV-02 ผ่านหัวหน้า', async ({ browser }) => {
  const NO = caseNo(13);
  await reset();
  const reg2 = await staffSession(browser, 'off.reg2');
  const p = reg2.page;

  await test.step('1 ปุ่มของเจ้าหน้าที่ SV-02', async () => {
    await openOfficer(p, NO);
    await expect(tid(p, 'approve-btn')).toHaveCount(0);
    await expect(tid(p, 'forward-btn')).toHaveCount(1);
    await expect(tid(p, 'forward-target')).toHaveCount(0);
  });

  await test.step('2 ส่งต่อหัวหน้า', async () => {
    await uiForward(p);
    await expectStatus(p, 'PENDING_APPROVAL');
    await p.goto('/officer/queue');
    await expect(tid(p, 'workload-count')).toHaveText('8');
    await expect(queueRow(p, NO)).toHaveCount(0);
  });

  const head = await staffSession(browser, 'head1');
  const h = head.page;
  await test.step('3 /head/approvals 3 แถวเรียงตาม BR-16', async () => {
    await h.goto('/head/approvals');
    await expect(tid(h, 'approval-row')).toHaveCount(3);
    expect(await caseOrder(h, 'approval-row')).toEqual([13, 14, 11].map((n) => caseNo(n)));
  });

  await test.step('4 เปิดคำขอจาก approval-open', async () => {
    await rowBy(h, 'approval-row', 'data-case-no', NO).getByTestId('approval-open').click();
    await waitPath(h, `/officer/cases/${NO}`);
    await expect(tid(h, 'approve-btn')).toHaveCount(1);
    await expect(tid(h, 'reject-btn')).toHaveCount(1);
    await expect(tid(h, 'issue-btn')).toHaveCount(0);
  });

  await test.step('5 หัวหน้าอนุมัติ (ไม่มีปุ่มออกเอกสาร)', async () => {
    await act(h, () => tid(h, 'approve-btn').click());
    await expectStatus(h, 'APPROVED');
    await expect(tid(h, 'issue-btn')).toHaveCount(0);
  });

  await test.step('6 off.reg1 ไม่ใช่ผู้รับเรื่อง ออกเอกสารไม่ได้', async () => {
    const reg1 = await staffSession(browser, 'off.reg1');
    await openOfficer(reg1.page, NO);
    await expect(tid(reg1.page, 'issue-btn')).toHaveCount(0);
    await expectApi(issueRaw(reg1.api, NO), 403, 'FORBIDDEN');
  });

  await test.step('7 off.reg2 ออกเอกสาร · ผู้ลงนาม = หัวหน้าฝ่าย', async () => {
    await openOfficer(p, NO);
    await expect(tid(p, 'issue-btn')).toHaveCount(1);
    await act(p, () => tid(p, 'issue-btn').click());
    await expectStatus(p, 'COMPLETED');
    await expect(tid(p, 'doc-no')).toHaveText('DOC-2569-000002');
    await expectSigner(browser, await verifyCodeOnPage(p), STAFF.head1.name);
  });

  await test.step('8 RESET · seed …000019 (APPROVED โดย head1) off.reg1 ออกเอกสาร', async () => {
    await reset();
    const { page: r1 } = await staffSession(browser, 'off.reg1');
    await openOfficer(r1, caseNo(19));
    await act(r1, () => tid(r1, 'issue-btn').click());
    await expectStatus(r1, 'COMPLETED');
    await expect(tid(r1, 'doc-no')).toHaveText('DOC-2569-000002');
    await expectSigner(browser, await verifyCodeOnPage(r1), STAFF.head1.name);
  });
});

test('TC-WORKFLOW-03 SV-03 สามขั้นตอน', async ({ browser }) => {
  const NO = caseNo(12);
  await reset();
  const reg2 = await staffSession(browser, 'off.reg2');
  const p = reg2.page;

  await test.step('1 ขั้น 1/3 ฝ่ายทะเบียน', async () => {
    await openOfficer(p, NO);
    await expect(tid(p, 'case-step')).toHaveText('ขั้นตอน 1/3 · ฝ่ายทะเบียน');
    await expect(tid(p, 'case-fee')).toHaveText('฿1,010');
    await expect(tid(p, 'forward-btn')).toHaveCount(1);
  });

  await test.step('2 ส่งต่อ → ขั้น 2/3 ฝ่ายโยธา (ยัง IN_REVIEW ไม่มีผู้รับ)', async () => {
    await uiForward(p);
    await expectStatus(p, 'IN_REVIEW');
    await expect(tid(p, 'case-step')).toHaveText('ขั้นตอน 2/3 · ฝ่ายโยธา');
    await expect(tid(p, 'case-owner')).toHaveText('ยังไม่มีผู้รับ');
  });

  await test.step('3 คิวทะเบียนไม่มี …000012 (16 แถว) · งานในมือ off.reg2 = 8', async () => {
    await p.goto('/officer/queue');
    await expect(queueRow(p, NO)).toHaveCount(0);
    await expect(tid(p, 'queue-row')).toHaveCount(16);
    await expect(tid(p, 'workload-count')).toHaveText('8');
  });

  const works = await staffSession(browser, 'off.works1');
  const w = works.page;
  await test.step('4 คิวโยธา 2 แถว', async () => {
    await w.goto('/officer/queue');
    await expect(tid(w, 'queue-row')).toHaveCount(2);
    expect(await caseOrder(w, 'queue-row')).toEqual([caseNo(10), NO]);
    await expect(tid(w, 'claim-btn')).toHaveCount(2);
  });

  await test.step('5 off.reg1 claim ข้ามแผนก → 403', async () => {
    const reg1 = await loginStaff('off.reg1');
    await expectApi(claimRaw(reg1, NO), 403, 'FORBIDDEN');
  });

  await test.step('6 off.works1 รับเรื่องแล้วส่งต่อ → ขั้น 3/3 หัวหน้าฝ่าย', async () => {
    await act(w, () => queueRow(w, NO).getByTestId('claim-btn').click());
    await openOfficer(w, NO);
    await expect(tid(w, 'case-owner')).toHaveText('off.works1');
    await uiForward(w);
    await expectStatus(w, 'PENDING_APPROVAL');
    await expect(tid(w, 'case-step')).toHaveText('ขั้นตอน 3/3 · หัวหน้าฝ่าย');
  });

  await test.step('7 หัวหน้าอนุมัติ', async () => {
    const { page: h } = await staffSession(browser, 'head1');
    await h.goto('/head/approvals');
    await expect(tid(h, 'approval-row')).toHaveCount(3);
    await expect(rowBy(h, 'approval-row', 'data-case-no', NO)).toHaveCount(1);
    await rowBy(h, 'approval-row', 'data-case-no', NO).getByTestId('approval-open').click();
    await waitPath(h, `/officer/cases/${NO}`);
    await act(h, () => tid(h, 'approve-btn').click());
    await expectStatus(h, 'APPROVED');
  });

  await test.step('8 ผู้ออกเอกสาร = ทะเบียนขั้นแรก (off.reg2)', async () => {
    await openOfficer(w, NO);
    await expect(tid(w, 'issue-btn')).toHaveCount(0);
    await openOfficer(p, NO);
    await expect(tid(p, 'issue-btn')).toHaveCount(1);
    await act(p, () => tid(p, 'issue-btn').click());
    await expectStatus(p, 'COMPLETED');
    await expectSigner(browser, await verifyCodeOnPage(p), STAFF.head1.name);
  });
});

test('TC-WORKFLOW-04 ตีกลับสูงสุด 2 ครั้ง และผลหลังครบ', async ({ browser }) => {
  test.setTimeout(240_000);

  await test.step('ส่วน A SV-01 …000020 ตีกลับครั้งที่ 1 2 ✓ ครั้งที่ 3 ✗ (จับ B12)', async () => {
    await reset();
    const NO = caseNo(20);
    const r1 = await staffSession(browser, 'off.reg1');
    const p = r1.page;
    const sc = await loginCitizen(ID.SOMCHAI);
    await openOfficer(p, NO);
    await expect(tid(p, 'return-count')).toHaveText('0');

    await uiReturn(p, R10);
    await expectStatus(p, 'NEED_FIX');
    await expect(tid(p, 'return-count')).toHaveText('1');

    await resubmit(sc, NO);
    const back = await getCase(r1.api, NO);
    expect(back.status).toBe('IN_REVIEW');
    expect(back.owner).toBe('off.reg1');

    await openOfficer(p, NO);
    await expectStatus(p, 'IN_REVIEW');
    await uiReturn(p, R10);
    await expectStatus(p, 'NEED_FIX');
    await expect(tid(p, 'return-count')).toHaveText('2');

    await resubmit(sc, NO);
    await openOfficer(p, NO);
    await expectStatus(p, 'IN_REVIEW');
    await expect(tid(p, 'return-btn')).toHaveCount(0);
    const err = await expectApi(returnRaw(r1.api, NO, R10), 409, 'RETURN_LIMIT');
    expect(err.message).toBe(MSG.RETURN_LIMIT);
    const c = await getCase(r1.api, NO);
    expect(c.status).toBe('IN_REVIEW');
    expect(c.returnCount).toBe(2);
    await p.reload();
    await expectStatus(p, 'IN_REVIEW');
    await expect(tid(p, 'return-count')).toHaveText('2');
    await expect(tid(p, 'approve-btn')).toHaveCount(1);
    await expect(tid(p, 'reject-btn')).toHaveCount(1);
  });

  await test.step('ส่วน B seed …000023 ตีกลับแล้ว 2 ครั้ง', async () => {
    await reset();
    const NO = caseNo(23);
    const r1 = await staffSession(browser, 'off.reg1');
    const p = r1.page;
    await openOfficer(p, NO);
    await expect(tid(p, 'return-count')).toHaveText('2');
    await expect(tid(p, 'return-btn')).toHaveCount(0);
    const err = await expectApi(returnRaw(r1.api, NO, R10), 409, 'RETURN_LIMIT');
    expect(err.message).toBe(MSG.RETURN_LIMIT);
    expect((await getCase(r1.api, NO)).status).toBe('IN_REVIEW');
    await p.reload();
    await expectStatus(p, 'IN_REVIEW');
    await expect(tid(p, 'approve-btn')).toHaveCount(1);
    await expect(tid(p, 'reject-btn')).toHaveCount(1);
  });

  await test.step('ส่วน C SV-02 …000013 หลังตีกลับครบ → ส่งต่อหัวหน้าเท่านั้น', async () => {
    await reset();
    const NO = caseNo(13);
    const NOTE = 'ส่งต่อให้หัวหน้าพิจารณา';
    const r2 = await staffSession(browser, 'off.reg2');
    const p = r2.page;
    const sc = await loginCitizen(ID.SOMCHAI);
    expect((await returnCase(r2.api, NO, R10)).returnCount).toBe(1);
    await resubmit(sc, NO);
    expect((await returnCase(r2.api, NO, R10)).returnCount).toBe(2);
    await resubmit(sc, NO);

    await openOfficer(p, NO);
    await expectStatus(p, 'IN_REVIEW');
    await expect(tid(p, 'return-btn')).toHaveCount(0);
    await expect(tid(p, 'approve-btn')).toHaveCount(0);
    await expect(tid(p, 'reject-btn')).toHaveCount(0);
    await expect(tid(p, 'forward-btn')).toHaveCount(1);
    await expectApi(rejectRaw(r2.api, NO, R10), 403);
    expect((await getCase(r2.api, NO)).status).toBe('IN_REVIEW');

    await uiForward(p, NOTE);
    await expectStatus(p, 'PENDING_APPROVAL');

    const auditor = await staffSession(browser, 'audit1');
    await uiAudit(auditor.page, { event: 'FORWARD' });
    const row = rowBy(auditor.page, 'audit-row', 'data-case-no', NO);
    await expect(row).toHaveCount(1);
    await expect(row.getByTestId('audit-detail')).toContainText(NOTE);

    const { page: h } = await staffSession(browser, 'head1');
    await openOfficer(h, NO);
    await expect(tid(h, 'reject-btn')).toHaveCount(1);
    await expect(tid(h, 'approve-btn')).toHaveCount(1);
  });
});

test('TC-WORKFLOW-05 เหตุผล ≥ 10 ตัวอักษร (ตีกลับ/ไม่อนุมัติ)', async ({ browser }) => {
  test.setTimeout(240_000);

  await test.step('ส่วน A ตีกลับ …000020 (off.reg1)', async () => {
    await reset();
    const NO = caseNo(20);
    const r1 = await staffSession(browser, 'off.reg1');
    const p = r1.page;
    await openOfficer(p, NO);

    for (const [label, reason] of [
      ['9 ตัว', R9],
      ['เว้นวรรค 10 ตัว', SPACES10],
    ] as const) {
      await uiReturn(p, reason, false);
      await expect(tid(p, 'return-reason-error'), label).toHaveText(MSG.REASON_TOO_SHORT);
      const e = await expectApi(returnRaw(r1.api, NO, reason), 400, 'REASON_TOO_SHORT');
      expect(e.message).toBe(MSG.REASON_TOO_SHORT);
      expect((await getCase(r1.api, NO)).status, label).toBe('IN_REVIEW');
    }
    await openOfficer(p, NO);
    await expectStatus(p, 'IN_REVIEW');

    await uiReturn(p, R10);
    await expectStatus(p, 'NEED_FIX');
    const { page: c } = await citizenSession(browser, ID.SOMCHAI);
    await openCitizen(c, NO);
    await expect(tid(c, 'return-reason-display')).toHaveText(R10);
  });

  await test.step('ส่วน B ไม่อนุมัติ SV-01 …000026 (off.reg2)', async () => {
    await reset();
    const NO = caseNo(26);
    const r2 = await staffSession(browser, 'off.reg2');
    const p = r2.page;
    await openOfficer(p, NO);

    await uiReject(p, R9, false);
    await expect(tid(p, 'reject-reason-error')).toHaveText(MSG.REASON_TOO_SHORT);
    await expectApi(rejectRaw(r2.api, NO, R9), 400, 'REASON_TOO_SHORT');
    expect((await getCase(r2.api, NO)).status).toBe('IN_REVIEW');

    await openOfficer(p, NO);
    await uiReject(p, R10);
    await expectStatus(p, 'REJECTED');
    await expect(tid(p, 'closed-at')).toHaveAttribute('data-iso', T0);
    await expectLevel(p, 'closed');

    const { page: c } = await citizenSession(browser, ID.SOMCHAI);
    await openCitizen(c, NO);
    await expectStatus(c, 'REJECTED');
    await expect(tid(c, 'no-refund-note')).toHaveText(MSG.NO_REFUND);

    const ex = await loginStaff('exec1');
    expectDash(await getDashboard(ex, '2026-12'), { closed: 1, onTime: 1 });
  });

  await test.step('ส่วน C หัวหน้าไม่อนุมัติ …000011', async () => {
    await reset();
    const NO = caseNo(11);
    const head = await staffSession(browser, 'head1');
    const p = head.page;
    await openOfficer(p, NO);

    await uiReject(p, R9, false);
    await expect(tid(p, 'reject-reason-error')).toHaveText(MSG.REASON_TOO_SHORT);
    await expectApi(rejectRaw(head.api, NO, R9), 400, 'REASON_TOO_SHORT');
    expect((await getCase(head.api, NO)).status).toBe('PENDING_APPROVAL');

    await openOfficer(p, NO);
    await uiReject(p, R10);
    await expectStatus(p, 'REJECTED');
    expect((await getCase(head.api, NO)).status).toBe('REJECTED');
  });
});

test('TC-WORKFLOW-06 เวลาแก้ไข 168 ชั่วโมง', async ({ browser }) => {
  const NO = caseNo(17);
  const DEADLINE = '2026-12-04T14:00:00+07:00';

  await test.step('หน้าตั้งต้น (1 ธ.ค. 09:00)', async () => {
    await reset();
    const { page: c } = await citizenSession(browser, ID.SOMCHAI);
    await openCitizen(c, NO);
    await expectStatus(c, 'NEED_FIX');
    await expect(tid(c, 'return-reason-display')).toHaveText('ชื่อในเอกสารไม่ตรงกับบัตร กรุณาแก้ไข');
    await expect(tid(c, 'fix-deadline')).toHaveText('4 ธ.ค. 2569 14:00');
    await expect(tid(c, 'fix-deadline')).toHaveAttribute('data-iso', DEADLINE);
    await expect(tid(c, 'submit-fix-btn')).toHaveCount(1);
  });

  await test.step('A 167:59 ส่งแก้ได้', async () => {
    await reset();
    await setClock('2026-12-04T13:59:00+07:00');
    const { page: c, api } = await citizenSession(browser, ID.SOMCHAI);
    await openCitizen(c, NO);
    await expect(tid(c, 'submit-fix-btn')).toBeEnabled();
    await act(c, () => tid(c, 'submit-fix-btn').click());
    await expectStatus(c, 'IN_REVIEW');
    expect((await getCase(api, NO)).status).toBe('IN_REVIEW');
  });

  await test.step('B 168:00 ยกเลิกอัตโนมัติ', async () => {
    await reset();
    await setClock(DEADLINE);
    const { page: c, api } = await citizenSession(browser, ID.SOMCHAI);
    await openCitizen(c, NO);
    await expectStatus(c, 'CANCELLED');
    await expect(tid(c, 'submit-fix-btn')).toHaveCount(0);
    await expect(tid(c, 'no-refund-note')).toHaveText(MSG.NO_REFUND);
    const r = await expectApi(resubmitRaw(api, NO), 409);
    expect(['FIX_WINDOW_EXPIRED', 'INVALID_STATE']).toContain(r.code);
    await expect(tid(c, 'case-timeline').locator(`[data-testid="timeline-item"][data-iso="${DEADLINE}"]`)).not.toHaveCount(0);
    const ex = await loginStaff('exec1');
    expectDash(await getDashboard(ex, '2026-12'), { backlog: 20 });
  });
});

// ═══════════════════════════════════ DOC ═══════════════════════════════════

test('TC-DOC-01 ออกเอกสารและข้อมูลใน PDF', async ({ browser }) => {
  await reset();
  const NO = caseNo(25);
  const DOC = 'DOC-2569-000002';
  const reg2 = await staffSession(browser, 'off.reg2');
  await apiApprove(reg2.api, NO);
  const issued = await expectApi(issueRaw(reg2.api, NO), 200);
  expect(issued.docNo).toBe(DOC);
  expect(issued.status).toBe('COMPLETED');
  expect(issued.verifyCode).toMatch(CODE_RE);
  const code: string = issued.verifyCode;

  const sy = await citizenSession(browser, ID.SOMYING);
  await test.step('PDF ของผู้ยื่น', async () => {
    const r = await sy.api.get(`/api/documents/${DOC}/pdf`);
    expect(r.status()).toBe(200);
    expect(r.headers()['content-type']).toContain('application/pdf');
    expect(r.headers()['content-disposition'] ?? '').toContain(`${DOC}.pdf`);
    const body = await r.body();
    expect(body.subarray(0, 4).toString('latin1')).toBe('%PDF');
    const line = `docNo=${DOC} caseNo=${NO} verify=${code} validUntil=2027-02-28`;
    expect(pdfHasLine(pdfText(body), line), line).toBe(true);
  });

  await test.step('/verify/<code> (ไม่ล็อกอิน)', async () => {
    const { page: v } = await newSession(browser);
    await expectVerify(v, code, 'VALID');
    await expect(tid(v, 'verify-doc-no')).toHaveText(DOC);
    await expect(tid(v, 'verify-applicant')).toHaveText('สมหญิง ร***');
    await expect(tid(v, 'verify-service')).toHaveText('SV-01 ขอหนังสือรับรอง');
    await expect(tid(v, 'verify-issued')).toHaveAttribute('data-iso', T0);
    await expect(tid(v, 'verify-expires')).toHaveAttribute('data-iso', '2027-02-28');
    await expect(tid(v, 'verify-signer')).toHaveText(STAFF['off.reg2'].name);
  });

  await test.step('doc-qr บนหน้าเคส', async () => {
    await openOfficer(reg2.page, NO);
    await expect(tid(reg2.page, 'doc-qr')).toHaveAttribute('data-url', `${ORIGIN}/verify/${code}`);
    await openCitizen(sy.page, NO);
    await expect(tid(sy.page, 'doc-qr')).toHaveAttribute('data-url', `${ORIGIN}/verify/${code}`);
  });

  await test.step('API verify · คนอื่นเปิด PDF ไม่ได้ · ออกซ้ำไม่ได้', async () => {
    const v = await expectApi((await newApi()).get(`/api/verify/${code}`), 200);
    expect(v.result).toBe('VALID');
    expect(v.validUntil).toBe('2027-02-28');
    expect(v.issuedAt).toBe(T0);

    const sc = await loginCitizen(ID.SOMCHAI);
    await expectApi(sc.get(`/api/documents/${DOC}/pdf`), 404);

    await expectApi(issueRaw(reg2.api, NO), 409, 'INVALID_STATE');
    const reg1 = await loginStaff('off.reg1');
    await apiIssue(reg1, caseNo(19), 'DOC-2569-000003');
  });
});

test('TC-DOC-02 ตรวจเอกสาร /verify', async ({ browser }) => {
  await reset();
  const { page: v } = await newSession(browser);

  await test.step('K7M2Q9XA ถูกต้อง (ไม่ redirect /login)', async () => {
    await expectVerify(v, 'K7M2Q9XA', 'VALID');
    await expect(tid(v, 'verify-doc-no')).toHaveText('DOC-2569-000001');
    await expect(tid(v, 'verify-applicant')).toHaveText('สมชาย ใ***');
    await expect(tid(v, 'verify-service')).toHaveText('SV-01 ขอหนังสือรับรอง');
    await expect(tid(v, 'verify-issued')).toHaveAttribute('data-iso', '2026-11-05T10:00:00+07:00');
    await expect(tid(v, 'verify-expires')).toHaveAttribute('data-iso', '2027-02-02');
    await expect(tid(v, 'verify-signer')).toHaveText(STAFF['off.reg1'].name);
    const textAll = await v.locator('body').innerText();
    const html = await v.content();
    for (const s of ['ใจดี', ID.SOMCHAI]) {
      expect(textAll, `ข้อความหน้า /verify ต้องไม่มี ${s}`).not.toContain(s);
      expect(html, `HTML หน้า /verify ต้องไม่มี ${s}`).not.toContain(s);
    }
  });

  await test.step('ZZZZZZZZ ไม่พบ (404)', async () => {
    await expectVerify(v, 'ZZZZZZZZ', 'NOT_FOUND');
    await expect(tid(v, 'verify-applicant')).toHaveCount(0);
    await expect(tid(v, 'verify-doc-no')).toHaveCount(0);
  });

  await test.step('API', async () => {
    const anon = await newApi();
    const ok = await expectApi(anon.get('/api/verify/K7M2Q9XA'), 200);
    expect(ok.result).toBe('VALID');
    expect(ok.applicantMasked).toBe('สมชาย ใ***');
    expect(JSON.stringify(ok)).not.toContain('ใจดี');
    const nf = await expectApi(anon.get('/api/verify/ZZZZZZZZ'), 404);
    expect(nf.result).toBe('NOT_FOUND');
  });
});

test('TC-DOC-03 เอกสารหมดอายุและลายเซ็นไม่ตรง', async ({ browser }) => {
  test.setTimeout(240_000);

  await test.step('ส่วน A SV-01 ออก 1 ธ.ค. 69 → ใช้ได้ถึง 28 ก.พ. 70', async () => {
    await reset();
    const reg2 = await loginStaff('off.reg2');
    await apiApprove(reg2, caseNo(25));
    const { verifyCode: c1 } = await apiIssue(reg2, caseNo(25), 'DOC-2569-000002');
    const { page: v } = await newSession(browser);
    await verifyAt(v, c1, '2027-02-28T23:59:00+07:00', 'VALID', '2027-02-28');
    await verifyAt(v, c1, '2027-03-01T00:00:00+07:00', 'EXPIRED', '2027-02-28');
  });

  await test.step('ส่วน B SV-02 ออก 1 ธ.ค. 69 → ใช้ได้ถึง 30 พ.ย. 70', async () => {
    await reset();
    const reg1 = await loginStaff('off.reg1');
    const { verifyCode: c2 } = await apiIssue(reg1, caseNo(19), 'DOC-2569-000002');
    const { page: v } = await newSession(browser);
    await verifyAt(v, c2, '2027-11-30T23:59:00+07:00', 'VALID', '2027-11-30');
    await verifyAt(v, c2, '2027-12-01T00:00:00+07:00', 'EXPIRED', '2027-11-30');
  });

  await test.step('ส่วน C seed K7M2Q9XA ใช้ได้ถึง 2 ก.พ. 70', async () => {
    await reset();
    const { page: v } = await newSession(browser);
    await verifyAt(v, 'K7M2Q9XA', '2027-02-02T23:59:00+07:00', 'VALID', '2027-02-02');
    await verifyAt(v, 'K7M2Q9XA', '2027-02-03T00:00:00+07:00', 'EXPIRED', '2027-02-02');
  });

  await test.step('ส่วน E ออกวันที่ 29 ก.พ. 2571', async () => {
    await reset();
    await setClock('2028-02-29T10:00:00+07:00');
    const reg2 = await loginStaff('off.reg2');
    await apiApprove(reg2, caseNo(25));
    const { verifyCode: e1 } = await apiIssue(reg2, caseNo(25), 'DOC-2571-000001');
    const reg1 = await loginStaff('off.reg1');
    const { verifyCode: e2 } = await apiIssue(reg1, caseNo(19), 'DOC-2571-000002');
    const { page: v } = await newSession(browser);
    await verifyAt(v, e1, '2028-05-28T23:59:00+07:00', 'VALID', '2028-05-28');
    await verifyAt(v, e1, '2028-05-29T00:00:00+07:00', 'EXPIRED', '2028-05-28');
    await verifyAt(v, e2, '2029-02-27T23:59:00+07:00', 'VALID', '2029-02-27');
    await verifyAt(v, e2, '2029-02-28T00:00:00+07:00', 'EXPIRED', '2029-02-27');
  });

  await test.step('ส่วน D ลายเซ็นไม่ตรง (ตรวจก่อนวันหมดอายุ A-43)', async () => {
    await reset();
    await tamper('DOC-2569-000001');
    const { page: v } = await newSession(browser);
    await expectVerify(v, 'K7M2Q9XA', 'TAMPERED');
    await expect(tid(v, 'verify-doc-no')).toHaveCount(0);
    await expect(tid(v, 'verify-applicant')).toHaveCount(0);
    const api = await expectApi((await newApi()).get('/api/verify/K7M2Q9XA'), 200);
    expect(api.result).toBe('TAMPERED');
    expect(api.applicantMasked).toBeUndefined();
    expect(api.docNo).toBeUndefined();
    await verifyAt(v, 'K7M2Q9XA', '2027-03-01T00:00:00+07:00', 'TAMPERED');
    await expect(tid(v, 'verify-doc-no')).toHaveCount(0);
  });
});

// ═══════════════════════════════════ PDPA ═══════════════════════════════════

test('TC-PDPA-01 ปิดบังเลขบัตรบนจอ', async ({ browser }) => {
  await reset();
  const NO = caseNo(25);

  await test.step('off.reg2 /officer/queue', async () => {
    const { page: p } = await staffSession(browser, 'off.reg2');
    await p.goto('/officer/queue');
    await expect(tid(p, 'queue-row')).toHaveCount(17);
    const masked = (await tid(p, 'row-id-masked').allInnerTexts()).map((t) => t.trim());
    expect(masked).toHaveLength(17);
    for (const m of masked) expect(m).toMatch(MASK_RE);
    await expect(queueRow(p, NO).getByTestId('row-id-masked')).toHaveText('X-XXXX-XXXXX-65-9');
    await expect(queueRow(p, caseNo(26)).getByTestId('row-id-masked')).toHaveText('X-XXXX-XXXXX-45-6');

    await openOfficer(p, NO);
    await expect(tid(p, 'applicant-id')).toHaveText('X-XXXX-XXXXX-65-9');
    const html = await p.content();
    expect(html).not.toContain('3100600987659');
    expect(html).not.toContain('3-1006-00987-65-9');
  });

  await test.step('head1 เห็นปิดบังเหมือนกัน', async () => {
    const { page: h } = await staffSession(browser, 'head1');
    await openOfficer(h, NO);
    await expect(tid(h, 'applicant-id')).toHaveText('X-XXXX-XXXXX-65-9');
    expect(await h.content()).not.toContain('3100600987659');
  });

  await test.step('ประชาชนเห็นเลขเต็มของตัวเอง', async () => {
    const sy = await citizenSession(browser, ID.SOMYING);
    await openCitizen(sy.page, NO);
    await expect(tid(sy.page, 'case-id-full')).toHaveText('3-1006-00987-65-9');
    const sc = await citizenSession(browser, ID.SOMCHAI);
    await openCitizen(sc.page, caseNo(20));
    await expect(tid(sc.page, 'case-id-full')).toHaveText('1-1017-00123-45-6');
  });
});

test('TC-PDPA-02 API (JSON) ไม่ส่งเลขบัตรเต็ม', async () => {
  await reset();
  const URLS = [
    '/api/officer/queue?filter=all',
    `/api/cases/${caseNo(25)}`,
    `/api/cases/${caseNo(26)}`,
    `/api/cases/${caseNo(20)}`,
    '/api/notifications',
    `/api/cases/${caseNo(25)}/files`,
  ];
  for (const user of ['off.reg1', 'head1'] as const) {
    await test.step(user, async () => {
      const api = await loginStaff(user);
      for (const url of URLS) {
        const label = `${user} GET ${url}`;
        const res = await api.get(url);
        expect.soft(res.status(), label).toBe(200);
        expect.soft(res.headers()['content-type'] ?? '', label).toContain('application/json');
        const body = await bodyOf(res);
        const s = JSON.stringify(body);
        expect.soft(s, `${label} ไม่มีเลข 13 หลัก`).not.toMatch(/\d{13}/);
        expect.soft(s, `${label} ไม่มีรูปแบบ d-dddd-ddddd-dd-d`).not.toMatch(/\d-\d{4}-\d{5}-\d{2}-\d/);
        expect.soft(deepKeys(body), `${label} ไม่มี key idNo`).not.toContain('idNo');
        for (const id of [ID.SOMYING, ID.SOMCHAI, ID.PITI]) expect.soft(s, `${label} ไม่มี ${id}`).not.toContain(id);
        if (Array.isArray(body.items)) {
          for (const it of body.items) if ('idMasked' in it) expect.soft(it.idMasked, `${label} items[].idMasked`).toMatch(MASK_RE);
        }
        if (url.startsWith('/api/officer/queue')) {
          expect.soft(body.items?.length, `${label} จำนวนแถว`).toBeGreaterThan(0);
          for (const it of body.items ?? []) expect.soft(it.idMasked, `${label} ${it.caseNo}`).toMatch(MASK_RE);
        }
        if (/^\/api\/cases\/EG-\d{4}-\d{6}$/.test(url)) expect.soft(body.idMasked, `${label} idMasked`).toMatch(MASK_RE);
      }
    });
  }
});

test('TC-PDPA-03 แสดงเลขเต็มต้องมีเหตุผลและ Audit', async ({ browser }) => {
  await reset();
  const NO = caseNo(25);
  const reg2 = await staffSession(browser, 'off.reg2');
  const p = reg2.page;
  const unmaskUrl = `/api/officer/cases/${NO}/unmask`;
  await openOfficer(p, NO);

  await test.step('1–2 เหตุผลว่าง / เว้นวรรคล้วน', async () => {
    for (const [label, reason] of [
      ['ว่าง', ''],
      ['เว้นวรรคล้วน', '   '],
    ] as const) {
      await uiUnmask(p, reason);
      await expect(tid(p, 'unmask-error'), label).toHaveText(MSG.REASON_REQUIRED);
      await expect(tid(p, 'full-id'), label).toHaveCount(0);
      const e = await expectApi(reg2.api.post(unmaskUrl, { data: { reason } }), 400, 'REASON_REQUIRED');
      expect(e.message).toBe(MSG.REASON_REQUIRED);
    }
  });

  await test.step('3 เหตุผลถูกต้อง → เห็นเลขเต็ม', async () => {
    await uiUnmask(p, 'ตรวจสอบตัวตนซ้ำ');
    await expect(tid(p, 'full-id')).toHaveText('3-1006-00987-65-9');
  });

  await test.step('4 โหลดหน้าซ้ำ → ปิดบังตามเดิม', async () => {
    await p.reload();
    await expect(tid(p, 'applicant-id')).toHaveText('X-XXXX-XXXXX-65-9');
    await expect(tid(p, 'full-id')).toHaveCount(0);
  });

  await test.step('5 Audit UNMASK 1 แถว (จับ B11)', async () => {
    const { page: a } = await staffSession(browser, 'audit1');
    const [row] = await uiAuditExpect(a, { event: 'UNMASK' }, 1);
    expect(row.actor).toBe('off.reg2');
    expect(row.role).toBe('officer');
    expect(row.caseText).toBe(NO);
    expect(row.eventText).toBe('UNMASK');
    expect(row.detail).toContain('ตรวจสอบตัวตนซ้ำ');
    expect(row.iso).toBe(T0);
  });

  await test.step('6 บทบาทอื่น/ประชาชนเรียก unmask → 403', async () => {
    for (const api of [await loginStaff('exec1'), await loginStaff('audit1'), await loginCitizen(ID.SOMYING)]) {
      await expectApi(api.post(unmaskUrl, { data: { reason: 'x' } }), 403);
    }
  });
});

// ═══════════════════════════════════ DASH ═══════════════════════════════════

test('TC-DASH-01 Dashboard ตัวเลขเริ่มต้น', async ({ browser }) => {
  await reset();
  const ex = await staffSession(browser, 'exec1');
  const p = ex.page;
  await p.goto('/dashboard');
  await expect(tid(p, 'period-select')).toHaveValue('2026-12');
  await expect(tid(p, 'service-select')).toHaveValue('ALL');

  await test.step('ALL ธ.ค. บนจอและ API', async () => {
    const k: Kpis = { received: 3, closed: 0, pct: '–', backlog: 21, overdue: 1 };
    await expectKpis(p, k);
    const d = await getDashboard(ex.api, '2026-12', 'ALL');
    expectDash(d, k);
    expect(d.ontimePct).toBeNull();

    const WL: Record<string, number> = { 'off.reg1': 3, 'off.reg2': 9, 'off.works1': 0 };
    await expect(tid(p, 'workload-row')).toHaveCount(3);
    for (const [u, n] of Object.entries(WL)) {
      await expect(rowBy(p, 'workload-row', 'data-username', u).getByTestId('workload-value')).toHaveText(String(n));
    }
    const wl = Object.fromEntries((d.workload as Array<{ username: string; count: number }>).map((w) => [w.username, w.count]));
    expect(wl).toEqual(WL);
  });

  await test.step('ไม่มีข้อมูลส่วนบุคคลบนจอ (BR-24)', async () => {
    const text = await p.locator('body').innerText();
    expect(text).not.toMatch(/\d{13}/);
    expect(text).not.toMatch(/0\d{9}/);
    expect(piiHits([text])).toEqual([]);
  });

  await test.step('ตัวกรองบริการ', async () => {
    const ROWS: Array<[string, Kpis]> = [
      ['SV-01', { received: 3, closed: 0, pct: '–', backlog: 11, overdue: 1 }],
      ['SV-02', { received: 0, closed: 0, pct: '–', backlog: 7, overdue: 0 }],
      ['SV-03', { received: 0, closed: 0, pct: '–', backlog: 3, overdue: 0 }],
    ];
    for (const [svc, k] of ROWS) {
      await uiDashboard(p, '2026-12', svc);
      await expectKpis(p, k);
      expectDash(await getDashboard(ex.api, '2026-12', svc), k, svc);
    }
  });
});

test('TC-DASH-02 Dashboard ย้อนหลัง พ.ย. ต.ค. รายปี', async ({ browser }) => {
  await reset();
  const ex = await staffSession(browser, 'exec1');
  const p = ex.page;
  await p.goto('/dashboard');
  const ROWS: Array<[string, string, number, number, number, string]> = [
    // period, service, received, closed, onTime, pct
    ['2026-10', 'ALL', 1, 1, 1, '100.0%'],
    ['2026-11', 'ALL', 26, 7, 6, '85.7%'],
    ['2026-11', 'SV-01', 12, 3, 3, '100.0%'],
    ['2026-11', 'SV-02', 10, 3, 2, '66.7%'],
    ['2026-11', 'SV-03', 4, 1, 1, '100.0%'],
    ['2026', 'ALL', 30, 8, 7, '87.5%'],
    ['2026', 'SV-01', 16, 4, 4, '100.0%'],
    ['2026', 'SV-02', 10, 3, 2, '66.7%'],
    ['2026', 'SV-03', 4, 1, 1, '100.0%'],
  ];
  for (const [period, svc, received, closed, onTime, pct] of ROWS) {
    await test.step(`${period} ${svc}`, async () => {
      const k: Kpis = { received, closed, pct, ...NOW_BY_SERVICE[svc] };
      expectDash(await getDashboard(ex.api, period, svc), { ...k, onTime }, `${period} ${svc}`);
      await uiDashboard(p, period, svc);
      await expectKpis(p, k);
    });
  }
});

test('TC-DASH-03 ส่งออก Excel/PDF เท่าหน้าจอ และไม่มีข้อมูลส่วนบุคคล', async ({ browser }) => {
  await reset();
  const ex = await staffSession(browser, 'exec1');
  const p = ex.page;
  await p.goto('/dashboard');
  const LABELS = ['รับเรื่อง', 'ปิดงาน', 'ทันกำหนด %', 'งานคงค้าง', 'เกินกำหนดคงค้าง'];
  const XLSX_CT = /spreadsheet|excel|octet-stream|zip/i;

  /** อ่านค่า 5 ช่องบนจอ */
  const screenKpis = async () =>
    Promise.all(['kpi-received', 'kpi-closed', 'kpi-ontime-pct', 'kpi-backlog', 'kpi-overdue'].map(async (id) => (await tid(p, id).innerText()).trim()));

  /** ส่งออก xlsx แล้วตรวจชีตแรก = ค่าที่คาด = ค่าบนจอ */
  async function checkXlsx(expected: string[]): Promise<void> {
    const f = await grabDownload(p, () => tid(p, 'export-xlsx-btn').click(), XLSX_CT);
    expect(f.status).toBe(200);
    const sheets = xlsxSheets(f.body);
    expect(sheets.length).toBeGreaterThan(0);
    const cells = sheets[0].cells;
    expect(cells.get('A1')).toBe('ตัวชี้วัด');
    expect(cells.get('B1')).toBe('ค่า');
    expect([2, 3, 4, 5, 6].map((r) => cells.get(`A${r}`))).toEqual(LABELS);
    const values = [2, 3, 4, 5, 6].map((r) => (cells.get(`B${r}`) ?? '').trim());
    expect(values).toEqual(expected);
    expect(values).toEqual(await screenKpis());
    expect(piiHits(xlsxAllText(sheets)), 'ข้อมูลส่วนบุคคลใน xlsx').toEqual([]);
  }

  await test.step('พ.ย. ALL → xlsx', async () => {
    await uiDashboard(p, '2026-11', 'ALL');
    await expectKpis(p, { received: 26, closed: 7, pct: '85.7%', backlog: 21, overdue: 1 });
    await checkXlsx(['26', '7', '85.7%', '21', '1']);
  });

  await test.step('พ.ย. ALL → pdf', async () => {
    const f = await grabDownload(p, () => tid(p, 'export-pdf-btn').click(), /pdf/i);
    expect(f.status).toBe(200);
    expect(f.contentType).toContain('application/pdf');
    const t = pdfText(f.body);
    const line = 'kpi received=26 closed=7 ontime=85.7% backlog=21 overdue=1';
    expect(pdfHasLine(t, line), line).toBe(true);
    expect(piiHits(t.lines), 'ข้อมูลส่วนบุคคลใน PDF').toEqual([]);
  });

  await test.step('ธ.ค. ALL → xlsx', async () => {
    await uiDashboard(p, '2026-12', 'ALL');
    await expectKpis(p, { received: 3, closed: 0, pct: '–', backlog: 21, overdue: 1 });
    await checkXlsx(['3', '0', '–', '21', '1']);
  });

  await test.step('Audit EXPORT 3 แถว', async () => {
    const { page: a } = await staffSession(browser, 'audit1');
    const rows = await uiAuditExpect(a, { event: 'EXPORT' }, 3);
    for (const r of rows) {
      expect(r.actor).toBe('exec1');
      expect(r.role).toBe('executive');
    }
    const want: Array<[string, string]> = [
      ['xlsx', '2026-11'],
      ['pdf', '2026-11'],
      ['xlsx', '2026-12'],
    ];
    for (const [fmt, period] of want) {
      expect(
        rows.some((r) => r.detail.includes(fmt) && r.detail.includes(period)),
        `audit-detail มี ${fmt} ${period}: ${JSON.stringify(rows.map((r) => r.detail))}`,
      ).toBe(true);
    }
  });
});

test('TC-DASH-04 ค่าขอบ "ทันกำหนด" 16:29:59 / 16:30:00 / 16:30:01', async ({ browser }) => {
  await reset();
  await setClock('2026-12-03T16:00:00+07:00');
  const reg1 = await staffSession(browser, 'off.reg1');
  const reg2 = await staffSession(browser, 'off.reg2');
  const ex = await staffSession(browser, 'exec1');

  /** closed-at บนหน้าเคส + API */
  async function expectClosed(s: { page: Page; api: APIRequestContext }, no: string, iso: string): Promise<void> {
    expect((await getCase(s.api, no)).closedAt).toBe(iso);
    await openOfficer(s.page, no);
    await expect(tid(s.page, 'closed-at')).toHaveAttribute('data-iso', iso);
  }

  /** Dashboard ธ.ค. ALL ทั้ง API และจอ */
  async function expectDec(closed: number, onTime: number): Promise<void> {
    expectDash(await getDashboard(ex.api, '2026-12'), { closed, onTime });
    await ex.page.goto('/dashboard');
    await expectKpis(ex.page, { closed });
  }

  await test.step('1 16:00:00 อนุมัติ …000025 และ …000023', async () => {
    await apiApprove(reg2.api, caseNo(25));
    await apiApprove(reg1.api, caseNo(23));
  });

  await test.step('2 16:29:59 ออกเอกสาร …000025 → ทัน', async () => {
    const t = '2026-12-03T16:29:59+07:00';
    await setClock(t);
    await apiIssue(reg2.api, caseNo(25));
    await expectClosed(reg2, caseNo(25), t);
    await expectDec(1, 1);
  });

  await test.step('3 16:30:00 ไม่อนุมัติ …000026 → ทัน (ที่ขอบ)', async () => {
    const t = '2026-12-03T16:30:00+07:00';
    await setClock(t);
    await apiReject(reg2.api, caseNo(26));
    await expectClosed(reg2, caseNo(26), t);
    await expectDec(2, 2);
  });

  await test.step('4 16:30:01 ออกเอกสาร …000023 → ไม่ทัน', async () => {
    const t = '2026-12-03T16:30:01+07:00';
    await setClock(t);
    await apiIssue(reg1.api, caseNo(23));
    await expectClosed(reg1, caseNo(23), t);
    await expectDec(3, 2);
    expectDash(await getDashboard(ex.api, '2026-12'), { backlog: 18 });
    await expectKpis(ex.page, { backlog: 18 });
  });
});

// ═══════════════════════════════════ AUDIT ═══════════════════════════════════

test('TC-AUDIT-01 เหตุการณ์และฟิลด์ใน Audit', async ({ browser }) => {
  await reset();
  const ARROW = (a: string, b: string) => `${a} → ${b}`;
  type Exp = { event: string; actor: StaffUser; role: string; caseNo?: string; transition?: string; detail?: string[] };
  const LOG: Exp[] = [];
  const log = (e: Exp) => LOG.push(e);

  await test.step('ทำรายการผ่าน API (ล็อกอินบัญชีละครั้ง)', async () => {
    const reg2 = await loginStaff('off.reg2');
    log({ event: 'STAFF_LOGIN', actor: 'off.reg2', role: 'officer' });
    expect((await claim(reg2, caseNo(28))).owner).toBe('off.reg2');
    log({ event: 'CLAIM', actor: 'off.reg2', role: 'officer', caseNo: caseNo(28), transition: ARROW('SUBMITTED', 'IN_REVIEW') });

    const reg1 = await loginStaff('off.reg1');
    log({ event: 'STAFF_LOGIN', actor: 'off.reg1', role: 'officer' });
    await returnCase(reg1, caseNo(20), R10);
    log({ event: 'RETURN', actor: 'off.reg1', role: 'officer', caseNo: caseNo(20), transition: ARROW('IN_REVIEW', 'NEED_FIX'), detail: [R10] });

    const fw = await expectApi(forwardRaw(reg2, caseNo(13)), 200);
    expect(fw.status).toBe('PENDING_APPROVAL');
    log({ event: 'FORWARD', actor: 'off.reg2', role: 'officer', caseNo: caseNo(13), transition: ARROW('IN_REVIEW', 'PENDING_APPROVAL') });

    const head = await loginStaff('head1');
    log({ event: 'STAFF_LOGIN', actor: 'head1', role: 'head' });
    await apiApprove(head, caseNo(13));
    log({ event: 'APPROVE', actor: 'head1', role: 'head', caseNo: caseNo(13), transition: ARROW('PENDING_APPROVAL', 'APPROVED') });

    await apiApprove(reg2, caseNo(25));
    log({ event: 'APPROVE', actor: 'off.reg2', role: 'officer', caseNo: caseNo(25), transition: ARROW('IN_REVIEW', 'APPROVED') });
    await apiIssue(reg2, caseNo(25), 'DOC-2569-000002');
    log({ event: 'ISSUE', actor: 'off.reg2', role: 'officer', caseNo: caseNo(25), transition: ARROW('APPROVED', 'COMPLETED'), detail: ['DOC-2569-000002'] });
    await apiReject(reg2, caseNo(26), R10);
    log({ event: 'REJECT', actor: 'off.reg2', role: 'officer', caseNo: caseNo(26), transition: ARROW('IN_REVIEW', 'REJECTED'), detail: [R10] });
    const um = await expectApi(reg2.post(`/api/officer/cases/${caseNo(25)}/unmask`, { data: { reason: 'ตรวจสอบตัวตนซ้ำ' } }), 200);
    expect(um.idNo).toBe(ID.SOMYING);
    log({ event: 'UNMASK', actor: 'off.reg2', role: 'officer', caseNo: caseNo(25), detail: ['ตรวจสอบตัวตนซ้ำ'] });

    const ex = await loginStaff('exec1');
    log({ event: 'STAFF_LOGIN', actor: 'exec1', role: 'executive' });
    const xr = await ex.get('/api/dashboard/export?format=xlsx&period=2026-12&service=ALL');
    expect(xr.status()).toBe(200);
    log({ event: 'EXPORT', actor: 'exec1', role: 'executive', detail: ['xlsx', '2026-12'] });

    const admin = await loginStaff('admin1');
    log({ event: 'STAFF_LOGIN', actor: 'admin1', role: 'admin' });
    await expectApi(admin.put('/api/admin/services/SV-01', { data: { fee: 25, sla: 3 } }), 200);
    log({ event: 'ADMIN_CHANGE', actor: 'admin1', role: 'admin', detail: ['SV-01 fee 20 → 25'] });
  });

  const auditor = await staffSession(browser, 'audit1');
  log({ event: 'STAFF_LOGIN', actor: 'audit1', role: 'auditor' });
  const p = auditor.page;
  let screen: AuditRowUi[] = [];

  await test.step('ไม่กรอง: 16 แถว ฟิลด์ครบ เรียงใหม่ → เก่า', async () => {
    screen = await uiAuditExpect(p, {}, 16);
    // เวลาเท่ากันทั้งหมด → เรียง data-id มาก → น้อย
    const ids = screen.map((r) => r.id);
    if (ids.every((i) => /^\d+$/.test(i))) {
      const nums = ids.map(Number);
      expect(nums, 'data-id เรียงมาก → น้อย').toEqual([...nums].sort((a, b) => b - a));
      expect(screen.map((r) => `${r.event}:${r.actor}`), 'ลำดับใหม่ → เก่า').toEqual(LOG.map((e) => `${e.event}:${e.actor}`).reverse());
    } else {
      expect(ids, 'data-id เรียงมาก → น้อย').toEqual([...ids].sort().reverse());
    }
    const left = [...screen];
    for (const e of LOG) {
      const i = left.findIndex((r) => r.event === e.event && r.actor === e.actor && (r.caseNo || '') === (e.caseNo ?? ''));
      expect(i, `ต้องมีแถว ${e.event} ${e.actor} ${e.caseNo ?? ''}`).toBeGreaterThanOrEqual(0);
      const r = left.splice(i, 1)[0];
      const label = `${e.event} ${e.actor} ${e.caseNo ?? ''}`;
      expect.soft(r.eventText, label).toBe(e.event);
      expect.soft(r.actorText, label).toBe(e.actor);
      expect.soft(r.role, label).toBe(e.role);
      if (e.caseNo) expect.soft(r.caseText, label).toBe(e.caseNo);
      else expect.soft(r.caseText, label).toMatch(/^[–-]?$/);
      expect.soft(r.transition, label).toBe(e.transition ?? '–');
      for (const d of e.detail ?? []) expect.soft(r.detail, label).toContain(d);
      expect.soft(r.iso, label).toBe(T0);
    }
    expect(left).toEqual([]);
    expect(await auditItems(auditor.api)).toHaveLength(16);
  });

  await test.step('กรอง actor / event', async () => {
    const mine = await uiAuditExpect(p, { actor: 'off.reg2' }, 7);
    expect(mine.map((r) => r.event).sort()).toEqual(['APPROVE', 'CLAIM', 'FORWARD', 'ISSUE', 'REJECT', 'STAFF_LOGIN', 'UNMASK']);
    const approve = await uiAuditExpect(p, { event: 'APPROVE' }, 2);
    expect(approve.map((r) => r.actor).sort()).toEqual(['head1', 'off.reg2']);
    const both = await uiAuditExpect(p, { actor: 'off.reg2', event: 'APPROVE' }, 1);
    expect(both[0].caseNo).toBe(caseNo(25));
    expect(await auditItems(auditor.api, { actor: 'off.reg2' })).toHaveLength(7);
    expect(await auditItems(auditor.api, { event: 'APPROVE' })).toHaveLength(2);
    expect(await auditItems(auditor.api, { actor: 'off.reg2', event: 'APPROVE' })).toHaveLength(1);
  });

  await test.step('ส่งออก CSV = หน้าจอ แล้วเพิ่ม EXPORT ของ audit1', async () => {
    const rows = await uiAuditExpect(p, {}, 16);
    const f = await grabDownload(p, () => tid(p, 'audit-export-csv-btn').click(), /csv|text\/plain|octet-stream/i);
    expect(f.status).toBe(200);
    const csv = parseCsv(f.body.toString('utf8'));
    expect(csv[0].join(',')).toBe('time,username,role,event,caseNo,fromStatus,toStatus,detail');
    const data = csv.slice(1);
    expect(data).toHaveLength(16);
    expect(data.map((r) => `${r[3]}:${r[1]}`)).toEqual(rows.map((r) => `${r.event}:${r.actor}`));
    expect(piiHits(data.flat()).filter((h) => !h.startsWith('ชื่อ'))).toEqual([]);

    await p.goto('/audit');
    await expect(tid(p, 'audit-count')).toHaveText('17');
    const [top] = await auditRowsUi(p);
    expect(top.event).toBe('EXPORT');
    expect(top.actor).toBe('audit1');
    expect(top.role).toBe('auditor');
    expect(top.detail).toContain('audit-csv');
  });
});

test('TC-AUDIT-02 Audit แก้/ลบไม่ได้ (405)', async ({ browser }) => {
  await reset();
  const auditor = await loginStaff('audit1');
  const before = await auditItems(auditor);
  expect(before).toHaveLength(1);
  expect(before[0].event).toBe('STAFF_LOGIN');
  const id = before[0].id;

  const admin = await loginStaff('admin1');
  for (const [who, api] of [
    ['admin1', admin],
    ['audit1', auditor],
  ] as const) {
    await test.step(`${who} แก้/ลบ Audit → 405`, async () => {
      const calls: Array<[string, () => Promise<APIResponse>]> = [
        [`PUT /api/audit/${id}`, () => api.put(`/api/audit/${id}`, { data: { detail: 'x' } })],
        [`PATCH /api/audit/${id}`, () => api.patch(`/api/audit/${id}`, { data: { detail: 'x' } })],
        [`DELETE /api/audit/${id}`, () => api.delete(`/api/audit/${id}`)],
        ['PUT /api/audit', () => api.put('/api/audit', { data: { detail: 'x' } })],
        ['DELETE /api/audit', () => api.delete('/api/audit')],
        ['DELETE /api/audit/999999', () => api.delete('/api/audit/999999')],
      ];
      for (const [label, call] of calls) {
        const r = await call();
        const b = await bodyOf(r);
        expect.soft(r.status(), `${who} ${label}`).toBe(405);
        expect.soft(b.code, `${who} ${label}`).toBe('METHOD_NOT_ALLOWED');
      }
    });
  }

  await test.step('ข้อมูลเดิมครบ เพิ่มเฉพาะ STAFF_LOGIN ของ admin1', async () => {
    const after = await auditItems(auditor);
    for (const b of before) expect(after).toContainEqual(b);
    expect(after).toHaveLength(before.length + 1);
    const added = after.filter((a) => !before.some((b) => b.id === a.id));
    expect(added).toHaveLength(1);
    expect(added[0].event).toBe('STAFF_LOGIN');
    expect(added[0].username).toBe('admin1');
  });

  await test.step('UI ไม่มีปุ่มแก้/ลบ · admin อ่าน Audit ไม่ได้', async () => {
    const { page: p } = await pageFromApi(browser, auditor);
    await p.goto('/audit');
    await expect(tid(p, 'audit-row')).not.toHaveCount(0);
    await expect(tid(p, 'audit-edit-btn')).toHaveCount(0);
    await expect(tid(p, 'audit-delete-btn')).toHaveCount(0);
    await expectApi(admin.get('/api/audit'), 403);
  });
});

test('TC-AUDIT-03 กรองช่วงวันที่ตามเวลาไทย', async ({ browser }) => {
  await reset();
  const L: Record<string, { iso: string; user: StaffUser }> = {
    L1: { iso: '2026-11-30T23:59:59+07:00', user: 'off.reg1' },
    L2: { iso: '2026-12-01T00:00:00+07:00', user: 'off.reg2' },
    L3: { iso: '2026-12-01T23:59:59+07:00', user: 'off.works1' },
    L4: { iso: '2026-12-02T00:00:00+07:00', user: 'off.reg1' },
    L5: { iso: '2026-12-02T09:00:00+07:00', user: 'audit1' },
  };
  let auditor!: APIRequestContext;
  for (const [k, { iso, user }] of Object.entries(L)) {
    await setClock(iso);
    const api = await loginStaff(user);
    if (k === 'L5') auditor = api;
  }
  const { page: p } = await pageFromApi(browser, auditor);

  const CASES: Array<{ from: string; to: string; actor?: string; rows: string[] }> = [
    { from: '2026-12-01', to: '2026-12-01', rows: ['L2', 'L3'] },
    { from: '2026-11-30', to: '2026-11-30', rows: ['L1'] },
    { from: '2026-11-30', to: '2026-12-01', rows: ['L1', 'L2', 'L3'] },
    { from: '2026-12-02', to: '', rows: ['L4', 'L5'] },
    { from: '', to: '2026-11-30', rows: ['L1'] },
    { from: '2026-12-01', to: '2026-12-02', rows: ['L2', 'L3', 'L4', 'L5'] },
    { from: '2026-12-01', to: '2026-12-01', actor: 'off.reg2', rows: ['L2'] },
  ];
  for (const c of CASES) {
    await test.step(`from=${c.from || '(ว่าง)'} to=${c.to || '(ว่าง)'}${c.actor ? ` actor=${c.actor}` : ''}`, async () => {
      // ใหม่ → เก่า
      const want = c.rows.map((k) => L[k]).sort((a, b) => b.iso.localeCompare(a.iso));
      const rows = await uiAuditExpect(p, { from: c.from, to: c.to, actor: c.actor }, want.length);
      expect(rows.map((r) => r.iso)).toEqual(want.map((w) => w.iso));
      expect(rows.map((r) => r.actor)).toEqual(want.map((w) => w.user));
      const api = await auditItems(auditor, { from: c.from || undefined, to: c.to || undefined, actor: c.actor });
      expect(api.map((a) => a.time).sort()).toEqual(want.map((w) => w.iso).sort());
    });
  }
});

// ═══════════════════════════════════ RBAC ═══════════════════════════════════

test('TC-RBAC-01 ประชาชนเปิดคำขอคนอื่นไม่ได้ (IDOR)', async ({ browser }) => {
  await reset();
  const sy = await citizenSession(browser, ID.SOMYING);
  const p = sy.page;

  await test.step('UI คำขอของสมชาย → 404', async () => {
    const res = await p.goto(`/citizen/cases/${caseNo(5)}`);
    expect(res?.status(), `สมหญิงเปิด /citizen/cases/${caseNo(5)} (ของสมชาย) ต้องได้ HTTP`).toBe(404);
    await expect(tid(p, 'not-found-msg')).toHaveText(MSG.NOT_FOUND);
    await expect(tid(p, 'case-no')).toHaveCount(0);
    await expect(tid(p, 'case-status')).toHaveCount(0);
    expect(await p.content()).not.toContain('สมชาย');
  });

  await test.step('API ของคนอื่น = ไม่มีจริง (404 เหมือนกันทุกตัวอักษร)', async () => {
    const other = await sy.api.get(`/api/cases/${caseNo(5)}`);
    const none = await sy.api.get('/api/cases/EG-2569-999999');
    expect(other.status()).toBe(404);
    expect(none.status()).toBe(404);
    expect(await bodyOf(other)).toEqual({ code: 'NOT_FOUND', message: MSG.NOT_FOUND });
    expect(await none.text()).toBe(await other.text());
    await expectApi(sy.api.get('/api/documents/DOC-2569-000001/pdf'), 404);
    await expectApi(sy.api.get('/api/drafts/DR-0001'), 404);
    await expectApi(sy.api.post(`/api/cases/${caseNo(30)}/cancel`), 404);
  });

  await test.step('ของตัวเองเปิดได้ · สมชายเปิดของตัวเองได้', async () => {
    const res = await p.goto(`/citizen/cases/${caseNo(7)}`);
    expect(res?.status()).toBe(200);
    await expect(tid(p, 'case-no')).toHaveText(caseNo(7));
    const sc = await loginCitizen(ID.SOMCHAI);
    await expectApi(sc.get(`/api/cases/${caseNo(5)}`), 200);
    expect((await getCase(sc, caseNo(30))).status).toBe('SUBMITTED');
  });
});

test('TC-RBAC-02 เจ้าหน้าที่อนุมัติ SV-02 ไม่ได้ (API)', async ({ browser }) => {
  await reset();
  const reg2 = await staffSession(browser, 'off.reg2');

  await test.step('1–3 off.reg2 approve/reject SV-02 ทาง API → 403', async () => {
    await expectApi(approveRaw(reg2.api, caseNo(14)), 403, 'FORBIDDEN');
    expect((await getCase(reg2.api, caseNo(14))).status).toBe('PENDING_APPROVAL');
    await expectApi(approveRaw(reg2.api, caseNo(13)), 403, 'FORBIDDEN');
    expect((await getCase(reg2.api, caseNo(13))).status).toBe('IN_REVIEW');
    await expectApi(rejectRaw(reg2.api, caseNo(14), R10), 403);
    expect((await getCase(reg2.api, caseNo(14))).status).toBe('PENDING_APPROVAL');
  });

  await test.step('4 UI ไม่มี approve-btn', async () => {
    for (const n of [13, 14]) {
      await openOfficer(reg2.page, caseNo(n));
      await expect(tid(reg2.page, 'approve-btn')).toHaveCount(0);
    }
  });

  await test.step('5–6 head1: SV-01 → 403 · SV-02 รออนุมัติ → 200', async () => {
    const head = await loginStaff('head1');
    await expectApi(approveRaw(head, caseNo(25)), 403);
    expect((await getCase(head, caseNo(25))).status).toBe('IN_REVIEW');
    await apiApprove(head, caseNo(14));
  });

  await test.step('7 Audit APPROVE มีเฉพาะ head1', async () => {
    const { page: a } = await staffSession(browser, 'audit1');
    const rows = await uiAuditExpect(a, { event: 'APPROVE' }, 1);
    expect(rows[0].actor).toBe('head1');
    expect(rows[0].caseNo).toBe(caseNo(14));
  });
});

test('TC-RBAC-03 ตารางสิทธิ์หน้า/API ตามบทบาท', async ({ browser }) => {
  test.setTimeout(300_000);
  type Role = 'anon' | 'citizen' | 'officer' | 'head' | 'executive' | 'auditor' | 'admin';
  const ROLES: Role[] = ['anon', 'citizen', 'officer', 'head', 'executive', 'auditor', 'admin'];
  const USER: Partial<Record<Role, StaffUser>> = { officer: 'off.reg1', head: 'head1', executive: 'exec1', auditor: 'audit1', admin: 'admin1' };
  const by = <T,>(...v: T[]): Record<Role, T> => Object.fromEntries(ROLES.map((r, i) => [r, v[i]])) as Record<Role, T>;

  type PageExp = 'ok' | 403 | 'login';
  const PAGES: Array<[string, Record<Role, PageExp>]> = [
    ['/citizen', by<PageExp>('login', 'ok', 403, 403, 403, 403, 403)],
    ['/officer/queue', by<PageExp>('login', 403, 'ok', 'ok', 403, 403, 403)],
    ['/head/approvals', by<PageExp>('login', 403, 403, 'ok', 403, 403, 403)],
    ['/dashboard', by<PageExp>('login', 403, 403, 403, 'ok', 403, 403)],
    ['/audit', by<PageExp>('login', 403, 403, 403, 403, 'ok', 403)],
    ['/admin/services', by<PageExp>('login', 403, 403, 403, 403, 403, 'ok')],
    ['/admin/holidays', by<PageExp>('login', 403, 403, 403, 403, 403, 'ok')],
    ['/admin/users', by<PageExp>('login', 403, 403, 403, 403, 403, 'ok')],
    ['/notifications', by<PageExp>('login', 403, 'ok', 'ok', 403, 403, 403)],
    ['/verify/K7M2Q9XA', by<PageExp>('ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok')],
  ];

  type Ctx = { api: APIRequestContext; somying: APIRequestContext };
  const APIS: Array<[string, (c: Ctx) => Promise<APIResponse>, Record<Role, number>]> = [
    ['GET /api/officer/queue', (c) => c.api.get('/api/officer/queue'), by(401, 403, 200, 200, 403, 403, 403)],
    ['GET /api/notifications', (c) => c.api.get('/api/notifications'), by(401, 403, 200, 200, 403, 403, 403)],
    ['GET /api/dashboard', (c) => c.api.get('/api/dashboard?period=2026-12&service=ALL'), by(401, 403, 403, 403, 200, 403, 403)],
    ['GET /api/audit', (c) => c.api.get('/api/audit'), by(401, 403, 403, 403, 403, 200, 403)],
    ['GET /api/admin/services', (c) => c.api.get('/api/admin/services'), by(401, 403, 403, 403, 403, 403, 200)],
    ['POST /api/drafts', (c) => c.api.post('/api/drafts', { data: { serviceId: 'SV-01', qty: 1 } }), by(401, 201, 403, 403, 403, 403, 403)],
    ['GET /api/cases/EG-2569-000025', (c) => c.somying.get(`/api/cases/${caseNo(25)}`), by(401, 200, 200, 200, 403, 403, 403)],
    // แถว claim เรียกท้ายสุด (ผู้ถือเรื่องยังไม่เปลี่ยนก่อน)
    ['POST claim EG-2569-000028', (c) => c.api.post(`/api/officer/cases/${caseNo(28)}/claim`), by(401, 403, 200, 403, 403, 403, 403)],
  ];

  const NAVS = ['nav-my-cases', 'nav-queue', 'nav-approvals', 'nav-dashboard', 'nav-audit', 'nav-admin-services', 'nav-admin-holidays', 'nav-admin-users', 'nav-bell'];
  const NAV_OF: Partial<Record<Role, string[]>> = {
    citizen: ['nav-my-cases'],
    officer: ['nav-queue', 'nav-bell'],
    head: ['nav-queue', 'nav-approvals', 'nav-bell'],
    executive: ['nav-dashboard'],
    auditor: ['nav-audit'],
    admin: ['nav-admin-services', 'nav-admin-holidays', 'nav-admin-users'],
  };
  const LANDING: Partial<Record<Role, string>> = {
    citizen: '/citizen',
    officer: '/officer/queue',
    head: '/head/approvals',
    executive: '/dashboard',
    auditor: '/audit',
    admin: '/admin/services',
  };

  for (const role of ROLES) {
    await test.step(`บทบาท ${role}`, async () => {
      await reset();
      const s =
        role === 'anon'
          ? await newSession(browser)
          : role === 'citizen'
            ? await citizenSession(browser, ID.SOMCHAI)
            : await staffSession(browser, USER[role]!);
      const p = s.page;

      // ส่วน A หน้า
      for (const [url, exp] of PAGES) {
        const want = exp[role];
        const label = `${role} ${url}`;
        const res = await p.goto(url);
        if (want === 'login') {
          expect.soft(pathOf(p), `${label} → /login`).toBe('/login');
        } else if (want === 403) {
          expect.soft(res?.status(), label).toBe(403);
          await expect.soft(tid(p, 'forbidden-msg'), label).toHaveText(MSG.FORBIDDEN_PAGE);
        } else {
          expect.soft(res?.status(), label).toBe(200);
          expect.soft(pathOf(p), label).toBe(url);
        }
      }

      // ส่วน D เมนู
      if (role !== 'anon') {
        await p.goto(LANDING[role]!);
        const want = NAV_OF[role]!;
        for (const nav of NAVS) await expect.soft(tid(p, nav), `${role} ${nav}`).toHaveCount(want.includes(nav) ? 1 : 0);
      }

      // ส่วน B API
      const api = role === 'anon' ? await newApi() : s.api;
      const somying = role === 'anon' ? api : role === 'citizen' ? await loginCitizen(ID.SOMYING) : api;
      for (const [label, call, exp] of APIS) {
        const r = await call({ api, somying });
        expect.soft(r.status(), `${role} ${label}`).toBe(exp[role]);
      }
    });
  }

  await test.step('ส่วน C ขอบเขตแผนก', async () => {
    await reset();
    const works = await loginStaff('off.works1');
    const reg1 = await loginStaff('off.reg1');
    await expectApi(claimRaw(works, caseNo(28)), 403);
    await expectApi(claimRaw(reg1, caseNo(10)), 403);
    expect((await queueItems(works, 'all')).map((i) => i.caseNo)).toEqual([caseNo(10)]);
  });
});

test('TC-RBAC-04 ผู้ดูแลระบบ: บริการ วันหยุด ผู้ใช้ และยอดที่ล็อก', async ({ browser }) => {
  test.setTimeout(240_000);
  await reset();
  const admin = await staffSession(browser, 'admin1');
  const a = admin.page;
  const HOLIDAYS = ['2026-12-07', '2026-12-10', '2026-12-31', '2027-01-01'];

  await test.step('1 วันหยุดตั้งต้น 4 วัน', async () => {
    await a.goto('/admin/holidays');
    await expect(tid(a, 'holiday-row')).toHaveCount(4);
    expect(((await attrs(tid(a, 'holiday-row'), 'data-date')) as string[]).sort()).toEqual(HOLIDAYS);
  });

  let sc!: APIRequestContext;
  await test.step('2 NEW_PAID ก่อนแก้ → …000031 กำหนด 4 ธ.ค.', async () => {
    const c = await newPaid({ idNo: ID.SOMCHAI, service: 'SV-01', qty: 1 });
    sc = c.api;
    expect(c.fee).toBe(20);
    expect(c.caseNo).toBe(caseNo(31));
    expect((await getCase(sc, caseNo(31))).dueAt).toBe('2026-12-04T16:30:00+07:00');
  });

  await test.step('3 แก้ค่าธรรมเนียม SV-01 = 25 · SV-02 = 600', async () => {
    for (const [svc, fee] of [
      ['SV-01', '25'],
      ['SV-02', '600'],
    ] as const) {
      await a.goto('/admin/services');
      await tid(a, `svc-fee-${svc}`).fill(fee);
      await act(a, () => tid(a, `svc-save-${svc}`).click(), { reload: false });
      await expect(tid(a, 'action-success'), svc).toBeVisible();
    }
    const items = (await expectApi(admin.api.get('/api/admin/services'), 200)).items as any[];
    expect(items.find((i) => i.id === 'SV-01').fee).toBe(25);
    expect(items.find((i) => i.id === 'SV-02').fee).toBe(600);
  });

  await test.step('4 ร่างใหม่ใช้ค่าใหม่ · คำขอเดิมไม่เปลี่ยน', async () => {
    const { page: c } = await pageFromApi(browser, sc);
    await c.goto('/citizen/new/SV-01');
    await fillField(tid(c, 'qty-input'), '5');
    await expect(tid(c, 'fee-total')).toHaveText('฿125');
    await fillField(tid(c, 'qty-input'), '1');
    await expect(tid(c, 'fee-total')).toHaveText('฿25');
    await c.goto('/citizen/new/SV-02');
    await expect(tid(c, 'fee-total')).toHaveText('฿600');
    expect((await createDraft(sc, 'SV-01', { qty: 5 })).fee).toBe(125);
    expect((await createDraft(sc, 'SV-02')).fee).toBe(600);
    await openCitizen(c, caseNo(30));
    await expect(tid(c, 'case-fee')).toHaveText('฿20');
  });

  await test.step('5 PP-0001 ยอดที่ล็อก ฿500', async () => {
    const { page: c } = await pageFromApi(browser, sc);
    await c.goto('/citizen/new/SV-02?draft=DR-0002');
    await c.waitForLoadState('networkidle').catch(() => {});
    const amt = tid(c, 'payment-amount');
    if (!(await amt.isVisible())) {
      // ร่างเปิดที่ขั้นก่อนหน้า → เดินไปขั้นชำระ (ร่างนี้แนบเอกสารครบแล้ว)
      if (await tid(c, 'to-upload-btn').isVisible()) await tid(c, 'to-upload-btn').click();
      await tid(c, 'to-payment-btn').click();
    }
    await expect(amt).toHaveText('฿500');
    expect((await getPayment(sc, 'PP-0001')).amount).toBe(500);
    await expectApi(payRaw('PP-0001', 600), 422, 'AMOUNT_MISMATCH');
    expect((await pay('PP-0001', 500)).caseNo).toBe(caseNo(32));
  });

  await test.step('6 เพิ่มวันหยุด 2 ธ.ค. → คำขอเดิมไม่คำนวณใหม่', async () => {
    await a.goto('/admin/holidays');
    await tid(a, 'holiday-date-input').fill('2026-12-02');
    await tid(a, 'holiday-name-input').fill('วันหยุดทดสอบ');
    await act(a, () => tid(a, 'holiday-add-btn').click());
    await expect(tid(a, 'holiday-row')).toHaveCount(5);
    await expect(rowBy(a, 'holiday-row', 'data-date', '2026-12-02')).toHaveCount(1);
    expect((await getCase(sc, caseNo(31))).dueAt).toBe('2026-12-04T16:30:00+07:00');
  });

  await test.step('7 NEW_PAID หลังเพิ่มวันหยุด → …000033 กำหนด 8 ธ.ค.', async () => {
    const c = await newPaid({ idNo: ID.SOMCHAI, service: 'SV-01', qty: 1 });
    expect(c.fee).toBe(25);
    expect(c.caseNo).toBe(caseNo(33));
    expect((await getCase(c.api, caseNo(33))).dueAt).toBe('2026-12-08T16:30:00+07:00');
  });

  let exPage!: Page;
  await test.step('8 เปลี่ยน exec1 เป็น auditor → ล็อกอินใหม่ไป /audit', async () => {
    await expectApi(admin.api.put('/api/admin/users/exec1', { data: { role: 'auditor', dept: '' } }), 200);
    const s = await newSession(browser);
    exPage = s.page;
    await uiStaffSubmit(exPage, 'exec1');
    await waitPath(exPage, '/audit');
    const res = await exPage.goto('/dashboard');
    expect(res?.status()).toBe(403);
    await expect(tid(exPage, 'forbidden-msg')).toHaveText(MSG.FORBIDDEN_PAGE);
  });

  const ADMIN_DETAILS = ['SV-01 fee 20 → 25', 'SV-02 fee 500 → 600', 'holiday add 2026-12-02', 'exec1 role executive → auditor'];
  const expectAdminChanges = async (n: number, details: string[]) => {
    const rows = await uiAuditExpect(exPage, { event: 'ADMIN_CHANGE' }, n);
    for (const r of rows) {
      expect(r.actor).toBe('admin1');
      expect(r.role).toBe('admin');
    }
    for (const d of details) expect(rows.some((r) => r.detail.includes(d)), `ADMIN_CHANGE "${d}"`).toBe(true);
  };

  await test.step('9 Audit ADMIN_CHANGE 4 แถว', async () => {
    await expectAdminChanges(4, ADMIN_DETAILS);
  });

  await test.step('10 admin ทำรายการคำขอไม่ได้', async () => {
    await expectApi(admin.api.post('/api/drafts', { data: { serviceId: 'SV-01', qty: 1 } }), 403);
  });

  await test.step('11 ลบวันหยุด 2 ธ.ค.', async () => {
    await a.goto('/admin/holidays');
    const row = rowBy(a, 'holiday-row', 'data-date', '2026-12-02');
    const inRow = row.getByTestId('holiday-delete-btn');
    const btn = (await inRow.count()) ? inRow : rowBy(a, 'holiday-delete-btn', 'data-date', '2026-12-02');
    await act(a, () => btn.click());
    await expect(tid(a, 'holiday-row')).toHaveCount(4);
    await expectAdminChanges(5, [...ADMIN_DETAILS, 'holiday delete 2026-12-02']);
  });
});

test('TC-RBAC-05 สิทธิ์เปิด/ดาวน์โหลดไฟล์แนบ', async ({ browser }) => {
  test.setTimeout(240_000);
  await reset();
  const SV01 = ['id-card.pdf'];
  const SV03 = ['deed.pdf', 'id-card.pdf', 'plan.pdf'];

  const reg1 = await staffSession(browser, 'off.reg1');
  const reg2 = await staffSession(browser, 'off.reg2');
  const sy = await citizenSession(browser, ID.SOMYING);
  const works = await loginStaff('off.works1');
  const head = await loginStaff('head1');
  const sc = await loginCitizen(ID.SOMCHAI);

  // fileId ของแต่ละคำขอ (หัวหน้าเห็นทุกแผนก · คำขอ …000025 ใช้ของสมหญิงตาม TEST-PLAN)
  const files: Record<number, Array<{ fileId: string; name: string }>> = {};
  files[25] = (await expectApi(sy.api.get(`/api/cases/${caseNo(25)}/files`), 200)).items;
  for (const n of [10, 11, 12]) files[n] = (await expectApi(head.get(`/api/cases/${caseNo(n)}/files`), 200)).items;

  async function check(label: string, api: APIRequestContext, n: number, exp: number, names?: string[]): Promise<void> {
    const r = await api.get(`/api/cases/${caseNo(n)}/files`);
    expect.soft(r.status(), `${label} /api/cases/${caseNo(n)}/files`).toBe(exp);
    if (exp === 200 && names) {
      const items = ((await bodyOf(r)).items ?? []) as Array<{ name: string }>;
      expect.soft(items.map((i) => i.name).sort(), `${label} รายการไฟล์ ${caseNo(n)}`).toEqual(names);
    }
    for (const f of files[n]) {
      const fr = await api.get(`/api/files/${f.fileId}`);
      expect.soft(fr.status(), `${label} /api/files/${f.fileId} (${f.name} ของ ${caseNo(n)})`).toBe(exp);
      if (exp === 200) {
        expect.soft(fr.headers()['content-type'] ?? '', `${label} ${f.name}`).toContain('application/pdf');
        expect.soft((await fr.body()).subarray(0, 4).toString('latin1'), `${label} ${f.name}`).toBe('%PDF');
      }
    }
  }

  await test.step('ตาราง API', async () => {
    await check('off.reg1', reg1.api, 25, 200, SV01);
    await check('off.works1', works, 25, 403);
    await check('off.reg2', reg2.api, 12, 200, SV03);
    await check('off.works1', works, 12, 403);
    await check('off.works1', works, 10, 200, SV03);
    await check('off.reg1', reg1.api, 10, 200, SV03);
    await check('off.works1', works, 11, 200, SV03);
    await check('head1', head, 25, 200, SV01);
    await check('head1', head, 10, 200, SV03);
    await check('head1', head, 12, 200, SV03);
    await check('สมหญิง', sy.api, 25, 200, SV01);
    await check('สมชาย', sc, 25, 404);
    for (const u of ['exec1', 'audit1', 'admin1'] as const) await check(u, await loginStaff(u), 25, 403);
    await check('ไม่ล็อกอิน', await newApi(), 25, 401);
    await expectApi(reg1.api.get('/api/files/999999999'), 404);
  });

  await test.step('UI doc-item + ดาวน์โหลด', async () => {
    await openOfficer(reg1.page, caseNo(25));
    await expect(tid(reg1.page, 'doc-item')).toHaveCount(1);
    const item = rowBy(reg1.page, 'doc-item', 'data-name', 'id-card.pdf');
    await expect(item).toHaveCount(1);
    const link = item.getByTestId('doc-download-link');
    await expect(link).toHaveCount(1);
    const f = await grabDownload(reg1.page, () => link.click(), /pdf|octet-stream/i);
    expect(f.status).toBe(200);
    expect(f.body.length).toBeGreaterThan(0);

    await openOfficer(reg2.page, caseNo(12));
    await expect(tid(reg2.page, 'doc-item')).toHaveCount(3);
    await openCitizen(sy.page, caseNo(25));
    await expect(tid(sy.page, 'doc-item')).toHaveCount(1);
  });
});

test('TC-RBAC-06 ผู้ดูแลระบบ: ช่วงค่าที่ยอมรับ', async ({ browser }) => {
  test.setTimeout(240_000);
  await reset();
  const admin = await staffSession(browser, 'admin1');
  const a = admin.page;
  const cur = { fee: 20, sla: 3 };
  const FEE_MSG = 'ค่าธรรมเนียมต้องเป็นจำนวนเต็ม 0–100,000 บาท';
  const SLA_MSG = 'SLA ต้องเป็นจำนวนเต็ม 1–60 วันทำการ';

  const sv01 = async () => ((await expectApi(admin.api.get('/api/admin/services'), 200)).items as any[]).find((i) => i.id === 'SV-01');
  const put = (body: { fee: number; sla: number }) => admin.api.put('/api/admin/services/SV-01', { data: body });

  /** บนจอ: แก้ช่องเดียวแล้วบันทึก */
  async function uiSave(field: 'fee' | 'sla', value: number): Promise<void> {
    await a.goto('/admin/services');
    await tid(a, `svc-${field}-SV-01`).fill(String(value));
    await act(a, () => tid(a, 'svc-save-SV-01').click(), { reload: false });
  }

  /** ค่าที่ถูกปฏิเสธ: บนจอ action-error + API 400 + ค่าไม่เปลี่ยน */
  async function rejected(field: 'fee' | 'sla', value: number): Promise<void> {
    const [code, msg] = field === 'fee' ? ['INVALID_FEE', FEE_MSG] : ['INVALID_SLA', SLA_MSG];
    await uiSave(field, value);
    await expect(tid(a, 'action-error'), `${field}=${value}`).toHaveText(msg);
    const e = await expectApi(put({ ...cur, [field]: value }), 400, code);
    expect(e.message).toBe(msg);
    expect(await sv01()).toMatchObject(cur);
  }

  /** ค่าที่ยอมรับ (ทำครั้งเดียวต่อค่า เพื่อให้ ADMIN_CHANGE = 5 พอดี) */
  async function accepted(field: 'fee' | 'sla', value: number, via: 'ui' | 'api'): Promise<void> {
    if (via === 'ui') {
      await uiSave(field, value);
      await expect(tid(a, 'action-success'), `${field}=${value}`).toBeVisible();
    } else {
      await expectApi(put({ ...cur, [field]: value }), 200);
    }
    cur[field] = value;
    expect(await sv01()).toMatchObject(cur);
  }

  await test.step('ค่าธรรมเนียม −1 / 0 / 100000 / 100001', async () => {
    await rejected('fee', -1);
    await accepted('fee', 0, 'ui');
    await accepted('fee', 100000, 'api');
    await rejected('fee', 100001);
  });

  await test.step('SLA 0 / 1 / 60 / 61', async () => {
    await rejected('sla', 0);
    await accepted('sla', 1, 'ui');
    await accepted('sla', 60, 'api');
    await rejected('sla', 61);
  });

  await test.step('วันหยุดซ้ำ / วันเสาร์', async () => {
    const dup = await expectApi(admin.api.post('/api/admin/holidays', { data: { date: '2026-12-07', name: 'ซ้ำ' } }), 409, 'DUPLICATE_HOLIDAY');
    expect(dup.message).toBe('มีวันหยุดนี้อยู่แล้ว');
    await a.goto('/admin/holidays');
    await expect(tid(a, 'holiday-row')).toHaveCount(4);
    await tid(a, 'holiday-date-input').fill('2026-12-07');
    await tid(a, 'holiday-name-input').fill('ซ้ำ');
    await act(a, () => tid(a, 'holiday-add-btn').click(), { reload: false });
    await expect(tid(a, 'action-error')).toHaveText('มีวันหยุดนี้อยู่แล้ว');
    await a.goto('/admin/holidays');
    await expect(tid(a, 'holiday-row')).toHaveCount(4);
    await expectApi(admin.api.post('/api/admin/holidays', { data: { date: '2026-12-05', name: 'วันเสาร์' } }), 201);
  });

  await test.step('เปลี่ยนบทบาทตัวเองไม่ได้', async () => {
    const e = await expectApi(admin.api.put('/api/admin/users/admin1', { data: { role: 'executive', dept: '' } }), 409, 'SELF_ROLE_CHANGE');
    expect(e.message).toBe('ไม่สามารถเปลี่ยนบทบาทของตัวเองได้');
    expect((await expectApi(admin.api.get('/api/me'), 200)).role).toBe('admin');
  });

  await test.step('Audit ADMIN_CHANGE = 5 (คำขอที่ถูกปฏิเสธไม่ถูกบันทึก)', async () => {
    const { page: p } = await staffSession(browser, 'audit1');
    const rows = await uiAuditExpect(p, { event: 'ADMIN_CHANGE' }, 5);
    for (const d of ['SV-01 fee 20 → 0', 'SV-01 fee 0 → 100000', 'SV-01 sla 3 → 1', 'SV-01 sla 1 → 60', 'holiday add 2026-12-05']) {
      expect(rows.some((r) => r.detail.includes(d)), `ADMIN_CHANGE "${d}" ใน ${JSON.stringify(rows.map((r) => r.detail))}`).toBe(true);
    }
  });
});

// ═══════════════════════════════════ NFR ═══════════════════════════════════

test('TC-NFR-01 Responsive 375 / 768 / 1280', async ({ browser }) => {
  test.setTimeout(300_000);
  await reset();
  const SIZES = [
    { width: 375, height: 812 },
    { width: 768, height: 1024 },
    { width: 1280, height: 800 },
  ];
  const anon = await newSession(browser);
  const sc = await citizenSession(browser, ID.SOMCHAI);
  const reg1 = await staffSession(browser, 'off.reg1');
  const head = await staffSession(browser, 'head1');
  const ex = await staffSession(browser, 'exec1');
  const au = await staffSession(browser, 'audit1');
  const ad = await staffSession(browser, 'admin1');
  const PAGES: Array<[Page, string]> = [
    [anon.page, '/login'],
    [sc.page, '/citizen'],
    [sc.page, '/citizen/new/SV-03'],
    [sc.page, `/citizen/cases/${caseNo(13)}`],
    [reg1.page, '/officer/queue'],
    [reg1.page, `/officer/cases/${caseNo(20)}`],
    [head.page, '/head/approvals'],
    [ex.page, '/dashboard'],
    [au.page, '/audit'],
    [ad.page, '/admin/services'],
    [anon.page, '/verify/K7M2Q9XA'],
  ];

  await test.step('11 หน้า × 3 ขนาด ไม่มี scroll แนวนอน', async () => {
    let checks = 0;
    for (const size of SIZES) {
      for (const [p, url] of PAGES) {
        await p.setViewportSize(size);
        const res = await p.goto(url);
        expect.soft(res?.status(), `${url} @${size.width}`).toBe(200);
        expect.soft(pathOf(p), `${url} @${size.width}`).toBe(url);
        const o = await overflowX(p);
        expect.soft(o.scrollWidth, `${url} @${size.width}px scrollWidth ≤ innerWidth (${o.innerWidth})`).toBeLessThanOrEqual(o.innerWidth);
        checks++;
      }
    }
    expect(checks).toBe(33);
  });

  await test.step('งานหลักที่ 375 px: ยื่น SV-01 ถึงปุ่มสร้าง QR', async () => {
    const { page: p } = await newSession(browser);
    await p.setViewportSize({ width: 375, height: 812 });
    await uiLoginCitizen(p, ID.SOMCHAI);
    await waitPath(p, '/citizen');
    await tid(p, 'start-service-SV-01').click();
    await waitPath(p, '/citizen/new/SV-01');
    await fillField(tid(p, 'qty-input'), '1');
    await expect(tid(p, 'fee-total')).toHaveText('฿20');
    await tid(p, 'to-upload-btn').click();
    await expect(tid(p, 'wizard-step')).toHaveText('2/3 แนบเอกสาร');
    await uiUpload(p, 'id-card', 'id-card.pdf');
    await expect(tid(p, 'to-payment-btn')).toBeEnabled();
    await tid(p, 'to-payment-btn').click();
    const qr = tid(p, 'create-qr-btn');
    await expect(qr).toBeVisible();
    const box = await qr.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(375);
    const o = await overflowX(p);
    expect(o.scrollWidth).toBeLessThanOrEqual(o.innerWidth);
  });
});

test('TC-NFR-02 WCAG: axe + คีย์บอร์ด + label + สถานะไม่ใช้สีอย่างเดียว', async ({ browser }) => {
  test.setTimeout(300_000);
  await reset();
  const anon = await newSession(browser);
  const mana = await citizenSession(browser, ID.MANA);
  const sc = await citizenSession(browser, ID.SOMCHAI);
  const reg1 = await staffSession(browser, 'off.reg1');
  const head = await staffSession(browser, 'head1');
  const ex = await staffSession(browser, 'exec1');
  const au = await staffSession(browser, 'audit1');
  const ad = await staffSession(browser, 'admin1');
  const PAGES: Array<[Page, string]> = [
    [anon.page, '/login'],
    [mana.page, '/register'],
    [sc.page, '/citizen'],
    [sc.page, '/citizen/new/SV-01'],
    [sc.page, `/citizen/cases/${caseNo(17)}`],
    [reg1.page, '/officer/queue'],
    [reg1.page, `/officer/cases/${caseNo(20)}`],
    [head.page, '/head/approvals'],
    [ex.page, '/dashboard'],
    [au.page, '/audit'],
    [ad.page, '/admin/services'],
    [reg1.page, '/notifications'],
    [anon.page, '/verify/K7M2Q9XA'],
  ];

  await test.step('ส่วน A axe (serious/critical = 0) + ส่วน C label ครบ', async () => {
    for (const [p, url] of PAGES) {
      await p.goto(url);
      await p.waitForLoadState('networkidle').catch(() => {});
      expect.soft(pathOf(p), url).toBe(url);
      expect.soft(await axeSerious(p), `axe ${url}`).toEqual([]);
      expect.soft(await unlabeledControls(p), `label ${url}`).toEqual([]);
    }
  });

  await test.step('ส่วน D สถานะมีข้อความตรงรหัส (รวม forced-colors)', async () => {
    const STATUS_PAGES: Array<[Page, string]> = [
      [sc.page, '/citizen'],
      [sc.page, `/citizen/cases/${caseNo(17)}`],
      [reg1.page, '/officer/queue'],
      [reg1.page, `/officer/cases/${caseNo(20)}`],
    ];
    for (const forced of ['none', 'active'] as const) {
      for (const [p, url] of STATUS_PAGES) {
        await p.emulateMedia({ forcedColors: forced });
        await p.goto(url);
        const label = `${url} forcedColors=${forced}`;
        const all = p.locator('[data-testid="case-status"], [data-testid="row-status"], [data-testid="sla-level"], [data-testid="row-sla-level"]');
        expect.soft(await all.count(), `${label} มีองค์ประกอบสถานะ`).toBeGreaterThan(0);
        expect.soft(await statusTextProblems(p), label).toEqual([]);
        if (forced === 'active') {
          const first = all.first();
          await expect.soft(first, label).toBeVisible();
          expect.soft(((await first.textContent()) ?? '').trim(), label).not.toBe('');
        }
      }
    }
    await sc.page.emulateMedia({ forcedColors: 'none' });
    await reg1.page.emulateMedia({ forcedColors: 'none' });
  });

  await test.step('ส่วน B คีย์บอร์ดอย่างเดียว: ล็อกอิน → ยื่น SV-01 → ขั้นชำระ', async () => {
    const { page: p } = await newSession(browser);
    const noRing: string[] = [];
    const kb = p.keyboard;
    await p.goto('/login');
    if (!(await tid(p, 'thaid-id-input').isVisible())) {
      expect(await tabTo(p, 'login-tab-citizen', noRing), 'Tab ถึง login-tab-citizen').toBe(true);
      await kb.press('Enter');
    }
    expect(await tabTo(p, 'thaid-id-input', noRing), 'Tab ถึง thaid-id-input').toBe(true);
    await kb.type(ID.SOMCHAI);
    await kb.press('Enter');
    await expect(tid(p, 'otp-step')).toBeVisible();
    expect(await tabTo(p, 'otp-input', noRing), 'Tab ถึง otp-input').toBe(true);
    await kb.type('123456');
    await kb.press('Enter');
    await waitPath(p, '/citizen');

    expect(await tabTo(p, 'start-service-SV-01', noRing), 'Tab ถึง start-service-SV-01').toBe(true);
    await kb.press('Enter');
    await waitPath(p, '/citizen/new/SV-01');
    expect(await tabTo(p, 'qty-input', noRing), 'Tab ถึง qty-input').toBe(true);
    await kb.press('Control+A');
    await kb.type('1');
    expect(await tabTo(p, 'to-upload-btn', noRing), 'Tab ถึง to-upload-btn').toBe(true);
    await kb.press('Enter');
    await expect(tid(p, 'wizard-step')).toHaveText('2/3 แนบเอกสาร');

    const input = tid(p, 'upload-input-id-card');
    if (!(await tabTo(p, 'upload-input-id-card', noRing, 30))) await input.focus();
    await withMutation(p, () => input.setInputFiles(fixturePath('id-card.pdf')), 30_000);
    await expect(rowBy(p, 'file-item', 'data-name', 'id-card.pdf')).toHaveCount(1);
    await expect(tid(p, 'to-payment-btn')).toBeEnabled();
    expect(await tabTo(p, 'to-payment-btn', noRing), 'Tab ถึง to-payment-btn').toBe(true);
    expect((await focusInfo(p)).ring, 'to-payment-btn มี focus ring').toBe(true);
    await kb.press('Enter');
    await expect(tid(p, 'create-qr-btn')).toBeVisible();
    expect(noRing, 'จุดโฟกัสที่ไม่มี outline/ring').toEqual([]);
  });
});

test('TC-NFR-03 Health เวลาโหลด และผลซ้ำได้', async ({ browser }) => {
  test.setTimeout(240_000);

  await test.step('health', async () => {
    const r = await (await newApi()).get('/api/health');
    expect(r.status()).toBe(200);
    expect(await r.json()).toStrictEqual({ status: 'ok' });
  });

  await test.step('เวลาโหลด ≤ 3,000 ms (รอบที่ 2)', async () => {
    await reset();
    const PAGES: Array<[Page, string]> = [
      [(await newSession(browser)).page, '/login'],
      [(await citizenSession(browser, ID.SOMCHAI)).page, '/citizen'],
      [(await staffSession(browser, 'off.reg1')).page, '/officer/queue'],
      [(await staffSession(browser, 'exec1')).page, '/dashboard'],
      [(await staffSession(browser, 'audit1')).page, '/audit'],
    ];
    for (const [p, url] of PAGES) {
      await p.goto(url, { waitUntil: 'load' });
      const t = Date.now();
      await p.goto(url, { waitUntil: 'load' });
      const ms = Date.now() - t;
      expect.soft(pathOf(p), url).toBe(url);
      expect.soft(ms, `${url} โหลด ${ms} ms`).toBeLessThanOrEqual(3_000);
    }
  });

  await test.step('RESET ให้ผลซ้ำได้', async () => {
    const snapshot = async () => {
      const clock = await getClock();
      const reg1 = await loginStaff('off.reg1');
      const queue = (await queueItems(reg1, 'all')).map((i) => ({ caseNo: i.caseNo, dueAt: i.dueAt, status: i.status, owner: i.owner }));
      const dash = await getDashboard(await loginStaff('exec1'), '2026-12');
      return { clock, queue, dash };
    };
    await reset();
    const s1 = await snapshot();
    expect(s1.clock).toBe(T0);

    await setClock('2026-12-10T12:00:00+07:00');
    await claim(await loginStaff('off.reg1'), caseNo(28));
    await newPaid();

    await reset();
    const s2 = await snapshot();
    expect(s2).toEqual(s1);
    expect(s2.clock).toBe(T0);
  });

  await test.step('นาฬิกาไม่มี offset → 400 INVALID_TIME', async () => {
    await expectApi((await newApi()).put('/api/test/clock', { data: { now: '2026-12-01 09:00' } }), 400, 'INVALID_TIME');
    expect(await getClock()).toBe(T0);
  });

  await test.step('ปิด hook เมื่อไม่ตั้ง TEST_MODE (ถ้ามีเว็บโหมดที่สอง)', async () => {
    const url = process.env.NO_TEST_MODE_URL;
    if (!url) {
      test.info().annotations.push({ type: 'skip-part', description: 'ไม่ได้ตั้ง NO_TEST_MODE_URL (เว็บที่รันโดยไม่ตั้ง TEST_MODE) จึงไม่ได้ตรวจ /api/test/reset → 404' });
      return;
    }
    const api = await newApi();
    const r = await api.post(`${url.replace(/\/+$/, '')}/api/test/reset`);
    expect(r.status()).toBe(404);
  });
});

test('TC-NFR-04 เข้ารหัสข้อมูลส่วนบุคคลที่เก็บ (inspection)', async () => {
  const fallback = path.resolve(__dirname, '..', '..', 'web', 'data', 'app.db');
  const dbPath = process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : fallback;
  test.skip(!process.env.DB_PATH && !fs.existsSync(fallback), `ไม่พบไฟล์ฐานข้อมูล (ตั้ง DB_PATH ให้ชี้ไฟล์ของเว็บ · ค่าเริ่มต้น ${fallback})`);
  expect(fs.existsSync(dbPath), `DB_PATH=${dbPath}`).toBe(true);

  await reset();
  await test.step('มานะลงทะเบียน (เบอร์ 0845678901)', async () => {
    const mana = await loginCitizen(ID.MANA);
    await expectApi(mana.post('/api/auth/register', { data: { mobile: '0845678901', email: '', consent: true } }), 201);
  });

  await test.step('ไม่พบเลขบัตร/เบอร์แบบข้อความตรงตัวในไฟล์ฐานข้อมูล', async () => {
    const files = [dbPath, `${dbPath}-wal`, `${dbPath}-journal`].filter((f) => fs.existsSync(f));
    const logPath = process.env.WEB_LOG_PATH;
    if (logPath && fs.existsSync(logPath)) {
      const st = fs.statSync(logPath);
      if (st.isDirectory()) files.push(...fs.readdirSync(logPath).map((f) => path.join(logPath, f)).filter((f) => fs.statSync(f).isFile()));
      else files.push(logPath);
    }
    const VALUES = [
      ID.SOMCHAI,
      ID.SOMYING,
      ID.PITI,
      ID.MANA,
      '0812345678',
      '0823456789',
      '0834567890',
      '0845678901',
      '1-1017-00123-45-6',
      '3-1006-00987-65-9',
      '1-9099-00555-01-5',
      '5-5004-00111-22-1',
    ];
    for (const v of VALUES) {
      const found = files.map((f) => [path.basename(f), countInFile(f, v)] as const).filter(([, n]) => n > 0);
      expect.soft(found, `พบ ${v} แบบไม่เข้ารหัส`).toEqual([]);
    }
    test.info().annotations.push({ type: 'inspected', description: files.join(', ') });
    test.info().annotations.push({ type: 'encryption', description: process.env.PII_ENCRYPTION ?? 'บันทึกวิธีเข้ารหัสในรายงาน (เช่น AES-256-GCM) · ตั้ง PII_ENCRYPTION เพื่อแนบในผลทดสอบ' });
  });

  await test.step('ตัวควบคุมบวก: เจ้าของยังเห็นเลขเต็ม (ถอดรหัสได้)', async () => {
    const sc = await loginCitizen(ID.SOMCHAI);
    expect((await getCase(sc, caseNo(5))).idNo).toBe(ID.SOMCHAI);
  });
});
