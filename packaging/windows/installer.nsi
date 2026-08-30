; Instalador de RAMI-Chain para Windows (NSIS + Modern UI 2).
; Un solo archivo (RAMI-Chain-Setup.exe) con icono, sin permisos de admin.
; Firmado con Authenticode SOLO si el CI tiene el certificado (ver SIGNING.md).

!include "MUI2.nsh"

!ifndef VERSION
  !define VERSION "0.0.0"
!endif

Name "RAMI-Chain"
OutFile "RAMI-Chain-Setup.exe"
Unicode True
InstallDir "$LOCALAPPDATA\RAMI-Chain"
RequestExecutionLevel user
BrandingText "RAMI-Chain ${VERSION} — testnet experimental, sin valor monetario"

!define MUI_ICON "rami.ico"
!define MUI_UNICON "rami.ico"
!define MUI_ABORTWARNING

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN "$INSTDIR\rami-gui.exe"
!define MUI_FINISHPAGE_RUN_PARAMETERS "--network testnet"
!define MUI_FINISHPAGE_RUN_TEXT "Abrir el monedero RAMI-Chain"
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "Spanish"
!insertmacro MUI_LANGUAGE "English"

Section "RAMI-Chain"
  SetOutPath "$INSTDIR"
  File "rami-gui.exe"
  File "rami-node.exe"
  File "rami-wallet.exe"
  File "rami.ico"
  File /nonfatal "COMO-ABRIR.txt"
  File /nonfatal "NOTICE.md"
  File /nonfatal "README.md"

  CreateDirectory "$SMPROGRAMS\RAMI-Chain"
  CreateShortcut "$SMPROGRAMS\RAMI-Chain\RAMI-Chain.lnk" "$INSTDIR\rami-gui.exe" "--network testnet" "$INSTDIR\rami.ico"
  CreateShortcut "$DESKTOP\RAMI-Chain.lnk" "$INSTDIR\rami-gui.exe" "--network testnet" "$INSTDIR\rami.ico"

  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\RAMI-Chain" "DisplayName" "RAMI-Chain"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\RAMI-Chain" "DisplayIcon" "$INSTDIR\rami.ico"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\RAMI-Chain" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\RAMI-Chain" "UninstallString" "$INSTDIR\Uninstall.exe"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
SectionEnd

Section "Uninstall"
  Delete "$INSTDIR\rami-gui.exe"
  Delete "$INSTDIR\rami-node.exe"
  Delete "$INSTDIR\rami-wallet.exe"
  Delete "$INSTDIR\rami.ico"
  Delete "$INSTDIR\COMO-ABRIR.txt"
  Delete "$INSTDIR\NOTICE.md"
  Delete "$INSTDIR\README.md"
  Delete "$INSTDIR\Uninstall.exe"
  Delete "$SMPROGRAMS\RAMI-Chain\RAMI-Chain.lnk"
  Delete "$DESKTOP\RAMI-Chain.lnk"
  RMDir "$SMPROGRAMS\RAMI-Chain"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\RAMI-Chain"
SectionEnd
