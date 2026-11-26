!include "LogicLib.nsh"

!macro customUnInstall
  ${ifNot} ${isUpdated}
    ReadEnvStr $4 ProgramData
    ${if} $4 == ""
      StrCpy $4 "C:\ProgramData"
    ${endIf}
    nsExec::ExecToStack 'sc.exe query NexLinkCoreService'
    Pop $0
    Pop $1
    StrCpy $7 "0"
    ${if} $4 != ""
    ${AndIf} ${FileExists} "$4\NexLink\*.*"
      StrCpy $7 "1"
    ${endIf}
    ${if} $0 == 0
    ${OrIf} $7 == "1"
      UserInfo::GetAccountType
      Pop $5
      ${if} $5 == "Admin"
        ${if} $0 == 0
          nsExec::ExecToStack 'sc.exe stop NexLinkCoreService'
          Pop $2
          Pop $3
          ; 轮询等待服务真正进入 STOPPED（最长 10 秒）后再 delete 与删目录，防止固定 Sleep 1000 竞态残留
          ${For} $6 1 20
            nsExec::ExecToStack 'cmd.exe /c sc.exe query NexLinkCoreService | findstr /C:"STOPPED" >nul'
            Pop $2
            Pop $3
            ${if} $2 == 0
              ${Break}
            ${endIf}
            nsExec::ExecToStack 'sc.exe query NexLinkCoreService'
            Pop $2
            Pop $3
            ${if} $2 != 0
              ${Break}
            ${endIf}
            Sleep 500
          ${Next}
          nsExec::ExecToStack 'sc.exe delete NexLinkCoreService'
          Pop $2
          Pop $3
          Sleep 300
        ${endIf}
        ; 仅在 ProgramData ($4) 非空时删除 NexLink 服务目录，防止环境变量异常导致误删根目录
        ${if} $4 != ""
          RMDir /r "$4\NexLink"
        ${endIf}
      ${else}
        ExecShellWait "runas" "powershell.exe" '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -Command "sc.exe stop NexLinkCoreService | Out-Null; for ($$i=0; $$i -lt 20; $$i++) { $$s = (sc.exe query NexLinkCoreService | Out-String); if ($$LASTEXITCODE -ne 0 -or $$s -match $\'STOPPED$\') { break }; Start-Sleep -Milliseconds 500 }; sc.exe delete NexLinkCoreService | Out-Null; Start-Sleep -Milliseconds 300; if ($$env:ProgramData) { $$d = Join-Path $$env:ProgramData $\'NexLink$\'; if (Test-Path $$d) { Remove-Item -LiteralPath $$d -Recurse -Force -ErrorAction SilentlyContinue } }"' SW_HIDE
      ${endIf}
    ${endIf}
    ; 在服务停止并删除后再探测 HKCU 代理：仅清理无进程监听的本机回环死代理，绝不误杀 Clash Verge 等活跃客户端
    nsExec::ExecToStack 'powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -Command "$$p = Get-ItemProperty -Path $\'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings$\' -ErrorAction SilentlyContinue; if ($$p -and $$p.ProxyEnable -eq 1 -and $$p.ProxyServer) { $$loopbacks = @(); foreach ($$e in ([string]$$p.ProxyServer -split $\';$\')) { $$a = ($$e.Trim() -replace $\'^[a-zA-Z0-9.+-]+=$\', $\'$\').Trim(); if ($$a -match $\'^(127\\.0\\.0\\.1|localhost|\\[::1\\]):(\\d+)$\') { $$h = if ($$Matches[1] -eq $\'[::1]$\') { $\'::1$\' } else { $$Matches[1] }; $$loopbacks += @{ Host = $$h; Port = [int]$$Matches[2] } } }; if ($$loopbacks.Count -gt 0) { $$anyAlive = $$false; foreach ($$ep in $$loopbacks) { try { $$c = New-Object System.Net.Sockets.TcpClient; $$ar = $$c.BeginConnect($$ep.Host, $$ep.Port, $$null, $$null); if ($$ar.AsyncWaitHandle.WaitOne(200) -and $$c.Connected) { $$anyAlive = $$true }; $$c.Close() } catch {} }; if (-not $$anyAlive) { Set-ItemProperty -Path $\'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings$\' -Name ProxyEnable -Value 0 -Type DWord; Set-ItemProperty -Path $\'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings$\' -Name ProxyServer -Value $\'$\' -Type String; Add-Type -TypeDefinition $\'using System;using System.Runtime.InteropServices;public class WinINetUninst{[DllImport(\"wininet.dll\")]public static extern bool InternetSetOption(IntPtr h,int o,IntPtr b,int l);}$\' -ErrorAction SilentlyContinue; [WinINetUninst]::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0) | Out-Null; [WinINetUninst]::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0) | Out-Null } } }"'
    Pop $8
    Pop $9
  ${endIf}
!macroend
