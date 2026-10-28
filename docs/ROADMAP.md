# Roadmap

Not a backlog of everything imaginable — four things worth doing next, written
down so they are not lost between sessions. Recorded 2026-10-28, after 1.2.7.

## 1. Links that worked a minute ago and then stop

**The symptom.** A download sits on "Reconnecting (attempt 5)" with nothing in
the temp file. The server accepts the connection and sends nothing.

**What is actually happening.** Most file hosts hand out an address signed for
a short window and often tied to the session or IP that asked for it. Fletch
runs as its own program, so it arrives at the host as a stranger even while the
browser is signed in: one stream per session, and the stranger is refused.

**What exists already and is not being used.** The add-on can pass the cookies
for the one site being downloaded from — *Let Fletch use your session for sites
you download from*, off by default — and the app has `cookiesFromBrowser`. Both
were off on the machine where this was first seen, which is probably the single
most common cause of this complaint.

**Worth building:**

- Turn session sharing on by default, or offer it the first time a download
  from a signed-in site fails. It is the fix, and nobody finds it.
- When a download fails having received nothing, re-resolve the page through
  yt-dlp for a fresh address and retry once before giving up. A dead signed URL
  is not a dead download.
- Say which of the three it was — expired, refused, or rate-limited — rather
  than reporting a bare network error. The user cannot act on "reconnecting".

## 2. Social video: Instagram, TikTok, Facebook, X

The sites people actually ask for, and what services like save.net exist to do.

yt-dlp already handles most of them, so this is not an extractor problem — it
is a session and interface problem:

- Most of these need a signed-in session for anything but public posts, which
  lands back on item 1.
- The grabber already finds the post a video belongs to in a feed. That part
  works and is tested; what is missing is handling the cases where the page
  gives nothing away and the extractor has to be asked directly.
- Decide what happens with a carousel or a thread containing several videos.
  Picking one silently is the kind of confident wrongness that caused the
  YouTube sidebar bug.

## 3. The interface

Make it sleek, and show the user only what they need.

- **Fewer popups.** Toasts, dialogs and the first-run walkthrough have
  accumulated. Work out which of them a person needs to see once, which belong
  in a quiet corner, and which should not exist.
- Default to the few things that matter and keep the rest behind something.
  Settings has five tabs; most people will touch one.
- The update screen and the add-on bar were both added quickly and work, but
  they were designed under pressure rather than deliberately.

## 4. Weight

Measured on 2026-10-28, with four Fletch processes and a download running:

| | |
|---|---|
| Working set | 447 MB |
| Private bytes | 320 MB |
| Installed size | 294 MB |

Ordinary for Electron, and not light — but memory turned out to be the wrong
thing to measure. What was meant by light is CPU: not making the machine work
when nothing is happening.

On that, measured over 30 seconds with the window open and nothing downloading:

| | |
|---|---|
| CPU used | 0.00 seconds |
| Share of one core | 0.00% |

So the app itself is already idle when idle, and there is nothing to fix here.

The one place still worth a look is not the app but the add-on: its content
script runs on every page, holding a MutationObserver over the whole document
and a timer every 1.2 seconds to keep the grabber button positioned. That cost
is paid in the browser, on every open tab, whether or not a video is there —
and it is the only thing in the project that does work on a schedule nobody
asked for. Measure it on a heavy page before deciding it matters.
