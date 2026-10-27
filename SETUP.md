<div align="center">
<img src="assets/icon.png" width="80" alt="Fletch">

# Fletch — setup on this laptop

</div>

Fletch is **already installed**, and it opens a short setup panel the first time
you start it. This page is the same thing in writing.

---

## 1. Installing

Run **`Fletch-Setup-1.0.2-x64.exe`** and accept the Windows admin prompt.

Every program that installs into `C:\Program Files` asks for that prompt —
IDM included. It is what lets the installer put Fletch somewhere all users
share, and register magnet links system-wide. The alternative, installing into
your own AppData, is what the earlier build did and is why magnet links broke
when that folder moved.

SmartScreen will also warn, because the build is unsigned: **More info → Run
anyway**. A signing certificate is a yearly cost this project does not have.

> **Remove the old copy first.** An earlier build installed itself to
> `C:\Users\NEW TECH\AppData\Local\Programs\Fletch`. Uninstall it from
> **Windows Settings → Apps → Fletch**, or you will have two.

| | |
|---|---|
| **Start it** | Desktop shortcut **Fletch**, or the Start menu |
| **Installed at** | `C:\Program Files\Fletch` |
| **Saves downloads to** | `C:\Users\NEW TECH\Downloads\Fletch` (change in Settings → General) |
| **Settings live in** | `C:\Users\NEW TECH\AppData\Roaming\Fletch` |

Closing the window leaves Fletch running in the tray so it can keep catching
links. Right-click the tray icon to quit properly.

**yt-dlp** and **ffmpeg** were already on this machine and Fletch found both, so
video works out of the box. Settings → Helpers shows them as *Ready*.

---

## 2. The browser extension

This is what makes it behave like IDM: click a download in the browser and
Fletch takes it.

Open Fletch and the setup panel does this for you — **Open Chrome** puts you on
the right page, and **Copy token** fills your clipboard. Or by hand:

1. Open **`chrome://extensions`** (or `edge://extensions`).
2. Turn on **Developer mode**, top right.
3. **Load unpacked** → pick:
   `C:\Program Files\Fletch\resources\extension`
4. On the **Fletch Capture** card: **Details → Extension options**.
5. Port `47809`, and the token from **Fletch → Settings → Browser**.
6. **Save and test** → *Paired. You are ready to capture.*

> Always copy the token from the app itself. It is regenerated if Fletch's
> settings are ever reset, and a stale one just fails to pair.

The extension talks only to `127.0.0.1`. The token stops any other page on your
machine from queueing downloads through it.

### Why doesn't the installer add it for me?

Because Chrome will not let it. Since Chrome 33, an extension that is not on
the Chrome Web Store cannot be installed by an outside program — not through
the registry, not from a `.crx`, not by any route short of a machine-wide
enterprise policy, which would stamp "Managed by your organization" across
every browser on the computer. Fletch will not do that to you.

IDM is in exactly the same position and solves it the same way: **its extension
is published on the Chrome Web Store.** Once Fletch Capture is published there
too, the installer can add it automatically and this step disappears.

Everything needed for that is ready — run `npm run pack:extension` and follow
[docs/EXTENSION.md](docs/EXTENSION.md). It is a one-off job: $5, a form, and a
few days of review.

Until then the first-run panel gets you as close as the browser permits: it
opens the right page and puts the token on your clipboard, leaving one
**Load unpacked** click.

---

## Magnet links

Clicking a magnet link anywhere on your system opens Fletch and starts the
torrent. The installer registers this for all users.

If magnets were pointing at an older copy of Fletch, this version repairs that
on launch — but only when the association names a Fletch. Another torrent
client's setting is left alone. To hand magnets back to a different client,
set it in **Windows Settings → Apps → Default apps**.

---

## 3. Using it

**Just click a download link.** With the extension paired, Chrome hands it to
Fletch and it downloads across 8 connections.

| | |
|---|---|
| Right-click a link, video or page | *Download with Fletch* |
| Extension popup | *Grab video from this page*, or pick from the media it spotted |
| Copy a link | Fletch offers it in the corner |
| Drag a link onto the window | Queues it |
| **Add link** button | Paste as many URLs as you like, one per line |
| A magnet link or `.torrent` | Paste it in, same as any other link |

Pause and resume anything — progress is on disk, so a pause, a crash or a
reboot carries on rather than starting over.

### Sites that need you logged in

Instagram, Facebook, X and private or age-restricted video only play when
signed in. **Settings → Browser → "Sign in as you, using your browser's
cookies"** → pick your browser. Fletch borrows that session and sends it only to
the site it came from. If it refuses to read them, close the browser first.

---

## 4. Updates

Fletch checks GitHub Releases shortly after launch and every few hours. When
there is a new version it tells you, asks before downloading, and asks again
before installing. **Settings → Updates** has a *Check now* button and an
on/off switch.

To publish one from this machine: set a `GH_TOKEN` and run `npm run release`.
The release target is in `package.json` under `build.publish` — change the
`owner` and `repo` there if you move it to a different account.

---

## 5. If something misbehaves

| Problem | What to do |
|---|---|
| A site's download breaks when Fletch takes it | Extension popup → untick **Catch downloads from this browser**, or add that file type to the exceptions in its options |
| Slow, or keeps reconnecting | Settings → Speed → lower **Connections per download**. Some servers only allow 2–3, and Fletch backs off on its own when they say so |
| Video has no sound | ffmpeg joins the two tracks. Settings → Helpers should show it **Ready** |
| A members-only or DRM video fails | Encrypted streams (Widevine, SAMPLE-AES) cannot be decrypted, by design |
| A torrent sits at "looking for peers" | The link may be dead, or your network may block peer traffic. Fletch gives up after 90s rather than hanging |
| SmartScreen warned on install | The installer is unsigned — a certificate costs money yearly. **More info → Run anyway** |

---

## 6. Uninstalling

Windows **Settings → Apps → Fletch → Uninstall**, or `Uninstall Fletch.exe` in
the install folder. Downloaded files are left alone.

---

## 7. Rebuilding it yourself

Everything lives in `C:\Users\NEW TECH\Documents\Fletch`.

```bash
npm start          # run from source
npm test           # 9 offline suites, no network needed
npm run test:live  # fetches real files from the internet
npm run dist:win   # rebuild the installer into release\
npm run release    # build and publish to GitHub Releases
```

### Does it run on a Mac?

The code is cross-platform and the Mac and Linux build targets are configured,
icons included. But a Mac build has to be made **on a Mac** — Apple's packaging
and signing tools only run there. On a Mac, `npm install && npm run dist` builds
a `.dmg`. Everything else behaves the same; the tray icon is a proper macOS
template image and the window follows macOS conventions.

That build has not been made or tested here, because this is a Windows machine.
