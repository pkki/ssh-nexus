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
!define MUI_LANGDLL_REGISTRY_ROOT HKCU
!define MUI_LANGDLL_REGISTRY_KEY "Software\SSH Nexus"
!define MUI_LANGDLL_REGISTRY_VALUENAME "Installer Language"
!insertmacro MUI_RESERVEFILE_LANGDLL
!define MUI_FINISHPAGE_RUN "$INSTDIR\SSH Nexus.exe"
!define MUI_FINISHPAGE_RUN_TEXT "$(LaunchText)"
!define MUI_FINISHPAGE_LINK "$(OpenInstallFolder)"
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
!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "Korean"
!insertmacro MUI_LANGUAGE "Spanish"
!insertmacro MUI_LANGUAGE "French"
!insertmacro MUI_LANGUAGE "German"
!insertmacro MUI_LANGUAGE "PortugueseBR"

!macro SSHNexusLang LANG LAUNCH OPENFOLDER REQUIRES64 CLOSEAPP REQUIRED UNINSTALLLINK
  LangString LaunchText ${LANG} "${LAUNCH}"
  LangString OpenInstallFolder ${LANG} "${OPENFOLDER}"
  LangString Requires64 ${LANG} "${REQUIRES64}"
  LangString CloseBeforeUpdate ${LANG} "${CLOSEAPP}"
  LangString RequiredSection ${LANG} "${REQUIRED}"
  LangString UninstallShortcut ${LANG} "${UNINSTALLLINK}"
!macroend
!insertmacro SSHNexusLang ${LANG_JAPANESE} "SSH Nexusを起動する" "インストール先を開く" "SSH Nexusは64ビット版Windowsを必要とします。" "更新する前に、起動中のSSH Nexusを終了してください。終了済みならOKを押してください。" "SSH Nexus（必須）" "アンインストール"
!insertmacro SSHNexusLang ${LANG_ENGLISH} "Launch SSH Nexus" "Open installation folder" "SSH Nexus requires 64-bit Windows." "Close SSH Nexus before updating, then click OK." "SSH Nexus (required)" "Uninstall"
!insertmacro SSHNexusLang ${LANG_SIMPCHINESE} "启动 SSH Nexus" "打开安装文件夹" "SSH Nexus 需要 64 位 Windows。" "更新前请关闭正在运行的 SSH Nexus，然后单击确定。" "SSH Nexus（必需）" "卸载"
!insertmacro SSHNexusLang ${LANG_KOREAN} "SSH Nexus 시작" "설치 폴더 열기" "SSH Nexus에는 64비트 Windows가 필요합니다." "업데이트하기 전에 실행 중인 SSH Nexus를 닫고 확인을 누르십시오." "SSH Nexus(필수)" "제거"
!insertmacro SSHNexusLang ${LANG_SPANISH} "Iniciar SSH Nexus" "Abrir carpeta de instalación" "SSH Nexus requiere Windows de 64 bits." "Cierre SSH Nexus antes de actualizar y pulse Aceptar." "SSH Nexus (obligatorio)" "Desinstalar"
!insertmacro SSHNexusLang ${LANG_FRENCH} "Lancer SSH Nexus" "Ouvrir le dossier d’installation" "SSH Nexus nécessite Windows 64 bits." "Fermez SSH Nexus avant la mise à jour, puis cliquez sur OK." "SSH Nexus (requis)" "Désinstaller"
!insertmacro SSHNexusLang ${LANG_GERMAN} "SSH Nexus starten" "Installationsordner öffnen" "SSH Nexus benötigt 64-Bit-Windows." "Schließen Sie SSH Nexus vor dem Update und klicken Sie auf OK." "SSH Nexus (erforderlich)" "Deinstallieren"
!insertmacro SSHNexusLang ${LANG_PORTUGUESEBR} "Iniciar SSH Nexus" "Abrir pasta de instalação" "O SSH Nexus requer Windows de 64 bits." "Feche o SSH Nexus antes de atualizar e clique em OK." "SSH Nexus (obrigatório)" "Desinstalar"

Function .onInit
  !insertmacro MUI_LANGDLL_DISPLAY
  SetShellVarContext current
  SetRegView 64
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP|MB_OK "$(Requires64)"
    Abort
  ${EndIf}
FunctionEnd

Section "$(RequiredSection)" SecMain
  SectionIn RO
  SetShellVarContext current
  SetRegView 64
  IfFileExists "$INSTDIR\SSH Nexus.exe" 0 files_ready
  IfSilent files_ready
  MessageBox MB_ICONEXCLAMATION|MB_OKCANCEL "$(CloseBeforeUpdate)" IDOK files_ready
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
  CreateShortcut "$SMPROGRAMS\SSH Nexus\$(UninstallShortcut).lnk" "$INSTDIR\Uninstall SSH Nexus.exe"
  CreateShortcut "$DESKTOP\SSH Nexus.lnk" "$INSTDIR\SSH Nexus.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\App Paths\SSH Nexus.exe" "" "$INSTDIR\SSH Nexus.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\App Paths\SSH Nexus.exe" "Path" "$INSTDIR"
  WriteRegStr HKCU "Software\Classes\sshnexus" "" "URL:SSH Nexus connection request"
  WriteRegStr HKCU "Software\Classes\sshnexus" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\sshnexus\DefaultIcon" "" '"$INSTDIR\SSH Nexus.exe",0'
  WriteRegStr HKCU "Software\Classes\sshnexus\shell\open\command" "" '"$INSTDIR\SSH Nexus.exe" "%1"'
SectionEnd

Function un.onInit
  !insertmacro MUI_UNGETLANGUAGE
FunctionEnd

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
