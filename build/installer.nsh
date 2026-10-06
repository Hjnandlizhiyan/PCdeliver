!include "runtime-files.nsh"

!macro customHeader
  LangString keepInstallFolder ${LANG_SIMPCHINESE} "升级会沿用原安装目录，以保留设备配置和接收文件。请使用原目录：$\r$\n$perUserInstallationFolder"
  LangString keepInstallFolder ${LANG_ENGLISH} "Upgrades use the original installation folder to preserve settings and received files. Please use:$\r$\n$perUserInstallationFolder"
  LangString folderNotWritable ${LANG_SIMPCHINESE} "无法写入所选安装目录。请选择当前账户可写的文件夹，例如 D 盘的软件文件夹。"
  LangString folderNotWritable ${LANG_ENGLISH} "Cannot write to the selected installation folder. Choose a folder your account can write to, such as an apps folder on drive D."
  LangString closeBeforeUpgrade ${LANG_SIMPCHINESE} "软件仍在运行。请先完成或取消传输，然后从右下角托盘退出软件，再点击重试。安装器不会强制中断传输。"
  LangString closeBeforeUpgrade ${LANG_ENGLISH} "LanDrop is still running. Finish or cancel transfers, quit from the system tray, then click Retry. The installer will not force transfers to stop."
  LangString filesInUse ${LANG_SIMPCHINESE} "程序文件仍被占用，替换已停止。请退出软件后重新运行安装包；数据和接收文件仍保留在原目录。"
  LangString filesInUse ${LANG_ENGLISH} "Application files are still in use. Replacement has stopped. Quit LanDrop and run the installer again. Data and received files are kept in the original folder."
  LangString unWelcomeTitle ${LANG_SIMPCHINESE} "卸载局域传送"
  LangString unWelcomeTitle ${LANG_ENGLISH} "Uninstall LanDrop"
  LangString unWelcomeText ${LANG_SIMPCHINESE} "卸载只移除程序、快捷方式和安装登记。$\r$\n$\r$\n安装目录内的“数据”“接收文件”和其他个人文件都会保留。若要清理个人数据，请先退出软件，再自行删除这些文件夹。"
  LangString unWelcomeText ${LANG_ENGLISH} "Uninstalling removes only the application, shortcuts, and installation registration.$\r$\n$\r$\nThe data folder, received files, and other personal files in the installation folder are kept. To remove personal data, quit the app and delete those folders yourself."
!macroend

; Never force-kill Electron: the running app decides whether it is safe to quit.
!macro customCheckAppRunning
  !ifndef BUILD_UNINSTALLER
    ${if} $perUserInstallationFolder != ""
    ${andif} $INSTDIR != $perUserInstallationFolder
      MessageBox MB_OK|MB_ICONSTOP "$(keepInstallFolder)" /SD IDOK
      SetErrorLevel 2
      Quit
    ${endif}
    CreateDirectory "$INSTDIR"
    ClearErrors
    FileOpen $R2 "$INSTDIR\.landrop-install-${APP_GUID}.tmp" w
    ${if} ${Errors}
      MessageBox MB_OK|MB_ICONSTOP "$(folderNotWritable)" /SD IDOK
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
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(closeBeforeUpgrade)" /SD IDCANCEL IDRETRY +3
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
    MessageBox MB_OK|MB_ICONSTOP "$(filesInUse)" /SD IDOK
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
  !define MUI_WELCOMEPAGE_TITLE "$(unWelcomeTitle)"
  !define MUI_WELCOMEPAGE_TEXT "$(unWelcomeText)"
  !insertmacro MUI_UNPAGE_WELCOME
!macroend
