!include "LogicLib.nsh"
!include "nsDialogs.nsh"

!ifndef BUILD_UNINSTALLER
  Var DesktopShortcutCheckbox
  Var DesktopShortcutState
  Var DesktopShortcutPageShown
!endif

# 目录页之后的自定义页：是否创建桌面快捷方式。
# 默认不勾选：更新时不会自动创建；取消勾选也不删除已有图标。
!macro customPageAfterChangeDir
  Page custom DesktopShortcutPageCreate DesktopShortcutPageLeave

  Function DesktopShortcutPageCreate
    StrCpy $DesktopShortcutPageShown "1"

    !insertmacro MUI_HEADER_TEXT "桌面快捷方式" "选择是否在桌面创建 Dreamisle 快捷方式。"

    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}

    ${NSD_CreateCheckbox} 0 0 100% 12u "创建桌面快捷方式"
    Pop $DesktopShortcutCheckbox
    Pop $0

    nsDialogs::Show
  FunctionEnd

  Function DesktopShortcutPageLeave
    ${NSD_GetState} $DesktopShortcutCheckbox $DesktopShortcutState
  FunctionEnd
!macroend

# 内置快捷方式创建已由 createDesktopShortcut: false 关闭，这里按用户选择执行。
# 静默安装/更新不会显示页面（PageShown=0），因此不会碰现有图标。
!macro customInstall
  ${If} $DesktopShortcutPageShown == "1"
  ${AndIf} $DesktopShortcutState == "1"
    CreateShortCut "$DESKTOP\${SHORTCUT_NAME}.lnk" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
    ClearErrors
    WinShell::SetLnkAUMI "$DESKTOP\${SHORTCUT_NAME}.lnk" "${APP_ID}"
  ${EndIf}
!macroend

# 只在真正卸载时清理；更新时不碰图标。
!macro customUnInstall
  ${IfNot} ${isUpdated}
  ${AndIfNot} ${isKeepShortcuts}
    ClearErrors
    WinShell::UninstShortcut "$DESKTOP\${SHORTCUT_NAME}.lnk"
    Delete "$DESKTOP\${SHORTCUT_NAME}.lnk"
    ClearErrors
  ${EndIf}
!macroend
