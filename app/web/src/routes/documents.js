'use strict';
/*
 * บล็อก B07 · เอกสารดิจิทัล: ออกเอกสาร · HMAC · PDF · /verify · unmask · ไฟล์แนบ
 * CONTRACT §2.6 (doc-* unmask-* doc-item) · §2.13 · §3 · §6.2 · §6.3 · §6.4 · §8 · REQUIREMENTS FR-17 FR-18 FR-21 FR-29 BR-23 BR-24 BR-29
 *
 *   POST /api/officer/cases/:caseNo/issue      ผู้ออกเอกสาร (A-27) → 200 {docNo, verifyCode, status:'COMPLETED'} · 403 · 409 INVALID_STATE
 *   POST /officer/cases/:caseNo/issue          ฟอร์มหน้า (issue-btn แบบไม่ใช้ JS) → redirect กลับหน้าเคส + flash
 *   GET  /api/documents/:docNo/pdf             citizen เจ้าของ · officer · head → application/pdf · คนอื่น 404
 *   GET  /verify/:code · GET /api/verify/:code ไม่ต้องล็อกอิน → VALID | EXPIRED | TAMPERED (200) · NOT_FOUND (404)
 *   POST /api/test/documents/:docNo/tamper     (TEST_MODE) แก้ applicant ที่เก็บโดยไม่เซ็นใหม่ → 200 {ok:true} · 404
 *   POST /api/officer/cases/:caseNo/unmask     officer · head + เหตุผล → 200 {idNo} + Audit UNMASK (B11: ไม่บันทึก)
 *   GET  /api/cases/:caseNo/files · GET /api/files/:fileId   สิทธิ์ตาม BR-29
 *
 * ตัวช่วยสำหรับบล็อกหน้าเคส (require('./documents')):
 *   documentForCase(caseId) · documentPanelHtml(doc, {citizen}) · unmaskWidgetHtml(caseNo, maskedId)
 *   fileItemsHtml(caseId) · canAccessCaseFiles(user, caseRow) → 'ok' | 'forbidden' | 'notfound' · verifyUrl(code)
 */

const QRCode = require('qrcode');
const db = require('../db');
const clock = require('../lib/clock');
const { bug } = require('../lib/bugs');
const auth = require('../lib/auth');
const { sendError } = require('../lib/errors');
const format = require('../lib/format');
const cryptoLib = require('../lib/crypto');
const rules = require('../lib/rules');
const config = require('../lib/config');
const layout = require('../views/layout');

const { esc, attrs, dt } = layout;

const VERIFY_TEXT = {
  VALID: 'เอกสารถูกต้อง',
  EXPIRED: 'เอกสารหมดอายุ',
  TAMPERED: 'ลายเซ็นไม่ถูกต้อง',
  NOT_FOUND: 'ไม่พบเอกสาร',
};

// ---------------------------------------------------------------- ข้อมูล

const q = {
  caseByNo: () => db.prepare('SELECT * FROM cases WHERE case_no = ?'),
  caseById: () => db.prepare('SELECT * FROM cases WHERE id = ?'),
  docByNo: () => db.prepare('SELECT * FROM documents WHERE doc_no = ?'),
  docByCode: () => db.prepare('SELECT * FROM documents WHERE verify_code = ?'),
  docByCase: () => db.prepare('SELECT * FROM documents WHERE case_id = ? ORDER BY id DESC LIMIT 1'),
  citizen: () => db.prepare('SELECT id, name, id_enc FROM citizens WHERE id = ?'),
  userName: () => db.prepare('SELECT name FROM users WHERE username = ?'),
  filesOfCase: () => db.prepare('SELECT id, name, doc_key, size, mime FROM files WHERE case_id = ? ORDER BY created_at, rowid'),
  file: () => db.prepare('SELECT * FROM files WHERE id = ?'),
  draft: () => db.prepare('SELECT id, citizen_id, case_id FROM drafts WHERE id = ?'),
  works: () => db.prepare(`SELECT COUNT(*) AS n FROM case_events WHERE case_id = ?
      AND ((type = 'FORWARD' AND CAST(json_extract(data, '$.toStep') AS INTEGER) >= 2)
        OR (type = 'CLAIM' AND CAST(json_extract(data, '$.step') AS INTEGER) = 2))`),
};

function insertAudit({ user, event, caseNo = null, fromStatus = null, toStatus = null, detail = '' }) {
  db.prepare(`INSERT INTO audit (time, username, role, event, case_no, from_status, to_status, detail)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(clock.nowIso(), user.username, user.role, event, caseNo, fromStatus, toStatus, detail || '');
}

function displayName(username) {
  if (!username) return '';
  const row = q.userName().get(username);
  return row ? row.name : username;
}

function serviceLabel(serviceId) {
  const s = format.SERVICES[serviceId];
  return s ? `${serviceId} ${s.name}` : serviceId;
}

const verifyUrl = (code) => `${config.BASE_URL}/verify/${code}`;

function signatureFields(doc) {
  // ลำดับตาม CONTRACT §3: docNo, caseNo, applicant, serviceId, issuedAt, validUntil, signer
  return [doc.doc_no, doc.case_no, doc.applicant, doc.service_id, doc.issued_at, doc.valid_until, doc.signer];
}

// ผลตรวจ: ลายเซ็นไม่ตรงชนะหมดอายุ (A-43)
function verifyResult(doc) {
  if (!doc) return 'NOT_FOUND';
  if (!cryptoLib.verifySignature(signatureFields(doc), doc.signature)) return 'TAMPERED';
  if (rules.docExpired(doc.valid_until, clock.now())) return 'EXPIRED';
  return 'VALID';
}

function documentForCase(caseId) {
  return q.docByCase().get(caseId) || null;
}

// ---------------------------------------------------------------- สิทธิ์ไฟล์แนบ (BR-29)

// officer: ทะเบียน = ทุกคำขอ (ทุกบริการเริ่มที่ทะเบียน) · โยธา = SV-03 ที่ถึงหรือผ่านขั้นโยธาแล้ว
function officerReachedDept(user, c) {
  if (user.dept === 'registry') return true;
  if (user.dept !== 'works' || c.service_id !== 'SV-03') return false;
  if (c.dept === 'works' || Number(c.step) >= 2) return true;
  // ใบที่ปิดแล้ว step อาจไม่สะท้อนเส้นทางจริง → ดูไทม์ไลน์ว่าเคยส่งต่อ/รับเรื่องที่ขั้นโยธา
  return q.works().get(c.id).n > 0;
}

// → 'ok' | 'forbidden' | 'notfound' (ไม่ล็อกอินให้ middleware ตอบ 401 ก่อน)
function canAccessCaseFiles(user, c) {
  if (!user) return 'forbidden';
  if (user.role === 'citizen') return c && c.citizen_id === user.citizenId ? 'ok' : 'notfound';
  if (user.role === 'head') return c ? 'ok' : 'notfound';
  if (user.role === 'officer') {
    if (!c) return 'notfound';
    return officerReachedDept(user, c) ? 'ok' : 'forbidden';
  }
  return 'forbidden'; // executive · auditor · admin
}

function sendAccess(res, verdict) {
  if (verdict === 'notfound') return sendError(res, 'NOT_FOUND');
  return sendError(res, 'FORBIDDEN');
}

// ---------------------------------------------------------------- PDF (สร้างเอง ไม่ใช้ lib ภายนอก)

const pdfStr = (s) => '(' + String(s).replace(/[\\()]/g, (m) => '\\' + m).replace(/[^\x20-\x7e]/g, '?') + ')';

// ข้อความ Unicode (ชื่อไทย) ใน /Info → UTF-16BE hex พร้อม BOM
function pdfUtf16(s) {
  const buf = Buffer.from('\ufeff' + String(s), 'utf16le');
  for (let i = 0; i + 1 < buf.length; i += 2) { const t = buf[i]; buf[i] = buf[i + 1]; buf[i + 1] = t; }
  return '<' + buf.toString('hex').toUpperCase() + '>';
}

function machineLine(doc) {
  return `docNo=${doc.doc_no} caseNo=${doc.case_no} verify=${doc.verify_code} validUntil=${doc.valid_until}`;
}

function buildPdf(doc) {
  const url = verifyUrl(doc.verify_code);
  const line = machineLine(doc);

  // QR (vector) ไป /verify/<รหัส>
  const qr = QRCode.create(url, { errorCorrectionLevel: 'M' }).modules;
  const cell = 4;
  const qrX = 400;
  const qrY = 560;
  const rects = [];
  for (let r = 0; r < qr.size; r++) {
    for (let col = 0; col < qr.size; col++) {
      if (qr.get(r, col)) rects.push(`${qrX + col * cell} ${qrY + (qr.size - 1 - r) * cell} ${cell} ${cell} re`);
    }
  }

  const text = [
    ['F2', 18, 'Digital Document (simulated) - e-Service Municipality'],
    ['F1', 11, `Document No: ${doc.doc_no}`],
    ['F1', 11, `Case No: ${doc.case_no}`],
    ['F1', 11, `Service: ${doc.service_id}`],
    ['F1', 11, `Issued At: ${doc.issued_at}`],
    ['F1', 11, `Valid Until: ${doc.valid_until} (last valid day)`],
    ['F1', 11, `Signer: ${doc.signer_username || '-'}`],
    ['F1', 11, `Verify Code: ${doc.verify_code}`],
    ['F1', 11, `Verify URL: ${url}`],
    ['F1', 9, `Signature (HMAC-SHA256, simulated): ${doc.signature}`],
    ['F1', 10, line],
  ];
  let y = 790;
  const textOps = [];
  for (const [font, size, s] of text) {
    textOps.push(`BT /${font} ${size} Tf 50 ${y} Td ${pdfStr(s)} Tj ET`);
    y -= size + 12;
  }
  const content = [...textOps, '0 0 0 rg', ...rects, rects.length ? 'f' : ''].join('\n') + '\n';
  const embedded = line + '\n';

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R /Names << /EmbeddedFiles << /Names [(verify.txt) 8 0 R] >> >> >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}endstream`,
    `<< /Length ${Buffer.byteLength(embedded, 'latin1')} /Type /EmbeddedFile /Subtype /text#2Fplain >>\nstream\n${embedded}endstream`,
    '<< /Type /Filespec /F (verify.txt) /UF (verify.txt) /EF << /F 7 0 R >> >>',
    `<< /Title ${pdfStr(doc.doc_no)} /Subject ${pdfUtf16(`${doc.doc_no} · ${doc.case_no} · ${serviceLabel(doc.service_id)} · ผู้ยื่น ${doc.applicant} · ผู้ลงนาม ${doc.signer}`)} /Producer (e-Service B07) >>`,
  ];

  let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 9 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

// ---------------------------------------------------------------- ตัวช่วย HTML สำหรับหน้าเคส

// doc-no · verify-code · doc-qr · download-doc-btn (citizen · ไม่ใส่ download= เพราะ server ส่ง attachment เอง)
function documentPanelHtml(doc, { citizen = false } = {}) {
  if (!doc) return '';
  const url = verifyUrl(doc.verify_code);
  let qrSvg = '';
  try {
    const m = QRCode.create(url, { errorCorrectionLevel: 'M' }).modules;
    let d = '';
    for (let r = 0; r < m.size; r++) for (let c = 0; c < m.size; c++) if (m.get(r, c)) d += `M${c + 2} ${r + 2}h1v1h-1z`;
    qrSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${m.size + 4} ${m.size + 4}" width="140" height="140" role="img" aria-label="QR ตรวจสอบเอกสาร"><rect width="100%" height="100%" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
  } catch (_) { /* แสดงลิงก์แทน */ }
  return `<section class="card doc-panel" aria-labelledby="doc-panel-h">
<h2 id="doc-panel-h">เอกสารดิจิทัล</h2>
<dl>
<dt>เลขเอกสาร</dt><dd data-testid="doc-no">${esc(doc.doc_no)}</dd>
<dt>รหัสตรวจสอบ</dt><dd data-testid="verify-code">${esc(doc.verify_code)}</dd>
<dt>ใช้ได้ถึง</dt><dd>${dt('doc-valid-until', doc.valid_until)}</dd>
</dl>
<div${attrs({ 'data-testid': 'doc-qr', 'data-url': url, class: 'doc-qr' })}>${qrSvg}<p><a href="${esc(url)}">${esc(url)}</a></p></div>
${citizen ? `<p><a class="btn" data-testid="download-doc-btn" href="/api/documents/${esc(encodeURIComponent(doc.doc_no))}/pdf">ดาวน์โหลดเอกสาร</a></p>` : ''}
</section>`;
}

// applicant-id · show-full-id-btn · unmask-reason · unmask-submit · unmask-error · full-id (เห็นเต็มเฉพาะในหน้านั้น)
function unmaskWidgetHtml(caseNo, maskedId) {
  const api = `/api/officer/cases/${encodeURIComponent(caseNo)}/unmask`;
  return `<div class="unmask" data-unmask-api="${esc(api)}">
<span data-testid="applicant-id">${esc(maskedId)}</span>
<button type="button" class="btn btn-small" data-testid="show-full-id-btn" data-unmask-open>แสดงเลขเต็ม</button>
<span class="full-id-slot" data-unmask-slot></span>
<form class="unmask-form" data-unmask-form hidden novalidate>
<label for="unmask-reason-input">เหตุผลที่ขอดูเลขเต็ม</label>
<input id="unmask-reason-input" type="text" name="reason" data-testid="unmask-reason" autocomplete="off">
<button type="submit" class="btn" data-testid="unmask-submit">ยืนยัน</button>
<p class="field-error" data-unmask-error role="alert" aria-live="assertive"></p>
</form>
<script>(function(){var s=document.currentScript,w=s&&s.parentNode;if(!w)return;var f=w.querySelector('[data-unmask-form]'),o=w.querySelector('[data-unmask-open]'),e=w.querySelector('[data-unmask-error]'),slot=w.querySelector('[data-unmask-slot]');
o.addEventListener('click',function(){f.hidden=false;f.querySelector('input').focus();});
function showErr(t){e.innerHTML='';var x=document.createElement('span');x.setAttribute('data-testid','unmask-error');x.textContent=t;e.appendChild(x);}
f.addEventListener('submit',function(ev){ev.preventDefault();var r=f.querySelector('input').value;
if(!r||!r.trim()){showErr('กรุณากรอกเหตุผล');return;}
fetch(w.getAttribute('data-unmask-api'),{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify({reason:r})})
.then(function(res){return res.json().then(function(b){return {ok:res.ok,b:b};});})
.then(function(x){if(!x.ok){showErr(x.b&&x.b.message||'เกิดข้อผิดพลาด');return;}e.innerHTML='';var d=String(x.b.idNo||'');
var t=d.length===13?d[0]+'-'+d.slice(1,5)+'-'+d.slice(5,10)+'-'+d.slice(10,12)+'-'+d[12]:d;slot.innerHTML='';var sp=document.createElement('span');sp.setAttribute('data-testid','full-id');sp.textContent=t;slot.appendChild(sp);f.hidden=true;})
.catch(function(){showErr('เกิดข้อผิดพลาด');});});})();</script>
</div>`;
}

// doc-item (data-name data-file-id) + doc-download-link
function fileItemsHtml(caseId) {
  const files = q.filesOfCase().all(caseId);
  if (!files.length) return '<p>ไม่มีไฟล์แนบ</p>';
  const docNames = {};
  for (const s of Object.values(format.SERVICES)) for (const d of s.docs) docNames[d.key] = d.name;
  docNames.extra = docNames.extra || 'เอกสารเพิ่มเติม';
  return `<ul class="doc-list">${files.map((f) => `<li${attrs({ 'data-testid': 'doc-item', 'data-name': f.name, 'data-file-id': f.id, 'data-doc-key': f.doc_key })}>
${esc(docNames[f.doc_key] || f.doc_key)}: <a data-testid="doc-download-link" href="/api/files/${esc(encodeURIComponent(f.id))}" target="_blank" rel="noopener">${esc(f.name)}</a> (${esc(Math.ceil(f.size / 1024))} KB)</li>`).join('')}</ul>`;
}

// ---------------------------------------------------------------- ออกเอกสาร

// ผู้ออกเอกสาร (A-27): SV-01 = ผู้ถือเรื่องที่อนุมัติ · SV-02/03 = เจ้าหน้าที่ทะเบียนที่รับเรื่องขั้นแรก
function expectedIssuer(c) {
  if (c.service_id === 'SV-01') return c.approver || c.issuer || c.owner;
  return c.issuer;
}

function newVerifyCode() {
  for (let i = 0; i < 20; i++) {
    const code = cryptoLib.randomCode(8);
    if (!q.docByCode().get(code)) return code;
  }
  throw new Error('verify code collision');
}

// → { status, code?, body? }
function issueDocument(user, caseNo) {
  return db.transaction(() => {
    const c = q.caseByNo().get(caseNo);
    if (!c) return { error: 'NOT_FOUND' };
    if (!user || user.role !== 'officer' || user.username !== expectedIssuer(c)) return { error: 'FORBIDDEN' };
    if (c.status !== 'APPROVED' || documentForCase(c.id)) return { error: 'INVALID_STATE' };

    const now = clock.nowIso();
    const be = format.beYear(now);
    const docNo = format.numbers.docNo(be, db.nextSeq(`doc:${be}`));
    const cz = q.citizen().get(c.citizen_id);
    const signerUsername = c.approver || user.username;
    const doc = {
      doc_no: docNo,
      case_id: c.id,
      case_no: c.case_no,
      applicant: cz ? cz.name : '',
      service_id: c.service_id,
      issued_at: now,
      valid_until: rules.docValidUntil(now, c.service_id),
      signer: displayName(signerUsername),
      signer_username: signerUsername,
      issued_by: user.username,
      verify_code: newVerifyCode(),
    };
    doc.signature = cryptoLib.sign(signatureFields(doc));
    db.prepare(`INSERT INTO documents (doc_no, case_id, case_no, applicant, service_id, issued_at, valid_until, signer, signer_username, issued_by, verify_code, signature)
      VALUES (@doc_no, @case_id, @case_no, @applicant, @service_id, @issued_at, @valid_until, @signer, @signer_username, @issued_by, @verify_code, @signature)`).run(doc);
    db.prepare(`UPDATE cases SET status = 'COMPLETED', closed_at = ?, updated_at = ?, owner = NULL, dept = NULL WHERE id = ?`).run(now, now, c.id);
    db.prepare(`INSERT INTO case_events (case_id, at, type, actor, from_status, to_status, note, data)
      VALUES (?, ?, 'ISSUE', ?, 'APPROVED', 'COMPLETED', NULL, ?)`).run(c.id, now, user.username, JSON.stringify({ docNo }));
    insertAudit({ user, event: 'ISSUE', caseNo: c.case_no, fromStatus: 'APPROVED', toStatus: 'COMPLETED', detail: docNo });
    return { body: { docNo, verifyCode: doc.verify_code, status: 'COMPLETED' } };
  })();
}

// ---------------------------------------------------------------- หน้า /verify

function verifyPageBody(result, doc) {
  const shown = (result === 'VALID' || result === 'EXPIRED') && doc;
  const cls = result === 'VALID' ? 'msg-success' : 'msg-error';
  let body = `<h1>ตรวจสอบเอกสารดิจิทัล</h1>
<p class="msg ${cls}" role="status"><strong${attrs({ 'data-testid': 'verify-result', 'data-result': result })}>${esc(VERIFY_TEXT[result])}</strong></p>`;
  if (shown) {
    body += `<dl class="verify-details">
<dt>เลขเอกสาร</dt><dd data-testid="verify-doc-no">${esc(doc.doc_no)}</dd>
<dt>ผู้ยื่น</dt><dd data-testid="verify-applicant">${esc(rules.maskApplicantName(doc.applicant))}</dd>
<dt>บริการ</dt><dd data-testid="verify-service">${esc(serviceLabel(doc.service_id))}</dd>
<dt>วันออก</dt><dd>${dt('verify-issued', doc.issued_at)}</dd>
<dt>ใช้ได้ถึง</dt><dd>${dt('verify-expires', doc.valid_until)}</dd>
<dt>ผู้ลงนาม</dt><dd data-testid="verify-signer">${esc(doc.signer)}</dd>
</dl>`;
  }
  body += '<p class="hint">ลายเซ็นดิจิทัลเป็นระบบจำลอง (HMAC-SHA256)</p>';
  return body;
}

// ---------------------------------------------------------------- route

module.exports = function register(app) {
  const apiLogin = auth.requireLogin;

  // ----- ออกเอกสาร -----
  app.post('/api/officer/cases/:caseNo/issue', apiLogin, (req, res) => {
    const user = auth.currentUser(req);
    if (user.role !== 'officer') return sendError(res, 'FORBIDDEN');
    const r = issueDocument(user, req.params.caseNo);
    if (r.error) return sendError(res, r.error);
    return res.status(200).json(r.body);
  });

  app.post('/officer/cases/:caseNo/issue', auth.requireRole('officer', 'head'), (req, res) => {
    const user = auth.currentUser(req);
    const r = issueDocument(user, req.params.caseNo);
    if (r.error === 'NOT_FOUND') return layout.renderNotFound(req, res);
    if (r.error) layout.setFlash(req, 'error', require('../lib/errors').messageOf(r.error));
    else layout.setFlash(req, 'success', `ออกเอกสาร ${r.body.docNo} แล้ว`);
    return res.redirect(303, `/officer/cases/${encodeURIComponent(req.params.caseNo)}`);
  });

  // ----- PDF -----
  app.get('/api/documents/:docNo/pdf', apiLogin, (req, res) => {
    const user = auth.currentUser(req);
    const doc = q.docByNo().get(req.params.docNo);
    if (!doc) return sendError(res, 'NOT_FOUND');
    const c = q.caseById().get(doc.case_id);
    const allowed = user.role === 'officer' || user.role === 'head'
      || (user.role === 'citizen' && c && c.citizen_id === user.citizenId);
    if (!allowed) return sendError(res, 'NOT_FOUND');
    const pdf = buildPdf(doc);
    res.status(200);
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `attachment; filename="${doc.doc_no}.pdf"`);
    res.set('Content-Length', String(pdf.length));
    return res.end(pdf);
  });

  // ----- ตรวจเอกสาร (ไม่ต้องล็อกอิน) -----
  app.get('/api/verify/:code', (req, res) => {
    const doc = q.docByCode().get(String(req.params.code || '').trim().toUpperCase());
    const result = verifyResult(doc);
    if (result === 'NOT_FOUND') return res.status(404).json({ result });
    if (result === 'TAMPERED') return res.status(200).json({ result });
    return res.status(200).json({
      result,
      docNo: doc.doc_no,
      applicantMasked: rules.maskApplicantName(doc.applicant),
      serviceId: doc.service_id,
      issuedAt: doc.issued_at,
      validUntil: doc.valid_until,
      signer: doc.signer,
    });
  });

  app.get('/verify/:code', (req, res) => {
    const doc = q.docByCode().get(String(req.params.code || '').trim().toUpperCase());
    const result = verifyResult(doc);
    return layout.renderPage(req, res, {
      status: result === 'NOT_FOUND' ? 404 : 200,
      title: 'ตรวจสอบเอกสาร',
      body: verifyPageBody(result, doc),
    });
  });

  // ----- test hook: tamper (server.js ตอบ 404 ให้เองเมื่อไม่มี TEST_MODE) -----
  app.post('/api/test/documents/:docNo/tamper', (req, res) => {
    const doc = q.docByNo().get(req.params.docNo);
    if (!doc) return sendError(res, 'NOT_FOUND');
    db.prepare('UPDATE documents SET applicant = ? WHERE id = ?').run(`${doc.applicant} (แก้ไข)`, doc.id);
    return res.status(200).json({ ok: true });
  });

  // ----- แสดงเลขเต็ม (BR-24) -----
  app.post('/api/officer/cases/:caseNo/unmask', auth.requireRole('officer', 'head'), (req, res) => {
    const user = auth.currentUser(req);
    const reason = req.body && typeof req.body.reason === 'string' ? req.body.reason.trim() : '';
    const c = q.caseByNo().get(req.params.caseNo);
    if (!c) return sendError(res, 'NOT_FOUND');
    if (!reason) return sendError(res, 'REASON_REQUIRED');
    const cz = q.citizen().get(c.citizen_id);
    if (!cz) return sendError(res, 'NOT_FOUND');
    const idNo = cryptoLib.decrypt(cz.id_enc);
    if (!bug('B11')) insertAudit({ user, event: 'UNMASK', caseNo: c.case_no, detail: reason });
    return res.status(200).json({ idNo });
  });

  // ----- ไฟล์แนบ (BR-29) -----
  app.get('/api/cases/:caseNo/files', apiLogin, (req, res) => {
    const user = auth.currentUser(req);
    if (!['citizen', 'officer', 'head'].includes(user.role)) return sendError(res, 'FORBIDDEN');
    const c = q.caseByNo().get(req.params.caseNo);
    const verdict = canAccessCaseFiles(user, c);
    if (verdict !== 'ok') return sendAccess(res, verdict);
    const items = q.filesOfCase().all(c.id).map((f) => ({ fileId: f.id, name: f.name, docKey: f.doc_key, size: f.size }));
    return res.status(200).json({ items });
  });

  app.get('/api/files/:fileId', apiLogin, (req, res) => {
    const user = auth.currentUser(req);
    if (!['citizen', 'officer', 'head'].includes(user.role)) return sendError(res, 'FORBIDDEN');
    const f = q.file().get(req.params.fileId);
    if (!f) return sendError(res, 'NOT_FOUND');
    let verdict;
    if (f.case_id) {
      verdict = canAccessCaseFiles(user, q.caseById().get(f.case_id));
    } else {
      // ไฟล์ของร่างที่ยังไม่มีเลขคำขอ: เฉพาะประชาชนเจ้าของร่าง
      const d = f.draft_id ? q.draft().get(f.draft_id) : null;
      if (d && d.case_id) verdict = canAccessCaseFiles(user, q.caseById().get(d.case_id));
      else verdict = user.role === 'citizen' && d && d.citizen_id === user.citizenId ? 'ok' : 'notfound';
    }
    if (verdict !== 'ok') return sendAccess(res, verdict);
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data);
    res.status(200);
    res.set('Content-Type', f.mime);
    res.set('Content-Length', String(data.length));
    const ascii = f.name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    res.set('Content-Disposition', `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(f.name)}`);
    res.set('X-Content-Type-Options', 'nosniff');
    return res.end(data);
  });
};

Object.assign(module.exports, {
  documentForCase, documentPanelHtml, unmaskWidgetHtml, fileItemsHtml, canAccessCaseFiles, verifyUrl,
  verifyResult, buildPdf, issueDocument, VERIFY_TEXT,
});
