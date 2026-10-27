'use strict';

const $ = (s) => document.querySelector(s);

function shortName(url) {
  try {
    const u = new URL(url);
    const last = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || u.hostname);
    return last.length > 42 ? `${last.slice(0, 39)}…` : last;
  } catch { return url.slice(0, 42); }
}

function kindOf(item) {
  if (/mpegurl|m3u8/i.test(item.type + item.url)) return 'HLS stream';
  if (/dash\+xml|\.mpd/i.test(item.type + item.url)) return 'DASH stream';
  if (/^audio\//i.test(item.type)) return 'Audio';
  if (/^video\//i.test(item.type)) return 'Video';
  return 'Media';
}

chrome.runtime.sendMessage({ type: 'ping' }, (r) => {
  const s = $('#status');
  s.textContent = r && r.ok ? 'connected' : 'app not running';
  s.className = `status ${r && r.ok ? 'ok' : 'no'}`;
});

chrome.runtime.sendMessage({ type: 'list' }, (r) => {
  if (!r) return;

  $('#grab').onclick = () => {
    chrome.runtime.sendMessage({ type: 'send', payload: { url: r.page, forceVideo: true } });
    window.close();
  };
  $('#grabAudio').onclick = () => {
    chrome.runtime.sendMessage({ type: 'send', payload: { url: r.page, forceVideo: true, audioOnly: true } });
    window.close();
  };

  const list = $('#list');
  if (!r.items.length) return;
  list.replaceChildren();

  for (const item of r.items) {
    const b = document.createElement('button');
    b.className = 'item';
    const k = document.createElement('div');
    k.className = 'k';
    k.textContent = kindOf(item);
    const u = document.createElement('div');
    u.className = 'u';
    u.textContent = shortName(item.url);
    b.append(k, u);
    b.onclick = () => {
      chrome.runtime.sendMessage({
        type: 'send',
        payload: { url: item.url, headers: r.page ? { Referer: r.page } : {} },
      });
      window.close();
    };
    list.appendChild(b);
  }
});

// Quick on/off, for the occasional site that needs the browser to keep a download.
chrome.storage.local.get({ takeover: true }, ({ takeover }) => {
  $('#takeover').checked = takeover;
});
$('#takeover').onchange = (e) => {
  chrome.storage.local.set({ takeover: e.target.checked });
};

$('#opts').onclick = (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
};
