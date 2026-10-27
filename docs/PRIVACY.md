# Privacy

Short version: Fletch has no server, no account and no analytics. Nothing about
you or what you download leaves your computer.

---

## The desktop app

Fletch makes no network request you did not ask for.

**What it connects to**

- The servers hosting whatever you queue, to download it.
- Torrent peers and trackers, only while a torrent is running.
- `api.github.com`, to ask whether a newer version of Fletch exists — only if
  automatic update checks are left on. The request carries no identifier beyond
  the version you are running. Turn it off in **Settings → Updates**.
- The yt-dlp release page on GitHub, once, only if you press **Install** on the
  optional helper in **Settings → Helpers**.

**What it does not do**

- No analytics, telemetry, crash reporting or usage statistics.
- No account, sign-in or licence check.
- No list of your downloads sent anywhere. Your queue and history live in a
  file on your own disk.

**Cookies.** If you turn on *"Sign in as you, using your browser's cookies"*,
Fletch reads cookies from the browser you choose so that sites which need you
logged in will play. Those cookies are sent only to the site they belong to, as
part of fetching what you asked for. They are not stored by Fletch or sent
anywhere else.

**Where your data sits**

| | |
|---|---|
| Settings and download history | `%APPDATA%\Fletch` (Windows), `~/Library/Application Support/Fletch` (macOS), `~/.config/Fletch` (Linux) |
| Downloaded files | Wherever you point it, by default `Downloads/Fletch` |
| Working files | Your system temp folder, removed when the download finishes |

Uninstalling leaves your downloads alone. Delete the settings folder above to
remove everything else.

---

## The browser extension

The extension sends links to **one place only**: the Fletch app on
`127.0.0.1`, your own machine. Every request carries a token the app generated
locally, so no web page can queue downloads through it.

It never transmits page contents, browsing history, form data, cookies or
credentials anywhere.

It needs access to all sites because media can appear on any site, and it
watches network responses on the tab you are looking at to spot video a page
offers no download link for. That observation happens in your browser and is
discarded when you close the tab.

---

## Third-party components

Fletch can use two optional external tools, both of which you install
yourself and which run entirely on your machine:

- **yt-dlp** — works out where the media on a page actually lives.
- **ffmpeg** — joins separate video and audio tracks.

Torrent support uses **WebTorrent**, which connects to trackers and peers in the
normal way for BitTorrent. Your IP address is visible to peers in a swarm, as it
is with any torrent client. If that matters to you, do not use the torrent
feature, or route it through a VPN.

---

## Questions

Open an issue: <https://github.com/uncrownedprince786-collab/Fletch/issues>
