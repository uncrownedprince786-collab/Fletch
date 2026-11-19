# Changelog

## 1.3.3

- **Torrents find far more peers.** Every torrent is now announced to 14
  public trackers on top of its own, up from 5, one of which had been dead for
  years. Each was checked to answer before going in, and one works over HTTP
  for networks that block UDP. On the Debian installer's swarm that meant about
  70 peers instead of about 40, with DHT and peer exchange still off. A
  well-seeded torrent was already as fast as the line allowed, so the gain shows
  on torrents with few seeders, where more peers is more speed.
- Two other changes were measured and left out. uTP connections came out slower
  than TCP (2.9 against 3.7 MB/s from the same swarm), so torrents stay on TCP,
  now set explicitly so a run from source matches the installed app.
  Rarest-first piece order was no faster than the default.

## 1.3.2

Two security fixes. Download speed is unchanged.

- **Downloads now carry Windows' "came from the internet" mark** (the
  Zone.Identifier stream a browser writes). Windows SmartScreen checks a
  downloaded program before it first runs, and Office opens downloaded
  documents in Protected View, exactly as for a file Chrome fetched. Before,
  anything Fletch downloaded — including downloads it took over from the
  browser — skipped both. The mark names where the file came from, without the
  link's signed query string or any password. Torrent folders are marked file
  by file. Drives that cannot hold the mark (FAT32, exFAT) are skipped quietly.
- **A site's cookies and login no longer follow a redirect to another site.**
  Cookies are kept per site: the ones Fletch was given for a link, and the ones
  each redirect sets, go only to that same site, as in a browser. An
  `Authorization` header is dropped when a redirect leaves its origin. Redirects
  within a site work exactly as before. Telling sites apart now understands
  addresses like `example.co.uk` and `example.com.pk`.
- New tests: `motw.test.js`, `redirect-cookies.test.js`.

## 1.3.1

- Settings and the download list are saved for the last time when Fletch
  quits, and nothing is written after that. A save queued just before quitting
  used to land up to ~300ms later, which could overwrite the newer copy with an
  older one. In the test suite it wrote into a folder being deleted, which is
  what failed the Windows build of 1.3.0 (the 1.3.0 installers themselves were
  fine).
- New test: `store.test.js`.

## 1.3.0

Faster downloads, and more sites that work.

- **16 parallel workers per file by default** (was 8). Hosts that cap each
  connection's speed are now roughly twice as fast. Anyone still on the old
  default of 8 is moved up; a value you chose yourself is left alone. Fletch
  still eases off by itself when a server allows fewer.
- **Sites that block downloaders now go through Chrome's own network stack.**
  When a host resets Node's connection or answers with a bot-screen 403
  (Cloudflare, Akamai and the like), the request is retried through
  Chromium — Chrome's TLS and HTTP/2 fingerprint, the system's certificates
  and proxy — and that host stays there, *with all of its parallel workers*.
  This replaces the PowerShell fallback, which downloaded on one connection,
  froze the whole app while it ran, dropped cookies and Referer, and gave up
  after two minutes.
- **A download that starts as one stream becomes many.** When the size was
  not known up front, the first response's size now splits the file across
  workers mid-download. Files with no length at all now finish instead of
  failing with "Connection closed before the range was complete".
- **A server that refuses extra connections with 403 is treated as a cap,**
  not as "ranges unsupported": Fletch narrows the pool instead of restarting
  the whole file on a single connection. Refused pieces no longer hold a
  slot while they wait, so the connections that are accepted keep working.
- **Video sites:** the session cookies yt-dlp picks up while reading a page
  now go with the media requests (many sites 403 without them); yt-dlp's
  chunk size is honoured, so YouTube's CDN no longer throttles long requests
  to playback speed; an estimated size never decides the file's length.
- **If a site refuses Fletch's own engine** for a video yt-dlp understood,
  yt-dlp now fetches it instead of the download failing. Pages behind a bot
  screen are re-read with yt-dlp's Chrome impersonation.
- **Picking a quality by hand keeps the parallel engine** (it used to hand the
  whole download to yt-dlp on one connection), and a picture-only choice is
  paired with the best audio.
- HTTP 401/403/404/410 fail straight away instead of after a minute of
  retries, and the rest of the pool stops with them.
- Pausing no longer discards bytes still in the write buffer, and checkpoints
  only record bytes confirmed on disk, so a resume after a pause or a crash
  cannot leave a hole of zeros in the file.
- New tests: `workers.test.js`, `extractor.test.js`, and
  `npm run test:electron` for the Chromium path.

## 1.2.10

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