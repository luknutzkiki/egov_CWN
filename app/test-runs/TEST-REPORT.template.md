# TEST-REPORT · e-Service กลาง เทศบาลนครตัวอย่าง

บล็อก B12: รวมระบบ รัน Playwright ชุดเต็ม 51 TC และรัน BUG_MODE B01–B12 ตาม `BUGS.md` · รันเมื่อ 2026-11-14 ถึง 2026-11-15 · เว็บรันด้วย `docker compose up --build -d` (โฟลเดอร์ `web/`) · ผลดิบทุกรอบอยู่ใน `test-runs/`

## 1. สรุปผล

| รายการ | ผล |
|---|---|
| `TEST_MODE=1` ไม่ตั้ง `BUG_MODE` (rebuild แล้วรันชุดเต็ม · `normal-1`) | **{{N2}}** |
| รันซ้ำทันทีโดยไม่ restart เว็บ (BUGS.md §3 ขั้น 2 · `normal-2-rerun`) | **{{N3}}** |
| ปิดบั๊กทั้งหมดอีกครั้งหลังรัน BUG_MODE ครบ (BUGS.md §3 ขั้น 6 · `normal-3-final`) | **{{NF}}** |
| `BUG_MODE` B01–B12 ทีละตัว (restart เว็บทุกรอบ) | {{BUGSUM}} |
| รวมบั๊ก `B03,B07` และ `B01,B05,B09` (BUGS.md §3 ขั้น 5) | {{COMBOSUM}} |

{{CRITERIA}}

## 2. สภาพแวดล้อมและวิธีรัน

- Docker 29.9.3 · Docker Compose 5.7.0 · image `node:20-bookworm-slim` (Express + better-sqlite3) · Playwright 1.65.0 + Chromium headless shell 158 · `workers: 1` (เว็บมีสถานะกลางชุดเดียว)
- คำสั่งที่ใช้จริง (หนึ่งรอบ = restart เว็บ + ชุดเต็ม 51 TC):

```bash
test-runs/run-suite.sh <label> [BUG_MODE]       # เช่น test-runs/run-suite.sh bug-B03 B03
NO_RESTART=1 test-runs/run-suite.sh <label>     # รันซ้ำโดยไม่ restart เว็บ
HTML=1 test-runs/run-suite.sh <label>           # เพิ่มรายงาน HTML ที่ test-runs/<label>-html/
```

  สคริปต์ทำตามลำดับ: `cd web && TEST_MODE=1 BUG_MODE=<ค่า> docker compose up --build -d --force-recreate` → รอ `/api/health` → ตรวจ `GET /api/test/info` ว่า `testMode` = true, route โหลดครบ และ `bugs` ตรงกับ `BUG_MODE` ที่สั่ง (กันกรณี parse `BUG_MODE` ผิดตาม BUGS.md §5) → เปิดเว็บโหมดที่สองที่ไม่ตั้ง `TEST_MODE` (คอนเทนเนอร์ `egov-notest` พอร์ต 3102) ให้ TC-NFR-03 ตรวจ `POST /api/test/reset` → 404 → เก็บ log ของเว็บตลอดรอบให้ TC-NFR-04 ค้นข้อมูลส่วนบุคคล → `cd e2e && npx playwright test` → สรุปเทียบตาราง BUGS.md §2 ด้วย `test-runs/summarize.js`
- เทียบเท่าคำสั่งมือ: `cd web && TEST_MODE=1 BUG_MODE=B03 docker compose up --build -d` แล้ว `cd e2e && npx playwright test` (ตั้ง `NO_TEST_MODE_URL` `WEB_LOG_PATH` `PII_ENCRYPTION` ถ้าต้องการให้ TC-NFR-03/04 ตรวจครบทุกส่วน · ถ้าไม่ตั้ง ส่วนนั้นถูกข้ามพร้อม annotation)
- ทุกรอบในรายงานนี้ไม่มี TC ที่ถูกข้าม (skipped = 0) และ TC-NFR-03 / TC-NFR-04 ตรวจครบทุกส่วน (ไม่มี annotation `skip-part`)

## 3. ผลรอบปกติ (`TEST_MODE=1` · ไม่ตั้ง `BUG_MODE` · `normal-1`)

{{NORMAL_TABLE}}

## 4. สิ่งที่แก้ระหว่างรวมระบบ

รอบแรก (`pass1/run01-normal` · ก่อนแก้) ได้ 48/51: ล้ม 3 TC ที่ขั้นดาวน์โหลดไฟล์เหมือนกันทั้งหมด

| TC ที่ล้ม | อาการ | สาเหตุ | ประเภท | แก้ |
|---|---|---|---|---|
| TC-WORKFLOW-01 ขั้น 5 · TC-DASH-03 ขั้น xlsx · TC-AUDIT-01 ขั้น CSV | `ไม่ได้ไฟล์ดาวน์โหลด` (หมดเวลา 20 s) | ปุ่ม `download-doc-btn` `export-xlsx-btn` `export-pdf-btn` `audit-export-csv-btn` เป็น `<a … download>` · Chromium ส่งลิงก์ที่มีแอตทริบิวต์ `download` ไปตัวจัดการดาวน์โหลดตรง ไม่ผ่าน `context.route` และไม่เกิด event `request`/`response` (พิสูจน์ด้วยสคริปต์ทดลองกับเว็บสำรอง: เกิดแค่ event `download`) จึงอ่าน status / `Content-Type` / `Content-Disposition` ที่ TEST-PLAN ให้ตรวจไม่ได้ | test ผิด (กลไกดักไฟล์) · เว็บไม่ผิดกฎใด ๆ | **เว็บ:** ถอดแอตทริบิวต์ `download` ออกจาก 4 ลิงก์ (`web/src/routes/dashboard.js` `documents.js` `audit-admin.js`) · server ส่ง `Content-Disposition: attachment` อยู่แล้ว ผู้ใช้กดแล้วได้ไฟล์ชื่อเดิมและอยู่หน้าเดิม และ test อ่าน header จริงได้โดยเรียก server ครั้งเดียว (ไม่แก้ฝั่ง test ด้วยการดาวน์โหลดซ้ำเพื่ออ่าน header เพราะการส่งออกแต่ละครั้งเขียน Audit `EXPORT` ทำให้จำนวนที่ TC-DASH-03/TC-AUDIT-01 นับเกิน) · **test:** `grabDownload` ใน `e2e/helpers2.ts` ล้มทันทีพร้อมบอกสาเหตุถ้าเจอลิงก์ `download` แทนการรอจนหมดเวลา |

หลังแก้ได้ 51/51 (`pass1/run02-normal` และรันซ้ำ `pass1/run03-normal-rerun`) แล้วรัน BUG_MODE รอบแรก (`pass1/bug-B01` … `bug-B12`) ทุกบั๊กมี TC ที่ต้องล้มล้มครบ แต่พบข้อความล้มที่ยังไม่ดีพอตาม BUGS.md §3 ขั้น 4 จึงแก้ test เพิ่มตามตารางล่าง แล้วรันชุดหลักฐานทั้งหมดใหม่ด้วย test ชุดสุดท้าย (ผลในข้อ 1 3 5 6 มาจากรอบหลังนี้ทั้งหมด)

| TC | อาการในรอบแรก | ประเภท | แก้ |
|---|---|---|---|
| TC-QUEUE-02 ส่วน 1 (เปิด B08) | ล้มด้วย `action-error` … `element(s) not found` (หาข้อความของผู้แพ้ไม่เจอ เพราะทั้งสองคนรับเรื่องสำเร็จ) ไม่ใช่ค่าต่าง | test เปราะ (BUGS.md §5 แถว "ล้มด้วย timeout / หา element ไม่เจอ") | `e2e/tests/part1.spec.ts`: ตรวจผลบนจอของทั้งสองคนเป็นค่าก่อน ต้องได้ `[error: มีเจ้าหน้าที่รับเรื่องนี้แล้ว, success]` → เปิด B08 ได้ `[success, success]` · ตรวจกับเว็บสำรองแล้ว: เว็บถูกผ่าน · B08 ล้มที่ค่า |
| TC-UPLOAD-01 (B02) · TC-RBAC-01 (B06) | ล้มที่ค่าแล้ว (`Expected: 1 Received: 0` · `Expected: 404 Received: 200`) แต่ข้อความไม่บอกว่าเป็นไฟล์/หน้าไหน | ปรับข้อความ | เพิ่มข้อความกำกับ assert (`size-5242880.pdf … ต้องถูกรับ` · `สมหญิงเปิด /citizen/cases/EG-2569-000005 (ของสมชาย) ต้องได้ HTTP`) ไม่เปลี่ยนสิ่งที่ตรวจ |

ไม่ได้แก้ค่าที่คาดหวังใน test และไม่ได้แก้ข้อความ/testid/route/API ที่ CONTRACT กำหนด

## 5. ตาราง triage (BUGS.md §4)

แต่ละแถว = restart เว็บด้วย `TEST_MODE=1 BUG_MODE=<รหัส>` แล้วรันชุดเต็ม 51 TC

{{TRIAGE_TABLE}}

**สรุป:** {{TRIAGE_SUMMARY}}

### 5.1 ข้อความที่ล้ม (BUGS.md §3 ขั้น 4: ต้องบอกค่าจริงต่างจากค่าที่คาดตรงไหน)

{{VALUE_CHECK}} (`Timeout 7000ms` ที่ต่อท้ายบางบรรทัดคือเวลารอของ `toHaveText`/`toHaveCount` ซึ่งยังแสดงค่าจริงเทียบค่าคาด)

{{TRIAGE_DETAILS}}

### 5.2 B03 ทำให้ TC-NOTI-02 ล้มด้วย (นอกตาราง BUGS.md §2)

- **อาการ:** เปิด `BUG_MODE=B03` แล้ว TC-NOTI-02 ส่วน B (request แรกที่ ส. 5 ธ.ค. 2569 10:00) ไม่ได้ `…000016 near` ของ `off.reg2` และ `…000011 near` ของ `head1` (bell 9 แทน 10 · 14 แทน 15) · ยิง API ตรงกับเว็บ B03 ยืนยัน: `GET /api/cases/EG-2569-000016` ที่ 5 ธ.ค. ได้ `slaLevel` = `normal` แทน `near`
- **สาเหตุ:** TEST-DATA §8.1 กำหนดว่า `…000011` `…000016` (กำหนด อ. 8 ธ.ค.) "ใกล้ครบกำหนด (เหลือ 1: อ.8 ธ.ค.)" ซึ่งต้องข้าม จ. 7 ธ.ค. ที่เป็นวันหยุด · B03 ทำให้วันหยุดในตารางนับเป็นวันทำการ จึงเหลือ 2 วัน (จ.7, อ.8) = `ปกติ` · กลไกเดียวกับที่ BUGS.md ยอมรับให้ TC-SLA-03 ส่วน B ล้ม
- **ตรวจตาม BUGS.md §5:** บั๊กไม่รั่วเกินจุด: `bug('B03')` อยู่จุดเดียวใน `isWorkingDay()` (`web/src/lib/rules.js`) ซึ่งเป็นฟังก์ชันวันทำการตัวเดียวตามที่ DECISIONS §18 ("B03 กระทบอะไร") กำหนด: "ฟังก์ชันวันทำการตัวเดียวใช้ทั้งกำหนดเสร็จและวันคงเหลือ → TC ที่ใช้วันคงเหลือข้ามวันหยุดล้มด้วยได้" · TC-NOTI-02 RESET ต้นทุกส่วน ไม่พึ่งข้อมูลของ TC ก่อนหน้า · ล้มซ้ำได้ทุกครั้ง
- **ตัดสิน:** ไม่แก้เว็บและไม่แก้ test · ถ้าย้ายบั๊กไปกระทบเฉพาะการคำนวณกำหนดเสร็จ จะขัด DECISIONS §18 และถ้าลดการตรวจใน TC-NOTI-02 จะขัด TEST-PLAN/BUGS.md ข้อ 5 · ถือเป็น "แผนไม่ครบ" ส่งเป็นคำถาม Q-B12-1 (ข้อ 7) · ถ้า TA เลือกให้ B03 กระทบเฉพาะกำหนดเสร็จ แก้ได้จุดเดียวใน `rules.js` (ส่งตารางวันหยุดว่างให้ `dueAt`/`pausedExtension`/`extendDue` เมื่อเปิด B03 แทนการเช็กใน `isWorkingDay`) แล้ว TC-SLA-03 และ TC-NOTI-02 จะผ่าน

## 6. รวมบั๊ก (BUGS.md §3 ขั้น 5) และปิดบั๊กอีกครั้ง (ขั้น 6)

{{COMBO_TABLE}}

{{COMBO_DETAILS}}

## 7. คำถาม / ข้อสังเกตถึง TA

| รหัส | เรื่อง | รายละเอียด |
|---|---|---|
| Q-B12-1 | BUGS.md §2 แถว B03 ขาด TC-NOTI-02 ในคอลัมน์ "อาจล้มด้วย" | ตามข้อ 5.2 · DECISIONS §18 ยอมรับ TC ที่ใช้วันคงเหลือข้ามวันหยุด แต่ตารางระบุเฉพาะ TC-SLA-03 · TC-RBAC-04 · ขอยืนยันว่าเพิ่ม TC-NOTI-02 (ส่วน B) ในรายการได้ หรือให้ B03 กระทบเฉพาะการคำนวณกำหนดเสร็จ |
| N-1 | TC-PDPA-03 ขั้น 1–2 ใช้เวลาราว 19 s | หน้าเว็บตรวจเหตุผลว่าง/เว้นวรรคล้วนฝั่ง client (`documents.js` แสดง `กรุณากรอกเหตุผล` โดยไม่ยิง request) · helper `act()` รอ response ที่ไม่ใช่ GET ได้สูงสุด 8 s ต่อครั้งแล้วไปต่อ · ค่าที่ assert หลังจากนั้นยังตรวจจริง (`unmask-error` บนจอ + ยิง API ตรงได้ 400 `REASON_REQUIRED` จาก server) จึงไม่ใช่ผ่านเพราะหมดเวลา |
| N-2 | TC-NFR-04 (inspection) | ข้อมูลส่วนบุคคล (เลขบัตร · เบอร์มือถือ) เข้ารหัส **AES-256-GCM** (`web/src/lib/crypto.js` รูป `v1:` + base64(iv · tag · ciphertext)) · ค้นหา/ล็อก OTP ด้วย HMAC-SHA256 (`lookupHash`) · ตรวจไฟล์ `web/data/app.db` + `app.db-wal` + log ของเว็บทั้งรอบ: พบค่าตรงตัว 0 ทุกค่า · ตัวควบคุมบวก: สมชายยังได้ `idNo` = `1101700123456` · HTTPS ตอน deploy เป็น Q-08 ไม่ทดสอบที่นี่ |
| N-3 | `web/out.log` | ไฟล์ log ที่ agent อื่นทิ้งไว้ (node หา `web/t.js` ไม่เจอ) ไม่ใช่ส่วนของเว็บและไม่ถูก copy เข้า image (Dockerfile copy เฉพาะ `package*.json` และ `src/`) · ไม่ได้ลบเพราะไม่ใช่ไฟล์ของ B12 |

## 8. ไฟล์หลักฐาน (`test-runs/`)

| ไฟล์ | เนื้อหา |
|---|---|
| `<label>.json` | ผล Playwright (JSON reporter) ครบ 51 TC พร้อม step และข้อความ error |
| `<label>.log` | ผลแบบ line reporter |
| `<label>-summary.txt` | สรุปเทียบตาราง BUGS.md §2 (ต้องล้ม/อาจล้ม/ล้มเกิน/ควรล้มแต่ผ่าน) |
| `<label>-info.json` | `GET /api/test/info` หลัง restart (ยืนยัน `testMode` และ `bugs` ที่เปิดจริง) |
| `<label>-web.log` | log ของคอนเทนเนอร์เว็บตลอดรอบ (บรรทัด `[start] … BUG_MODE=…`) |
| `<label>-artifacts/` | screenshot + `error-context.md` ของ TC ที่ล้ม{{TRACE_NOTE}} |
| `normal-3-final-html/` | รายงาน HTML ของรอบปิดบั๊กท้ายสุด (`cd e2e && npx playwright show-report ../test-runs/normal-3-final-html`) |
| `pass1/` | ผลรอบแรกทั้งหมด (ก่อนแก้ดาวน์โหลด · BUG_MODE รอบแรกก่อนปรับข้อความ TC-QUEUE-02) เก็บไว้เป็นประวัติ |
| `run-all.sh` · `run-suite.sh` · `summarize.js` · `report-tables.js` · `fill-report.js` + `TEST-REPORT.template.md` | สคริปต์รัน · สรุปเทียบ BUGS.md · สร้างตาราง · เติมผลลงรายงานนี้จาก JSON (`node test-runs/fill-report.js` · ไม่คัดลอกผลด้วยมือ) |

label ที่ใช้ (ตามลำดับที่ `test-runs/run-all.sh` รัน): `normal-1` · `normal-2-rerun` · `bug-B01` … `bug-B12` · `combo-B03-B07` · `combo-B01-B05-B09` · `normal-3-final`
