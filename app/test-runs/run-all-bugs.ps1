# BUGS.md §3: rerun without restart, then BUG_MODE B01..B12 one at a time, then all bugs off again.
param([string[]]$Only = @())
$S = Join-Path $PSScriptRoot 'run-suite.ps1'
$codes = if ($Only.Count) { $Only } else { 1..12 | ForEach-Object { 'B{0:D2}' -f $_ } }
if (-not $Only.Count) { & powershell -NoProfile -ExecutionPolicy Bypass -File $S -Label host-normal-rerun -NoRestart }
foreach ($b in $codes) {
  Write-Output "===== $b ====="
  & powershell -NoProfile -ExecutionPolicy Bypass -File $S -Label "host-$b" -Bugs $b
}
if (-not $Only.Count) {
  Write-Output '===== all bugs off ====='
  & powershell -NoProfile -ExecutionPolicy Bypass -File $S -Label host-normal-final
}
Write-Output '===== DONE ====='
