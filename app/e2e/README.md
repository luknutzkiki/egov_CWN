# e2e · Playwright (TEST-PLAN 51 TC)

```bash
cd e2e
npm install
npx playwright install --with-deps chromium   # ครั้งแรก
# เว็บต้องรันด้วย TEST_MODE=1 (cd ../web && docker compose up --build)
BASE_URL=http://localhost:3000 npx playwright test          # ทั้งหมด
npx playwright test tests/part1.spec.ts                      # ชุด 1 (AUTH FEE SUBMIT UPLOAD PAY QUEUE SLA NOTI)
npx playwright test -g "TC-QUEUE-02"                         # TC เดียว
npx playwright test --list                                   # รายชื่อ TC
```

- `playwright.config.ts`: `workers: 1` (เว็บมีสถานะกลางชุดเดียว) · `BASE_URL` จาก env (ค่าเริ่มต้น `http://localhost:3000`)
- `global-setup.ts` → `fixtures/make-fixtures.js` สร้างไฟล์ทดสอบ TEST-DATA §11 ใน `fixtures/files/` (ขนาดตรงไบต์ · รันเองได้ `npm run fixtures`)
- `helpers.ts`: `reset()` `setClock()` `loginCitizen()` `loginStaff()` (API) · `uiLoginCitizen()` `uiLoginStaff()` (หน้าจอ) ·
  `citizenSession()` `staffSession()` (browser context + `context.request` cookie เดียวกัน) · `newPaid()` `newPending()` `pay()` `payRaw()` ·
  `expectApi(res, status, code)` · `cleanup()` (ใส่ใน `test.afterEach`)
- ทุก TC เริ่มด้วย `reset()` และหลัง `reset()` ทุกครั้งต้องสร้าง context ใหม่แล้วล็อกอินใหม่ (CONTRACT 0.9)
- ผลรายงาน: `playwright-report/` (html) · `test-results/results.json`
