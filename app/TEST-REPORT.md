# TEST-REPORT · e-Service กลาง เทศบาลนครตัวอย่าง

บล็อก B12: รวมระบบ รัน Playwright ชุดเต็ม 51 TC และรัน BUG_MODE B01–B12 ตาม `BUGS.md` · รันเมื่อ 2026-11-14 ถึง 2026-11-15 · เว็บรันด้วย `docker compose up --build -d` (โฟลเดอร์ `web/`) · ผลดิบทุกรอบอยู่ใน `test-runs/`

## 1. สรุปผล

| รายการ | ผล |
|---|---|
| `TEST_MODE=1` ไม่ตั้ง `BUG_MODE` (rebuild แล้วรันชุดเต็ม · `normal-1`) | **51/51 passed (144 s) ✅** |
| รันซ้ำทันทีโดยไม่ restart เว็บ (BUGS.md §3 ขั้น 2 · `normal-2-rerun`) | **51/51 passed (144 s) ✅** |
| ปิดบั๊กทั้งหมดอีกครั้งหลังรัน BUG_MODE ครบ (BUGS.md §3 ขั้น 6 · `normal-3-final`) | **51/51 passed (168 s) ✅** |
| `BUG_MODE` B01–B12 ทีละตัว (restart เว็บทุกรอบ) | TC ที่ต้องล้มล้มครบ **12/12** บั๊ก · ตรงตาราง BUGS.md §2 ทุกช่อง 11/12 · B03 ล้มเกิน TC-NOTI-02 (มีกฎรองรับ · ข้อ 5.2) |
| รวมบั๊ก `B03,B07` และ `B01,B05,B09` (BUGS.md §3 ขั้น 5) | `B03,B07` ล้มเท่ากับ union ✅ · `B01,B05,B09` ล้มเท่ากับ union ✅ |

| เกณฑ์เสร็จของ B12 | ผล |
|---|---|
| `TEST_MODE=1` ไม่ตั้ง `BUG_MODE`: 51/51 TC ผ่าน | ✅ 51/51 · 51/51 · 51/51 (3 รอบ) |
| เปิด `BUG_MODE` ทีละตัว B01–B12: TC ที่ระบุใน BUGS.md ล้ม และที่เหลือผ่าน | ⚠️ ตรงทุกช่อง 11/12 · TC ที่ต้องล้มล้มครบ 12/12 · B03: ล้มเกิน TC-NOTI-02 ซึ่ง DECISIONS §18 รองรับแต่ตาราง BUGS.md §2 ไม่ได้ระบุ (ข้อ 5.2 · Q-B12-1) |
| TEST-REPORT.md มีผลรวม + ตาราง triage ตาม BUGS.md §4 | ✅ ข้อ 1 และข้อ 5 |

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

| TC | ชื่อ | ผล | เวลา (s) |
|---|---|---|---|
| TC-AUTH-01 | เลขบัตร 13 หลัก + checksum | ✅ ผ่าน | 1.8 |
| TC-AUTH-02 | OTP ผิด 3 ครั้งล็อก 15 นาที | ✅ ผ่าน | 2.9 |
| TC-AUTH-03 | ลงทะเบียนครั้งแรก | ✅ ผ่าน | 1.8 |
| TC-AUTH-04 | เจ้าหน้าที่ SSO จำลองและหน้าตั้งต้นตามบทบาท | ✅ ผ่าน | 3.5 |
| TC-FEE-01 | ค่าธรรมเนียม SV-01 / SV-02 / SV-03 | ✅ ผ่าน | 1.1 |
| TC-SUBMIT-01 | ยื่นคำขอ SV-01 ครบวงจร | ✅ ผ่าน | 1.1 |
| TC-SUBMIT-02 | เอกสารบังคับครบก่อนชำระ | ✅ ผ่าน | 0.9 |
| TC-SUBMIT-03 | ร่าง การลบร่าง และการยกเลิก | ✅ ผ่าน | 1.9 |
| TC-UPLOAD-01 | ขนาดและจำนวนไฟล์ | ✅ ผ่าน | 1.4 |
| TC-UPLOAD-02 | ชนิดไฟล์จากเนื้อไฟล์ | ✅ ผ่าน | 1.0 |
| TC-PAY-01 | อายุ QR 15:00 | ✅ ผ่าน | 0.4 |
| TC-PAY-02 | ยอดเงินและ callback ซ้ำ | ✅ ผ่าน | 0.1 |
| TC-PAY-03 | ชำระพร้อมกัน เลขไม่ซ้ำ | ✅ ผ่าน | 0.2 |
| TC-PAY-04 | เลขคำขอข้ามปี 2569 → 2570 | ✅ ผ่าน | 0.7 |
| TC-QUEUE-01 | ลำดับคิวและขอบเขตแผนก | ✅ ผ่าน | 1.3 |
| TC-QUEUE-02 | รับเรื่องซ้อน (พร้อมกันและต่อกัน) | ✅ ผ่าน | 1.5 |
| TC-QUEUE-03 | งานในมือสูงสุด 10 | ✅ ผ่าน | 2.4 |
| TC-SLA-01 | กำหนดเสร็จตามตารางวันที่ | ✅ ผ่าน | 2.1 |
| TC-SLA-02 | หยุดนับ SLA ระหว่างรอแก้ไข | ✅ ผ่าน | 1.8 |
| TC-SLA-03 | ระดับเตือน ปกติ / ใกล้ครบกำหนด / เกินกำหนด | ✅ ผ่าน | 2.1 |
| TC-NOTI-01 | ผู้รับแจ้งเตือนตามระดับ | ✅ ผ่าน | 1.0 |
| TC-NOTI-02 | ไม่แจ้งซ้ำ ข้ามระดับ และขั้นรออนุมัติ/รอออกเอกสาร | ✅ ผ่าน | 2.8 |
| TC-WORKFLOW-01 | SV-01 อนุมัติ + ออกเอกสาร | ✅ ผ่าน | 0.9 |
| TC-WORKFLOW-02 | SV-02 ผ่านหัวหน้า | ✅ ผ่าน | 1.9 |
| TC-WORKFLOW-03 | SV-03 สามขั้นตอน | ✅ ผ่าน | 1.9 |
| TC-WORKFLOW-04 | ตีกลับสูงสุด 2 ครั้ง และผลหลังครบ | ✅ ผ่าน | 2.9 |
| TC-WORKFLOW-05 | เหตุผล ≥ 10 ตัวอักษร (ตีกลับ/ไม่อนุมัติ) | ✅ ผ่าน | 2.7 |
| TC-WORKFLOW-06 | เวลาแก้ไข 168 ชั่วโมง | ✅ ผ่าน | 0.9 |
| TC-DOC-01 | ออกเอกสารและข้อมูลใน PDF | ✅ ผ่าน | 0.7 |
| TC-DOC-02 | ตรวจเอกสาร /verify | ✅ ผ่าน | 0.3 |
| TC-DOC-03 | เอกสารหมดอายุและลายเซ็นไม่ตรง | ✅ ผ่าน | 1.7 |
| TC-PDPA-01 | ปิดบังเลขบัตรบนจอ | ✅ ผ่าน | 0.9 |
| TC-PDPA-02 | API (JSON) ไม่ส่งเลขบัตรเต็ม | ✅ ผ่าน | 0.2 |
| TC-PDPA-03 | แสดงเลขเต็มต้องมีเหตุผลและ Audit | ✅ ผ่าน | 22.0 |
| TC-DASH-01 | Dashboard ตัวเลขเริ่มต้น | ✅ ผ่าน | 1.0 |
| TC-DASH-02 | Dashboard ย้อนหลัง พ.ย. ต.ค. รายปี | ✅ ผ่าน | 1.3 |
| TC-DASH-03 | ส่งออก Excel/PDF เท่าหน้าจอ และไม่มีข้อมูลส่วนบุคคล | ✅ ผ่าน | 1.9 |
| TC-DASH-04 | ค่าขอบ "ทันกำหนด" 16:29:59 / 16:30:00 / 16:30:01 | ✅ ผ่าน | 0.9 |
| TC-AUDIT-01 | เหตุการณ์และฟิลด์ใน Audit | ✅ ผ่าน | 4.3 |
| TC-AUDIT-02 | Audit แก้/ลบไม่ได้ (405) | ✅ ผ่าน | 0.4 |
| TC-AUDIT-03 | กรองช่วงวันที่ตามเวลาไทย | ✅ ผ่าน | 5.5 |
| TC-RBAC-01 | ประชาชนเปิดคำขอคนอื่นไม่ได้ (IDOR) | ✅ ผ่าน | 0.3 |
| TC-RBAC-02 | เจ้าหน้าที่อนุมัติ SV-02 ไม่ได้ (API) | ✅ ผ่าน | 1.3 |
| TC-RBAC-03 | ตารางสิทธิ์หน้า/API ตามบทบาท | ✅ ผ่าน | 4.8 |
| TC-RBAC-04 | ผู้ดูแลระบบ: บริการ วันหยุด ผู้ใช้ และยอดที่ล็อก | ✅ ผ่าน | 9.8 |
| TC-RBAC-05 | สิทธิ์เปิด/ดาวน์โหลดไฟล์แนบ | ✅ ผ่าน | 6.3 |
| TC-RBAC-06 | ผู้ดูแลระบบ: ช่วงค่าที่ยอมรับ | ✅ ผ่าน | 12.6 |
| TC-NFR-01 | Responsive 375 / 768 / 1280 | ✅ ผ่าน | 3.0 |
| TC-NFR-02 | WCAG: axe + คีย์บอร์ด + label + สถานะไม่ใช้สีอย่างเดียว | ✅ ผ่าน | 16.0 |
| TC-NFR-03 | Health เวลาโหลด และผลซ้ำได้ | ✅ ผ่าน | 1.5 |
| TC-NFR-04 | เข้ารหัสข้อมูลส่วนบุคคลที่เก็บ (inspection) | ✅ ผ่าน | 0.2 |

รวม: 51 passed · 0 failed · 0 skipped · 144 s

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

| บั๊ก | TC ที่คาดว่าล้ม (จากตาราง 2) | TC ที่ล้มจริง | TC ล้มเกินที่คาด | TC ที่ควรล้มแต่ผ่าน | ผล |
|---|---|---|---|---|---|
| (ปกติ) | – | – | – | – | 51 passed · 0 failed ✅ |
| B01 | TC-FEE-01 | TC-FEE-01 | – | – | 50 passed · 1 failed ✅ |
| B02 | TC-UPLOAD-01 | TC-UPLOAD-01 | – | – | 50 passed · 1 failed ✅ |
| B03 | TC-SLA-01 · TC-SLA-02 (อาจล้ม: TC-SLA-03 · TC-RBAC-04) | TC-SLA-01 · TC-SLA-02 · TC-SLA-03 · TC-NOTI-02 · TC-RBAC-04 | TC-NOTI-02 (มีกฎรองรับ ดูหมายเหตุ) | – | 46 passed · 5 failed ⚠️ |
| B04 | TC-SLA-02 | TC-SLA-02 | – | – | 50 passed · 1 failed ✅ |
| B05 | TC-PAY-01 | TC-PAY-01 | – | – | 50 passed · 1 failed ✅ |
| B06 | TC-RBAC-01 | TC-RBAC-01 | – | – | 50 passed · 1 failed ✅ |
| B07 | TC-RBAC-02 (อาจล้ม: TC-WORKFLOW-01) | TC-RBAC-02 | – | – | 50 passed · 1 failed ✅ |
| B08 | TC-QUEUE-02 | TC-QUEUE-02 | – | – | 50 passed · 1 failed ✅ |
| B09 | TC-PDPA-02 | TC-PDPA-02 | – | – | 50 passed · 1 failed ✅ |
| B10 | TC-DASH-02 (อาจล้ม: TC-DASH-01 · TC-DASH-03) | TC-DASH-01 · TC-DASH-02 · TC-DASH-03 | – | – | 48 passed · 3 failed ✅ |
| B11 | TC-PDPA-03 · TC-AUDIT-01 | TC-PDPA-03 · TC-AUDIT-01 | – | – | 49 passed · 2 failed ✅ |
| B12 | TC-WORKFLOW-04 | TC-WORKFLOW-04 | – | – | 50 passed · 1 failed ✅ |

**สรุป:** จับได้ 12/12 บั๊ก (ทุกบั๊กมี TC ที่ต้องล้มล้มครบ · ไม่มี TC ที่ควรล้มแต่ผ่าน = ไม่มี test ผ่านหลอก) · ตรงตารางทุกช่อง 11/12 · B03: TC ที่ต้องล้ม + อาจล้มเป็นไปตามตาราง แต่ TC-NOTI-02 ล้มเกิน (ดูข้อ 5.2)

### 5.1 ข้อความที่ล้ม (BUGS.md §3 ขั้น 4: ต้องบอกค่าจริงต่างจากค่าที่คาดตรงไหน)

ทุกข้อที่ล้มในรอบ BUG_MODE และรวมบั๊ก (28 ข้อ) ล้มที่ assert ที่มีค่าจริงเทียบค่าคาด (Expected/Received) · ไม่มีข้อไหนล้มเพราะหา element ไม่เจอหรือรอจนหมดเวลาโดยไม่มีค่าเทียบ (`Timeout 7000ms` ที่ต่อท้ายบางบรรทัดคือเวลารอของ `toHaveText`/`toHaveCount` ซึ่งยังแสดงค่าจริงเทียบค่าคาด)

- **B01 · TC-FEE-01** (ขั้น `SV-03 พื้นที่ 101`): Error: expect(locator).toHaveText(expected) failed · Locator:  getByTestId('fee-total') · Expected: "฿1,010" · Received: "฿1,000" · Timeout:  7000ms
- **B02 · TC-UPLOAD-01** (ขั้น `ขนาด (หน้าจอ)`): Error: size-5242880.pdf (5,242,880 ไบต์ = ขอบ ≤ 5 MB) ต้องถูกรับ: จำนวน file-item · expect(locator).toHaveCount(expected) failed · Locator:  getByTestId('file-item') · Expected: 1 · Received: 0 · Timeout:  7000ms
- **B03 · TC-SLA-01** (ขั้น `แถว c: SV-01 ชำระ 2026-12-01T16:30:00+07:00`): Error: expect(received).toBe(expected) // Object.is equality · Expected: "2026-12-08T16:30:00+07:00" · Received: "2026-12-07T16:30:00+07:00"
- **B03 · TC-SLA-02** (ขั้น `ส่วน 1 ตีกลับ 2 ธ.ค. ส่งแก้ 3 ธ.ค. (หยุด 1 วัน)`): Error: expect(locator).toHaveAttribute(expected) failed · Locator:  getByTestId('sla-due') · Expected: "2026-12-08T16:30:00+07:00" · Received: "2026-12-07T16:30:00+07:00" · Timeout:  7000ms
- **B03 · TC-SLA-03** (ขั้น `ส่วน B seed …000016 กำหนด อ. 8 ธ.ค. 16:30 › EG-2569-000016 @ 2026-12-04T09:00:00+07:00 → near`): Error: expect(received).toBe(expected) // Object.is equality · Expected: "near" · Received: "normal"
- **B03 · TC-NOTI-02** (ขั้น `ส่วน B ข้ามระดับ (request แรกที่ ส. 5 ธ.ค. 10:00)`): Error: expect(received).toEqual(expected) // deep equality · - Expected  - 1 · + Received  + 0 · @@ -1,9 +1,8 @@ · Array [ · "EG-2569-000013:overdue", · "EG-2569-000015:overdue", · -   "EG-2569-000016:near", · "EG-2569-000024:overdue", · "EG-2569-000025:overdue", · "EG-2569-000026:overdue", · "EG-2569-000027:overdue", · "EG-2569-000028:overdue",
- **B03 · TC-RBAC-04** (ขั้น `7 NEW_PAID หลังเพิ่มวันหยุด → …000033 กำหนด 8 ธ.ค.`): Error: expect(received).toBe(expected) // Object.is equality · Expected: "2026-12-08T16:30:00+07:00" · Received: "2026-12-04T16:30:00+07:00"
- **B04 · TC-SLA-02** (ขั้น `ส่วน 1 ตีกลับ 2 ธ.ค. ส่งแก้ 3 ธ.ค. (หยุด 1 วัน)`): Error: expect(locator).toHaveAttribute(expected) failed · Locator:  getByTestId('sla-due') · Expected: "2026-12-08T16:30:00+07:00" · Received: "2026-12-04T16:30:00+07:00" · Timeout:  7000ms
- **B05 · TC-PAY-01** (ขั้น `รอบ 3 09:10:00 (อายุ 15:00 พอดี) → 410`): Error: http://localhost:3000/api/test/payments/PP-0001/pay → 200 {"status":"PAID","caseNo":"EG-2569-000031","receiptNo":"RC-2569-000031","duplicate":false} · expect(received).toBe(expected) // Object.is equality · Expected: 410 · Received: 200
- **B06 · TC-RBAC-01** (ขั้น `UI คำขอของสมชาย → 404`): Error: สมหญิงเปิด /citizen/cases/EG-2569-000005 (ของสมชาย) ต้องได้ HTTP · expect(received).toBe(expected) // Object.is equality · Expected: 404 · Received: 200
- **B07 · TC-RBAC-02** (ขั้น `1–3 off.reg2 approve/reject SV-02 ทาง API → 403`): Error: http://localhost:3000/api/cases/EG-2569-000014/approve → 200 {"status":"APPROVED"} · expect(received).toBe(expected) // Object.is equality · Expected: 403 · Received: 200
- **B08 · TC-QUEUE-02** (ขั้น `ส่วน 1 พร้อมกัน (UI 2 context)`): Error: กดรับเรื่องพร้อมกัน 2 คน: สำเร็จ 1 และได้ ALREADY_CLAIMED 1 · expect(received).toEqual(expected) // deep equality · - Expected  - 1 · + Received  + 1 · Array [ · -   "error: มีเจ้าหน้าที่รับเรื่องนี้แล้ว", · +   "success", · "success", · ]
- **B09 · TC-PDPA-02** (ขั้น `off.reg1`): Error: off.reg1 GET /api/officer/queue?filter=all ไม่มีเลข 13 หลัก · expect(received).not.toMatch(expected) · Expected pattern: not /\d{13}/ · Received string:      "{\"items\":[{\"caseNo\":\"EG-2569-000020\",\"serviceId\":\"SV-01\",\"applicantName\":\"สมชาย ใจดี\",\"idMasked\":\"X-XXXX-XXXXX-45-6\",\"status\":\"IN_REVIEW\",\"step\":null,\"owner\":\"off.reg1\",\"dueAt\":\"2026-11-30T16:30:00+07:00\",\"slaLevel\":\"overdue\",\"idNo\":\"1101700123456\"},{\"caseNo\":\"EG-2569-000022\",\"serviceId\":\"SV-01\",\"applicantName\":\"สมหญิง รักไทย\",\"idMasked\":\"X-XXXX-XXXXX-65-9\",\"status\":\"IN_RE
- **B10 · TC-DASH-01** (ขั้น `ALL ธ.ค. บนจอและ API`): Error: expect(locator).toHaveText(expected) failed · Locator:  getByTestId('kpi-ontime-pct') · Expected: "–" · Received: "0.0%" · Timeout:  7000ms
- **B10 · TC-DASH-02** (ขั้น `2026-11 ALL`): Error: 2026-11 ALL ontimePct · expect(received).toBe(expected) // Object.is equality · Expected: 85.7 · Received: 23.1
- **B10 · TC-DASH-03** (ขั้น `พ.ย. ALL → xlsx`): Error: expect(locator).toHaveText(expected) failed · Locator:  getByTestId('kpi-ontime-pct') · Expected: "85.7%" · Received: "23.1%" · Timeout:  7000ms
- **B11 · TC-PDPA-03** (ขั้น `5 Audit UNMASK 1 แถว (จับ B11)`): Error: expect(locator).toHaveText(expected) failed · Locator:  getByTestId('audit-count') · Expected: "1" · Received: "0" · Timeout:  7000ms
- **B11 · TC-AUDIT-01** (ขั้น `ไม่กรอง: 16 แถว ฟิลด์ครบ เรียงใหม่ → เก่า`): Error: expect(locator).toHaveText(expected) failed · Locator:  getByTestId('audit-count') · Expected: "16" · Received: "15" · Timeout:  7000ms
- **B12 · TC-WORKFLOW-04** (ขั้น `ส่วน A SV-01 …000020 ตีกลับครั้งที่ 1 2 ✓ ครั้งที่ 3 ✗ (จับ B12)`): Error: expect(locator).toHaveCount(expected) failed · Locator:  getByTestId('return-btn') · Expected: 0 · Received: 1 · Timeout:  7000ms

### 5.2 B03 ทำให้ TC-NOTI-02 ล้มด้วย (นอกตาราง BUGS.md §2)

- **อาการ:** เปิด `BUG_MODE=B03` แล้ว TC-NOTI-02 ส่วน B (request แรกที่ ส. 5 ธ.ค. 2569 10:00) ไม่ได้ `…000016 near` ของ `off.reg2` และ `…000011 near` ของ `head1` (bell 9 แทน 10 · 14 แทน 15) · ยิง API ตรงกับเว็บ B03 ยืนยัน: `GET /api/cases/EG-2569-000016` ที่ 5 ธ.ค. ได้ `slaLevel` = `normal` แทน `near`
- **สาเหตุ:** TEST-DATA §8.1 กำหนดว่า `…000011` `…000016` (กำหนด อ. 8 ธ.ค.) "ใกล้ครบกำหนด (เหลือ 1: อ.8 ธ.ค.)" ซึ่งต้องข้าม จ. 7 ธ.ค. ที่เป็นวันหยุด · B03 ทำให้วันหยุดในตารางนับเป็นวันทำการ จึงเหลือ 2 วัน (จ.7, อ.8) = `ปกติ` · กลไกเดียวกับที่ BUGS.md ยอมรับให้ TC-SLA-03 ส่วน B ล้ม
- **ตรวจตาม BUGS.md §5:** บั๊กไม่รั่วเกินจุด: `bug('B03')` อยู่จุดเดียวใน `isWorkingDay()` (`web/src/lib/rules.js`) ซึ่งเป็นฟังก์ชันวันทำการตัวเดียวตามที่ DECISIONS §18 ("B03 กระทบอะไร") กำหนด: "ฟังก์ชันวันทำการตัวเดียวใช้ทั้งกำหนดเสร็จและวันคงเหลือ → TC ที่ใช้วันคงเหลือข้ามวันหยุดล้มด้วยได้" · TC-NOTI-02 RESET ต้นทุกส่วน ไม่พึ่งข้อมูลของ TC ก่อนหน้า · ล้มซ้ำได้ทุกครั้ง
- **ตัดสิน:** ไม่แก้เว็บและไม่แก้ test · ถ้าย้ายบั๊กไปกระทบเฉพาะการคำนวณกำหนดเสร็จ จะขัด DECISIONS §18 และถ้าลดการตรวจใน TC-NOTI-02 จะขัด TEST-PLAN/BUGS.md ข้อ 5 · ถือเป็น "แผนไม่ครบ" ส่งเป็นคำถาม Q-B12-1 (ข้อ 7) · ถ้า TA เลือกให้ B03 กระทบเฉพาะกำหนดเสร็จ แก้ได้จุดเดียวใน `rules.js` (ส่งตารางวันหยุดว่างให้ `dueAt`/`pausedExtension`/`extendDue` เมื่อเปิด B03 แทนการเช็กใน `isWorkingDay`) แล้ว TC-SLA-03 และ TC-NOTI-02 จะผ่าน

## 6. รวมบั๊ก (BUGS.md §3 ขั้น 5) และปิดบั๊กอีกครั้ง (ขั้น 6)

| BUG_MODE | union ของ TC ที่ล้มในรอบเดี่ยว | TC ที่ล้มจริง | เทียบ | ผลรัน |
|---|---|---|---|---|
| `B03,B07` | TC-SLA-01 · TC-SLA-02 · TC-SLA-03 · TC-NOTI-02 · TC-RBAC-04 · TC-RBAC-02 | TC-SLA-01 · TC-SLA-02 · TC-SLA-03 · TC-NOTI-02 · TC-RBAC-02 · TC-RBAC-04 | เท่ากัน ✅ | 45 passed · 6 failed |
| `B01,B05,B09` | TC-FEE-01 · TC-PAY-01 · TC-PDPA-02 | TC-FEE-01 · TC-PAY-01 · TC-PDPA-02 | เท่ากัน ✅ | 48 passed · 3 failed |
| ปิดบั๊กทั้งหมด (`normal-3-final`) | – | – | ผ่านครบ ✅ | 51 passed · 0 failed |

- **B03,B07 · TC-SLA-01** (ขั้น `แถว c: SV-01 ชำระ 2026-12-01T16:30:00+07:00`): Error: expect(received).toBe(expected) // Object.is equality · Expected: "2026-12-08T16:30:00+07:00" · Received: "2026-12-07T16:30:00+07:00"
- **B03,B07 · TC-SLA-02** (ขั้น `ส่วน 1 ตีกลับ 2 ธ.ค. ส่งแก้ 3 ธ.ค. (หยุด 1 วัน)`): Error: expect(locator).toHaveAttribute(expected) failed · Locator:  getByTestId('sla-due') · Expected: "2026-12-08T16:30:00+07:00" · Received: "2026-12-07T16:30:00+07:00" · Timeout:  7000ms
- **B03,B07 · TC-SLA-03** (ขั้น `ส่วน B seed …000016 กำหนด อ. 8 ธ.ค. 16:30 › EG-2569-000016 @ 2026-12-04T09:00:00+07:00 → near`): Error: expect(received).toBe(expected) // Object.is equality · Expected: "near" · Received: "normal"
- **B03,B07 · TC-NOTI-02** (ขั้น `ส่วน B ข้ามระดับ (request แรกที่ ส. 5 ธ.ค. 10:00)`): Error: expect(received).toEqual(expected) // deep equality · - Expected  - 1 · + Received  + 0 · @@ -1,9 +1,8 @@ · Array [ · "EG-2569-000013:overdue", · "EG-2569-000015:overdue", · -   "EG-2569-000016:near", · "EG-2569-000024:overdue", · "EG-2569-000025:overdue", · "EG-2569-000026:overdue", · "EG-2569-000027:overdue", · "EG-2569-000028:overdue",
- **B03,B07 · TC-RBAC-02** (ขั้น `1–3 off.reg2 approve/reject SV-02 ทาง API → 403`): Error: http://localhost:3000/api/cases/EG-2569-000014/approve → 200 {"status":"APPROVED"} · expect(received).toBe(expected) // Object.is equality · Expected: 403 · Received: 200
- **B03,B07 · TC-RBAC-04** (ขั้น `7 NEW_PAID หลังเพิ่มวันหยุด → …000033 กำหนด 8 ธ.ค.`): Error: expect(received).toBe(expected) // Object.is equality · Expected: "2026-12-08T16:30:00+07:00" · Received: "2026-12-04T16:30:00+07:00"
- **B01,B05,B09 · TC-FEE-01** (ขั้น `SV-03 พื้นที่ 101`): Error: expect(locator).toHaveText(expected) failed · Locator:  getByTestId('fee-total') · Expected: "฿1,010" · Received: "฿1,000" · Timeout:  7000ms
- **B01,B05,B09 · TC-PAY-01** (ขั้น `รอบ 3 09:10:00 (อายุ 15:00 พอดี) → 410`): Error: http://localhost:3000/api/test/payments/PP-0001/pay → 200 {"status":"PAID","caseNo":"EG-2569-000031","receiptNo":"RC-2569-000031","duplicate":false} · expect(received).toBe(expected) // Object.is equality · Expected: 410 · Received: 200
- **B01,B05,B09 · TC-PDPA-02** (ขั้น `off.reg1`): Error: off.reg1 GET /api/officer/queue?filter=all ไม่มีเลข 13 หลัก · expect(received).not.toMatch(expected) · Expected pattern: not /\d{13}/ · Received string:      "{\"items\":[{\"caseNo\":\"EG-2569-000020\",\"serviceId\":\"SV-01\",\"applicantName\":\"สมชาย ใจดี\",\"idMasked\":\"X-XXXX-XXXXX-45-6\",\"status\":\"IN_REVIEW\",\"step\":null,\"owner\":\"off.reg1\",\"dueAt\":\"2026-11-30T16:30:00+07:00\",\"slaLevel\":\"overdue\",\"idNo\":\"1101700123456\"},{\"caseNo\":\"EG-2569-000022\",\"serviceId\":\"SV-01\",\"applicantName\":\"สมหญิง รักไทย\",\"idMasked\":\"X-XXXX-XXXXX-65-9\",\"status\":\"IN_RE

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
| `<label>-artifacts/` | screenshot + `error-context.md` ของ TC ที่ล้ม + `trace.zip` (เปิดด้วย `npx playwright show-trace <ไฟล์>`) |
| `normal-3-final-html/` | รายงาน HTML ของรอบปิดบั๊กท้ายสุด (`cd e2e && npx playwright show-report ../test-runs/normal-3-final-html`) |
| `pass1/` | ผลรอบแรกทั้งหมด (ก่อนแก้ดาวน์โหลด · BUG_MODE รอบแรกก่อนปรับข้อความ TC-QUEUE-02) เก็บไว้เป็นประวัติ |
| `run-all.sh` · `run-suite.sh` · `summarize.js` · `report-tables.js` · `fill-report.js` + `TEST-REPORT.template.md` | สคริปต์รัน · สรุปเทียบ BUGS.md · สร้างตาราง · เติมผลลงรายงานนี้จาก JSON (`node test-runs/fill-report.js` · ไม่คัดลอกผลด้วยมือ) |

label ที่ใช้ (ตามลำดับที่ `test-runs/run-all.sh` รัน): `normal-1` · `normal-2-rerun` · `bug-B01` … `bug-B12` · `combo-B03-B07` · `combo-B01-B05-B09` · `normal-3-final`
