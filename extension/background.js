'use strict';

// Fletch Capture talks to one place only: the Fletch app on this machine,
// at 127.0.0.1, using a token the user pastes in once. It never sends a page,
// a cookie or a browsing record anywhere else.

const DEFAULTS = { port: 47809, token: '', takeover: true, skipExt: '' };

const MEDIA_RE = /\.(m3u8|mpd|mp4|webm|mkv|mov|avi|flv|m4v|ts|mp3|m4a|aac|ogg|opus|flac|wav)(\?|$)/i;
const MEDIA_TYPE_RE = /^(video|audio)\//i;

// Per-tab list of media URLs we have seen fly past, newest first.
const seen = new Map();

// Why the last send failed, so the page can say something true rather than
// blaming the app for being closed when it was actually the app that refused.
let lastSendError = '';

function config() {
  return new Promise((resolve) => chrome.storage.local.get(DEFAULTS, resolve));
}

/**
 * Pair with the Fletch app without troubling the user.
 *
 * The app recognises this extension by the id the browser gives it, which is
 * fixed by the public key in the manifest, and hands over the token on
 * request. Copying it across by hand is only a fallback now.
 */
// Chrome does not reliably attach an Origin to a fetch from a service worker,
// so the extension names itself here instead. A web page cannot set this
// header on a cross-origin request without a preflight the app refuses.
function identityHeaders() {
  return {
    'X-Fletch-Extension': chrome.runtime.id,
    // So the app can say when a browser is still running a withdrawn copy of
    // this extension: updating the app does not reload what the browser holds.
    'X-Fletch-Extension-Version': chrome.runtime.getManifest().version,
  };
}

/**
 * The cookies that would be sent to this exact URL, and nothing else.
 *
 * Fletch runs as its own program, so it arrives at every site as a stranger
 * even while the browser is signed in. Reading the browser's cookie store from
 * outside no longer works on current Chrome, which encrypts it on purpose, so
 * the extension — which is already inside the signed-in browser — passes along
 * the session for the one site being downloaded from.
 *
 * Deliberately narrow: chrome.cookies.getAll({ url }) returns only what that
 * URL itself would receive. No other site's cookies are read, and this runs
 * only when a download is started.
 */
async function collectCookies(url) {
  if (!/^https?:\/\//i.test(url || '')) return [];
  try {
    const list = await chrome.cookies.getAll({ url });
    return list.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path || '/',
      secure: Boolean(c.secure),
      hostOnly: Boolean(c.hostOnly),
      expires: c.expirationDate ? Math.floor(c.expirationDate) : 0,
    }));
  } catch {
    return []; // permission withheld, or an internal URL
  }
}

async function ensurePaired(force = false) {
  const { port, token } = await config();
  if (token && !force) return token;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/pair`, { headers: identityHeaders() });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.token) return null;
    await chrome.storage.local.set({ token: data.token, port: data.port || port });
    return data.token;
  } catch {
    return null; // app not running yet; we will try again on the next action
  }
}

chrome.runtime.onInstalled.addListener(() => { ensurePaired(); });
chrome.runtime.onStartup.addListener(() => { ensurePaired(); });

async function send(payload, quiet = false) {
  const cfg = await config();
  const port = cfg.port;
  const token = cfg.token || await ensurePaired();

  // Carry the signed-in session for the site being downloaded from, so Fletch
  // is not turned away at the door while the browser is logged in.
  if (cfg.shareCookies && payload && payload.url && !payload.cookies) {
    const cookies = await collectCookies(payload.url);
    if (cookies.length) payload = { ...payload, cookies };
  }
  if (!token) {
    lastSendError = 'not paired with Fletch';
    if (!quiet) {
      notify('Fletch is not running',
        'Start Fletch and try again. It pairs with this extension by itself.');
    }
    return null;
  }
  try {
    const res = await fetch(`http://127.0.0.1:${port}/add`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...identityHeaders(),
      },
      body: JSON.stringify(payload),
    });
    if (res.status === 401) {
      // The app regenerated its token. Pair again and retry once, rather than
      // sending the user off to copy a new one.
      const fresh = await ensurePaired(true);
      if (fresh) return send(payload, quiet);
      if (!quiet) notify('Fletch would not accept this', 'Try restarting Fletch.');
      return null;
    }
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json()).error || ''; } catch { /* no body */ }
      lastSendError = detail || `Fletch refused it (HTTP ${res.status})`;
      if (!quiet) notify('Fletch could not take that', lastSendError);
      return null;
    }
    lastSendError = '';
    const data = await res.json();
    const n = (data.added || []).length;
    if (!quiet) notify('Sent to Fletch', n === 1 ? (data.added[0].title || 'Queued.') : `${n} links queued.`);
    return data;
  } catch (err) {
    lastSendError = 'Fletch is not running';
    if (!quiet) notify('Could not reach Fletch', 'Make sure the Fletch app is running, then try again.');
    return null;
  }
}

function notify(title, message) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icon128.png',
    title,
    message: String(message || '').slice(0, 220),
  });
}

// ---------------------------------------------------------------- menus

function buildMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'link', title: 'Download with Fletch', contexts: ['link'],
    });
    chrome.contextMenus.create({
      id: 'media', title: 'Download this media with Fletch', contexts: ['video', 'audio', 'image'],
    });
    chrome.contextMenus.create({
      id: 'page', title: 'Grab video from this page', contexts: ['page'],
    });
    chrome.contextMenus.create({
      id: 'page-audio', title: 'Grab audio only from this page', contexts: ['page'],
    });
  });
}

chrome.runtime.onInstalled.addListener(buildMenus);
chrome.runtime.onStartup.addListener(buildMenus);

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const referer = tab && tab.url ? tab.url : '';
  if (info.menuItemId === 'link' && info.linkUrl) {
    send({ url: info.linkUrl, headers: referer ? { Referer: referer } : {} });
  } else if (info.menuItemId === 'media' && info.srcUrl) {
    send({ url: info.srcUrl, headers: referer ? { Referer: referer } : {} });
  } else if (info.menuItemId === 'page') {
    send({ url: info.pageUrl || referer, forceVideo: true });
  } else if (info.menuItemId === 'page-audio') {
    send({ url: info.pageUrl || referer, forceVideo: true, audioOnly: true });
  }
});

// ---------------------------------------------------------- download takeover

// Chrome replays downloads.onCreated for everything already in its download
// list when the browser starts. Arriving here is therefore no proof that a
// file is being fetched right now: the record of a download finished last week
// looks like a fresh one apart from its state and the time it began. Acting on
// one cancels nothing and fetches the whole history over again.
const FRESH_MS = 60 * 1000;

function isLiveDownload(item) {
  if (item.state !== 'in_progress') return false;
  const started = Date.parse(item.startTime || '');
  return !Number.isFinite(started) || Date.now() - started < FRESH_MS;
}

// URLs handed back to Chrome because Fletch could not take them. Kept in
// session storage rather than a variable: the service worker is stopped
// whenever it falls idle, and an entry forgotten that way means the hand-back
// is caught as if it were new and handed back again, without end. Entries
// expire instead of being removed on sight, so a redirect that changes the URL
// cannot slip past on the second pass either.
const HANDBACK_KEY = 'handedBack';
const HANDBACK_MS = 5 * 60 * 1000;

async function handedBackMap() {
  const stored = await chrome.storage.session.get(HANDBACK_KEY);
  const map = stored[HANDBACK_KEY] || {};
  const now = Date.now();
  for (const [url, at] of Object.entries(map)) {
    if (now - at > HANDBACK_MS) delete map[url];
  }
  return map;
}

async function wasHandedBack(urls) {
  const map = await handedBackMap();
  return urls.some((url) => map[url]);
}

async function markHandedBack(urls, mark = true) {
  const map = await handedBackMap();
  for (const url of urls) {
    if (mark) map[url] = Date.now();
    else delete map[url];
  }
  await chrome.storage.session.set({ [HANDBACK_KEY]: map });
}

// Nobody clicks ten downloads in a second. A burst on this scale means
// something upstream is wrong — a page script gone mad, a browser behaviour
// nobody has met yet — and the honest answer to not understanding what is
// happening is to stop touching it, not to act on all of it.
//
// This is deliberately not a fix for the history replay, which is handled
// above and tested. It is the ceiling that was missing when that went wrong:
// the net for the next fault, whatever it turns out to be. The cost of being
// wrong here is a handful of downloads that Chrome keeps for itself, which is
// the harmless direction.
const BURST_KEY = 'takeoverBurst';
const BURST_WINDOW_MS = 10 * 1000;
// Twelve in ten seconds. Set so that clicking a batch of links by hand is
// never caught, while the runaway that prompted this — which managed about
// two and a half files a second, for minutes — trips it within about five
// seconds of starting.
const BURST_LIMIT = 12;
const BURST_COOLDOWN_MS = 60 * 1000;

/**
 * Record this takeover and say whether the extension should stand down.
 *
 * Kept in session storage for the same reason as the hand-back record: a
 * counter in a variable is reset every time Chrome stops the idle service
 * worker, which is precisely when a runaway would be at its worst.
 */
async function burstTripped() {
  const now = Date.now();
  const stored = await chrome.storage.session.get(BURST_KEY);
  const state = stored[BURST_KEY] || { times: [], until: 0 };

  if (state.until > now) return true; // still standing down

  const times = (state.times || []).filter((t) => now - t < BURST_WINDOW_MS);
  times.push(now);

  const tripped = times.length > BURST_LIMIT;
  if (tripped) state.until = now + BURST_COOLDOWN_MS;
  state.times = times;
  await chrome.storage.session.set({ [BURST_KEY]: state });

  if (tripped) {
    notify('Fletch has stepped back',
      'Downloads were arriving faster than anyone could click. Your browser is handling them for the next minute.');
  }
  return tripped;
}

// Whether the app is up, asked before anything is cancelled so that a closed
// Fletch leaves the browser's own downloads alone entirely, rather than
// stopping each one and starting it again.
let appSeenAt = 0;
let appSeenOk = false;

async function appIsRunning() {
  if (Date.now() - appSeenAt < 5000) return appSeenOk;
  const { port } = await config();
  const signal = AbortSignal.timeout ? AbortSignal.timeout(1500) : undefined;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/ping`, { signal });
    appSeenOk = res.ok;
  } catch {
    appSeenOk = false;
  }
  appSeenAt = Date.now();
  return appSeenOk;
}

function extensionOf(url, filename) {
  const name = filename || (() => {
    try { return new URL(url).pathname.split('/').pop() || ''; } catch { return ''; }
  })();
  const dot = name.lastIndexOf('.');
  return dot > -1 ? name.slice(dot + 1).toLowerCase() : '';
}

/**
 * The IDM move: when Chrome starts a download, stop it and give it to Fletch
 * instead. Chrome is cancelled first so the file is never fetched twice; if
 * Fletch cannot be reached, the download is handed straight back to Chrome so
 * nothing is ever silently lost.
 */
chrome.downloads.onCreated.addListener(async (item) => {
  if (!isLiveDownload(item)) return;

  const { takeover, skipExt } = await config();
  if (!takeover) return;

  const url = item.finalUrl || item.url || '';
  // blob:, data: and filesystem: URLs exist only inside the page; Fletch has
  // nothing it could re-request, so Chrome keeps those.
  if (!/^https?:\/\//i.test(url)) return;

  // Both spellings: a redirect leaves the hand-back with a finalUrl that is
  // not the URL it was started with.
  const urls = [item.url, item.finalUrl].filter(Boolean);
  if (await wasHandedBack(urls)) return;

  const skips = String(skipExt || '').split(/[,\s]+/).map((s) => s.trim().replace(/^\./, '').toLowerCase()).filter(Boolean);
  if (skips.length && skips.includes(extensionOf(url, item.filename))) return;

  // Nothing to take over with: let Chrome get on with it untouched.
  if (!await appIsRunning()) return;

  // Too many, too fast to be a person: leave the rest to the browser.
  if (await burstTripped()) return;

  let cancelled = false;
  try { await chrome.downloads.cancel(item.id); cancelled = true; } catch { /* finished first */ }
  // It beat us to it and Chrome has the file. Taking it over now would only
  // fetch a second copy of something already on disk.
  if (!cancelled) return;
  try { await chrome.downloads.erase({ id: item.id }); } catch { /* already gone */ }

  const sent = await send({
    url,
    headers: item.referrer ? { Referer: item.referrer } : {},
    show: false,
  }, true);

  if (sent) {
    const name = (sent.added && sent.added[0] && sent.added[0].title) || 'Queued in Fletch.';
    notify('Caught by Fletch', name);
    return;
  }

  // Fletch answered the ping and then refused the download: put it back the
  // way it was.
  await markHandedBack(urls);
  try {
    await chrome.downloads.download({ url });
    notify('Fletch could not take that', 'Chrome is handling this download instead.');
  } catch {
    await markHandedBack(urls, false);
    notify('Download could not be started', url.slice(0, 120));
  }
});

// ---------------------------------------------------------------- sniffing

function remember(tabId, url, type) {
  if (tabId < 0) return;
  const list = seen.get(tabId) || [];
  if (list.some((x) => x.url === url)) return;
  list.unshift({ url, type: type || '', at: Date.now() });
  seen.set(tabId, list.slice(0, 40));
  chrome.action.setBadgeText({ tabId, text: String(Math.min(99, list.length)) });
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#FF9A2E' });
}

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    const header = (details.responseHeaders || [])
      .find((h) => h.name.toLowerCase() === 'content-type');
    const type = header ? header.value : '';
    if (MEDIA_TYPE_RE.test(type) || /mpegurl|dash\+xml/i.test(type) || MEDIA_RE.test(details.url)) {
      // Ad and tracking pixels masquerade as media often enough to be worth skipping.
      if (/\/(ads?|beacon|pixel|analytics)\//i.test(details.url)) return;
      remember(details.tabId, details.url, type);
    }
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

chrome.tabs.onRemoved.addListener((tabId) => seen.delete(tabId));
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading' && info.url) {
    seen.delete(tabId);
    chrome.action.setBadgeText({ tabId, text: '' });
  }
});

// ---------------------------------------------------------------- popup API

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.type === 'list') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      reply({ items: (tab && seen.get(tab.id)) || [], page: tab ? tab.url : '', title: tab ? tab.title : '' });
    });
    return true;
  }
  if (msg.type === 'send') {
    send(msg.payload).then((r) => reply({ ok: Boolean(r) }));
    return true;
  }
  // From the in-page grabber button and the magnet-link handler. Quiet: the
  // content script shows its own feedback in the corner of the page.
  if (msg.type === 'grab-video' || msg.type === 'grab-magnet') {
    lastSendError = '';
    send({ ...msg.payload, show: false }, true)
      .then((r) => reply({ ok: Boolean(r), reason: r ? '' : lastSendError }));
    return true;
  }
  if (msg.type === 'ping') {
    config().then(async ({ port }) => {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/ping`);
        reply({ ok: res.ok });
      } catch { reply({ ok: false }); }
    });
    return true;
  }
  return false;
});
