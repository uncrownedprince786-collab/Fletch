<div align="center">

<img src="assets/icon.png" width="104" alt="Fletch">

# Fletch

### A fast download manager that is free for good.

No licence key. No trial. No subscription. No account. No telemetry.

[![Release](https://img.shields.io/github/v/release/uncrownedprince786-collab/Fletch?label=download&color=FF9A2E)](https://github.com/uncrownedprince786-collab/Fletch/releases/latest)
[![Build](https://github.com/uncrownedprince786-collab/Fletch/actions/workflows/release.yml/badge.svg)](https://github.com/uncrownedprince786-collab/Fletch/actions)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Platforms](https://img.shields.io/badge/windows%20%C2%B7%20macos%20%C2%B7%20linux-supported-444)

[**Download**](https://github.com/uncrownedprince786-collab/Fletch/releases/latest) ·
[Setup guide](SETUP.md) ·
[Extension](docs/EXTENSION.md) ·
[Privacy](docs/PRIVACY.md)

</div>

---

Fletch splits a file across many connections and pulls the pieces at once, the
way a good download manager has always worked. It also understands video: give
it a page and it finds the stream, picks the best quality, and puts separate
video and audio tracks back together. And it does torrents.

The name is the fletching on an arrow — the feathers that make it fly fast and
straight — and a pun on *fetch*.

---

## Why it exists

Download managers that do this well tend to cost money, nag you, or quietly
stop working when a trial lapses. Fletch is MIT-licensed and finished. There is
no paid tier, because there is no tier.

---

## What it does

### Downloads

| | |
|---|---|
| **Multi-connection transfer** | Files split across up to 32 parallel connections. |
| **Dynamic segment stealing** | A connection that finishes early takes the back half of whichever peer has the most left. One slow connection can't hold the tail of a download hostage. *Measured: 8 segments became 15 mid-download.* |
| **Real resume** | Progress is checkpointed next to the file. A pause, a crash or a reboot continues where it stopped. |
| **Adaptive concurrency** | A server answering with HTTP 429 is taken at its word — Fletch narrows the pool instead of hammering. *Measured: eased 12 → 3 against a server capping at 3, and still finished intact.* |
| **Self-healing stalls** | If a server goes quiet, Fletch stops waiting, halves its connections and retries by itself. |
| **Speed limit** | Across all downloads at once, not per connection. |
| **Queue** | Concurrency limit, pause/resume all, automatic category folders. |

### Video

- **~1800 sites** via the yt-dlp extractor — but yt-dlp is only asked *where*
  the media is. Fletch downloads it with its own parallel engine, which is
  usually considerably faster than letting yt-dlp fetch it.
- **HLS (`.m3u8`)** fetched segment-by-segment in parallel, with AES-128
  decryption and variant selection.
- **Byte-range playlists** (`EXT-X-BYTERANGE`), where every "segment" is a slice
  of one large file — including Apple's own reference streams.
- **Separate audio renditions** (`EXT-X-MEDIA`). Most real streams keep sound in
  its own playlist; Fletch fetches both and merges them rather than quietly
  handing you a silent video.
- **Separate video + audio tracks** muxed with ffmpeg. Stream copy only —
  nothing is ever re-encoded.
- **Signed-in sites.** Borrow your browser's cookies and Instagram, Facebook, X
  and private or age-restricted video work too.
- Quality picker per download, or a default ceiling. Audio-only extraction.

### Torrents

- **Magnet links and `.torrent` files**, with DHT, peer exchange and local peer
  discovery, so a swarm is found without relying on one tracker.
- **Registered as the magnet handler**, so clicking a magnet anywhere opens
  Fletch.
- **Piece-level progress** in the same bar as everything else, and a live peer
  count.
- Seeding stops when the download finishes, unless you ask it to keep going.

### Catching links

- **Download takeover** — the IDM behaviour. Click a download in your browser
  and the extension hands it to Fletch. If Fletch is not running, the browser
  keeps it, so nothing is ever lost.
- **Browser extension** for Chrome, Edge and Brave, with a right-click menu and
  a popup listing every media file spotted on the current tab.
- **Clipboard watch** — copy a link and Fletch offers it. Nothing downloads
  without a click.
- **Drag and drop** a link onto the window.

### Keeping current

Fletch checks GitHub Releases shortly after launch and every few hours, then
tells you. It asks before downloading and asks again before installing.

---

## Install

Grab the latest build from [**Releases**](https://github.com/uncrownedprince786-collab/Fletch/releases/latest).

| Platform | File | Note |
|---|---|---|
| Windows | `Fletch-Setup-*.exe` | Installs to `C:\Program Files\Fletch`. Needs the usual admin prompt. |
| Windows, no install | `Fletch-Portable-*.exe` | Runs as-is from anywhere. |
| macOS, Apple silicon | `Fletch-*-arm64.dmg` | |
| macOS, Intel | `Fletch-*-x64.dmg` | |
| Linux | `Fletch-*.AppImage` / `*.deb` | |

> **Unsigned builds.** Code-signing certificates cost money every year and this
> project has no income. Windows SmartScreen will warn — **More info → Run
> anyway**. macOS needs **right-click → Open** the first time.

Then open Fletch and follow the short panel to add the browser extension. See
[SETUP.md](SETUP.md).

### The two optional helpers

Fletch downloads files entirely on its own. These extend it, and both are
optional:

| Tool | Adds | How |
|---|---|---|
| **yt-dlp** | Finding media on web pages | Settings → Helpers → **Install** (one click) |
| **ffmpeg** | Joining video/audio, repacking streams | Install it yourself, then Settings → Helpers → **Locate…** |

Without them, direct file links and HLS streams still work.

---

## How it works

```
  URL
   │
   ├─ probe: size, byte-range support, real filename, content type
   │
   ├── a file ──────────► segmented engine ─────────────► file
   │                      N sockets, one byte range each,
   │                      rebalanced as they finish
   │
   ├── an .m3u8 ────────► HLS engine ──────────────────► .ts ──ffmpeg──► .mp4
   │                      parallel segments, byte ranges,
   │                      AES-128, strict write order
   │
   ├── a magnet ────────► torrent engine ──────────────► file or folder
   │                      DHT + PEX + trackers
   │
   └── a web page ──────► yt-dlp (extract only)
                           │
                           ├─ one stream ──► segmented engine ──► file
                           ├─ two streams ─► engine ×2 ──ffmpeg──► merged
                           └─ exotic protocol ──► yt-dlp downloads it
```

### Layout

| Path | What lives there |
|---|---|
| `src/main/engine/http-download.js` | The segmented downloader |
| `src/main/engine/hls.js` | HLS playlists, byte ranges, renditions |
| `src/main/engine/torrent.js` | Magnets and torrents |
| `src/main/engine/ytdlp.js` | Extractor wrapper and format selection |
| `src/main/engine/manager.js` | Queue, engine routing, lifecycle |
| `src/main/bridge.js` | Loopback endpoint for the extension |
| `src/main/protocol.js` | The `magnet:` association |
| `src/main/updater.js` | Update checks |
| `src/renderer/` | The interface |
| `extension/` | The browser extension |
| `scripts/make-icons.js` | Draws the whole icon set from geometry, no image library |

---

## Building it yourself

```bash
npm install
npm start            # run from source

npm test             # 10 offline suites, no network needed
npm run test:live    # fetches real files from the internet

npm run dist:win     # Windows installer + portable
npm run dist         # for whichever platform you are on
npm run pack:extension
```

**macOS and Linux builds must be made on those platforms** — Apple's packaging
tools only run on macOS. That is what
[`.github/workflows/release.yml`](.github/workflows/release.yml) is for: push a
tag like `v1.0.1` and GitHub builds all three and attaches them to a release.

```bash
git tag v1.0.1 && git push origin v1.0.1
```

---

## Privacy

Fletch makes no network request that is not part of doing its job, and every
one can be switched off. No analytics, no crash reporting, no account, no
update ping you cannot turn off. It also fetches its two helpers, yt-dlp and
ffmpeg, shortly after first run and refreshes them weekly — checked against
their projects' published checksums, and switchable in **Settings → Helpers**.
Full detail in [docs/PRIVACY.md](docs/PRIVACY.md).

---

## Licence

[MIT](LICENSE). Yours to use, change and redistribute.

Respect the terms of the sites you download from, and other people's copyright.
Fletch is a tool for moving files you are entitled to have.
