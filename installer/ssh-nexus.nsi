Unicode True

!ifndef APP_VERSION
  !define APP_VERSION "2.22.0"
!endif
!ifndef APP_FILE_VERSION
  !define APP_FILE_VERSION "2.22.0.0"
!endif
!ifndef PROJECT_DIR
  !define PROJECT_DIR ".."
!endif

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"

Name "SSH Nexus"
OutFile "${PROJECT_DIR}/release/SSH-Nexus-Setup-${APP_VERSION}.exe"
InstallDir "$LOCALAPPDATA\Programs\SSH Nexus"
InstallDirRegKey HKCU "Software\SSH Nexus" "InstallLocation"
RequestExecutionLevel user
SetCompressor /SOLID lzma
SetCompressorDictSize 64
CRCCheck on
XPStyle on
BrandingText "SSH Nexus ${APP_VERSION}"
Icon "${PROJECT_DIR}/assets/ssh-nexus-icon.ico"
WindowIcon on

VIProductVersion "${APP_FILE_VERSION}"
VIAddVersionKey /LANG=1041 "ProductName" "SSH Nexus"
VIAddVersionKey /LANG=1041 "ProductVersion" "${APP_VERSION}"
VIAddVersionKey /LANG=1041 "FileDescription" "SSH Nexus Installer"
VIAddVersionKey /LANG=1041 "FileVersion" "${APP_VERSION}"
VIAddVersionKey /LANG=1041 "LegalCopyright" "SSH Nexus"

!define MUI_ICON "${PROJECT_DIR}/assets/ssh-nexus-icon.ico"
!define MUI_UNICON "${PROJECT_DIR}/assets/ssh-nexus-icon.ico"
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\SSH Nexus.exe"
!define MUI_FINISHPAGE_RUN_TEXT "SSH Nexusを起動する"
!define MUI_FINISHPAGE_LINK "インストール先を開く"
!define MUI_FINISHPAGE_LINK_LOCATION "$INSTDIR"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_UNPAGE_FINISH

!insertmacro MUI_LANGUAGE "Japanese"
!insertmacro MUI_LANGUAGE "English"

Function .onInit
  SetShellVarContext current
  SetRegView 64
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP|MB_OK "SSH Nexusは64ビット版Windowsを必要とします。"
    Abort
  ${EndIf}
FunctionEnd

Section "SSH Nexus（必須）" SecMain
  SectionIn RO
  SetShellVarContext current
  SetRegView 64
  IfFileExists "$INSTDIR\SSH Nexus.exe" 0 files_ready
  IfSilent files_ready
  MessageBox MB_ICONEXCLAMATION|MB_OKCANCEL "更新する前に、起動中のSSH Nexusを終了してください。終了済みならOKを押してください。" IDOK files_ready
  Abort
files_ready:
  SetOutPath "$INSTDIR"

  ; The complete, already verified Electron Windows directory.
  File /r "${PROJECT_DIR}/release/win-unpacked\*"

  WriteUninstaller "$INSTDIR\Uninstall SSH Nexus.exe"
  WriteRegStr HKCU "Software\SSH Nexus" "InstallLocation" "$INSTDIR"

  ; Windows Apps & Features registration (current user, no administrator required).
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\SSH Nexus" "DisplayName" "SSH Nexus"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\SSH Nexus" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\SSH Nexus" "DisplayIcon" "$INSTDIR\SSH Nexus.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\SSH Nexus" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\SSH Nexus" "UninstallString" '"$INSTDIR\Uninstall SSH Nexus.exe"'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\SSH Nexus" "QuietUninstallString" '"$INSTDIR\Uninstall SSH Nexus.exe" /S'
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\SSH Nexus" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\SSH Nexus" "NoRepair" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\SSH Nexus" "EstimatedSize" 382800

  ; Start menu, desktop, App Paths and sshnexus:// protocol integration.
  CreateDirectory "$SMPROGRAMS\SSH Nexus"
  CreateShortcut "$SMPROGRAMS\SSH Nexus\SSH Nexus.lnk" "$INSTDIR\SSH Nexus.exe"
  CreateShortcut "$SMPROGRAMS\SSH Nexus\アンインストール.lnk" "$INSTDIR\Uninstall SSH Nexus.exe"
  CreateShortcut "$DESKTOP\SSH Nexus.lnk" "$INSTDIR\SSH Nexus.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\App Paths\SSH Nexus.exe" "" "$INSTDIR\SSH Nexus.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\App Paths\SSH Nexus.exe" "Path" "$INSTDIR"
  WriteRegStr HKCU "Software\Classes\sshnexus" "" "URL:SSH Nexus connection request"
  WriteRegStr HKCU "Software\Classes\sshnexus" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\sshnexus\DefaultIcon" "" '"$INSTDIR\SSH Nexus.exe",0'
  WriteRegStr HKCU "Software\Classes\sshnexus\shell\open\command" "" '"$INSTDIR\SSH Nexus.exe" "%1"'
SectionEnd

Section "Uninstall"
  SetShellVarContext current
  SetRegView 64
  Delete "$DESKTOP\SSH Nexus.lnk"
  RMDir /r "$SMPROGRAMS\SSH Nexus"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\SSH Nexus"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\App Paths\SSH Nexus.exe"
  DeleteRegKey HKCU "Software\Classes\sshnexus"
  DeleteRegKey HKCU "Software\SSH Nexus"
  RMDir /r "$INSTDIR"
  ; Credential vault, recordings and settings under the user profile are
  ; intentionally retained so uninstalling or upgrading never destroys data.
SectionEnd
