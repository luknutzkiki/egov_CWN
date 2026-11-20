'use strict';
// hook ที่บล็อกอื่นลงทะเบียนได้โดยไม่แก้ server.js
//
// onRequest(name, fn, { order })  — รันก่อน route ทุก request ยกเว้น /api/test/* และ /static/* (CONTRACT §0 ข้อ 7)
//   fn({ db, now, nowIso, req }) ต้องเป็น synchronous · รันใน db.transaction ของตัวเอง · ลำดับ order น้อยก่อน (ค่าเริ่ม 100)
//   แนะนำ: ยกเลิกอัตโนมัติเมื่อเลย 168 ชม. (A-46) order 10 · ประเมินแจ้งเตือน SLA (A-30) order 50
//   ลงทะเบียนชื่อเดิมซ้ำ = แทนที่ของเดิม (กันลงซ้ำเมื่อโมดูลถูกโหลดใหม่)
//   hook ที่ throw → log แล้วข้าม (request ยังทำงานต่อ)
// onReset(name, fn) — รันหลัง POST /api/test/reset seed เสร็จ ใช้ล้าง state ในหน่วยความจำของบล็อก

const db = require('../db');
const clock = require('./clock');

const requestHooks = new Map();
const resetHooks = new Map();
let seq = 0;

function onRequest(name, fn, opts = {}) {
  if (typeof fn !== 'function') throw new TypeError(`hook ${name}: fn must be a function`);
  const prev = requestHooks.get(name);
  requestHooks.set(name, { name, fn, order: opts.order ?? 100, seq: prev ? prev.seq : seq++ });
}

function onReset(name, fn) {
  resetHooks.set(name, fn);
}

function sortedRequestHooks() {
  return [...requestHooks.values()].sort((a, b) => a.order - b.order || a.seq - b.seq);
}

function runRequestHooks(req) {
  const now = clock.now();
  const ctx = { db, now, nowIso: clock.toIso(now), req };
  for (const h of sortedRequestHooks()) {
    try {
      db.transaction(() => h.fn(ctx))();
    } catch (err) {
      console.error(`[hooks] request hook "${h.name}" failed:`, err);
    }
  }
}

function runResetHooks() {
  for (const [name, fn] of resetHooks) {
    try {
      fn({ db, now: clock.now(), nowIso: clock.nowIso() });
    } catch (err) {
      console.error(`[hooks] reset hook "${name}" failed:`, err);
    }
  }
}

function list() {
  return { request: sortedRequestHooks().map((h) => `${h.name}@${h.order}`), reset: [...resetHooks.keys()] };
}

module.exports = { onRequest, onReset, runRequestHooks, runResetHooks, list };
