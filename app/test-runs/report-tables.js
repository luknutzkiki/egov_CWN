'use strict';
// สร้างตาราง markdown สำหรับ TEST-REPORT.md จากผล JSON ใน test-runs/ (ไม่คัดลอกผลด้วยมือ)
// ใช้: node test-runs/report-tables.js normal <run.json>         → ตาราง TC | ผล | เวลา
//      node test-runs/report-tables.js triage <label=BUG_MODE>... → ตาราง triage BUGS.md §4 + ข้อความที่ล้ม
const path = require('path');
const { execFileSync } = require('child_process');

const DIR = __dirname;
const summarize = (file, bugs) =>
  JSON.parse(execFileSync(process.execPath, [path.join(DIR, 'summarize.js'), path.join(DIR, file), bugs, '--json'], { encoding: 'utf8' }));
const cell = (s) => String(s).replace(/\|/g, '\\|');
const list = (a) => (a.length ? a.join(' · ') : '–');

function normal(file) {
  const r = require(path.join(DIR, file));
  const rows = [];
  const walk = (s) => {
    for (const sp of s.specs || []) {
      for (const t of sp.tests) {
        const res = t.results[t.results.length - 1] || {};
        const [tc, ...rest] = sp.title.split(' ');
        rows.push(`| ${tc} | ${cell(rest.join(' '))} | ${t.status === 'expected' ? '✅ ผ่าน' : '❌ ล้ม'} | ${(res.duration / 1000).toFixed(1)} |`);
      }
    }
    for (const x of s.suites || []) walk(x);
  };
  r.suites.forEach(walk);
  console.log('| TC | ชื่อ | ผล | เวลา (s) |\n|---|---|---|---|');
  console.log(rows.join('\n'));
  console.log(`\nรวม: ${r.stats.expected} passed · ${r.stats.unexpected} failed · ${r.stats.skipped} skipped · ${(r.stats.duration / 1000).toFixed(0)} s`);
}

function triage(specs) {
  const rows = [];
  const details = [];
  for (const spec of specs) {
    const [label, bugs = ''] = spec.split('=');
    const s = summarize(`${label}.json`, bugs);
    const expectText = s.mustFail.join(' · ') + (s.mayFail.length ? ` (อาจล้ม: ${s.mayFail.join(' · ')})` : '');
    const why = new Set(s.explained.map((e) => e.tc));
    const extra = s.extra.length ? s.extra.map((tc) => (why.has(tc) ? `${tc} (มีกฎรองรับ ดูหมายเหตุ)` : tc)).join(' · ') : '–';
    const mark = s.ok ? '✅' : s.okExplained ? '⚠️' : '❌';
    rows.push(
      `| ${bugs.split(',').join('+') || '(ปกติ)'} | ${expectText || '–'} | ${list(s.failedTCs)} | ${extra} | ${list(s.missed)} | ${s.passed} passed · ${s.failed} failed ${mark} |`,
    );
    for (const f of s.failures) details.push(`- **${bugs || 'ปกติ'} · ${f.tc}** (ขั้น \`${cell(f.step || '-')}\`): ${cell(f.error).replace(/ ⏎ /g, ' · ')}`);
  }
  console.log('| บั๊ก | TC ที่คาดว่าล้ม (จากตาราง 2) | TC ที่ล้มจริง | TC ล้มเกินที่คาด | TC ที่ควรล้มแต่ผ่าน | ผล |\n|---|---|---|---|---|---|');
  console.log(rows.join('\n'));
  console.log('\n' + details.join('\n'));
}

const [mode, ...args] = process.argv.slice(2);
if (mode === 'normal') normal(args[0]);
else if (mode === 'triage') triage(args);
else throw new Error('ใช้: report-tables.js normal <run.json> | triage <label=BUG_MODE>...');
