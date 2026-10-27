'use strict';

const $ = (s) => document.querySelector(s);

chrome.storage.local.get({ port: 47809, token: '', takeover: true, skipExt: '' }, (cfg) => {
  $('#port').value = cfg.port;
  $('#token').value = cfg.token;
  $('#takeover').checked = cfg.takeover;
  $('#skipExt').value = cfg.skipExt;
});

function say(text, ok) {
  const m = $('#msg');
  m.textContent = text;
  m.className = `msg ${ok === undefined ? '' : ok ? 'ok' : 'no'}`;
}

$('#save').onclick = async () => {
  const port = Number($('#port').value) || 47809;
  const token = $('#token').value.trim();
  const takeover = $('#takeover').checked;
  const skipExt = $('#skipExt').value.trim();
  await chrome.storage.local.set({ port, token, takeover, skipExt });
  say('Saved. Checking…');

  try {
    const ping = await fetch(`http://127.0.0.1:${port}/ping`);
    if (!ping.ok) throw new Error('no answer');
  } catch {
    say('Saved, but Fletch is not answering on that port. Is the app running?', false);
    return;
  }

  if (!token) { say('Saved. Add the token to finish pairing.', false); return; }

  // A status call is the cheapest way to prove the token is the right one.
  try {
    const res = await fetch(`http://127.0.0.1:${port}/status`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 401) say('Fletch is running, but that token is not right.', false);
    else if (res.ok) say('Paired. You are ready to capture.', true);
    else say(`Unexpected answer from Fletch (HTTP ${res.status}).`, false);
  } catch {
    say('Could not reach Fletch.', false);
  }
};
