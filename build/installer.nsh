!include "runtime-files.nsh"

; Never force-kill Electron: the running app decides whether it is safe to quit.
!macro customCheckAppRunning
  !ifndef BUILD_UNINSTALLER
    ${if} $perUserInstallationFolder != ""
    ${andif} $INSTDIR != $perUserInstallationFolder
      MessageBox MB_OK|MB_ICONSTOP "升级会沿用原安装目录，以保留设备配置和接收文件。请使用原目录：$\r$\n$perUserInstallationFolder" /SD IDOK
      SetErrorLevel 2
      Quit
    ${endif}
    CreateDirectory "$INSTDIR"
    ClearErrors
    FileOpen $R2 "$INSTDIR\.landrop-install-${APP_GUID}.tmp" w
    ${if} ${Errors}
      MessageBox MB_OK|MB_ICONSTOP "无法写入所选安装目录。请选择当前账户可写的文件夹，例如 D 盘的软件文件夹。" /SD IDOK
      SetErrorLevel 2
      Quit
    ${endif}
    FileClose $R2
    Delete "$INSTDIR\.landrop-install-${APP_GUID}.tmp"
  !endif
  !define /redef updateRetryLabel "update_retry_${__LINE__}"
  !define /redef updateWaitLabel "update_wait_${__LINE__}"
  !define /redef updateDoneLabel "update_done_${__LINE__}"
  ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R0
  ${if} $R0 == 0
    ${if} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
      ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --quit-for-update' $R0
    ${endif}
    StrCpy $R1 0
    ${updateWaitLabel}:
      Sleep 500
      ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R0
      ${if} $R0 != 0
        Goto ${updateDoneLabel}
      ${endif}
      IntOp $R1 $R1 + 1
      ${if} $R1 < 12
        Goto ${updateWaitLabel}
      ${endif}
    ${updateRetryLabel}:
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "软件仍在运行。请先完成或取消传输，然后从右下角托盘退出软件，再点击重试。安装器不会强制中断传输。" /SD IDCANCEL IDRETRY +3
      SetErrorLevel 2
      Quit
      ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R0
      ${if} $R0 == 0
        Goto ${updateRetryLabel}
      ${endif}
  ${endif}
  ${updateDoneLabel}:
!macroend

!macro removeProgramFile relative
  ClearErrors
  Delete "$INSTDIR\${relative}"
  ${if} ${Errors}
    MessageBox MB_OK|MB_ICONSTOP "程序文件仍被占用，替换已停止。请退出软件后重新运行安装包；数据和接收文件仍保留在原目录。" /SD IDOK
    SetErrorLevel 2
    Quit
  ${endif}
!macroend

!macro customRemoveFiles
  SetOutPath $TEMP
  !insertmacro removePackagedFiles
  Delete "$INSTDIR\${UNINSTALL_FILENAME}"
  RMDir "$INSTDIR"
!macroend

!macro customInstall
  ; No online updater is used. Avoid retaining a second installer in the C-drive cache.
  Delete "$LOCALAPPDATA\${APP_INSTALLER_STORE_FILE}"
  CreateDirectory "$INSTDIR\数据"
  CreateDirectory "$INSTDIR\接收文件"
!macroend

!macro customUnWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "卸载局域传送"
  !define MUI_WELCOMEPAGE_TEXT "卸载只移除程序、快捷方式和安装登记。$\r$\n$\r$\n安装目录内的“数据”“接收文件”和其他个人文件都会保留。若要清理个人数据，请先退出软件，再自行删除这些文件夹。"
  !insertmacro MUI_UNPAGE_WELCOME
!macroend
