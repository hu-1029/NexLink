!include "LogicLib.nsh"

!macro customUnInstall
  ${ifNot} ${isUpdated}
    ReadEnvStr $4 ProgramData
    nsExec::ExecToStack 'sc.exe query NexLinkCoreService'
    Pop $0
    Pop $1
    ${if} $0 == 0
    ${OrIf} ${FileExists} "$4\NexLink\*.*"
      UserInfo::GetAccountType
      Pop $5
      ${if} $5 == "Admin"
        nsExec::ExecToStack 'sc.exe stop NexLinkCoreService'
        Pop $2
        Pop $3
        Sleep 1000
        nsExec::ExecToStack 'sc.exe delete NexLinkCoreService'
        Pop $2
        Pop $3
        Sleep 600
        RMDir /r "$4\NexLink"
      ${else}
        ExecShellWait "runas" "cmd.exe" '/c sc.exe stop NexLinkCoreService & timeout /t 1 /nobreak >nul & sc.exe delete NexLinkCoreService & rmdir /s /q "$4\NexLink"' SW_HIDE
      ${endIf}
    ${endIf}
  ${endIf}
!macroend
