# Прогон оффлайн-набора сервиса: по одному тесту, последняя строка в сводку.
$ErrorActionPreference = 'Continue'
Set-Location 'D:\DSHarness-0.1\DSH.OPEN.WEB'
# Живые проверки с браузером и работающим сервисом на :3131 в оффлайн-прогон не входят:
# без поднятого сервера они падают на ECONNREFUSED, а не из-за кода.
$skip = @('live.mjs','cloud.mjs','pdf-live.mjs','ui-dnd.mjs','ui-flows.mjs','ui-keyboard-typing.mjs','ui-keyboard.mjs','ui-mobile.mjs','ui-panels.mjs','ui-runs.mjs','ui-scroll.mjs','ui-swipe.mjs','ui-version.mjs','ui-modal-sheet.mjs','status-bar.mjs','theme-reload.mjs','typo-visual.mjs','device-wording.mjs','device-guard.mjs','push-auto.mjs','push-broadcast.mjs','push-sw.mjs','dashboard.mjs','chat-links.mjs','two-devices.mjs','backup.mjs','pdf-live.mjs','docpreview.mjs','status-bar-live.mjs','landing.mjs','smoke.mjs','vision.mjs')
$files = Get-ChildItem test -Filter *.mjs | Where-Object { $skip -notcontains $_.Name } | Select-Object -ExpandProperty Name
foreach ($file in $files) {
  $out = & node "test/$file" 2>&1
  $code = $LASTEXITCODE
  $tail = ($out | Where-Object { $_ -match '\S' } | Select-Object -Last 1)
  $fails = ($out | Select-String -Pattern '^\s*(FAIL|not ok)' ).Count
  "{0,-24} exit={1} fail={2} :: {3}" -f $file, $code, $fails, $tail
}
