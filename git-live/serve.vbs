' 用隐藏窗口启动 Git 状态面板，避免弹出黑色控制台窗口。
' 计划任务调用本文件，命令行为: wscript.exe serve.vbs <要监控的目录>
Option Explicit

Dim shell, fso, here, target, exe, cmd
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

here = fso.GetParentFolderName(WScript.ScriptFullName)
target = here
If WScript.Arguments.Count > 0 Then target = WScript.Arguments(0)

exe = "C:\Program Files\nodejs\node.exe"
If Not fso.FileExists(exe) Then
  exe = "node.exe"
End If

cmd = """" & exe & """ """ & here & "\server.js"" """ & target & """"
shell.CurrentDirectory = here
shell.Run cmd, 0, False
