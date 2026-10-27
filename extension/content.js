'use strict';

// Two jobs on every page:
//
//   1. Float a "Download this video" button over any video worth grabbing,
//      the way IDM does.
//   2. Catch clicks on magnet links and hand them to Fletch, instead of
//      letting the browser bounce the user through an "open which app?"
//      dialog and off to whatever torrent client is registered.
//
// Everything visible lives inside a shadow root, so no page stylesheet can
// bend it out of shape and nothing here leaks into the page.

const MIN_WIDTH = 240;
const MIN_HEIGHT = 135;
const EDGE = 8;

let settings = { showGrabber: true, takeover: true };
let host = null;
let root = null;
let bar = null;
let label = null;
let tracked = null;        // the <video> the button currently belongs to
let dismissed = new WeakSet();
let frame = 0;

chrome.storage.local.get({ showGrabber: true, takeover: true }, (s) => {
  settings = s;
  if (settings.showGrabber) start();
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.showGrabber) {
    settings.showGrabber = changes.showGrabber.newValue;
    if (!settings.showGrabber) hide();
  }
  if (changes.takeover) settings.takeover = changes.takeover.newValue;
});

// ---------------------------------------------------------------- the button

function build() {
  if (host) return;

  host = document.createElement('div');
  host.id = '__fletch_grabber__';
  // Nothing of the page's layout should shift because of us.
  host.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647';
  root = host.attachShadow({ mode: 'closed' });

  const style = document.createElement('style');
  style.textContent = `
    .bar {
      position: fixed;
      display: none;
      align-items: center;
      gap: 6px;
      padding: 6px 8px 6px 10px;
      border-radius: 9px;
      background: linear-gradient(135deg, #FFC24B, #FF7A33);
      color: #1A1005;
      font: 600 12.5px/1.2 'Segoe UI', system-ui, -apple-system, sans-serif;
      box-shadow: 0 4px 14px rgba(0,0,0,.35);
      cursor: pointer;
      user-select: none;
      opacity: 0;
      transition: opacity .14s ease;
      white-space: nowrap;
    }
    .bar.on { display: inline-flex; opacity: 1; }
    .bar:hover { filter: brightness(1.06); }
    .chev { width: 13px; height: 13px; flex: none; }
    .txt { pointer-events: none; }
    .x {
      margin-left: 2px; width: 17px; height: 17px; flex: none;
      border-radius: 5px; display: grid; place-items: center;
      font-size: 13px; line-height: 1; opacity: .65;
    }
    .x:hover { background: rgba(0,0,0,.16); opacity: 1; }
    .toast {
      position: fixed; right: 16px; bottom: 16px;
      padding: 10px 13px; border-radius: 10px;
      background: #171D26; color: #E8ECF3;
      font: 500 12.5px/1.4 'Segoe UI', system-ui, sans-serif;
      box-shadow: 0 8px 24px rgba(0,0,0,.45);
      border: 1px solid #2A3340;
      opacity: 0; transform: translateY(6px);
      transition: opacity .16s ease, transform .16s ease;
      pointer-events: none; max-width: 300px;
    }
    .toast.on { opacity: 1; transform: none; }
  `;

  bar = document.createElement('div');
  bar.className = 'bar';
  bar.title = 'Download this video with Fletch';

  const chev = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  chev.setAttribute('viewBox', '0 0 64 64');
  chev.setAttribute('class', 'chev');
  chev.innerHTML = '<g fill="none" stroke="#1A1005" stroke-width="7" stroke-linecap="round" '
    + 'stroke-linejoin="round"><path d="M13 18 L32 30 L51 18"/><path d="M19 30 L32 40 L45 30"/>'
    + '<path d="M25 41 L32 48 L39 41"/></g>';

  label = document.createElement('span');
  label.className = 'txt';
  label.textContent = 'Download this video';

  const close = document.createElement('span');
  close.className = 'x';
  close.textContent = '×';
  close.title = 'Hide for this video';
  close.addEventListener('click', (e) => {
    e.stopPropagation();
    if (tracked) dismissed.add(tracked);
    hide();
  });

  bar.append(chev, label, close);
  bar.addEventListener('click', grab);

  root.append(style, bar);
  document.documentElement.appendChild(host);
}

function hide() {
  if (bar) bar.classList.remove('on');
  tracked = null;
}

function toast(text) {
  if (!root) return;
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = text;
  root.appendChild(t);
  requestAnimationFrame(() => t.classList.add('on'));
  setTimeout(() => {
    t.classList.remove('on');
    setTimeout(() => t.remove(), 250);
  }, 2600);
}

// ---------------------------------------------------------------- finding video

/** The biggest video on screen that is actually worth offering to download. */
function bestVideo() {
  let best = null;
  let bestArea = 0;
  for (const v of document.querySelectorAll('video')) {
    if (dismissed.has(v)) continue;
    const r = v.getBoundingClientRect();
    if (r.width < MIN_WIDTH || r.height < MIN_HEIGHT) continue;
    // Must be at least partly on screen.
    if (r.bottom < 0 || r.top > window.innerHeight) continue;
    if (r.right < 0 || r.left > window.innerWidth) continue;
    const style = getComputedStyle(v);
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) < 0.1) continue;
    const area = r.width * r.height;
    if (area > bestArea) { bestArea = area; best = v; }
  }
  return best;
}

function place() {
  frame = 0;
  if (!settings.showGrabber) return hide();
  // The button would sit on top of the picture in fullscreen, which is the one
  // time nobody wants it.
  if (document.fullscreenElement) return hide();

  const video = bestVideo();
  if (!video) return hide();

  build();
  tracked = video;

  const r = video.getBoundingClientRect();
  bar.classList.add('on');
  const w = bar.offsetWidth || 190;
  const h = bar.offsetHeight || 30;

  // Above the top-right corner where there is room, otherwise just inside it.
  let top = r.top - h - EDGE;
  if (top < EDGE) top = r.top + EDGE;
  let left = r.right - w - EDGE;
  left = Math.max(EDGE, Math.min(left, window.innerWidth - w - EDGE));
  top = Math.max(EDGE, Math.min(top, window.innerHeight - h - EDGE));

  bar.style.top = `${Math.round(top)}px`;
  bar.style.left = `${Math.round(left)}px`;
}

function schedule() {
  if (frame) return;
  frame = requestAnimationFrame(place);
}

// ---------------------------------------------------------------- actions

// Permalink shapes for the feeds where the address bar says nothing useful.
const PERMALINK = [
  'a[href*="/status/"]',          // X / Twitter
  'a[href*="/reel/"]',            // Instagram, Facebook
  'a[href*="/p/"]',               // Instagram posts
  'a[href*="/videos/"]',
  'a[href*="/video/"]',
  'a[href*="/watch"]',            // Facebook, YouTube
  'a[href*="/posts/"]',
].join(',');

/**
 * The address of the post this video belongs to.
 *
 * On a feed, location.href is the feed — x.com/home tells an extractor
 * nothing, and it ends up following a redirect to a login page. The post's
 * own permalink is almost always sitting next to the video.
 */
function permalinkFor(video) {
  let node = video;
  for (let depth = 0; node && depth < 12; depth++) {
    const link = node.querySelector ? node.querySelector(PERMALINK) : null;
    if (link && link.href && /^https?:/i.test(link.href)) return link.href;
    node = node.parentElement;
  }
  return '';
}

/** A feed or app shell, where the current URL names no particular video. */
function isFeedUrl(href) {
  return /^https?:\/\/[^/]*(x\.com|twitter\.com)\/(home|explore|i\/|search|notifications)?$/i.test(href)
    || /\/(home|feed|explore|reels|for-you)\/?$/i.test(href)
    || /^https?:\/\/[^/]+\/?$/i.test(href);
}

function grab() {
  const video = tracked;
  label.textContent = 'Sending…';

  // A direct file src is worth sending as-is; a blob: or MSE source is not,
  // so a page URL goes instead and the app's extractor works it out.
  const src = video && video.currentSrc ? video.currentSrc : '';
  const direct = /^https?:\/\//i.test(src) && !/\.m3u8|\.mpd/i.test(src);

  // Prefer the post's own permalink over whatever the address bar happens to
  // be showing, which on a feed is not this video at all.
  const permalink = permalinkFor(video);
  const pageUrl = (permalink && (isFeedUrl(location.href) || permalink !== location.href))
    ? permalink
    : location.href;

  chrome.runtime.sendMessage({
    type: 'grab-video',
    payload: direct
      ? { url: src, headers: { Referer: location.href } }
      : { url: pageUrl, forceVideo: true },
  }, (reply) => {
    label.textContent = 'Download this video';
    if (reply && reply.ok) toast('Sent to Fletch.');
    else toast(reply && reply.reason ? reply.reason : 'Could not reach Fletch — is it running?');
  });
}

// ---------------------------------------------------------------- magnet links

document.addEventListener('click', (e) => {
  if (!settings.takeover) return;
  const link = e.target && e.target.closest ? e.target.closest('a[href^="magnet:"]') : null;
  if (!link) return;

  // Taking this ourselves avoids the browser's "open which application?"
  // prompt and whatever torrent client happens to be registered.
  e.preventDefault();
  e.stopPropagation();

  build();
  chrome.runtime.sendMessage({
    type: 'grab-magnet',
    payload: { url: link.href },
  }, (reply) => {
    if (reply && reply.ok) toast('Torrent sent to Fletch.');
    else toast(reply && reply.reason ? reply.reason : 'Could not reach Fletch — is it running?');
  });
}, true);

// ---------------------------------------------------------------- lifecycle

function start() {
  const watch = new MutationObserver(schedule);
  watch.observe(document.documentElement, { childList: true, subtree: true });

  addEventListener('scroll', schedule, { passive: true, capture: true });
  addEventListener('resize', schedule, { passive: true });
  addEventListener('fullscreenchange', schedule);
  // Single-page apps swap video without touching the DOM we are watching.
  setInterval(schedule, 1200);
  schedule();
}
