!macro customInit
  IfFileExists "$INSTDIR\${APP_EXECUTABLE_FILENAME}" LANDropExistingInstall
  StrCpy $INSTDIR "C:\LAN Drop"
LANDropExistingInstall:
!macroend
