; Per-user installation. Nonce is only an accidental-invocation guard; same-user processes can forge it.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    CreateDirectory "$APPDATA\swift-client\harness"
    System::Call 'kernel32::GetTickCount() i.r0'
    FileOpen $1 "$APPDATA\swift-client\harness\uninstall.nonce" w
    FileWrite $1 "swift-uninstall:$0"
    FileClose $1
    ExecWait '"$INSTDIR\swift-client.exe" --harness-detach-all'
  ${endIf}
!macroend
