# BUG-HUNT · egov-eservice

พิสูจน์ว่าชุด Playwright จับบั๊กใน `BUG_MODE` ได้จริง ตามขั้นตอนใน `BUGS.md` §3 ข้อ 1–4 และ 6

| เรื่อง | ค่า |
|---|---|
| วันที่รัน | 15 พ.ย. 2569 |
| ที่รัน | เครื่อง Windows (host) · Docker Desktop · Node 22.14 · Playwright 1.65 (chromium) |
| โค้ดที่ทดสอบ | `./week2/egov-eservice/app` (เว็บ `web/` · test `e2e/` 51 TC) |
| วิธีรัน | `test-runs/run-suite.ps1` ทุกรอบ restart เว็บด้วย `docker compose up --build -d --force-recreate` และ `TEST_MODE=1 BUG_MODE=Bxx` แล้วรันชุดเต็ม 51 TC · ก่อนรันตรวจ `GET /api/test/info` ว่าเว็บเปิดบั๊กตรงกับที่ตั้ง · ทั้งชุดรันด้วย `test-runs/run-all-bugs.ps1` |
| ตัวเทียบผล | `test-runs/summarize.js` เทียบ TC ที่ล้มกับตาราง `BUGS.md` §2 |
| ผลดิบ | `app/test-runs/host-*.json` · `host-*.log` · `host-*-summary.txt` · `host-*-artifacts/` (trace/screenshot ของข้อที่ล้ม) |

## 1. รอบปกติ (ไม่เปิดบั๊ก)

| รอบ | ผล |
|---|---|
| `TEST_MODE=1` ไม่ตั้ง `BUG_MODE` (`host-normal`) | **51/51 passed** (246 s) ✅ |
| รันซ้ำทันทีโดยไม่ restart เว็บ (`host-normal-rerun` · §3 ข้อ 2) | **51/51 passed** (229 s) ✅ |
| ปิดบั๊กทั้งหมดอีกครั้งหลังรัน B01–B12 (`host-normal-final` · §3 ข้อ 6) | **51/51 passed** (232 s) ✅ |

## 2. ตารางบันทึกผล (รูปแบบ `BUGS.md` §4)

| บั๊ก | TC ที่คาดว่าล้ม (จากตาราง 2) | TC ที่ล้มจริง | TC ล้มเกินที่คาด | TC ที่ควรล้มแต่ผ่าน | ผล |
|---|---|---|---|---|---|
| (ปกติ) | – | – | – | – | 51/51 passed |
| B01 | TC-FEE-01 | TC-FEE-01 | – | – | 50 passed · 1 failed ✅ |
| B02 | TC-UPLOAD-01 | TC-UPLOAD-01 | – | – | 50 passed · 1 failed ✅ |
| B03 | TC-SLA-01 · TC-SLA-02 (อาจล้มด้วย TC-SLA-03 · TC-RBAC-04) | TC-SLA-01 · TC-SLA-02 · TC-SLA-03 · TC-RBAC-04 · TC-NOTI-02 | TC-NOTI-02 (ผลข้างเคียงที่มีกฎรองรับ ดูข้อ 4) | – | 46 passed · 5 failed ✅⚠️ |
| B04 | TC-SLA-02 | TC-SLA-02 | – | – | 50 passed · 1 failed ✅ |
| B05 | TC-PAY-01 | TC-PAY-01 | – | – | 50 passed · 1 failed ✅ |
| B06 | TC-RBAC-01 | TC-RBAC-01 | – | – | 50 passed · 1 failed ✅ |
| B07 | TC-RBAC-02 | TC-RBAC-02 | – | – | 50 passed · 1 failed ✅ |
| B08 | TC-QUEUE-02 (ส่วน 3 ต่อกัน ล้มแน่นอน) | TC-QUEUE-02 | – | – | 50 passed · 1 failed ✅ |
| B09 | TC-PDPA-02 | TC-PDPA-02 | – | – | 50 passed · 1 failed ✅ |
| B10 | TC-DASH-02 (อาจล้มด้วย TC-DASH-01 · TC-DASH-03) | TC-DASH-01 · TC-DASH-02 · TC-DASH-03 | – | – | 48 passed · 3 failed ✅ |
| B11 | TC-PDPA-03 · TC-AUDIT-01 | TC-PDPA-03 · TC-AUDIT-01 | – | – | 49 passed · 2 failed ✅ |
| B12 | TC-WORKFLOW-04 | TC-WORKFLOW-04 | – | – | 50 passed · 1 failed ✅ |

**สรุป: จับได้ 12/12 บั๊ก**
- ทุกบั๊ก TC ที่ต้องล้มล้มครบ จึงไม่มี test ผ่านหลอก
- TC อื่นผ่านทั้งหมด ยกเว้น TC-NOTI-02 ตอนเปิด B03 (ดูข้อ 4)

## 3. ข้อความที่ล้ม (§3 ข้อ 4: ต้องเป็นค่าต่าง ไม่ใช่ timeout/หา element ไม่เจอ)

| บั๊ก | TC · ขั้นที่ล้ม | expected → received |
|---|---|---|
| B01 | TC-FEE-01 · SV-03 พื้นที่ 101 | `fee-total` `฿1,010` → `฿1,000` |
| B02 | TC-UPLOAD-01 · ขนาด (หน้าจอ) | `size-5242880.pdf` ต้องถูกรับ: `file-item` 1 → 0 |
| B03 | TC-SLA-01 · แถว c ชำระ 1 ธ.ค. 16:30 | `dueAt` `2026-12-08T16:30:00+07:00` → `2026-12-07T16:30:00+07:00` |
| B03 | TC-SLA-02 · ส่วน 1 ตีกลับ 2 ธ.ค. ส่งแก้ 3 ธ.ค. | `sla-due` `2026-12-08…` → `2026-12-07…` |
| B03 | TC-SLA-03 · ส่วน B …000016 @ 4 ธ.ค. 09:00 | ระดับ `near` → `normal` |
| B03 | TC-RBAC-04 · ชำระหลังเพิ่มวันหยุด 2 ธ.ค. | `dueAt` `2026-12-08…` → `2026-12-04…` |
| B03 | TC-NOTI-02 · ส่วน B request แรก ส. 5 ธ.ค. 10:00 | ขาดแจ้งเตือน `EG-2569-000016:near` |
| B04 | TC-SLA-02 · ส่วน 1 | `sla-due` `2026-12-08…` → `2026-12-04…` |
| B05 | TC-PAY-01 · รอบ 3 09:10:00 (อายุ 15:00 พอดี) | HTTP `410` → `200 PAID EG-2569-000031` |
| B06 | TC-RBAC-01 · สมหญิงเปิดคำขอของสมชาย | HTTP `404` → `200` |
| B07 | TC-RBAC-02 · `off.reg2` POST `/api/cases/EG-2569-000014/approve` | HTTP `403` → `200 APPROVED` (ยิง API ตรง ไม่ได้ดูแค่ปุ่ม) |
| B08 | TC-QUEUE-02 · ส่วน 1 รับพร้อมกัน 2 context | ผลคาด `[success, ALREADY_CLAIMED]` → `[success, success]` |
| B09 | TC-PDPA-02 · `off.reg1` GET `/api/officer/queue` | ต้องไม่มี `\d{13}` → พบเลขบัตรเต็มใน JSON |
| B10 | TC-DASH-02 · 2026-11 ALL | `ontimePct` `85.7` → `23.1` |
| B10 | TC-DASH-01 / TC-DASH-03 | `kpi-ontime-pct` `–` → `0.0%` · `85.7%` → `23.1%` |
| B11 | TC-PDPA-03 · Audit UNMASK | `audit-count` `1` → `0` |
| B11 | TC-AUDIT-01 · ไม่กรอง | `audit-count` `16` → `15` |
| B12 | TC-WORKFLOW-04 · …000020 ตีกลับครั้งที่ 3 | `return-btn` ต้องหาย: count `0` → `1` |

ข้อความทุกข้อเป็นค่าที่ต่างจากที่คาด จึงไม่ใช่ test เปราะ บรรทัด `Timeout: 7000ms` ในบางข้อความเป็นแค่ข้อมูลของ `expect(locator)` ที่รอแล้วค่ายังไม่ตรง ไม่ได้แปลว่าหา element ไม่เจอ

## 4. Triage ข้อที่ไม่ตรงตารางตรงตัว: B03 → TC-NOTI-02

| เรื่อง | ผล |
|---|---|
| อาการ | เปิด B03 แล้ว TC-NOTI-02 ล้มด้วย (BUGS.md §2 ไม่ได้ใส่ไว้ใน "อาจล้มด้วย") |
| สาเหตุ | B03 ทำให้ `isWorkingDay` ไม่ข้ามวันหยุดในตาราง ฟังก์ชันนี้ใช้ร่วมทั้งการคิดกำหนดเสร็จและ "วันคงเหลือ" · ที่ ส. 5 ธ.ค. คำขอ `…000016` กำหนด อ. 8 ธ.ค. ควรเหลือ 1 วันทำการ (จ. 7 ธ.ค. เป็นวันหยุด) → `near` · พอเปิดบั๊กจะนับ 7 ธ.ค. เป็นวันทำการ → เหลือ 2 วัน → `normal` → ไม่เกิดแจ้งเตือน `near` |
| เป็นบั๊กรั่วเกินจุดหรือ test พึ่งกันเองไหม | ไม่ใช่ทั้งสองอย่าง · กลไกเดียวกับ TC-SLA-03 ส่วน B ที่ BUGS.md ยอมรับไว้แล้ว · ตรงกับ DECISIONS §18 "B03 กระทบอะไร": *ฟังก์ชันวันทำการตัวเดียวใช้ทั้งกำหนดเสร็จและวันคงเหลือ → TC ที่ใช้วันคงเหลือข้ามวันหยุดล้มด้วยได้* · TC-NOTI-02 เริ่มด้วย reset ของตัวเอง |
| การแก้ | ไม่แก้เว็บและไม่แก้ test (แก้แล้วจะขัด DECISIONS §18 หรือ TEST-PLAN) · บันทึกเป็นผลข้างเคียงที่ยอมรับ |
| ข้อเสนอถึงผู้สอน/TA | เพิ่ม TC-NOTI-02 ในคอลัมน์ "TC ที่อาจล้มด้วย" ของ B03 ใน BUGS.md §2 (ห้ามแก้ไฟล์โจทย์เอง) |

## 5. ตรวจว่าเว็บฝังบั๊กตรงจุดตาม BUGS.md (กติกาข้อ 1 และ 4: ตรรกะฝั่งเซิร์ฟเวอร์)

| บั๊ก | จุดในโค้ด | พฤติกรรมเมื่อเปิด |
|---|---|---|
| B01 | `web/src/lib/rules.js:367` | ส่วนเกินคิดเมื่อ `area > 101` แทน `≥ 101` |
| B02 | `web/src/routes/citizen.js:260` | `size < 5,242,880` แทน `≤` |
| B03 | `web/src/lib/rules.js:128` | `isWorkingDay` ไม่ดูตารางวันหยุด |
| B04 | `web/src/lib/rules.js:200` | ช่วงหยุดนับ = 0 วัน |
| B05 | `web/src/lib/rules.js:249` | อายุ QR `≤ 15:00` แทน `< 15:00` |
| B06 | `web/src/routes/citizen.js:1013, 1261` | `ownCase(... allowOthers)` ทั้งหน้าและ API |
| B07 | `web/src/routes/officer.js:284` | `decisionCheck` ปล่อยเจ้าหน้าที่ approve SV-02/03 ผ่าน API (ปุ่มบนหน้ายังซ่อน) |
| B08 | `web/src/routes/officer.js:203` | claim ข้ามการตรวจว่ามีผู้ถือแล้ว |
| B09 | `web/src/routes/officer.js:184` | ใส่ `idNo` ในแถวของ API คิว |
| B10 | `web/src/routes/dashboard.js:131` | ตัวหาร = รับเรื่อง แทน ปิดงาน |
| B11 | `web/src/routes/documents.js:420` | ไม่บันทึก Audit `UNMASK` |
| B12 | `web/src/routes/officer.js:231, 597` | ข้าม `RETURN_LIMIT` ทั้ง API และปุ่ม |

ทุกบั๊กเปิดผ่าน `bug('Bxx')` ใน `web/src/lib/bugs.js` เท่านั้น และ `/api/test/info` ยืนยันว่าเว็บเปิดตรงตัวที่ตั้งทุกรอบ

## 6. สิ่งที่ไม่ได้ทำในรอบนี้

- **§3 ข้อ 5 (รวมบั๊ก `B03,B07` และ `B01,B05,B09`):** ไม่ได้รันซ้ำบนเครื่องนี้ เพราะไม่อยู่ในขอบเขตที่สั่ง · ผลจากบล็อก B12 ใน container (`app/TEST-REPORT.md`) ได้ union ตรงทั้งสองชุด
- **การแก้โค้ด:** ไม่มี · ไม่มีบั๊กไหนที่ TC ไม่ล้ม จึงไม่ต้องแก้ทั้งเว็บและ test · ไฟล์ที่เพิ่มคือ `app/test-runs/run-suite.ps1` และ `run-all-bugs.ps1` (ตัวรันบน Windows)
