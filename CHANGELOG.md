# Changelog

## 1.0.3

- macOS builds now work. The hand-written `.icns` was rejected during
  packaging; electron-builder generates each platform's icon from a single
  1024px PNG instead, using the native tooling.
- Failing builds write their output into the GitHub Actions run summary, so a
  CI failure can be read rather than guessed at.

## 1.0.2

- Tests run inside each platform's own CI job rather than once on Linux, and
  the release publishes whatever built. One platform failing no longer denies
  everyone else an installer.

## 1.0.1

- Fixed the release build on the Linux and macOS runners: the protocol tests
  compare Windows paths, and `path.basename` does not treat a backslash as a
  separator off Windows, so every one of those assertions collapsed.

## 1.0.0

First release.

### Downloads

- Segmented transfer across up to 32 connections, with dynamic segment
  stealing — a connection that finishes early takes the back half of whichever
  peer has the most left, so one slow socket cannot hold the tail of a file.
- Resume from an on-disk checkpoint after a pause, a crash or a reboot.
- Adaptive concurrency: a server answering HTTP 429 is taken at its word and
  the pool narrows rather than hammering it.
- Stall detection, with an automatic retry at fewer connections.
- Global speed limit, queue with a concurrency cap, category folders.

### Video

- yt-dlp used as an extractor only; the transfer runs on Fletch's own parallel
  engine, which is usually considerably faster.
- HLS with AES-128, byte-range playlists (`EXT-X-BYTERANGE`) and separate audio
  renditions (`EXT-X-MEDIA`) — the last of which is why streams no longer come
  out silent.
- Separate video and audio tracks muxed with ffmpeg, stream copy only.
- Optional browser cookies for sites that need a signed-in session.

### Torrents

- Magnet links and `.torrent` files over WebTorrent, with DHT and peer
  exchange.
- Registered as the system `magnet:` handler.
- Piece-level progress and a live peer count.

### Browser extension

- Takes over downloads clicked in Chrome, Edge or Brave, and hands them back
  untouched if Fletch is not running.
- Pairs with the app over loopback using a locally generated token.
- Lists media spotted on the current tab, for pages that offer no download
  link.

### Elsewhere

- Working files moved out of the download folder; older `.fletch-tmp` folders
  are swept away on launch.
- Updates from GitHub Releases, which ask before downloading and again before
  installing.
- A dependency-free icon rasteriser, and ten offline test suites.
