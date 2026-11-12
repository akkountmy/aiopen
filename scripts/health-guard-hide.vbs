' Runs the DSH OPEN WEB health guard with no console window (0 = hidden).
' Used by the scheduled task "DSH Open Web health guard" so cmd.exe never flashes.
CreateObject("WScript.Shell").Run "cmd.exe /c ""cd /d D:\DSHarness-0.1\DSH.OPEN.WEB && node scripts\health-guard.mjs > nul 2>&1""", 0, False
