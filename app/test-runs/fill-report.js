'use strict';
// เติมผลจาก test-runs/*.json ลง TEST-REPORT.template.md → ../TEST-REPORT.md (ไม่คัดลอกผลด้วยมือ)
// ใช้: node test-runs/fill-report.js
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DIR = __dirname;
const BUGS = ['B01', 'B02', 'B03', 'B04', 'B05', 'B06', 'B07', 'B08', 'B09', 'B10', 'B11', 'B12'];
const COMBOS = [
  ['combo-B03-B07', 'B03,B07'],
  ['combo-B01-B05-B09', 'B01,B05,B09'],
];

const run = (script, args) => execFileSync(process.execPath, [path.join(DIR, script), ...args], { encoding: 'utf8' }).trimEnd();
const sum = (label, bugs) => JSON.parse(run('summarize.js', [path.join(DIR, `${label}.json`), bugs, '--json']));
const passLine = (s) => `${s.passed}/${s.total} passed${s.failed ? ` · ${s.failed} failed` : ''}${s.skipped ? ` · ${s.skipped} skipped` : ''} (${s.durationSec} s)`;
const list = (a) => (a.length ? a.join(' · ') : '–');

const normals = { N2: sum('normal-1', ''), N3: sum('normal-2-rerun', ''), NF: sum('normal-3-final', '') };
const bugRuns = BUGS.map((b) => ({ bug: b, s: sum(`bug-${b}`, b) }));
const caught = bugRuns.filter((r) => r.s.missed.length === 0);
const exact = bugRuns.filter((r) => r.s.ok);
const explained = bugRuns.filter((r) => !r.s.ok && r.s.okExplained);
const bad = bugRuns.filter((r) => !r.s.okExplained);

// ขั้น 5: ผลรวมบั๊ก = union ของ TC ที่ล้มจริงในรอบเดี่ยว
const combos = COMBOS.map(([label, bugs]) => {
  const s = sum(label, bugs);
  const union = [...new Set(bugs.split(',').flatMap((b) => bugRuns.find((r) => r.bug === b).s.failedTCs))];
  const got = new Set(s.failedTCs);
  const same = union.length === got.size && union.every((tc) => got.has(tc));
  return { label, bugs, s, union, same };
});

const out = {};
for (const [k, s] of Object.entries(normals)) out[k] = `${passLine(s)} ${s.ok ? '✅' : '❌'}`;
out.BUGSUM =
  `TC ที่ต้องล้มล้มครบ **${caught.length}/12** บั๊ก · ตรงตาราง BUGS.md §2 ทุกช่อง ${exact.length}/12` +
  (explained.length ? ` · ${explained.map((r) => `${r.bug} ล้มเกิน ${r.s.explained.map((e) => e.tc).join(' · ')}`).join(' · ')} (มีกฎรองรับ · ข้อ 5.2)` : '') +
  (bad.length ? ` · ❌ ไม่ตรง: ${bad.map((r) => r.bug).join(' · ')}` : '');
out.COMBOSUM = combos.map((c) => `\`${c.bugs}\` ${c.same ? 'ล้มเท่ากับ union ✅' : 'ไม่เท่ากับ union ❌'}`).join(' · ');

const allNormalOk = Object.values(normals).every((s) => s.ok);
out.CRITERIA = [
  '| เกณฑ์เสร็จของ B12 | ผล |',
  '|---|---|',
  `| \`TEST_MODE=1\` ไม่ตั้ง \`BUG_MODE\`: 51/51 TC ผ่าน | ${allNormalOk ? '✅' : '❌'} ${Object.values(normals).map((s) => `${s.passed}/${s.total}`).join(' · ')} (3 รอบ) |`,
  `| เปิด \`BUG_MODE\` ทีละตัว B01–B12: TC ที่ระบุใน BUGS.md ล้ม และที่เหลือผ่าน | ${bad.length ? '❌' : explained.length ? '⚠️' : '✅'} ตรงทุกช่อง ${exact.length}/12 · TC ที่ต้องล้มล้มครบ ${caught.length}/12${explained.length ? ` · ${explained.map((r) => r.bug).join(' · ')}: ล้มเกิน ${explained.flatMap((r) => r.s.explained.map((e) => e.tc)).join(' · ')} ซึ่ง DECISIONS §18 รองรับแต่ตาราง BUGS.md §2 ไม่ได้ระบุ (ข้อ 5.2 · Q-B12-1)` : ''} |`,
  '| TEST-REPORT.md มีผลรวม + ตาราง triage ตาม BUGS.md §4 | ✅ ข้อ 1 และข้อ 5 |',
].join('\n');

out.NORMAL_TABLE = run('report-tables.js', ['normal', 'normal-1.json']);

const triage = run('report-tables.js', ['triage', 'normal-1=', ...BUGS.map((b) => `bug-${b}=${b}`)]);
const [tTable, tDetails = ''] = triage.split('\n\n');
out.TRIAGE_TABLE = tTable;
out.TRIAGE_DETAILS = tDetails;
out.TRIAGE_SUMMARY =
  `จับได้ ${caught.length}/12 บั๊ก (ทุกบั๊กมี TC ที่ต้องล้มล้มครบ · ไม่มี TC ที่ควรล้มแต่ผ่าน = ไม่มี test ผ่านหลอก) · ` +
  `ตรงตารางทุกช่อง ${exact.length}/12` +
  (explained.length
    ? ` · ${explained.map((r) => `${r.bug}: TC ที่ต้องล้ม + อาจล้มเป็นไปตามตาราง แต่ ${r.s.explained.map((e) => e.tc).join(' · ')} ล้มเกิน (ดูข้อ 5.2)`).join(' · ')}`
    : '') +
  (bad.length ? ` · ❌ ${bad.map((r) => r.bug).join(' · ')}` : '');

const cRows = combos.map(
  (c) => `| \`${c.bugs}\` | ${list(c.union)} | ${list(c.s.failedTCs)} | ${c.same ? 'เท่ากัน ✅' : 'ไม่เท่ากัน ❌'} | ${c.s.passed} passed · ${c.s.failed} failed |`,
);
cRows.push(`| ปิดบั๊กทั้งหมด (\`normal-3-final\`) | – | ${list(normals.NF.failedTCs)} | ${normals.NF.ok ? 'ผ่านครบ ✅' : '❌'} | ${normals.NF.passed} passed · ${normals.NF.failed} failed |`);
out.COMBO_TABLE = ['| BUG_MODE | union ของ TC ที่ล้มในรอบเดี่ยว | TC ที่ล้มจริง | เทียบ | ผลรัน |', '|---|---|---|---|---|', ...cRows].join('\n');
out.COMBO_DETAILS = combos
  .flatMap((c) => c.s.failures.map((f) => `- **${c.bugs} · ${f.tc}** (ขั้น \`${f.step || '-'}\`): ${f.error.replace(/ ⏎ /g, ' · ').replace(/\|/g, '\\|')}`))
  .join('\n');
// BUGS.md §3 ขั้น 4: ทุกข้อที่ล้มต้องมีค่าจริงเทียบค่าคาด (ไม่ใช่หา element ไม่เจอ/หมดเวลาเปล่า)
const allFailures = [...bugRuns.flatMap((r) => r.s.failures), ...combos.flatMap((c) => c.s.failures)];
const notValue = allFailures.filter((f) => !/Received/.test(f.error) || /element\(s\) not found|exceeded while waiting/.test(f.error));
out.VALUE_CHECK = notValue.length
  ? `❌ มี ${notValue.length} ข้อที่ไม่ได้ล้มที่ค่า: ${notValue.map((f) => f.tc).join(' · ')}`
  : `ทุกข้อที่ล้มในรอบ BUG_MODE และรวมบั๊ก (${allFailures.length} ข้อ) ล้มที่ assert ที่มีค่าจริงเทียบค่าคาด (Expected/Received) · ไม่มีข้อไหนล้มเพราะหา element ไม่เจอหรือรอจนหมดเวลาโดยไม่มีค่าเทียบ`;
out.TRACE_NOTE = ' + `trace.zip` (เปิดด้วย `npx playwright show-trace <ไฟล์>`)';

let md = fs.readFileSync(path.join(DIR, 'TEST-REPORT.template.md'), 'utf8');
md = md.replace(/\{\{([A-Z0-9_]+)\}\}/g, (m, k) => {
  if (!(k in out)) throw new Error(`ไม่มีค่าสำหรับ ${m}`);
  return out[k];
});
fs.writeFileSync(path.join(DIR, '..', 'TEST-REPORT.md'), md);
console.log(`เขียน TEST-REPORT.md แล้ว · ${out.BUGSUM}`);
