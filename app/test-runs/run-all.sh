#!/usr/bin/env bash
# รันครบชุดหลักฐานของ B12 ตามลำดับ BUGS.md §3 (ขั้น 1–6) · ผลสรุปทีละรอบพิมพ์ออก stdout
set -u
cd "$(dirname "$0")/.." || exit 2
one() { # <label> <BUG_MODE> [env...]
  local label=$1 bugs=$2; shift 2
  env "$@" timeout 1200 test-runs/run-suite.sh "$label" "$bugs" >"test-runs/$label-runner.txt" 2>&1
  echo "=== $label"
  tail -n +2 "test-runs/$label-runner.txt" | grep -E "^BUG_MODE|^ล้มจริง|^ล้มเกิน|^ผล|ล้มเหลว|ไม่ตรง|ไม่ถูกต้อง"
}
one normal-1 ""                                # ขั้น 1: เว็บถูกต้อง
one normal-2-rerun "" NO_RESTART=1             # ขั้น 2: รันซ้ำทันทีโดยไม่ restart
for b in B01 B02 B03 B04 B05 B06 B07 B08 B09 B10 B11 B12; do one "bug-$b" "$b"; done   # ขั้น 3
one combo-B03-B07 "B03,B07"                    # ขั้น 5
one combo-B01-B05-B09 "B01,B05,B09"
one normal-3-final "" HTML=1                   # ขั้น 6: ปิดบั๊กทั้งหมดอีกครั้ง
