'use strict';

// Fletch Capture talks to one place only: the Fletch app on this machine,
// at 127.0.0.1, using a token the user pastes in once. It never sends a page,
// a cookie or a browsing record anywhere else.

const DEFAULTS = { port: 47809, token: '', takeover: true, skipExt: '' };

const MEDIA_RE = /\.(m3u8|mpd|mp4|webm|mkv|mov|avi|flv|m4v|ts|mp3|m4a|aac|ogg|opus|flac|wav)(\?|$)/i;
const MEDIA_TYPE_RE = /^(video|audio)\//i;

// Per-tab list of media URLs we have seen fly past, newest first.
const seen = new Map();

function config() {
  return new Promise((resolve) => chrome.storage.local.get(DEFAULTS, resolve));
}

async function send(payload, quiet = false) {
  const { port, token } = await config();
  if (!token) {
    if (!quiet) {
      notify('Fletch is not paired yet', 'Open the extension options and paste the pairing token from Fletch > Settings > Browser.');
      chrome.runtime.openOptionsPage();
    }
    return null;
  }
  try {
    const res = await fetch(`http://127.0.0.1:${port}/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
    });
    if (res.status === 401) {
      if (!quiet) notify('Fletch rejected the token', 'The pairing token has changed. Copy it again from Fletch > Settings > Browser.');
      return null;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const n = (data.added || []).length;
    if (!quiet) notify('Sent to Fletch', n === 1 ? (data.added[0].title || 'Queued.') : `${n} links queued.`);
    return data;
  } catch {
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

// URLs we handed back to Chrome because Fletch could not take them. Without
// this, re-issuing the download would trip this same listener forever.
const handingBack = new Set();

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
  const { takeover, skipExt } = await config();
  if (!takeover) return;

  const url = item.finalUrl || item.url || '';
  // blob:, data: and filesystem: URLs exist only inside the page; Fletch has
  // nothing it could re-request, so Chrome keeps those.
  if (!/^https?:\/\//i.test(url)) return;
  if (handingBack.has(url)) { handingBack.delete(url); return; }

  const skips = String(skipExt || '').split(/[,\s]+/).map((s) => s.trim().replace(/^\./, '').toLowerCase()).filter(Boolean);
  if (skips.length && skips.includes(extensionOf(url, item.filename))) return;

  try { await chrome.downloads.cancel(item.id); } catch { /* already finished */ }
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

  // Fletch is not running or not paired: put it back the way it was.
  handingBack.add(url);
  try {
    await chrome.downloads.download({ url });
    notify('Fletch is not running', 'Chrome is handling this download instead.');
  } catch {
    handingBack.delete(url);
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
