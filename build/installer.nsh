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
  ; --- a ProgId of our own, which is what a default-app choice points at ---
  WriteRegStr HKLM "Software\Classes\Fletch.Magnet" "" "Magnet Link"
  WriteRegStr HKLM "Software\Classes\Fletch.Magnet" "URL Protocol" ""
  WriteRegStr HKLM "Software\Classes\Fletch.Magnet\DefaultIcon" "" "$INSTDIR\Fletch.exe,0"
  WriteRegStr HKLM "Software\Classes\Fletch.Magnet\shell\open\command" "" '"$INSTDIR\Fletch.exe" "%1"'

  ; --- the legacy association, for anything that still consults it ---
  WriteRegStr HKLM "Software\Classes\magnet" "" "URL:Magnet Protocol"
  WriteRegStr HKLM "Software\Classes\magnet" "URL Protocol" ""
  WriteRegStr HKLM "Software\Classes\magnet" "Content Type" "application/x-magnet"
  WriteRegStr HKLM "Software\Classes\magnet\DefaultIcon" "" "$INSTDIR\Fletch.exe,0"
  WriteRegStr HKLM "Software\Classes\magnet\shell\open\command" "" '"$INSTDIR\Fletch.exe" "%1"'

  ; --- declare the capability, so Windows lists Fletch in Default apps ---
  ;
  ; Windows 11 will not let a program make itself the handler for a protocol
  ; behind the user's back: the real choice lives in a UserChoice key that is
  ; signed with a per-user hash, and writing the association directly is
  ; ignored. All an installer can honestly do is register as a candidate and
  ; let the user pick. Settings > Apps > Default apps > Fletch.
  WriteRegStr HKLM "Software\Fletch\Capabilities" "ApplicationName" "Fletch"
  WriteRegStr HKLM "Software\Fletch\Capabilities" "ApplicationDescription" "Download manager"
  WriteRegStr HKLM "Software\Fletch\Capabilities\UrlAssociations" "magnet" "Fletch.Magnet"
  WriteRegStr HKLM "Software\RegisteredApplications" "Fletch" "Software\Fletch\Capabilities"
!macroend

!macro customUnInstall
  DeleteRegKey HKLM "Software\Classes\Fletch.Magnet"
  DeleteRegKey HKLM "Software\Classes\magnet"
  DeleteRegKey HKLM "Software\Fletch"
  DeleteRegValue HKLM "Software\RegisteredApplications" "Fletch"
!macroend
