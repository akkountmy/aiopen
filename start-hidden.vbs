' Запускает сервер без видимого окна консоли.
' Лог пишется в data\server.log. Остановка — stop.cmd.
Option Explicit
Dim shell, fso, base
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
base = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = base
If Not fso.FolderExists(base & "\data") Then fso.CreateFolder base & "\data"
shell.Run "cmd /c node server.mjs >> data\server.log 2>&1", 0, False
