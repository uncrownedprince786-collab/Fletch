# Store listing copy

Ready-made answers for the Chrome Web Store and Edge Add-ons forms. Both take
the same zip from `npm run pack:extension`.

---

## Name

```
Fletch Capture
```

## Short description (132 characters max)

```
Send downloads and videos from your browser to the Fletch download manager, for multi-connection speed and resumable transfers.
```

## Detailed description

```
Fletch Capture is the browser half of Fletch, a free download manager for
Windows, macOS and Linux.

With Fletch running on your computer, this extension hands your downloads to it
instead of the browser's own downloader. Fletch then splits each file across
several connections at once, which is usually several times faster, and can
pause and resume without losing progress.

WHAT IT DOES

• Catches downloads you click, and sends them to Fletch
• Right-click any link, video or image to download it with Fletch
• Lists the media it spots on the page you are viewing, so you can grab a video
  the page does not offer a download for
• One click to pull the video from the current page, or just its audio
• Turn capture off at any time from the toolbar popup, per browsing session

WHAT YOU NEED

The Fletch desktop app, which is free and open source:
https://github.com/uncrownedprince786-collab/Fletch

The extension pairs with it over your own machine's loopback interface using a
token the app generates. It does nothing at all on its own.

PRIVACY

This extension sends links only to Fletch on 127.0.0.1, on your own computer.
It has no server, no analytics and no account. It never transmits page
contents, browsing history, cookies or credentials anywhere. The source is on
GitHub and can be read in full.
```

## Category

`Productivity` (Chrome) / `Productivity` (Edge)

---

## Permission justifications

Reviewers ask for these one by one.

| Permission | Why |
|---|---|
| `downloads` | To take over a download the user started in the browser and pass it to the Fletch app, then cancel the browser's copy so the file is not fetched twice. |
| `contextMenus` | To add "Download with Fletch" to the right-click menu for links, video, audio and images. |
| `storage` | To remember the port and pairing token for the local Fletch app, and the user's capture on/off preference. |
| `webRequest` | To notice media responses on the current tab so the popup can list videos a page offers no download link for. Observational only; nothing is blocked or modified. |
| `tabs` | To read the current tab's URL, so a page can be handed to Fletch for video extraction and the correct Referer can be sent. |
| `notifications` | To tell the user a download was caught, or that the Fletch app is not running. |
| `host_permissions: <all_urls>` | Media can appear on any site, so detection cannot be limited to a fixed list. No page content is read or sent. |
| `host_permissions: http://127.0.0.1/*` | The only destination the extension ever contacts: the Fletch app on the user's own machine. |

## Single purpose statement

```
Fletch Capture has one purpose: to pass downloadable links from the browser to
the Fletch download manager running on the same computer.
```

## Data usage disclosures

Tick **none** of the data collection categories. The truthful answers are:

- Does not collect or transmit personally identifiable information
- Does not collect health, financial or authentication information
- Does not collect personal communications or location
- Does not collect browsing activity
- Does not sell or transfer data to third parties
- Does not use data for anything unrelated to its single purpose
- Does not use data to determine creditworthiness or for lending

## Privacy policy URL

```
https://github.com/uncrownedprince786-collab/Fletch/blob/main/docs/PRIVACY.md
```
