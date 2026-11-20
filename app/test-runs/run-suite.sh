#!/usr/bin/env bash
# รันชุด Playwright เต็ม 51 TC กับเว็บใน Docker (B12 · BUGS.md §3)
#
#   test-runs/run-suite.sh <label> [BUG_MODE]            restart เว็บด้วย TEST_MODE=1 BUG_MODE=<ค่า> แล้วรันชุดเต็ม
#   NO_RESTART=1 test-runs/run-suite.sh <label> [BUG_MODE]  รันซ้ำทันทีโดยไม่ restart เว็บ (BUGS.md §3 ขั้น 2)
#   HTML=1 ...                                              เพิ่มรายงาน HTML ที่ test-runs/<label>-html/
#
# ผล: test-runs/<label>.json (Playwright JSON) · <label>.log · <label>-web.log (log ของเว็บ ใช้ใน TC-NFR-04)
#     <label>-info.json (GET /api/test/info) · <label>-artifacts/ (trace/screenshot เฉพาะที่ล้ม) · <label>-summary.txt
# เว็บโหมดที่สอง (ไม่ตั้ง TEST_MODE) รันเป็นคอนเทนเนอร์ egov-notest ที่พอร์ต 3102 ให้ TC-NFR-03 ตรวจ /api/test/reset → 404
set -u
APP="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$APP/test-runs"
LABEL="${1:?label}"
BUGS="${2:-}"
BASE="http://localhost:${PORT:-3000}"
NOTEST_PORT=3102

cd "$APP/web" || exit 2
if [ -z "${NO_RESTART:-}" ]; then
  TEST_MODE=1 BUG_MODE="$BUGS" docker compose up --build -d --force-recreate >"$OUT/$LABEL-compose.log" 2>&1 \
    || { echo "docker compose up ล้มเหลว (ดู $OUT/$LABEL-compose.log)"; exit 2; }
fi
for _ in $(seq 1 60); do curl -sf "$BASE/api/health" >/dev/null && break; sleep 1; done
curl -s "$BASE/api/test/info" >"$OUT/$LABEL-info.json" || { echo "เว็บไม่ตอบ /api/test/info"; exit 2; }
want=$(node -e 'const s=new Set(String(process.argv[1]||"").split(",").map(x=>x.trim()).filter(Boolean));console.log([...s].sort().join(","))' "$BUGS")
got=$(node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));if(!j.testMode)process.exit(3);if(j.routes.failed.length)process.exit(4);console.log(j.bugs.join(","))' "$OUT/$LABEL-info.json")
rc=$?
[ $rc -eq 0 ] || { echo "/api/test/info ไม่ถูกต้อง (rc=$rc): $(cat "$OUT/$LABEL-info.json")"; exit 2; }
[ "$want" = "$got" ] || { echo "BUG_MODE ไม่ตรง: ต้องการ [$want] เว็บรายงาน [$got]"; exit 2; }
echo "เว็บพร้อม · TEST_MODE=1 · BUG_MODE=[${got:--}]"

# เว็บโหมดที่สอง (image เดียวกัน ไม่ตั้ง TEST_MODE · ไม่ mount ฐานข้อมูล)
docker rm -f egov-notest >/dev/null 2>&1
docker run -d --rm --name egov-notest -p "$NOTEST_PORT:3000" egov-eservice-web:latest >/dev/null
for _ in $(seq 1 30); do curl -sf "http://localhost:$NOTEST_PORT/api/health" >/dev/null && break; sleep 1; done

# log ของเว็บตลอดการรัน (TC-NFR-04 ค้นเลขบัตร/เบอร์ใน log ด้วย)
docker compose logs -f --no-color >"$OUT/$LABEL-web.log" 2>&1 &
LOGPID=$!

cd "$APP/e2e" || exit 2
rm -rf "$OUT/$LABEL-artifacts"
BASE_URL="$BASE" \
NO_TEST_MODE_URL="http://localhost:$NOTEST_PORT" \
WEB_LOG_PATH="$OUT/$LABEL-web.log" \
PII_ENCRYPTION="AES-256-GCM (web/src/lib/crypto.js · เลขบัตรและเบอร์มือถือ · ค้นหาด้วย HMAC-SHA256 lookupHash)" \
PLAYWRIGHT_JSON_OUTPUT_FILE="$OUT/$LABEL.json" \
PLAYWRIGHT_HTML_OUTPUT_DIR="$OUT/$LABEL-html" PLAYWRIGHT_HTML_OPEN=never \
  npx playwright test --reporter="line,json${HTML:+,html}" --output="$OUT/$LABEL-artifacts" >"$OUT/$LABEL.log" 2>&1
PWRC=$?
kill "$LOGPID" 2>/dev/null; wait "$LOGPID" 2>/dev/null
docker rm -f egov-notest >/dev/null 2>&1

node "$OUT/summarize.js" "$OUT/$LABEL.json" "$BUGS" | tee "$OUT/$LABEL-summary.txt"
exit $PWRC
