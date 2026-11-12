# Changelog

## Unreleased

- HTTP requests that fail because a host blocks Node.js' TLS fingerprint
  (connection reset during the handshake) now fall back to Windows' native
  HTTP stack (PowerShell / Schannel), which is accepted by far more sites.
  This applies to page scraping, small file fetches and large downloads; large
  downloads retry on connection drops.
- The page scraper now prefers real media files (mp4, m3u8, mpd, ...) over
  embed or watch URLs, so it picks the downloadable stream instead of a page
  link. Media-extension checks also tolerate a trailing slash before the query
  string (e.g. .mp4/?token=...).
- The grabber button now appears within ~500ms of a video starting to play,
  instead of up to 1.2s later. It listens for play, loadeddata and canplay
  events on every video (including shadow roots), and the background sniffer
  notifies the page the moment a media response is seen.
- A native DASH (MPD) downloader handles SegmentTemplate and SegmentList
  manifests directly, with init segments and numbered media segments written
  in order.
- Filenames are cleaned more aggressively: control characters, zero-width
  marks and emoji are stripped.
- Grabber is on by default and needs no configuration.

## 1.2.9

- The grabber button now appears within half a second of a video starting to
  play, instead of up to 1.2 seconds later. It listens for play, loadeddata
  and canplay events on every video (including ones inside shadow roots), and
  the background sniffer notifies the page the moment a media response is seen,
  so the button can appear before the video element is even fully rendered.
- A native DASH (MPD) downloader joins the HLS one. DASH streams used to be
  handed to yt-dlp; common SegmentTemplate and SegmentList manifests are now
  fetched directly, with init segments and numbered media segments written in
  order, and progress reported per segment.
- Filenames are cleaned more aggressively: control characters, zero-width
  marks and emoji are stripped, Windows reserved names are prefixed, and the
  180-character cap keeps the extension intact.
- The grabber button is on by default and needs no configuration; the sniffer
  captures m3u8, mpd, mp4 and other media responses automatically.

## 1.2.8

- Torrents are private by default. DHT, peer exchange and local discovery all
  advertise what is being downloaded, so all three are now off; trackers still
  connect every magnet that has them, so nothing that worked stops working.
- A magnet with no trackers at all borrows the DHT for that one download.
- UPnP/NAT-PMP stay on while torrents run, and the WebTorrent client is
  destroyed when the queue empties, closing the port and dropping the map.
- Upload stays uncapped by default with an optional cap in Settings.
- Ten downloads at once, up from three.
- The grabber button starts Fletch when it is not running.

## 1.2.7

- The grabber downloads the video you are watching.
- A magnet link reaches Windows when Fletch is closed.
- yt-dlp and ffmpeg install themselves.
"