# The browser extension

**Fletch Capture** is what makes Fletch behave like IDM: click a download in
your browser and it comes to Fletch instead of the browser's own downloader.

- **Extension ID:** `lmaaeoobpbmcgnaelmpakgnhbhaoejim`
- **Folder:** `resources/extension` inside the installed app, or `extension/` in
  this repository
- **Works in:** Chrome, Edge, Brave, and other Chromium browsers

---

## Can it install itself automatically?

**Not yet, and it is worth being precise about why.**

Chrome has refused to silently install extensions that are not on the Chrome Web
Store since Chrome 33. That applies to every method an installer might use:

| Method | Works? |
|---|---|
| `HKLM\Software\Google\Chrome\Extensions\<id>` with a local `.crx` | **No.** Chrome disables it as "not from the Chrome Web Store". |
| Same key with an `update_url` pointing at the Web Store | **Yes** — but only once the extension is published there. |
| `--load-extension` on the command line | Only for that one browser session, and Chrome flags it. |
| Enterprise policy (`ExtensionInstallForcelist`) | Technically yes, but it is a machine-wide security policy that puts "Managed by your organization" in every user's browser. Fletch will not do that to you. |

IDM is in the same position, and solves it the same way: **its extension is on
the Chrome Web Store.** Publishing is what turns this from two clicks into zero.

So Fletch does the most it legitimately can:

1. The installer places the extension inside the app, at a stable path.
2. On first launch Fletch opens your browser's extensions page for you, shows
   the exact folder, and puts the pairing token on your clipboard.

That leaves you one **Load unpacked** away, rather than hunting for anything.

---

## Publishing it, so installs become automatic

A one-off job. After this, new users get the extension without touching
`chrome://extensions`.

### 1. Build the upload package

```bash
npm run pack:extension
```

That writes `release/fletch-extension-<version>.zip`.

### 2. Upload it

- **Chrome Web Store:** <https://chrome.google.com/webstore/devconsole> — one-off
  $5 developer registration, review usually takes a few days.
- **Edge Add-ons:** <https://partner.microsoft.com/dashboard/microsoftedge> —
  free, and it accepts the same zip.

Fill in the listing from `docs/STORE-LISTING.md`, which has the description,
permission justifications and privacy answers already written.

### 3. Switch the installer on

Once published, the store gives you a real extension ID. Put it in
`package.json`:

```json
"fletch": { "chromeExtensionId": "<the id the store gave you>" }
```

and add this to `build/installer.nsh`, inside `customInstall`:

```nsis
WriteRegStr HKLM "Software\Google\Chrome\Extensions\<the id>" "update_url" \
  "https://clients2.google.com/service/update2/crx"
WriteRegStr HKLM "Software\Microsoft\Edge\Extensions\<the id>" "update_url" \
  "https://edge.microsoft.com/extensionwebstorebase/v1/crx"
```

Chrome and Edge pick it up the next time they start, and the user is asked once
to enable it. That is as automatic as either browser allows.

---

## Loading it by hand (what to tell testers today)

1. Open `chrome://extensions` (or `edge://extensions`).
2. Turn on **Developer mode**, top right.
3. **Load unpacked**, and choose the folder Fletch shows you on first launch —
   normally `C:\Program Files\Fletch\resources\extension`.
4. On the **Fletch Capture** card: **Details → Extension options**.
5. Port `47809` and the token from **Fletch → Settings → Browser**.
6. **Save and test** → *Paired. You are ready to capture.*

---

## What it can see, and what it sends

The extension asks for broad host access because it watches for media on
whatever page you are on. It is worth knowing exactly what that means:

- It sends links **only** to `http://127.0.0.1:47809`, on your own machine.
- Every request carries a token that Fletch generated locally. Without it the
  app refuses the request, so no web page can queue downloads through it.
- It never sends page contents, browsing history, cookies or credentials
  anywhere. There is no analytics and no remote server.
- `downloads` permission is what lets it take a download over from Chrome. If
  Fletch is not running, the download is handed straight back, so nothing is
  lost.

Turn takeover off any time from the extension popup.
