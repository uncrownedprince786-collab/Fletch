# Changelog

## 1.2.4

- Installing an update always leaves the browser holding the add-on from the
  version before it, so the update screen now says to reload it every time,
  rather than only when a published floor said the add-on was too old.
- An out-of-date add-on on its own no longer blocks the window. It shows a bar
  along the bottom instead, which stays until the add-on reports a current
  version. Fletch can replace itself, so locking the window over an app update
  is always escapable; it cannot reach into the browser, and anyone who loaded
  the add-on from a folder of their own could have pressed Reload all day
  without the version ever changing. Locking them out of the app over that
  would have been a trap. The bar offers the extensions page and the folder
  holding the current files, which is what actually fixes that case.
- Whether the browser's add-on is behind is now judged against the copy this
  build carries, not a line in the policy file. It is true by itself after
  every release, and needs nobody to remember to publish a floor.

## 1.2.3

- The extension will not take over more than a dozen downloads in ten seconds.
  Nobody clicks that fast, so a burst on that scale means something upstream
  is wrong, and the right answer to not understanding what is happening is to
  stop touching it: the browser keeps the rest, and Fletch stands back for a
  minute. This is not another fix for 1.2.2's history replay, which is dealt
  with and tested. It is the ceiling that was missing when that went wrong —
  the one that would have turned 727 duplicated files into twelve.

## 1.2.2

- A withdrawn version can now be stopped. Fletch reads a small policy file
  published beside the source, and a copy below the version it names is held
  behind a screen it cannot be dismissed from: the reason, the replacement,
  and a button to install it. Fletch fetches that replacement without asking,
  because the question is not worth putting. Turning automatic updates off
  does not waive this — that setting is about convenience, not about keeping a
  version that was recalled. A policy file that is missing, corrupt or
  unreachable holds nobody back.
- A copy that cannot replace itself — a portable build, or one run from source
  — no longer sends the user off to a web page to find the installer. It
  downloads the installer with the download manager it already is, and opens
  it the moment it lands. If that download fails, the screen says so and
  offers to try again rather than sitting on "Downloading" forever.
- The extension names its version on every call it makes to the app, so Fletch
  can tell when the browser is still holding an old copy of it — updating the
  app does not reload what the browser has — and says to reload it.
- The browser extension no longer re-downloads your download history. Chrome
  replays `downloads.onCreated` for every item already in its list when it
  starts, and the takeover read each replayed record as a download beginning
  now: it erased the history entry and fetched the file over again. One cold
  boot could pull down months of history. The takeover now acts only on a
  download that is actually running and started moments ago.
- With Fletch closed, the extension leaves the browser's own downloads alone.
  It used to cancel each one, fail to reach the app, and start it again in
  Chrome.
- What was handed back to Chrome is remembered in session storage rather than
  in a variable the service worker loses when it is stopped, and is matched on
  the redirected URL as well as the original, so a hand-back cannot be caught
  and handed back without end.

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
