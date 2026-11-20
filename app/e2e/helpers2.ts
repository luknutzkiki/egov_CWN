/**
 * helpers2.ts · ตัวช่วยเพิ่มของชุด 2 (B11 · tests/part2.spec.ts) — ไม่แก้ helpers.ts ของ B10
 *
 *   act(page, fn)                         ทำรายการที่เปลี่ยนสถานะ แล้วรอหน้าแสดงผลใหม่ (reload ถ้าหน้าไม่ navigate เอง)
 *   uiReturn / uiReject / uiUnmask / uiForward   ฟอร์มเหตุผล/ส่งต่อบนหน้า /officer/cases/:caseNo
 *   getDashboard / uiDashboard / expectKpis       Dashboard (API + หน้าจอ)
 *   uiAudit / auditRowsUi                 กรองและอ่านแถว /audit
 *   grabDownload                          ดาวน์โหลดจากปุ่ม/ลิงก์ (ได้ status + header + เนื้อไฟล์ ครั้งเดียว)
 *   pdfText / xlsxSheets / parseCsv       อ่านไฟล์ส่งออกด้วย Node ล้วน (ไม่เพิ่ม dependency)
 *   pageFromApi                           เปิด browser context จาก cookie ของ request context (ไม่ล็อกอินซ้ำ = ไม่เพิ่ม STAFF_LOGIN)
 *   axeSerious / unlabeledControls / tabTo        WCAG (TC-NFR-02)
 *
 * ใช้ cleanup2() ใน test.afterEach คู่กับ cleanup() ของ helpers.ts
 */
import AxeBuilder from '@axe-core/playwright';
import {
  expect,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Frame,
  type Locator,
  type Page,
  type Route,
} from '@playwright/test';
import fs from 'fs';
import zlib from 'zlib';
import { BASE_URL, LEVEL_TH, STATUS_TH, expectApi, newApi, withMutation, type Session, type SlaLevel } from './helpers';

// ───────────────────────── พื้นฐาน ─────────────────────────

export const tid = (scope: Page | Locator, id: string): Locator => scope.getByTestId(id);

/** ฿ + คั่นหลักพัน (CONTRACT 0.2) */
export const baht = (n: number): string => `฿${n.toLocaleString('en-US')}`;

export const pathOf = (p: Page): string => new URL(p.url()).pathname;

/** ตรวจ case-status (ข้อความไทย + data-status) */
export async function expectStatus(p: Page, status: keyof typeof STATUS_TH): Promise<void> {
  const el = tid(p, 'case-status');
  await expect(el).toHaveText(STATUS_TH[status]);
  await expect(el).toHaveAttribute('data-status', status);
}

/** ตรวจ sla-level (ข้อความไทย + data-level) */
export async function expectLevel(p: Page, level: SlaLevel): Promise<void> {
  const el = tid(p, 'sla-level');
  await expect(el).toHaveText(LEVEL_TH[level]);
  await expect(el).toHaveAttribute('data-level', level);
}

/** POST /api/test/documents/<docNo>/tamper → 200 {"ok":true} */
export async function tamper(docNo: string): Promise<void> {
  const body = await expectApi((await newApi()).post(`/api/test/documents/${docNo}/tamper`), 200);
  expect(body.ok).toBe(true);
}

// ───────────────────────── context เพิ่ม ─────────────────────────

const extraContexts: BrowserContext[] = [];

/** ปิด context ที่เปิดผ่าน helpers2 (เรียกใน test.afterEach) */
export async function cleanup2(): Promise<void> {
  while (extraContexts.length) await extraContexts.pop()!.close().catch(() => {});
}

/** browser context ใหม่ที่ใช้ cookie เดียวกับ request context ที่ล็อกอินแล้ว (ไม่ล็อกอินซ้ำ) */
export async function pageFromApi(browser: Browser, api: APIRequestContext): Promise<Session> {
  const context = await browser.newContext({
    baseURL: BASE_URL,
    locale: 'th-TH',
    timezoneId: 'Asia/Bangkok',
    viewport: { width: 1280, height: 900 },
    storageState: await api.storageState(),
  });
  extraContexts.push(context);
  const page = await context.newPage();
  page.on('dialog', (d) => d.accept().catch(() => {}));
  return { context, page, api: context.request };
}

// ───────────────────────── ทำรายการบนหน้าจอ ─────────────────────────

/** รอให้หน้า navigate (ถ้ามี) ภายในเวลาสั้น ๆ แล้วรอโหลดเสร็จ */
export async function settle(p: Page, action: () => Promise<unknown>, navTimeout = 1_500): Promise<void> {
  const nav = p.waitForEvent('framenavigated', { predicate: (f) => f === p.mainFrame(), timeout: navTimeout }).catch(() => null);
  await action();
  await nav;
  await p.waitForLoadState('load').catch(() => {});
  await p.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
}

/**
 * ทำรายการที่ส่งข้อมูลขึ้นเซิร์ฟเวอร์ (รอ response แรกที่ไม่ใช่ GET)
 * - ถ้าหน้า navigate เอง (form POST → redirect / location.reload) รอหน้าใหม่โหลด
 * - ถ้าไม่ navigate และ reload = true → reload ให้ได้สถานะล่าสุดจากเซิร์ฟเวอร์
 * - ใช้ reload = false เมื่อจะตรวจข้อความ error / toast / full-id ที่แสดงเฉพาะหน้านั้น
 */
export async function act(p: Page, action: () => Promise<unknown>, opts: { reload?: boolean } = {}): Promise<void> {
  const reload = opts.reload ?? true;
  let navigated = false;
  const onNav = (f: Frame) => {
    if (f === p.mainFrame()) navigated = true;
  };
  p.on('framenavigated', onNav);
  try {
    await withMutation(p, action);
    if (!navigated) {
      await p
        .waitForEvent('framenavigated', { predicate: (f) => f === p.mainFrame(), timeout: 1_500 })
        .then(() => (navigated = true))
        .catch(() => {});
    }
    await p.waitForLoadState('load').catch(() => {});
    if (!navigated && reload) await p.reload();
  } finally {
    p.off('framenavigated', onNav);
  }
}

/** เปิดฟอร์มเหตุผล (กดปุ่มเปิดถ้าช่องยังไม่แสดง) กรอก แล้วกดยืนยัน */
async function reasonForm(p: Page, openBtn: string, input: string, submit: string, reason: string, reload: boolean): Promise<void> {
  const box = tid(p, input);
  if (!(await box.isVisible())) await tid(p, openBtn).click();
  await expect(box).toBeVisible();
  await box.fill(reason);
  await act(p, () => tid(p, submit).click(), { reload });
}

/** return-btn → return-reason → return-submit */
export const uiReturn = (p: Page, reason: string, reload = true) => reasonForm(p, 'return-btn', 'return-reason', 'return-submit', reason, reload);
/** reject-btn → reject-reason → reject-submit */
export const uiReject = (p: Page, reason: string, reload = true) => reasonForm(p, 'reject-btn', 'reject-reason', 'reject-submit', reason, reload);
/** show-full-id-btn → unmask-reason → unmask-submit (ไม่ reload: เลขเต็มเห็นเฉพาะในหน้านั้น) */
export const uiUnmask = (p: Page, reason: string) => reasonForm(p, 'show-full-id-btn', 'unmask-reason', 'unmask-submit', reason, false);

/** กรอก forward-note (ถ้ามี) แล้วกด forward-btn */
export async function uiForward(p: Page, note?: string): Promise<void> {
  if (note !== undefined) await tid(p, 'forward-note').fill(note);
  await act(p, () => tid(p, 'forward-btn').click());
}

/** เลือกค่าใน select แล้วรอหน้าอัปเดต (รองรับทั้ง onchange submit และ fetch) */
export async function uiSelect(p: Page, testid: string, value: string): Promise<void> {
  const sel = tid(p, testid);
  if ((await sel.inputValue()) === value) return;
  await settle(p, () => sel.selectOption(value));
  await expect(tid(p, testid)).toHaveValue(value);
}

// ───────────────────────── Dashboard ─────────────────────────

export interface Kpis {
  received: number;
  closed: number;
  /** ข้อความ kpi-ontime-pct เช่น '85.7%' หรือ '–' */
  pct: string;
  backlog: number;
  overdue: number;
}

/** GET /api/dashboard?period=…&service=… (executive) */
export async function getDashboard(api: APIRequestContext, period: string, service = 'ALL'): Promise<any> {
  return expectApi(api.get(`/api/dashboard?period=${period}&service=${service}`), 200);
}

/** /dashboard เลือก period-select + service-select */
export async function uiDashboard(p: Page, period: string, service = 'ALL'): Promise<void> {
  if (pathOf(p) !== '/dashboard') await p.goto('/dashboard');
  await uiSelect(p, 'period-select', period);
  await uiSelect(p, 'service-select', service);
}

/** ตรวจ kpi-* บนจอ (เฉพาะช่องที่ส่งมา) */
export async function expectKpis(p: Page, k: Partial<Kpis>): Promise<void> {
  if (k.received !== undefined) await expect(tid(p, 'kpi-received')).toHaveText(String(k.received));
  if (k.closed !== undefined) await expect(tid(p, 'kpi-closed')).toHaveText(String(k.closed));
  if (k.pct !== undefined) await expect(tid(p, 'kpi-ontime-pct')).toHaveText(k.pct);
  if (k.backlog !== undefined) await expect(tid(p, 'kpi-backlog')).toHaveText(String(k.backlog));
  if (k.overdue !== undefined) await expect(tid(p, 'kpi-overdue')).toHaveText(String(k.overdue));
}

/** ค่าที่ API ต้องได้จากข้อความทันกำหนด % ('85.7%' → 85.7 · '–' → null) */
export const pctValue = (pct: string): number | null => (pct === '–' ? null : Number(pct.replace('%', '')));

// ───────────────────────── Audit ─────────────────────────

export interface AuditFilter {
  actor?: string;
  event?: string;
  from?: string;
  to?: string;
}

/** เปิด /audit ใหม่ กรอกตัวกรองทุกช่อง (ว่าง = ไม่กรอง) แล้วกด audit-apply-btn */
export async function uiAudit(p: Page, f: AuditFilter = {}): Promise<void> {
  await p.goto('/audit');
  await tid(p, 'audit-filter-actor').fill(f.actor ?? '');
  await tid(p, 'audit-filter-event').selectOption(f.event ?? '');
  await tid(p, 'audit-filter-from').fill(f.from ?? '');
  await tid(p, 'audit-filter-to').fill(f.to ?? '');
  await settle(p, () => tid(p, 'audit-apply-btn').click());
}

export interface AuditRowUi {
  id: string;
  event: string;
  actor: string;
  caseNo: string;
  iso: string;
  actorText: string;
  role: string;
  eventText: string;
  caseText: string;
  transition: string;
  detail: string;
}

/** อ่านทุกแถว audit-row บนจอ (ลำดับตามจอ) */
export async function auditRowsUi(p: Page): Promise<AuditRowUi[]> {
  return tid(p, 'audit-row').evaluateAll((rows) =>
    rows.map((r) => {
      const cell = (id: string) => r.querySelector(`[data-testid="${id}"]`);
      const txt = (id: string) => (cell(id)?.textContent ?? '').replace(/\s+/g, ' ').trim();
      return {
        id: r.getAttribute('data-id') ?? '',
        event: r.getAttribute('data-event') ?? '',
        actor: r.getAttribute('data-actor') ?? '',
        caseNo: r.getAttribute('data-case-no') ?? '',
        iso: cell('audit-time')?.getAttribute('data-iso') ?? '',
        actorText: txt('audit-actor'),
        role: txt('audit-role'),
        eventText: txt('audit-event'),
        caseText: txt('audit-case-no'),
        transition: txt('audit-transition'),
        detail: txt('audit-detail'),
      };
    }),
  );
}

/** กรองบนจอแล้วตรวจ audit-count + จำนวนแถว แล้วคืนแถว */
export async function uiAuditExpect(p: Page, f: AuditFilter, count: number): Promise<AuditRowUi[]> {
  await uiAudit(p, f);
  await expect(tid(p, 'audit-count')).toHaveText(String(count));
  await expect(tid(p, 'audit-row')).toHaveCount(count);
  return auditRowsUi(p);
}

// ───────────────────────── ดาวน์โหลด ─────────────────────────

export interface Grabbed {
  url: string;
  status: number;
  contentType: string;
  disposition: string;
  filename: string;
  body: Buffer;
}

/** ชื่อไฟล์จาก Content-Disposition (รองรับ filename*=UTF-8'') */
export function dispositionName(h: string): string {
  const star = /filename\*\s*=\s*[^']*'[^']*'([^;]+)/i.exec(h);
  if (star) return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ''));
  const m = /filename\s*=\s*"?([^";]+)"?/i.exec(h);
  return m ? m[1].trim() : '';
}

/**
 * กดปุ่ม/ลิงก์ดาวน์โหลดแล้วดักไฟล์ที่ได้ (ผ่าน context.route → เซิร์ฟเวอร์ถูกเรียกครั้งเดียว)
 * ใช้ได้ทั้งลิงก์ <a href>, form GET, fetch + blob และแท็บใหม่ · `want` = regex ของ Content-Type ที่ต้องการ
 * ลิงก์ที่มีแอตทริบิวต์ `download` ใช้ไม่ได้: Chromium ส่งไปตัวจัดการดาวน์โหลดตรง ไม่ผ่าน context.route
 * (อ่าน status/header ไม่ได้) → ล้มทันทีพร้อมบอกสาเหตุ แทนที่จะรอจนหมดเวลา
 */
export async function grabDownload(p: Page, click: () => Promise<unknown>, want: RegExp): Promise<Grabbed> {
  const box: { got?: Grabbed; bypassed?: string } = {};
  const ctx = p.context();
  const onDownload = (d: { url(): string }) => {
    if (!box.got) box.bypassed = d.url();
  };
  const handler = async (route: Route) => {
    const req = route.request();
    if (box.got || req.method() !== 'GET' || !['document', 'fetch', 'xhr', 'other'].includes(req.resourceType())) {
      await route.continue().catch(() => {});
      return;
    }
    let resp;
    try {
      resp = await route.fetch();
    } catch {
      await route.continue().catch(() => {});
      return;
    }
    const h = resp.headers();
    const body = await resp.body();
    const ct = h['content-type'] ?? '';
    const cd = h['content-disposition'] ?? '';
    if (!box.got && (/attachment|filename/i.test(cd) || want.test(ct))) {
      box.got = { url: req.url(), status: resp.status(), contentType: ct, disposition: cd, filename: dispositionName(cd), body };
    }
    await route.fulfill({ response: resp, body }).catch(() => {});
  };
  await ctx.route('**/*', handler);
  p.on('download', onDownload);
  try {
    await click();
    await expect.poll(() => !!box.got || !!box.bypassed, { timeout: 20_000, message: `ไม่ได้ไฟล์ดาวน์โหลด (${want})` }).toBe(true);
  } finally {
    p.off('download', onDownload);
    await ctx.unroute('**/*', handler).catch(() => {});
  }
  if (!box.got) throw new Error(`ดาวน์โหลด ${box.bypassed} ไม่ผ่าน context.route (ลิงก์มีแอตทริบิวต์ download?) จึงตรวจ status/Content-Type ไม่ได้`);
  return box.got;
}

// ───────────────────────── PDF (ข้อความที่เครื่องอ่านได้) ─────────────────────────

function pdfLiteral(s: string, i: number): [string, number] {
  // s[i] === '('
  let depth = 1;
  let out = '';
  i++;
  while (i < s.length && depth > 0) {
    const c = s[i];
    if (c === '\\') {
      const n = s[i + 1];
      const map: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' };
      if (n in map) {
        out += map[n];
        i += 2;
      } else if (/[0-7]/.test(n)) {
        const oct = /^[0-7]{1,3}/.exec(s.slice(i + 1, i + 4))![0];
        out += String.fromCharCode(parseInt(oct, 8));
        i += 1 + oct.length;
      } else if (n === '\r' || n === '\n') {
        i += n === '\r' && s[i + 2] === '\n' ? 3 : 2;
      } else {
        out += n ?? '';
        i += 2;
      }
      continue;
    }
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (depth > 0) out += c;
    i++;
  }
  return [out, i];
}

function pdfHex(h: string): string {
  const hex = h.replace(/[^0-9a-fA-F]/g, '');
  const bytes = Buffer.from(hex.length % 2 ? `${hex}0` : hex, 'hex');
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return bytes.subarray(2).swap16().toString('utf16le');
  return bytes.toString('latin1');
}

/** ข้อความจาก operator แสดงข้อความ (Tj TJ ' ") ของ content stream หนึ่งก้อน → บรรทัด */
function pdfShowStrings(content: string): string[] {
  const lines: string[] = [];
  let cur = '';
  let inArray = false;
  let i = 0;
  const flush = () => {
    if (cur) lines.push(cur);
    cur = '';
  };
  while (i < content.length) {
    const c = content[i];
    if (c === '(') {
      const [str, next] = pdfLiteral(content, i);
      cur += str;
      i = next;
      continue;
    }
    if (c === '<') {
      if (content[i + 1] === '<') {
        i += 2;
        continue;
      }
      const end = content.indexOf('>', i);
      if (end < 0) break;
      cur += pdfHex(content.slice(i + 1, end));
      i = end + 1;
      continue;
    }
    if (c === '[') inArray = true;
    else if (c === ']') inArray = false;
    else if (inArray && /[-\d.]/.test(c)) {
      const num = /^-?[\d.]+/.exec(content.slice(i, i + 20));
      if (num) {
        if (Number(num[0]) < -200) cur += ' ';
        i += num[0].length;
        continue;
      }
    } else if (!inArray && /[A-Za-z'"*]/.test(c)) {
      const op = /^[A-Za-z'"*]+/.exec(content.slice(i, i + 10))![0];
      if (['Tj', 'TJ', "'", '"', 'Td', 'TD', 'T*', 'Tm', 'ET', 'BT'].includes(op)) flush();
      else if (cur && !['Tf', 'Tc', 'Tw', 'Tz', 'TL', 'Ts', 'Tr'].includes(op)) flush();
      i += op.length;
      continue;
    }
    i++;
  }
  flush();
  return lines;
}

export interface PdfText {
  /** ไบต์ดิบ (latin1) + stream ที่คลาย Flate แล้ว — ใช้ค้นบรรทัด ASCII */
  raw: string;
  /** ข้อความจาก operator แสดงข้อความ (ทั้งแบบ latin1 และ UTF-8) — ใช้ตรวจข้อมูลส่วนบุคคล */
  lines: string[];
}

/** stream ที่เป็นข้อความ (content stream) ไม่ใช่ข้อมูลภาพ/ฟอนต์ไบนารี */
function textLike(s: string): boolean {
  if (!s.length) return false;
  let ok = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127)) ok++;
  }
  return ok / s.length > 0.6;
}

/** ดึงข้อความจาก PDF แบบไม่ใช้ไลบรารี (รองรับ stream ไม่บีบอัด/FlateDecode) */
export function pdfText(buf: Buffer): PdfText {
  const s = buf.toString('latin1');
  const inflated: string[] = [];
  const textual: string[] = [];
  let skeleton = '';
  let last = 0;
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const start = m.index + m[0].length;
    const end = s.indexOf('endstream', start);
    if (end < 0) break;
    skeleton += s.slice(last, start);
    last = end;
    const chunk = buf.subarray(start, end);
    let content = chunk.toString('latin1');
    for (const f of [zlib.inflateSync, zlib.inflateRawSync]) {
      try {
        content = f(chunk, { finishFlush: zlib.constants.Z_SYNC_FLUSH }).toString('latin1');
        inflated.push(content);
        break;
      } catch {
        /* ไม่ใช่ Flate */
      }
    }
    if (textLike(content)) textual.push(content);
    re.lastIndex = end + 'endstream'.length;
  }
  skeleton += s.slice(last);
  const lines: string[] = [];
  for (const c of textual.concat(skeleton)) {
    for (const l of pdfShowStrings(c)) {
      lines.push(l);
      const utf8 = Buffer.from(l, 'latin1').toString('utf8');
      if (utf8 !== l) lines.push(utf8);
    }
  }
  return { raw: [s, ...inflated].join('\n'), lines };
}

/** PDF มีบรรทัด ASCII นี้ (ค้นทั้งไบต์ดิบ stream ที่คลายแล้ว และข้อความที่ดึงได้) */
export function pdfHasLine(t: PdfText, line: string): boolean {
  return t.raw.includes(line) || t.lines.some((l) => l.includes(line));
}

// ───────────────────────── XLSX (zip + XML) ─────────────────────────

function unzip(buf: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error(`ไม่ใช่ไฟล์ zip/xlsx (ขึ้นต้น ${JSON.stringify(buf.subarray(0, 8).toString('latin1'))})`);
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const local = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + csize);
    files.set(name, method === 8 ? zlib.inflateRawSync(data) : Buffer.from(data));
    off += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

const xmlDecode = (s: string): string =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');

const tText = (xml: string): string =>
  [...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => xmlDecode(m[1])).join('');

const attr = (attrs: string, name: string): string | undefined => new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1];

export interface Sheet {
  name: string;
  /** 'A1' → ข้อความในเซลล์ */
  cells: Map<string, string>;
}

/** อ่านทุกชีตของ .xlsx ตามลำดับใน workbook (ชีตแรก = [0]) */
export function xlsxSheets(buf: Buffer): Sheet[] {
  const files = unzip(buf);
  const text = (n: string) => files.get(n)?.toString('utf8') ?? '';
  const shared = [...text('xl/sharedStrings.xml').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) => tText(m[1]));
  const rels = new Map<string, string>();
  for (const m of text('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const id = attr(m[1], 'Id');
    const target = attr(m[1], 'Target');
    if (id && target) rels.set(id, target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`);
  }
  const sheets: Sheet[] = [];
  const decl = [...text('xl/workbook.xml').matchAll(/<sheet\b([^>]*)\/?>/g)];
  const targets = decl.length
    ? decl.map((m) => ({ name: xmlDecode(attr(m[1], 'name') ?? ''), path: rels.get(attr(m[1], 'r:id') ?? '') ?? '' }))
    : [...files.keys()].filter((k) => /^xl\/worksheets\/[^/]+\.xml$/.test(k)).sort().map((k) => ({ name: k, path: k }));
  for (const t of targets) {
    const xml = text(t.path);
    const cells = new Map<string, string>();
    for (const m of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = attr(m[1], 'r');
      if (!ref) continue;
      const type = attr(m[1], 't');
      const inner = m[2] ?? '';
      const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      let val = '';
      if (type === 's') val = shared[Number(v)] ?? '';
      else if (type === 'inlineStr') val = tText(inner);
      else if (type === 'b') val = v === '1' ? 'TRUE' : 'FALSE';
      else val = v === undefined ? '' : xmlDecode(v);
      cells.set(ref, val);
    }
    sheets.push({ name: t.name, cells });
  }
  return sheets;
}

/** ข้อความทุกเซลล์ของทุกชีต (ตรวจข้อมูลส่วนบุคคล) */
export const xlsxAllText = (sheets: Sheet[]): string[] => sheets.flatMap((s) => [...s.cells.values()]);

// ───────────────────────── CSV ─────────────────────────

/** แยก CSV (รองรับ "..." , "" และขึ้นบรรทัดในช่อง) · ตัด BOM · ข้ามบรรทัดว่าง */
export function parseCsv(text: string): string[][] {
  const s = text.replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let f = '';
  let q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          f += '"';
          i++;
        } else q = false;
      } else f += c;
    } else if (c === '"') q = true;
    else if (c === ',') {
      row.push(f);
      f = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(f);
      rows.push(row);
      row = [];
      f = '';
    } else f += c;
  }
  if (f !== '' || row.length) {
    row.push(f);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

// ───────────────────────── JSON / ข้อมูลส่วนบุคคล ─────────────────────────

/** ชื่อ key ทุกชั้นของ JSON */
export function deepKeys(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x) => deepKeys(x, out));
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      out.push(k);
      deepKeys(x, out);
    }
  }
  return out;
}

export const PII_NAMES = ['สมชาย', 'สมหญิง', 'ปิติ', 'มานะ'];

/** ข้อความที่พบข้อมูลส่วนบุคคล (เลข 13 หลัก · เบอร์ 0xxxxxxxxx · ชื่อผู้ยื่น) — คืนรายการที่พบ */
export function piiHits(texts: string[]): string[] {
  const hits: string[] = [];
  for (const t of texts) {
    if (/\d{13}/.test(t)) hits.push(`13 หลัก: ${t}`);
    if (/0\d{9}/.test(t)) hits.push(`เบอร์: ${t}`);
    for (const n of PII_NAMES) if (t.includes(n)) hits.push(`ชื่อ ${n}: ${t}`);
  }
  return hits;
}

// ───────────────────────── Responsive / WCAG ─────────────────────────

/** ความกว้างทั้งหน้าเทียบกับหน้าต่าง (ไม่มี scroll แนวนอน ⇔ scrollWidth ≤ innerWidth) */
export async function overflowX(p: Page): Promise<{ scrollWidth: number; innerWidth: number }> {
  return p.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
}

export const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

/** axe: violation ระดับ serious/critical (คืนคำอธิบายสั้น) */
export async function axeSerious(p: Page): Promise<string[]> {
  const r = await new AxeBuilder({ page: p }).withTags(WCAG_TAGS).analyze();
  return r.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id} (${v.impact}) ×${v.nodes.length}: ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
}

/** input/select/textarea ที่มองเห็นแต่ไม่มีชื่อที่เข้าถึงได้ (label / aria-label / aria-labelledby) */
export async function unlabeledControls(p: Page): Promise<string[]> {
  return p.evaluate(() => {
    const visible = (e: Element) => {
      const r = e.getBoundingClientRect();
      const cs = getComputedStyle(e);
      return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
    };
    const named = (e: Element) => {
      const al = e.getAttribute('aria-label');
      if (al && al.trim()) return true;
      const lb = e.getAttribute('aria-labelledby');
      if (lb && lb.split(/\s+/).some((id) => (document.getElementById(id)?.textContent ?? '').trim())) return true;
      const labels = (e as HTMLInputElement).labels;
      return !!labels && Array.from(labels).some((l) => (l.textContent ?? '').trim());
    };
    return Array.from(document.querySelectorAll('input, select, textarea'))
      .filter((e) => !['hidden', 'submit', 'button', 'reset', 'image'].includes((e as HTMLInputElement).type))
      .filter((e) => visible(e) && !named(e))
      .map((e) => e.getAttribute('data-testid') || e.getAttribute('name') || e.id || e.outerHTML.slice(0, 80));
  });
}

/** ข้อมูลองค์ประกอบที่โฟกัสอยู่ + มี outline/ring มองเห็นหรือไม่ */
export async function focusInfo(p: Page): Promise<{ testid: string; ring: boolean; desc: string }> {
  return p.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return { testid: '', ring: true, desc: 'body' };
    const ring = (e: Element) => {
      const cs = getComputedStyle(e);
      return (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) || (!!cs.boxShadow && cs.boxShadow !== 'none');
    };
    // input ที่ซ่อนด้วยสไตล์ (เช่น file input) ให้ดู ring ของ label/กล่องแม่ (:focus-within)
    const alts: Element[] = [el, ...Array.from((el as HTMLInputElement).labels ?? []), ...(el.parentElement ? [el.parentElement] : [])];
    return {
      testid: el.getAttribute('data-testid') ?? '',
      ring: alts.some(ring),
      desc: el.getAttribute('data-testid') || `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}`,
    };
  });
}

/** กด Tab จนโฟกัสถึง data-testid ที่ต้องการ (บันทึกจุดโฟกัสที่ไม่มี ring ลง noRing) */
export async function tabTo(p: Page, testid: string, noRing: string[], max = 50): Promise<boolean> {
  if ((await focusInfo(p)).testid === testid) return true;
  for (let i = 0; i < max; i++) {
    await p.keyboard.press('Tab');
    const f = await focusInfo(p);
    if (!f.ring) noRing.push(f.desc);
    if (f.testid === testid) return true;
  }
  return false;
}

/** ตรวจว่าทุก case-status/row-status/sla-level/row-sla-level มีข้อความไม่ว่างและตรงรหัส (CONTRACT 4.1/4.2) */
export async function statusTextProblems(p: Page): Promise<string[]> {
  return p.evaluate(
    ({ statusTh, levelTh }) => {
      const out: string[] = [];
      const near = (e: Element, a: string, alt?: string): string | null => {
        const own = e.getAttribute(a) ?? (alt ? e.getAttribute(alt) : null);
        if (own) return own;
        const up = e.closest(`[${a}]${alt ? `, [${alt}]` : ''}`);
        return up ? (up.getAttribute(a) ?? (alt ? up.getAttribute(alt) : null)) : null;
      };
      for (const id of ['case-status', 'row-status']) {
        document.querySelectorAll(`[data-testid="${id}"]`).forEach((e) => {
          const t = (e.textContent ?? '').trim();
          const code = near(e, 'data-status');
          if (!t) out.push(`${id} ว่าง`);
          else if (!code || statusTh[code] !== t) out.push(`${id} "${t}" ≠ ${code}`);
        });
      }
      for (const id of ['sla-level', 'row-sla-level']) {
        document.querySelectorAll(`[data-testid="${id}"]`).forEach((e) => {
          const t = (e.textContent ?? '').trim();
          const code = near(e, 'data-level', 'data-sla-level');
          if (!t) out.push(`${id} ว่าง`);
          else if (!code || levelTh[code] !== t) out.push(`${id} "${t}" ≠ ${code}`);
        });
      }
      return out;
    },
    { statusTh: STATUS_TH as Record<string, string>, levelTh: LEVEL_TH as Record<string, string> },
  );
}

// ───────────────────────── ไฟล์ฐานข้อมูล (TC-NFR-04) ─────────────────────────

/** นับจำนวนครั้งที่พบสตริง (UTF-8) ในไฟล์ */
export function countInFile(file: string, needle: string): number {
  const buf = fs.readFileSync(file);
  const n = Buffer.from(needle, 'utf8');
  let count = 0;
  let i = buf.indexOf(n);
  while (i >= 0) {
    count++;
    i = buf.indexOf(n, i + 1);
  }
  return count;
}
