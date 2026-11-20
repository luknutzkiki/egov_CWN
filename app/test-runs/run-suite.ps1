# Run the full 51-TC Playwright suite against the web in Docker (Windows host version of run-suite.sh).
#   .\test-runs\run-suite.ps1 -Label host-B03 -Bugs B03
#   .\test-runs\run-suite.ps1 -Label host-normal-2 -NoRestart
# Output: test-runs\<Label>.json / .log / -web.log / -info.json / -summary.txt / -artifacts\
param(
  [Parameter(Mandatory = $true)][string]$Label,
  [string]$Bugs = '',
  [switch]$NoRestart
)
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$OutputEncoding = [Text.Encoding]::UTF8
$App = Split-Path -Parent $PSScriptRoot
$Out = Join-Path $App 'test-runs'
$Base = 'http://localhost:3000'
$NoTestPort = 3102

Push-Location (Join-Path $App 'web')
try {
  if (-not $NoRestart) {
    $env:TEST_MODE = '1'; $env:BUG_MODE = $Bugs
    docker compose up --build -d --force-recreate *> (Join-Path $Out "$Label-compose.log")
    if ($LASTEXITCODE -ne 0) { Write-Output "docker compose up failed (see $Label-compose.log)"; exit 2 }
  }
  $ready = $false
  for ($i = 0; $i -lt 60; $i++) {
    try { Invoke-RestMethod "$Base/api/health" -TimeoutSec 2 | Out-Null; $ready = $true; break } catch { Start-Sleep 1 }
  }
  if (-not $ready) { Write-Output 'web did not become healthy'; exit 2 }
  $info = Invoke-RestMethod "$Base/api/test/info"
  $info | ConvertTo-Json -Depth 6 | Out-File -Encoding utf8 (Join-Path $Out "$Label-info.json")
  $want = (($Bugs -split ',') | ForEach-Object { $_.Trim() } | Where-Object { $_ } | Sort-Object -Unique) -join ','
  $got = (@($info.bugs) | Sort-Object) -join ','
  if (-not $info.testMode -or $want -ne $got) { Write-Output "BUG_MODE mismatch: want [$want] web reports [$got] testMode=$($info.testMode)"; exit 2 }
  Write-Output "web ready · TEST_MODE=1 · BUG_MODE=[$got]"

  # second web without TEST_MODE (for TC-NFR-03 /api/test/reset -> 404)
  docker rm -f egov-notest *> $null
  docker run -d --rm --name egov-notest -p "${NoTestPort}:3000" egov-eservice-web:latest *> $null
  for ($i = 0; $i -lt 30; $i++) { try { Invoke-RestMethod "http://localhost:$NoTestPort/api/health" -TimeoutSec 2 | Out-Null; break } catch { Start-Sleep 1 } }

  $webLog = Join-Path $Out "$Label-web.log"
  $logJob = Start-Job -ScriptBlock { param($dir, $file) Set-Location $dir; docker compose logs -f --no-color *> $file } -ArgumentList (Get-Location).Path, $webLog
} finally { Pop-Location }

Push-Location (Join-Path $App 'e2e')
try {
  $art = Join-Path $Out "$Label-artifacts"
  if (Test-Path $art) { Remove-Item -Recurse -Force $art }
  $env:BASE_URL = $Base
  $env:NO_TEST_MODE_URL = "http://localhost:$NoTestPort"
  $env:WEB_LOG_PATH = $webLog
  $env:DB_PATH = Join-Path $App 'web\data\app.db'
  $env:PII_ENCRYPTION = 'AES-256-GCM (web/src/lib/crypto.js)'
  $env:PLAYWRIGHT_JSON_OUTPUT_FILE = Join-Path $Out "$Label.json"
  npx playwright test '--reporter=line,json' "--output=$art" *> (Join-Path $Out "$Label.log")
  $pw = $LASTEXITCODE
} finally {
  Pop-Location
  Stop-Job $logJob -ErrorAction SilentlyContinue; Remove-Job $logJob -Force -ErrorAction SilentlyContinue
  docker rm -f egov-notest *> $null
}

node (Join-Path $Out 'summarize.js') (Join-Path $Out "$Label.json") $Bugs | Tee-Object -FilePath (Join-Path $Out "$Label-summary.txt")
exit $pw
