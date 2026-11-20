'use strict';
// สรุปผล Playwright JSON เทียบกับตาราง BUGS.md §2 (TC ที่ต้องล้ม / อาจล้ม)
// ใช้: node test-runs/summarize.js <ผล.json> [BUG_MODE] [--json]
const fs = require('fs');

// BUGS.md §2: [TC ที่ต้องล้ม, TC ที่อาจล้มด้วย]
const EXPECT = {
  B01: [['TC-FEE-01'], []],
  B02: [['TC-UPLOAD-01'], []],
  B03: [['TC-SLA-01', 'TC-SLA-02'], ['TC-SLA-03', 'TC-RBAC-04']],
  B04: [['TC-SLA-02'], []],
  B05: [['TC-PAY-01'], []],
  B06: [['TC-RBAC-01'], []],
  B07: [['TC-RBAC-02'], ['TC-WORKFLOW-01']],
  B08: [['TC-QUEUE-02'], []],
  B09: [['TC-PDPA-02'], []],
  B10: [['TC-DASH-02'], ['TC-DASH-01', 'TC-DASH-03']],
  B11: [['TC-PDPA-03', 'TC-AUDIT-01'], []],
  B12: [['TC-WORKFLOW-04'], []],
};

// TC ที่ล้มเกินตาราง BUGS.md §2 แต่มีกฎใน brief รองรับ (แยกรายงาน ไม่ถือว่าตรงตาราง)
const EXPLAINED = {
  B03: {
    'TC-NOTI-02': 'DECISIONS §18 "B03 กระทบอะไร": ฟังก์ชันวันทำการตัวเดียวใช้ทั้งกำหนดเสร็จและวันคงเหลือ → TC ที่ใช้วันคงเหลือข้ามวันหยุดล้มด้วยได้ (ส่วน B ที่ ส.5 ธ.ค.: …000011/…000016 เหลือ 1 วัน ข้าม จ.7)',
  },
};

const stripAnsi = (s) => String(s || '').replace(/\u001b\[[0-9;]*m/g, '');

// ข้อความ assert ที่บอกค่าคาดหวัง/ค่าจริง (ตัด call log และโค้ดรอบ ๆ ออก)
function shortError(err) {
  const lines = stripAnsi(err && err.message).split('\n').map((l) => l.trimEnd());
  const keep = [];
  for (const l of lines) {
    if (/^\s*(Call log|Call Log):?/i.test(l) || /^\s+at /.test(l) || /^\s*\d+ \|/.test(l) || /^\s*>\s*\d+ \|/.test(l)) break;
    if (l.trim()) keep.push(l.trim());
  }
  // ซ้ำบรรทัดแรก (Error: msg + msg) → ตัดซ้ำ
  const uniq = keep.filter((l, i) => i === 0 || l !== keep[i - 1].replace(/^Error: /, ''));
  return uniq.join(' ⏎ ').slice(0, 600);
}

// ชื่อ step ที่ล้ม (ลึกสุด)
function failedStep(steps, path = []) {
  for (const s of steps || []) {
    if (s.error) {
      const deeper = failedStep(s.steps, [...path, s.title]);
      return deeper || [...path, s.title].join(' › ');
    }
  }
  return null;
}

function load(file) {
  const r = JSON.parse(fs.readFileSync(file, 'utf8'));
  const tests = [];
  const walk = (s) => {
    for (const sp of s.specs || []) {
      for (const t of sp.tests) {
        const res = t.results[t.results.length - 1] || {};
        tests.push({
          tc: sp.title.split(' ')[0],
          title: sp.title,
          status: t.status === 'expected' ? 'passed' : t.status === 'skipped' ? 'skipped' : 'failed',
          duration: res.duration || 0,
          step: failedStep(res.steps),
          error: (res.errors && res.errors[0]) || res.error || null,
          annotations: (t.annotations || []).concat(res.annotations || []),
        });
      }
    }
    for (const x of s.suites || []) walk(x);
  };
  for (const s of r.suites) walk(s);
  return { stats: r.stats, tests };
}

function main() {
  const [file, bugArg = '', flag] = process.argv.slice(2);
  const { stats, tests } = load(file);
  const bugs = [...new Set(String(bugArg).split(',').map((b) => b.trim().toUpperCase()).filter(Boolean))].sort();
  const must = new Set();
  const may = new Set();
  for (const b of bugs) {
    const e = EXPECT[b];
    if (!e) throw new Error(`ไม่รู้จักบั๊ก ${b}`);
    e[0].forEach((tc) => must.add(tc));
    e[1].forEach((tc) => may.add(tc));
  }
  for (const tc of must) may.delete(tc);
  const explainedBy = {};
  for (const b of bugs) Object.assign(explainedBy, EXPLAINED[b] || {});
  const failed = tests.filter((t) => t.status === 'failed');
  const failedSet = new Set(failed.map((t) => t.tc));
  const extra = failed.filter((t) => !must.has(t.tc) && !may.has(t.tc)).map((t) => t.tc);
  const explained = extra.filter((tc) => explainedBy[tc]);
  const missed = [...must].filter((tc) => !failedSet.has(tc));
  const sideEffects = failed.filter((t) => may.has(t.tc)).map((t) => t.tc);
  const passed = tests.filter((t) => t.status === 'passed').length;
  const skipped = tests.filter((t) => t.status === 'skipped').length;
  const ok = tests.length === 51 && extra.length === 0 && missed.length === 0 && skipped === 0;
  // ตรงตาราง BUGS.md ยกเว้น TC ที่ล้มเกินซึ่งมีกฎใน brief รองรับ (EXPLAINED)
  const okExplained = tests.length === 51 && extra.length === explained.length && missed.length === 0 && skipped === 0;
  const result = {
    bugMode: bugs.join(',') || '-',
    total: tests.length,
    passed,
    failed: failed.length,
    skipped,
    durationSec: Math.round((stats.duration || 0) / 1000),
    mustFail: [...must],
    mayFail: [...may],
    failedTCs: failed.map((t) => t.tc),
    sideEffects,
    extra,
    explained: explained.map((tc) => ({ tc, why: explainedBy[tc] })),
    missed,
    ok,
    okExplained,
    failures: failed.map((t) => ({ tc: t.tc, step: t.step, error: shortError(t.error) })),
  };
  if (flag === '--json') {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }
  const L = [];
  L.push(`BUG_MODE=[${result.bugMode}] · ${passed} passed · ${failed.length} failed · ${skipped} skipped · รวม ${tests.length} · ${result.durationSec} s`);
  L.push(`ต้องล้ม: ${result.mustFail.join(' · ') || '–'} · อาจล้ม: ${result.mayFail.join(' · ') || '–'}`);
  L.push(`ล้มจริง: ${result.failedTCs.join(' · ') || '–'}`);
  L.push(`ล้มเกินที่คาด: ${extra.join(' · ') || '–'} · ควรล้มแต่ผ่าน: ${missed.join(' · ') || '–'}`);
  for (const e of result.explained) L.push(`  ล้มเกินแต่มีกฎรองรับ: ${e.tc} — ${e.why}`);
  for (const f of result.failures) L.push(`  ✗ ${f.tc} [${f.step || '-'}] ${f.error}`);
  L.push(ok ? 'ผล: ✅ ตรงแผน' : okExplained ? 'ผล: ⚠️ ตรงแผน ยกเว้น TC ที่ล้มเกินซึ่งมีกฎใน brief รองรับ (ดูบรรทัดบน)' : 'ผล: ❌ ไม่ตรงแผน');
  process.stdout.write(L.join('\n') + '\n');
}

main();
