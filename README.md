# egov_CWN · e-Service กลาง เทศบาลนครตัวอย่าง

เว็บ e-Service กลางของเทศบาล (หน่วยงานสมมติ) ให้ประชาชนยื่นคำขอออนไลน์ ชำระเงินผ่าน QR และรับเอกสารดิจิทัล พร้อมระบบฝั่งเจ้าหน้าที่ / หัวหน้า, Dashboard และชุดทดสอบ Playwright ครบ 51 TC

> ThaiD, PromptPay และลายเซ็นดิจิทัลในระบบนี้เป็น**ตัวจำลอง**ทั้งหมด

## ฟีเจอร์หลัก

| โมดูล | ไฟล์ | รายละเอียด |
|---|---|---|
| ยืนยันตัวตน | `web/src/routes/auth.js` | ThaiD + OTP, ล็อกบัญชี, ลงทะเบียน, SSO เจ้าหน้าที่ |
| ประชาชน | `web/src/routes/citizen.js` | ร่างคำขอ, แนบไฟล์, ชำระ QR, เลขคำขอ, ยกเลิก / ส่งแก้ |
| เจ้าหน้าที่ / หัวหน้า | `web/src/routes/officer.js` | คิวงาน, รับเรื่อง, ตีกลับ, ส่งต่อ, อนุมัติ, แจ้งเตือน |
| เอกสารดิจิทัล | `web/src/routes/documents.js` | ออกเอกสาร, HMAC, PDF, `/verify`, unmask |
| Dashboard | `web/src/routes/dashboard.js` | สถิติ + ส่งออก Excel / PDF |
| Audit / Admin | `web/src/routes/audit-admin.js` | บันทึกการใช้งานและการจัดการระบบ |
| กฎธุรกิจ | `web/src/lib/rules.js` | ค่าธรรมเนียม, SLA ฯลฯ (เวลาอ่านจาก `lib/clock.js` เท่านั้น) |

## Tech stack

- **Backend:** Node.js 20 + Express, หน้า server-rendered
- **Database:** SQLite (better-sqlite3)
- **Test:** Playwright 1.65 (Chromium) + `node --test` สำหรับ unit test ของกฎ
- **Run:** Docker Compose

## โครงสร้างโปรเจกต์

```
.
├── app/
│   ├── web/              # แอปพลิเคชัน (Express + SQLite)
│   │   ├── src/
│   │   │   ├── server.js
│   │   │   ├── db.js, seed.js
│   │   │   ├── lib/      # rules, clock, bugs, auth, crypto, audit ...
│   │   │   ├── routes/   # auth, citizen, officer, documents, dashboard, audit-admin
│   │   │   ├── views/
│   │   │   └── public/
│   │   ├── Dockerfile
│   │   └── docker-compose.yml
│   ├── e2e/              # Playwright (51 TC) — ดู app/e2e/README.md
│   ├── test-runs/        # สคริปต์และผลสรุปการรันทดสอบแต่ละรอบ
│   └── TEST-REPORT.md    # รายงานผลทดสอบฉบับเต็ม
├── PLAN.md               # แผนแบ่งงานเป็นบล็อก (DAG + Gantt)
├── REPORT.md             # แผน vs ผลจริงของแต่ละบล็อก
├── BUG-HUNT.md
└── blocks.json, *.png    # ข้อมูลบล็อกและภาพ DAG / Gantt
```

## วิธีรัน

ต้องมี Docker + Docker Compose

```bash
cd app/web
docker compose up --build
# เปิด http://localhost:3000
```

ตัวแปรที่ใช้ได้:

| ตัวแปร | ค่าเริ่มต้น | ความหมาย |
|---|---|---|
| `PORT` | `3000` | พอร์ตบนเครื่อง |
| `TEST_MODE` | (ว่าง) | `1` = เปิด `/api/test/*` (reset, ตั้งนาฬิกา ฯลฯ) · ไม่ตั้ง = 404 |
| `BUG_MODE` | (ว่าง) | เปิดบั๊กที่ฝังไว้ เช่น `B03` หรือ `B03,B07` |
| `BASE_URL` | `http://localhost:3000` | URL ที่ใช้สร้างลิงก์ในเอกสาร |

```bash
TEST_MODE=1 docker compose up --build               # โหมดทดสอบ
TEST_MODE=1 BUG_MODE=B03 docker compose up --build  # เปิดบั๊ก B03
```

ฐานข้อมูลอยู่ที่ `app/web/data/app.db` (mount เข้าคอนเทนเนอร์ที่ `/app/data/app.db`)

รันแบบไม่ใช้ Docker:

```bash
cd app/web
npm install
npm start          # หรือ npm run dev (TEST_MODE=1)
npm test           # unit test ของกฎธุรกิจ
```

## ทดสอบ E2E (Playwright)

```bash
# 1) รันเว็บในโหมดทดสอบ
cd app/web && TEST_MODE=1 docker compose up --build -d

# 2) รันชุดทดสอบ
cd ../e2e
npm install
npx playwright install --with-deps chromium   # ครั้งแรก
BASE_URL=http://localhost:3000 npx playwright test
npx playwright test -g "TC-QUEUE-02"          # รัน TC เดียว
```

รายละเอียดเพิ่มเติมดู [app/e2e/README.md](app/e2e/README.md)

## ผลการทดสอบ

- โหมดปกติ (`TEST_MODE=1`, ไม่ตั้ง `BUG_MODE`): **51/51 ผ่าน** (รัน 3 รอบ)
- `BUG_MODE` B01–B12 ทีละตัว: TC ที่ควรล้มล้มครบ 12/12 บั๊ก

ดูฉบับเต็มที่ [app/TEST-REPORT.md](app/TEST-REPORT.md)
