'use strict';
/*
 * e-Service กลาง เทศบาลนครตัวอย่าง · เซิร์ฟเวอร์หลัก (บล็อก B01)
 * รัน: cd web && docker compose up --build   (หรือ npm install && TEST_MODE=1 node src/server.js)
 * env: TEST_MODE=1 เปิด /api/test/* · BUG_MODE=B03,B07 · DB_PATH=ไฟล์ SQLite · BASE_URL · PORT (3000)
 *
 * ===================== คู่มือสำหรับบล็อกอื่น (อ่านส่วนนี้พอ ไม่ต้องแก้ไฟล์นี้) =====================
 *
 * 1) เพิ่ม route: สร้างไฟล์ web/src/routes/<ชื่อ>.js → server โหลดทุกไฟล์ในโฟลเดอร์นี้อัตโนมัติ (เรียงตามชื่อ
 *    ข้ามไฟล์ที่ขึ้นต้น _ และ *.test.js) · export ได้แบบใดแบบหนึ่ง:
 *      module.exports = router;                          // express.Router()
 *      module.exports = (app, ctx) => { app.get(…) };   // ฟังก์ชันลงทะเบียน (คืน router ก็ได้)
 *      module.exports = { router } หรือ { register(app, ctx) }
 *    ใช้ Express 4: handler แบบ async ต้องจับ error เอง หรือห่อด้วย ctx.ah(fn) · better-sqlite3 เป็น sync
 *    ไฟล์ที่โหลดไม่ขึ้นจะถูก log และข้าม (เว็บยังรันต่อ) · ดูผลที่ GET /api/test/info (TEST_MODE)
 *
 * 2) ctx ที่ส่งให้ route (หรือ require โมดูลตรงก็ได้):
 *      ctx.db        require('../db')            better-sqlite3 instance + { nextSeq(name), setSeq(name,v), CASE_STATUSES, ROLES, AUDIT_EVENTS }
 *                                                schema ทุกตาราง + ข้อตกลงเวลา/ตัวนับ อยู่หัวไฟล์ web/src/db.js
 *      ctx.clock     require('../lib/clock')     now() → Date · nowIso() → '2026-12-01T09:00:00+07:00' · toIso(x) · parseIso(s)
 *                                                กฎเวลาทุกข้อใช้ clock เท่านั้น ห้าม Date.now()/new Date() ตรง ๆ
 *      ctx.bug       require('../lib/bugs').bug  bug('B07') → true เมื่อเปิดใน BUG_MODE
 *      ctx.auth      require('../lib/auth')      requireRole('officer','head') · requireCitizen · requireLogin · currentUser(req)
 *                                                login(req, user) (Promise) · loginPendingCitizen(req,{citizenId,name}) · logout(req)
 *                                                landingFor(user) · isApi(req) · รูปแบบ req.session.user ดูหัวไฟล์ lib/auth.js
 *                    ไม่ล็อกอิน: หน้า → redirect /login · API → 401 UNAUTHENTICATED
 *                    บทบาทไม่ตรง: หน้า → 403 + `forbidden-msg` · API → 403 FORBIDDEN
 *      ctx.errors    require('../lib/errors')    sendError(res,'ALREADY_CLAIMED',{extra}) · new AppError(code) · ข้อความตรง CONTRACT §5
 *      ctx.format    require('../lib/format')    thaiDateTime → `4 ธ.ค. 2569 16:30` · thaiDate → `2 ก.พ. 2570` · money → `฿1,010`
 *                                                iso(x) → ISO +07:00 · ymd(x) · bkkParts(x) · fromBkk(y,m,d,h,mi) · beYear(x)
 *                                                formatIdNo · STATUS_TH LEVEL_TH ROLE_TH SERVICES(docs ตามตาราง 4.3) · numbers.caseNo(be,seq) …
 *      ctx.crypto    require('../lib/crypto')    encrypt/decrypt (AES-256-GCM) · lookupHash(idNo) · sign([...]) HMAC-SHA256 '|'
 *                                                hashPassword/verifyPassword · randomCode(8) · randomId('f_')
 *      ctx.layout    require('../views/layout')  renderPage(req,res,{title,body,status,scripts,inlineScript}) · renderForbidden · renderNotFound
 *                                                esc · html`` · raw · attrs · dt(testid, iso) (data-iso + ข้อความไทย) · statusBadge · levelBadge · setFlash
 *                    หัวเว็บ (app-header user-name user-role nav-* nav-bell bell-count logout-btn) render ให้แล้วตามบทบาท
 *                    action-error/action-success: ใช้ setFlash (เซิร์ฟเวอร์) หรือ eg.showError/eg.showSuccess (/static/app.js) ชิ้นเดียวต่อหน้า
 *      ctx.hooks     require('../lib/hooks')     onRequest(name, fn, {order}) · onReset(name, fn) — ดูข้อ 3
 *      ctx.upload    multer (memoryStorage) จำกัด 10 MB/ไฟล์ → ไฟล์ 5,242,881 ไบต์เข้าถึง handler ได้ ต้องตรวจขนาดเองตาม BR-07
 *                    ใช้: router.post('/api/drafts/:id/files', ctx.upload.single('file'), handler) → req.file.buffer / req.body.docKey
 *      ctx.config    require('../lib/config')    TEST_MODE · BASE_URL · PORT · DB_PATH
 *      ctx.ah(fn)    ห่อ async handler ให้ error ไปที่ตัวจัดการกลาง
 *
 * 3) hook ทุก request (CONTRACT §0 ข้อ 7): ลงทะเบียนตอนโหลดโมดูล เช่น
 *      ctx.hooks.onRequest('auto-cancel', ({ db, now, nowIso }) => { … }, { order: 10 });   // B05 ยกเลิกเมื่อเลย 168 ชม.
 *      ctx.hooks.onRequest('sla-notify', ({ db, now, nowIso }) => { … }, { order: 50 });    // B06 แจ้งเตือน SLA
 *    รันก่อน route ทุก request ยกเว้น /api/test/* และ /static/* · แต่ละ hook อยู่ใน db.transaction · ต้องเป็น sync
 *
 * 4) test hook (เฉพาะ TEST_MODE=1 · ไม่ตั้ง → ทุก path /api/test/* ตอบ 404 ให้อัตโนมัติ):
 *      POST /api/test/reset  → DROP+สร้างตารางใหม่ · เรียก seed(db, ctx) จาก web/src/seed.js (export ฟังก์ชัน หรือ { seed })
 *                               ใน transaction · นาฬิกากลับ 2026-12-01T09:00:00+07:00 · ล้าง session ทุกคน · รัน onReset hooks
 *                               → 200 {"ok":true,"now":"2026-12-01T09:00:00+07:00"}
 *      GET  /api/test/clock  → 200 {"now":"…"} · PUT {"now":"<ISO+offset>"} → แช่แข็ง → 200 {"now":"…+07:00"} · ผิด → 400 INVALID_TIME
 *      บล็อกอื่นเพิ่ม /api/test/payments/:ref/pay (B05) และ /api/test/documents/:docNo/tamper (B07) ในไฟล์ route ของตัวเองได้เลย
 *    ฐานข้อมูลว่างตอนเริ่ม (ไม่มี users) → reset + seed ให้อัตโนมัติ
 *
 * 5) อื่น ๆ: GET /api/health → {"status":"ok"} · GET / → redirect หน้าตั้งต้นตามบทบาท (route อื่นที่ลงทะเบียน / ก่อนจะชนะ)
 *    POST|GET /logout → ล้าง session → /login (ปุ่ม logout-btn ในหัวเว็บ) · body JSON/form ≤ 10 MB
 *    404 ที่ไม่มี route: API → {"code":"NOT_FOUND","message":"ไม่พบคำขอ"} · หน้า → `not-found-msg`
 *    error กลาง: AppError → JSON ตามรหัส · multer LIMIT_FILE_SIZE → 400 FILE_TOO_LARGE · JSON ผิดรูป → 400 BAD_REQUEST
 * ==================================================================================================
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const multer = require('multer');

const db = require('./db');
const clock = require('./lib/clock');
const bugs = require('./lib/bugs');
const auth = require('./lib/auth');
const errors = require('./lib/errors');
const format = require('./lib/format');
const cryptoLib = require('./lib/crypto');
const hooks = require('./lib/hooks');
const config = require('./lib/config');
const layout = require('./views/layout');

const ROUTES_DIR = path.join(__dirname, 'routes');
const SEED_FILE = path.join(__dirname, 'seed.js');
const BODY_LIMIT = '10mb'; // ≥ 6 MB (CONTRACT §0 ข้อ 10)
const UPLOAD_FILE_LIMIT = 10 * 1024 * 1024; // ให้ไฟล์ 5,242,881 ไบต์ถึง handler แล้วตอบ 400 FILE_TOO_LARGE เอง

const ah = (fn) => (req, res, next) => Promise.resolve().then(() => fn(req, res, next)).catch(next);

const isRouter = (m) => typeof m === 'function' && typeof m.use === 'function' && typeof m.handle === 'function' && Array.isArray(m.stack);

function loadSeedFn() {
  if (!fs.existsSync(SEED_FILE)) return null;
  const mod = require(SEED_FILE);
  if (typeof mod === 'function') return mod;
  if (mod && typeof mod.seed === 'function') return mod.seed;
  if (mod && typeof mod.default === 'function') return mod.default;
  throw new Error('web/src/seed.js ต้อง export ฟังก์ชัน seed(db)');
}

function createApp() {
  const app = express();
  const sessionStore = new session.MemoryStore();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: UPLOAD_FILE_LIMIT, files: 20 } });

  const ctx = {
    app, db, clock, bugs, bug: bugs.bug, auth, errors, format, crypto: cryptoLib, hooks, layout, upload, config, ah,
  };

  const routeStatus = { loaded: [], failed: [] };

  // ล้างทุกอย่างแล้ว seed ใหม่ (POST /api/test/reset และตอนเริ่มเมื่อฐานข้อมูลว่าง)
  async function resetAll() {
    db.resetSchema();
    const seed = loadSeedFn();
    if (seed) {
      if (seed.constructor && seed.constructor.name === 'AsyncFunction') await seed(db, ctx);
      else db.transaction(() => seed(db, ctx))();
    } else {
      console.warn('[reset] ไม่พบ web/src/seed.js — ฐานข้อมูลว่าง');
    }
    clock.reset();
    await new Promise((resolve) => sessionStore.clear(() => resolve()));
    hooks.runResetHooks();
    db.checkpoint();
    return { ok: true, now: clock.nowIso() };
  }
  ctx.resetAll = resetAll;

  app.disable('x-powered-by');
  app.set('etag', false);

  // ไฟล์คงที่ (ไม่ผ่าน hook)
  app.use('/static', express.static(path.join(__dirname, 'public'), { maxAge: '1h', index: false }));
  app.get('/favicon.ico', (req, res) => res.status(204).end());

  // /api/test/* เปิดเฉพาะ TEST_MODE=1 (ไม่ตั้ง → 404 ก่อนถึง route ใด ๆ)
  app.use('/api/test', (req, res, next) => {
    if (!config.TEST_MODE) return res.status(404).json({ code: 'NOT_FOUND', message: 'Not Found' });
    return next();
  });

  app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  app.use(express.json({ limit: BODY_LIMIT }));
  app.use(express.urlencoded({ extended: false, limit: BODY_LIMIT }));

  app.use(session({
    name: 'egov.sid',
    secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', secure: false, path: '/' },
  }));

  app.use((req, res, next) => {
    req.user = auth.currentUser(req);
    res.locals.user = req.user;
    next();
  });

  // ประเมิน SLA/แจ้งเตือน/ยกเลิกอัตโนมัติตามนาฬิกาปัจจุบัน ทุก request ยกเว้น /api/test/*
  app.use((req, res, next) => {
    if (!req.path.startsWith('/api/test/') && req.path !== '/api/test') hooks.runRequestHooks(req);
    next();
  });

  app.get('/api/health', (req, res) => res.status(200).json({ status: 'ok' }));

  // ---------- test hook: reset / clock ----------
  app.post('/api/test/reset', ah(async (req, res) => {
    const out = await resetAll();
    res.status(200).json(out);
  }));

  app.get('/api/test/clock', (req, res) => res.json({ now: clock.nowIso() }));

  app.put('/api/test/clock', (req, res) => {
    const value = req.body && req.body.now;
    if (typeof value !== 'string' || !clock.parseIso(value)) return errors.sendError(res, 'INVALID_TIME');
    return res.json({ now: clock.set(value) });
  });

  // ข้อมูลวินิจฉัยสำหรับทีม (TEST_MODE เท่านั้น · ไม่อยู่ใน CONTRACT)
  app.get('/api/test/info', (req, res) => res.json({
    now: clock.nowIso(),
    testMode: config.TEST_MODE,
    bugs: bugs.enabledBugs(),
    routes: routeStatus,
    hooks: hooks.list(),
    dbPath: config.DB_PATH,
  }));

  // ---------- route ของบล็อกอื่น (auto-load) ----------
  const files = fs.existsSync(ROUTES_DIR)
    ? fs.readdirSync(ROUTES_DIR).filter((f) => f.endsWith('.js') && !f.endsWith('.test.js') && !f.startsWith('_')).sort()
    : [];
  for (const file of files) {
    try {
      const mod = require(path.join(ROUTES_DIR, file));
      if (!mount(app, mod, ctx)) console.warn(`[routes] ${file}: ไม่มี router/ฟังก์ชันให้ mount (โหลดเพื่อผลข้างเคียงเท่านั้น)`);
      routeStatus.loaded.push(file);
    } catch (err) {
      routeStatus.failed.push({ file, error: String(err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : err) });
      console.error(`[routes] โหลด ${file} ไม่สำเร็จ:`, err);
    }
  }

  // ---------- route กลางสำรอง (route ของบล็อกอื่นที่ลงทะเบียน path เดียวกันก่อนจะชนะ) ----------
  app.get('/', (req, res) => {
    const user = auth.currentUser(req);
    if (user) return res.redirect(auth.landingFor(user));
    if (req.session && req.session.pendingCitizen) return res.redirect('/register');
    return res.redirect('/login');
  });

  const logoutPage = ah(async (req, res) => {
    await auth.logout(req);
    res.clearCookie('egov.sid', { path: '/' });
    res.redirect(303, '/login');
  });
  app.post('/logout', logoutPage);
  app.get('/logout', logoutPage);

  // ---------- 404 ----------
  app.use((req, res) => {
    if (auth.isApi(req)) return errors.sendError(res, 'NOT_FOUND');
    return layout.renderNotFound(req, res);
  });

  // ---------- error กลาง ----------
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    let code;
    let extra = {};
    let status;
    if (err && err.isAppError) {
      code = err.code;
      extra = err.extra || {};
      status = err.status;
    } else if (err && (err.code === 'LIMIT_FILE_SIZE' || err.type === 'entity.too.large')) {
      code = 'FILE_TOO_LARGE';
    } else if (err && err.code === 'LIMIT_FILE_COUNT') {
      code = 'FILE_COUNT';
    } else if (err && (err.type === 'entity.parse.failed' || (err.name === 'MulterError'))) {
      code = req.path === '/api/test/clock' ? 'INVALID_TIME' : 'BAD_REQUEST';
    } else {
      console.error(`[error] ${req.method} ${req.originalUrl}:`, err);
      code = 'INTERNAL';
      extra = config.TEST_MODE && err ? { detail: String(err.message || err) } : {};
    }
    status = status || errors.statusOf(code);
    if (auth.isApi(req)) return errors.sendError(res, code, extra, { status });
    if (status === 403) return layout.renderForbidden(req, res);
    if (status === 404) return layout.renderNotFound(req, res);
    return layout.renderPage(req, res, {
      status,
      title: 'เกิดข้อผิดพลาด',
      flash: null,
      body: `<h1>เกิดข้อผิดพลาด</h1><div class="msg msg-error" data-testid="action-error" role="alert">${layout.esc(errors.errorBody(code, extra).message)}</div>`,
    });
  });

  app.locals.ctx = ctx;
  app.locals.routeStatus = routeStatus;
  return { app, ctx, resetAll, sessionStore };
}

function mount(app, mod, ctx) {
  if (!mod) return false;
  if (isRouter(mod)) { app.use(mod); return true; }
  if (typeof mod === 'function') {
    const r = mod(app, ctx);
    if (isRouter(r)) app.use(r);
    return true;
  }
  if (isRouter(mod.router)) { app.use(mod.router); return true; }
  if (typeof mod.register === 'function') {
    const r = mod.register(app, ctx);
    if (isRouter(r)) app.use(r);
    return true;
  }
  if (mod.default) return mount(app, mod.default, ctx);
  return false;
}

async function start() {
  const { app, resetAll } = createApp();
  if (db.isEmpty()) {
    try {
      await resetAll();
      console.log('[start] ฐานข้อมูลว่าง → reset + seed แล้ว');
    } catch (err) {
      console.error('[start] seed ไม่สำเร็จ:', err);
    }
  }
  const server = app.listen(config.PORT, '0.0.0.0', () => {
    console.log(`[start] e-Service ฟังที่พอร์ต ${config.PORT} · TEST_MODE=${config.TEST_MODE ? '1' : 'ปิด'} · BUG_MODE=${bugs.enabledBugs().join(',') || '-'} · DB_PATH=${config.DB_PATH}`);
  });
  const shutdown = () => server.close(() => { try { db.close(); } catch (_) { /* ปิดแล้ว */ } process.exit(0); });
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  return server;
}

module.exports = { createApp, start };

if (require.main === module) {
  start().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
