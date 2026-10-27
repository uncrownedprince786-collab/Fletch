; Extra installer steps for Fletch.
;
; electron-builder already writes the uninstall entry and the shortcuts. This
; adds the machine-wide magnet: association, so clicking a magnet link anywhere
; on the system opens Fletch.
;
; A per-user association in HKCU takes precedence over this one. Rather than
; reaching into another torrent client's settings from the installer, Fletch
; checks that key itself on launch and only corrects it when it is pointing at
; a copy of Fletch that no longer exists. See src/main/protocol.js.

!macro customInstall
  WriteRegStr HKCR "magnet" "" "URL:Magnet Protocol"
  WriteRegStr HKCR "magnet" "URL Protocol" ""
  WriteRegStr HKCR "magnet" "Content Type" "application/x-magnet"
  WriteRegStr HKCR "magnet\DefaultIcon" "" "$INSTDIR\Fletch.exe,0"
  WriteRegStr HKCR "magnet\shell" "" "open"
  WriteRegStr HKCR "magnet\shell\open\command" "" '"$INSTDIR\Fletch.exe" "%1"'
!macroend

!macro customUnInstall
  DeleteRegKey HKCR "magnet"
!macroend
