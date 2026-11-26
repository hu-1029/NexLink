!include "LogicLib.nsh"

!macro customUnInstall
  ${ifNot} ${isUpdated}
    ReadEnvStr $4 ProgramData
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
  ${endIf}
!macroend
