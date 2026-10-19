# Обёртка сторожа места DSH OPEN WEB: пароль администратора берётся из закрытого
# хранилища и живёт только в окружении процесса — в журнал и в историю не попадает.
# Запускается задачей планировщика «DSH OPEN WEB Storage Watch» (раз в неделю)
# через dshow-storage-hide.vbs.
$ErrorActionPreference = 'Stop'

$node = 'C:\Program Files\nodejs\node.exe'
$script = 'D:\DSHarness-0.1\DSH.OPEN.WEB\scripts\storage-watch.mjs'
$vault = Join-Path $env:USERPROFILE '.dsh\secrets\_vault.ps1'
$logFile = 'D:\DSHarness\telegram\dshow-storage.log'

function Write-Log([string]$line) {
  $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  try {
    if (-not (Test-Path $logFile)) { Set-Content -Path $logFile -Value '' -Encoding UTF8 }
    Add-Content -Path $logFile -Value "$stamp $line" -Encoding UTF8
  } catch { }
}

try {
  if (-not (Test-Path $node)) { throw "не найден node.exe: $node" }
  if (-not (Test-Path $script)) { throw "не найден сторож: $script" }

  $env:DSHOW_USER = 'DSHOPENWEB'
  $env:DSHOW_PASS = (& $vault get dshow-admin -Field password)
  if (-not $env:DSHOW_PASS) { throw 'хранилище не отдало пароль dshow-admin' }

  $env:DSHOW_STORAGE_ALERT_PCT = '70'
  $env:DSHOW_BASE = 'https://dshopen-vladimir00177.msk1.amvera.tech'

  & $node $script
  exit $LASTEXITCODE
} catch {
  Write-Log "ошибка запуска сторожа места: $($_.Exception.Message)"
  exit 1
} finally {
  # пароль не должен остаться в окружении дольше нужного
  Remove-Item Env:DSHOW_PASS -ErrorAction SilentlyContinue
}
