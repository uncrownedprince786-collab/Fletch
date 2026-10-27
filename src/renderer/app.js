'use strict';
/* global fletch */

// ---------------------------------------------------------------- helpers

const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

function bytes(n) {
  if (!Number.isFinite(n) || n < 0) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
}

function duration(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '—';
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

const CATEGORY_ICON = {
  video: '▶', audio: '♪', documents: '▤', archives: '▦',
  // Up and down together: a torrent both takes and gives.
  programs: '⚙', images: '▣', torrents: '⇅', other: '●',
};

const STATE_LABEL = {
  analyzing: 'Reading', queued: 'Queued', running: 'Downloading',
  paused: 'Paused', done: 'Finished', error: 'Failed', cancelled: 'Cancelled',
};

// ---------------------------------------------------------------- state

const state = {
  tasks: [],
  stats: { speed: 0, active: 0, queued: 0 },
  filter: 'all',
  search: '',
  settings: {},
  history: new Array(70).fill(0),
  seenClipboard: new Set(),
};

// ---------------------------------------------------------------- nav

const FILTERS = [
  { id: 'all', label: 'All downloads', icon: '≡' },
  { id: 'running', label: 'Active', icon: '↓' },
  { id: 'queued', label: 'Queued', icon: '○' },
  { id: 'paused', label: 'Paused', icon: '‖' },
  { id: 'done', label: 'Finished', icon: '✓' },
  { id: 'error', label: 'Failed', icon: '⚠' },
];

const CATEGORIES = [
  { id: 'cat:video', label: 'Video', icon: CATEGORY_ICON.video },
  { id: 'cat:audio', label: 'Audio', icon: CATEGORY_ICON.audio },
  { id: 'cat:documents', label: 'Documents', icon: CATEGORY_ICON.documents },
  { id: 'cat:programs', label: 'Programs', icon: CATEGORY_ICON.programs },
  { id: 'cat:archives', label: 'Archives', icon: CATEGORY_ICON.archives },
  { id: 'cat:images', label: 'Images', icon: CATEGORY_ICON.images },
  { id: 'cat:torrents', label: 'Torrents', icon: CATEGORY_ICON.torrents },
];

function matchesFilter(task, filter) {
  if (filter === 'all') return true;
  if (filter.startsWith('cat:')) return task.category === filter.slice(4);
  if (filter === 'running') return task.state === 'running' || task.state === 'analyzing';
  return task.state === filter;
}

function renderNav() {
  const nav = $('#nav');
  nav.replaceChildren();

  const section = (title, items) => {
    if (title) nav.appendChild(el('h4', null, title));
    for (const item of items) {
      const b = el('button', state.filter === item.id ? 'on' : '');
      b.appendChild(el('span', 'ico', item.icon));
      b.appendChild(el('span', null, item.label));
      const n = state.tasks.filter((t) => matchesFilter(t, item.id)).length;
      if (n) b.appendChild(el('span', 'count', String(n)));
      b.onclick = () => { state.filter = item.id; render(); };
      nav.appendChild(b);
    }
  };

  section(null, FILTERS);
  section('Categories', CATEGORIES);
}

// ---------------------------------------------------------------- list

function segmentBar(task) {
  const track = el('div', 'track');
  const segs = Array.isArray(task.segments) && task.segments.length
    ? task.segments
    : [{ done: task.progress || 0, start: 0, end: 1 }];

  // Blocks are sized by how much of the whole each connection owns, so the bar
  // is a true picture of the file rather than a single averaged percentage.
  // The spans are measured in whatever unit the engine reports — bytes for a
  // file, segment counts for a stream — so the total comes from the spans
  // themselves rather than from the file size.
  const spans = segs.map((s) => Math.max(1, (s.end - s.start) + 1));
  const total = spans.reduce((a, n) => a + n, 0) || 1;

  segs.forEach((s, i) => {
    const block = el('div', 'seg');
    block.style.flex = `${spans[i] / total}`;
    const fill = el('i');
    fill.style.width = `${Math.max(0, Math.min(1, s.done || 0)) * 100}%`;
    block.appendChild(fill);
    track.appendChild(block);
  });
  return track;
}

function renderItem(task) {
  const item = el('div', `item ${task.state}`);
  item.dataset.id = task.id;

  // thumbnail
  const thumb = el('div', 'thumb');
  if (task.thumbnail) {
    const img = el('img');
    img.src = task.thumbnail;
    img.referrerPolicy = 'no-referrer';
    img.onerror = () => { thumb.replaceChildren(document.createTextNode(CATEGORY_ICON[task.category] || '●')); };
    thumb.appendChild(img);
  } else {
    thumb.textContent = CATEGORY_ICON[task.category] || '●';
  }
  item.appendChild(thumb);

  // body
  const body = el('div', 'body');
  body.appendChild(el('div', 'title', task.title || task.filename || task.sourceUrl));

  const sub = el('div', 'sub');
  if (task.uploader) { sub.appendChild(el('span', null, task.uploader)); sub.appendChild(el('span', 'dot', '·')); }
  if (task.duration) { sub.appendChild(el('span', null, duration(task.duration))); sub.appendChild(el('span', 'dot', '·')); }
  sub.appendChild(el('span', null, task.filename || ''));
  if (task.formatLabel) sub.appendChild(el('span', 'tagx', task.formatLabel));
  if (task.engine === 'hls') sub.appendChild(el('span', 'tagx', 'HLS'));
  body.appendChild(sub);

  body.appendChild(segmentBar(task));

  // meta line
  const meta = el('div', 'meta');
  const stateLabel = el('span', `state ${task.state}`, STATE_LABEL[task.state] || task.state);
  meta.appendChild(stateLabel);

  if (task.state === 'error') {
    meta.appendChild(el('span', 'err', task.error || 'Something went wrong.'));
  } else if (task.stage) {
    meta.appendChild(el('span', null, task.stage));
  } else {
    const pct = Math.round((task.progress || 0) * 100);
    const sizeText = task.size ? `${bytes(task.downloaded)} of ${bytes(task.size)}` : bytes(task.downloaded);
    meta.appendChild(el('span', null, `${pct}%`));
    meta.appendChild(el('span', 'dot', '·'));
    meta.appendChild(el('span', null, sizeText));
    if (task.state === 'running') {
      meta.appendChild(el('span', 'dot', '·'));
      const sp = el('span');
      sp.appendChild(el('b', null, `${bytes(task.speed)}/s`));
      meta.appendChild(sp);
      if (task.connections > 1) {
        meta.appendChild(el('span', 'dot', '·'));
        meta.appendChild(el('span', null, `${task.connections} connections`));
      }
      if (task.eta != null) {
        meta.appendChild(el('span', 'dot', '·'));
        meta.appendChild(el('span', null, `${duration(task.eta)} left`));
      }
    }
    if (task.note) { meta.appendChild(el('span', 'dot', '·')); meta.appendChild(el('span', null, task.note)); }
  }
  body.appendChild(meta);
  item.appendChild(body);

  // actions
  const actions = el('div', 'actions');
  const act = (glyph, title, fn, cls) => {
    const b = el('button', `iconbtn ${cls || ''}`, glyph);
    b.title = title;
    b.onclick = (e) => { e.stopPropagation(); fn(); };
    actions.appendChild(b);
  };

  if (task.state === 'running' || task.state === 'queued' || task.state === 'analyzing') {
    act('‖', 'Pause', () => fletch.tasks.pause(task.id));
  } else if (task.state === 'paused' || task.state === 'cancelled') {
    act('▶', 'Resume', () => fletch.tasks.resume(task.id));
  } else if (task.state === 'error') {
    act('↻', 'Try again', () => fletch.tasks.retry(task.id));
  } else if (task.state === 'done') {
    act('▶', 'Open file', async () => {
      const r = await fletch.file.open(task.id);
      if (!r.ok) toast('Could not open it', r.error, 'bad');
    });
  }

  if (task.availableFormats && task.availableFormats.length) {
    act('⚙', 'Pick a different quality', () => formatDialog(task));
  }
  act('⌂', 'Show in folder', async () => {
    const r = await fletch.file.reveal(task.id);
    if (!r.ok) toast('Could not find it', r.error, 'bad');
  });
  act('✕', 'Remove from list', () => removeDialog(task), 'danger');

  item.appendChild(actions);
  return item;
}

function render() {
  renderNav();
  const list = $('#list');
  const q = state.search.toLowerCase();
  const visible = state.tasks.filter(
    (t) => matchesFilter(t, state.filter)
      && (!q || `${t.title} ${t.filename} ${t.sourceUrl} ${t.uploader}`.toLowerCase().includes(q))
  );

  if (!visible.length) {
    list.replaceChildren(emptyState());
    return;
  }

  // Patch in place where we can: a full rebuild every 400ms would fight the
  // user's scroll position and kill the progress-bar transitions.
  const existing = new Map([...list.children].map((c) => [c.dataset.id, c]));
  const next = document.createDocumentFragment();
  for (const task of visible) {
    next.appendChild(renderItem(task));
    existing.delete(task.id);
  }
  list.replaceChildren(next);
}

function emptyState() {
  const wrap = el('div', 'empty');
  wrap.innerHTML = `
    <svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="4"
         stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M15 17 L32 34 L49 17"/><path d="M20.5 29 L32 40.5 L43.5 29"/>
      <path d="M26 41 L32 47 L38 41"/>
    </svg>`;
  const titles = {
    all: ['Nothing here yet', 'Paste a link, drop one on the window, or copy a video URL and Fletch will offer to grab it.'],
    running: ['Nothing downloading', 'Anything you start will show up here with its connections and speed.'],
    queued: ['Nothing waiting', 'Links beyond the concurrent limit queue up here.'],
    paused: ['Nothing paused', 'Paused downloads keep their progress and resume where they stopped.'],
    done: ['Nothing finished yet', 'Completed downloads collect here until you clear them.'],
    error: ['No failures', 'Anything that goes wrong lands here with the reason why.'],
  };
  const [h, p] = titles[state.filter] || ['Nothing in this category', 'Downloads are filed by type as they finish.'];
  wrap.appendChild(el('h3', null, h));
  wrap.appendChild(el('p', null, p));
  if (state.filter === 'all') {
    const b = el('button', 'btn primary', 'Add a link');
    b.onclick = addDialog;
    wrap.appendChild(b);
  }
  return wrap;
}

// ---------------------------------------------------------------- gauge

function renderGauge() {
  $('#gaugeSpeed').textContent = `${bytes(state.stats.speed)}/s`;
  const { active, queued } = state.stats;
  $('#gaugeLabel').textContent = active
    ? `${active} downloading${queued ? `, ${queued} queued` : ''}`
    : (queued ? `${queued} queued` : 'idle');

  const c = $('#spark');
  const ctx = c.getContext('2d');
  const w = c.width;
  const h = c.height;
  ctx.clearRect(0, 0, w, h);

  const peak = Math.max(1, ...state.history);
  const step = w / (state.history.length - 1);

  ctx.beginPath();
  ctx.moveTo(0, h);
  state.history.forEach((v, i) => ctx.lineTo(i * step, h - (v / peak) * (h - 4) - 2));
  ctx.lineTo(w, h);
  ctx.closePath();
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, 'rgba(255,154,46,0.45)');
  grad.addColorStop(1, 'rgba(255,154,46,0.02)');
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.beginPath();
  state.history.forEach((v, i) => {
    const y = h - (v / peak) * (h - 4) - 2;
    i ? ctx.lineTo(i * step, y) : ctx.moveTo(0, y);
  });
  ctx.strokeStyle = '#FFB020';
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

// ---------------------------------------------------------------- toasts

function toast(title, detail, kind, actions) {
  const host = $('#toasts');
  const t = el('div', `toast ${kind || ''}`);
  t.appendChild(el('div', 't', title));
  if (detail) t.appendChild(el('div', 'd', detail));

  const close = () => { t.style.opacity = '0'; setTimeout(() => t.remove(), 180); };
  if (actions && actions.length) {
    const row = el('div', 'acts');
    for (const a of actions) {
      const b = el('button', `btn sm ${a.primary ? 'primary' : ''}`, a.label);
      b.onclick = () => { close(); a.onClick(); };
      row.appendChild(b);
    }
    const dismiss = el('button', 'btn sm ghost', 'Ignore');
    dismiss.onclick = close;
    row.appendChild(dismiss);
    t.appendChild(row);
  } else {
    setTimeout(close, 5200);
  }
  host.appendChild(t);
  return t;
}

// ---------------------------------------------------------------- modals

function modal(title, buildContent, buttons, wide) {
  const host = $('#modalHost');
  const scrim = el('div', 'scrim');
  const box = el('div', `modal ${wide ? 'wide' : ''}`);

  const head = el('header');
  head.appendChild(el('h2', null, title));
  box.appendChild(head);

  const content = el('div', 'content');
  box.appendChild(content);

  const close = () => { scrim.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);

  const foot = el('footer');
  for (const b of buttons || []) {
    const btn = el('button', `btn ${b.primary ? 'primary' : ''}`, b.label);
    btn.onclick = () => b.onClick(close, content);
    foot.appendChild(btn);
  }
  if (buttons && buttons.length) box.appendChild(foot);

  buildContent(content, close);
  scrim.appendChild(box);
  scrim.onclick = (e) => { if (e.target === scrim) close(); };
  host.appendChild(scrim);
  return { close, content };
}

function addDialog(prefill) {
  let area;
  modal('Add links', (c) => {
    const f = el('label', 'field');
    f.appendChild(el('span', 'lab', 'Paste one link per line'));
    area = el('textarea', 'input');
    area.placeholder = 'https://example.com/file.zip\nhttps://www.youtube.com/watch?v=…';
    area.value = prefill || '';
    f.appendChild(area);
    f.appendChild(el('span', 'hint',
      'Direct files download with multiple connections. A page link is handed to the extractor, which finds the video on it.'));
    c.appendChild(f);

    const row = el('div', 'row2');

    const qf = el('label', 'field');
    qf.appendChild(el('span', 'lab', 'Maximum quality'));
    const q = el('select', 'input');
    for (const [v, t] of [[0, 'Best available'], [2160, 'Up to 4K'], [1080, 'Up to 1080p'], [720, 'Up to 720p'], [480, 'Up to 480p']]) {
      const o = el('option', null, t);
      o.value = String(v);
      if (Number(state.settings.maxHeight || 0) === v) o.selected = true;
      q.appendChild(o);
    }
    qf.appendChild(q);
    row.appendChild(qf);

    const af = el('label', 'field');
    af.appendChild(el('span', 'lab', 'What to save'));
    const a = el('select', 'input');
    a.appendChild(Object.assign(el('option', null, 'Video with sound'), { value: 'video' }));
    a.appendChild(Object.assign(el('option', null, 'Audio only'), { value: 'audio' }));
    af.appendChild(a);
    row.appendChild(af);

    c.appendChild(row);
    c.dataset.ready = '1';
    c._quality = q;
    c._audio = a;
    setTimeout(() => area.focus(), 50);
  }, [
    { label: 'Cancel', onClick: (close) => close() },
    {
      label: 'Download',
      primary: true,
      onClick: async (close, content) => {
        const urls = area.value.split(/\s+/).map((s) => s.trim()).filter(Boolean);
        if (!urls.length) return close();
        close();
        const r = await fletch.tasks.addMany(urls, {
          maxHeight: Number(content._quality.value) || 0,
          audioOnly: content._audio.value === 'audio',
        });
        if (r.ok && r.data.failed.length) {
          toast(`${r.data.failed.length} link${r.data.failed.length > 1 ? 's' : ''} could not be added`,
            r.data.failed[0].error, 'bad');
        }
      },
    },
  ]);
}

function removeDialog(task) {
  const finished = task.state === 'done';
  modal('Remove download', (c) => {
    c.appendChild(el('p', null,
      finished
        ? 'Take this out of the list. The downloaded file stays on disk unless you say otherwise.'
        : 'Stop this download and take it out of the list. Any partial data is discarded.'));
    if (finished) {
      const wrap = el('label', 'check');
      wrap.style.marginTop = '14px';
      const cb = el('input');
      cb.type = 'checkbox';
      wrap.appendChild(cb);
      const t = el('div');
      t.appendChild(el('div', 'lab', 'Also delete the file from disk'));
      t.appendChild(el('div', 'hint', task.filePath || ''));
      wrap.appendChild(t);
      c.appendChild(wrap);
      c._cb = cb;
    }
  }, [
    { label: 'Keep it', onClick: (close) => close() },
    {
      label: 'Remove',
      primary: true,
      onClick: (close, content) => {
        close();
        fletch.tasks.remove(task.id, Boolean(content._cb && content._cb.checked));
      },
    },
  ]);
}

function formatDialog(task) {
  modal(`Quality for “${task.title}”`, (c) => {
    const list = (task.availableFormats || [])
      .slice()
      .sort((a, b) => (b.height || 0) - (a.height || 0));
    if (!list.length) { c.appendChild(el('p', null, 'No alternative formats were offered for this item.')); return; }
    c.appendChild(el('p', null, 'Pick a stream and Fletch will fetch that one instead. The current download is replaced.'));
    const holder = el('div');
    holder.style.marginTop = '14px';
    for (const f of list) {
      const row = el('div', 'fmt');
      row.appendChild(el('div', 'res', f.height ? `${f.height}p` : (f.hasAudio && !f.hasVideo ? 'Audio' : '—')));
      row.appendChild(el('div', 'meta2', `${f.label}${f.size ? ` · ${bytes(f.size)}` : ''}`));
      row.onclick = async () => {
        const r = await fletch.tasks.chooseFormat(task.id, f.id);
        if (!r.ok) toast('Could not switch format', r.error, 'bad');
        document.querySelector('.scrim')?.remove();
      };
      holder.appendChild(row);
    }
    c.appendChild(holder);
  }, [{ label: 'Close', onClick: (close) => close() }], true);
}

// ---------------------------------------------------------------- updates

let lastUpdateState = '';

/**
 * The browser is holding an older add-on than this Fletch ships.
 *
 * A bar rather than a blocking screen: the app itself is fine, and the thing
 * that needs doing is in the browser, where Fletch has no reach. It stays put
 * until the add-on actually reports a current version, so it cannot be
 * dismissed into being forgotten — but it never stops anyone using Fletch.
 */
function renderExtensionBanner(show) {
  let bar = document.getElementById('extbar');
  if (!show) {
    if (bar) bar.remove();
    return;
  }
  if (bar) return;

  bar = el('div');
  bar.id = 'extbar';
  bar.appendChild(el('span', 'what',
    'Your browser is still running the previous Fletch add-on. Reload it there, or restart your browser, and downloads will be caught again.'));

  const open = el('button', 'btn sm primary', 'Open the extensions page');
  open.onclick = () => fletch.setup.openExtensionsPage('chrome');
  bar.appendChild(open);

  // For the case the reload cannot fix: an add-on loaded from a folder of
  // their own, which updating Fletch never touched. This is where the current
  // files are.
  const folder = el('button', 'btn sm', 'Show the add-on folder');
  folder.onclick = () => fletch.setup.openExtensionFolder();
  bar.appendChild(folder);

  document.body.appendChild(bar);
}

/**
 * The one screen Fletch will not let you past.
 *
 * Every other update is an offer: Fletch asks before spending bandwidth and
 * asks again before replacing itself. This is the exception, and it exists
 * because of a version that filled people's Downloads folders — when carrying
 * on is the harmful option, the choice is no kindness.
 *
 * It covers two separate repairs, because the app and the extension are two
 * separate installations. Updating Fletch leaves the browser holding whatever
 * copy of the extension it already had, and the extension is the half that
 * was doing the damage, so the browser has to be sent to reload it. The
 * policy file in the repository decides what counts as too old; see
 * src/main/updater.js.
 */
function renderForcedUpdate(s) {
  let box = document.getElementById('forced');
  const appStale = Boolean(s && s.required);
  const extStale = Boolean(s && s.extensionOutdated);

  // An out-of-date add-on on its own gets a banner, never this screen. Fletch
  // can replace itself, so locking the window is always escapable; it cannot
  // reach into the browser, and someone whose add-on was loaded from a folder
  // Fletch does not control could press Reload all day without the version
  // changing. Locking them out of the app over it would be a trap.
  if (!appStale) {
    if (box) box.remove();
    renderExtensionBanner(extStale);
    return;
  }
  renderExtensionBanner(false);

  if (!box) {
    box = el('div');
    box.id = 'forced';
    const card = el('div', 'forced-card');
    card.appendChild(el('h2'));
    card.appendChild(el('p', 'why'));
    card.appendChild(el('p', 'vers'));

    const appStep = el('section', 'step app');
    appStep.appendChild(el('h3'));
    appStep.appendChild(el('p', 'state'));
    const appActs = el('div', 'acts');
    appActs.appendChild(el('button', 'btn primary'));
    appStep.appendChild(appActs);
    card.appendChild(appStep);

    const extStep = el('section', 'step ext');
    extStep.appendChild(el('h3'));
    extStep.appendChild(el('p', 'lead'));
    const steps = el('ol');
    for (const line of [
      'Open the extensions page.',
      'Find Fletch Capture in the list.',
      'Click the reload arrow on its card.',
    ]) steps.appendChild(el('li', '', line));
    extStep.appendChild(steps);
    const extActs = el('div', 'acts');
    extActs.appendChild(el('button', 'btn primary ext-open', 'Open the extensions page'));
    extStep.appendChild(extActs);
    card.appendChild(extStep);

    box.appendChild(card);
    document.body.appendChild(box);

    box.querySelector('.ext-open').onclick = () => fletch.setup.openExtensionsPage('chrome');
  }

  const appStep = box.querySelector('.step.app');
  const extStep = box.querySelector('.step.ext');
  appStep.hidden = !appStale;
  // Always shown alongside an app update. Installing a new Fletch leaves the
  // browser holding the add-on from the old one, every time, so the reload is
  // part of the same job rather than a separate complaint.
  extStep.hidden = !appStale && !extStale;

  box.querySelector('h2').textContent = appStale
    ? 'Update Fletch to carry on'
    : 'Reload the Fletch extension';

  box.querySelector('.why').textContent = (s && s.reason)
    || 'The copy your browser is running has been withdrawn and should not keep working.';

  box.querySelector('.vers').textContent = appStale && s.minimumVersion
    ? `You are on ${s.current}. Version ${s.minimumVersion} replaces it.`
    : '';

  // Numbered only when there are two things to do in order.
  appStep.querySelector('h3').textContent = extStale ? '1. Update the app' : 'Update the app';
  extStep.querySelector('h3').textContent = appStale
    ? '2. Reload the browser extension'
    : 'Reload the browser extension';

  extStep.querySelector('.lead').textContent =
    'Your browser keeps its own copy of the add-on, so installing this does not change it. Restart your browser afterwards and it picks up the new one — or do it there now:';

  const line = appStep.querySelector('.state');
  const button = appStep.querySelector('.acts .primary');

  if (!appStale) return;

  if (s.state === 'ready') {
    line.textContent = 'The new version is downloaded and ready.';
    button.textContent = 'Restart and install';
    button.disabled = false;
    button.onclick = async () => {
      button.disabled = true;
      const r = await fletch.update.install();
      if (!r.ok) { line.textContent = r.error; button.disabled = false; }
    };
  } else if (s.state === 'downloading') {
    line.textContent = `Downloading… ${Math.round((s.progress || 0) * 100)}%`;
    button.textContent = 'Downloading…';
    button.disabled = true;
  } else if (s.usable) {
    line.textContent = 'Fletch is fetching the new version for you.';
    button.textContent = 'Download now';
    button.disabled = false;
    button.onclick = async () => {
      button.disabled = true;
      const r = await fletch.update.download();
      if (!r.ok) { line.textContent = r.error; button.disabled = false; }
    };
  } else if (s.installerUrl) {
    // A portable copy, or one run from source, cannot swap itself out in
    // place — but it can fetch its own replacement and open it, which is all
    // the user wanted from a link to a web page anyway.
    if (s.installerState === 'fetching') {
      line.textContent = 'Downloading the installer. It will open by itself when it is ready.';
      button.textContent = 'Downloading…';
      button.disabled = true;
    } else {
      line.textContent = s.installerError
        || 'This copy cannot replace itself, so Fletch will download the installer and open it.';
      button.textContent = s.installerError ? 'Try again' : 'Download and install';
      button.disabled = false;
      button.onclick = async () => {
        button.disabled = true;
        button.textContent = 'Downloading…';
        const r = await fletch.update.fetchInstaller();
        if (!r.ok) {
          line.textContent = r.error;
          button.textContent = 'Try again';
          button.disabled = false;
        }
      };
    }
  } else {
    // No installer has been named, so the release page is all there is.
    line.textContent = 'This copy cannot replace itself. Download the new one and run it instead.';
    button.textContent = 'Get the new version';
    button.disabled = false;
    button.onclick = () => fletch.app.openExternal(s.downloadUrl
      || 'https://github.com/uncrownedprince786-collab/Fletch/releases/latest');
  }
}

/**
 * Updates are announced, never imposed: Fletch asks before spending bandwidth
 * and asks again before replacing itself. The screen above is the one case
 * that is not an announcement.
 */
function handleUpdateStatus(s) {
  state.update = s;
  renderForcedUpdate(s);
  if (!s || s.state === lastUpdateState) return;
  lastUpdateState = s.state;

  if (s.state === 'available' && s.info) {
    toast(`Fletch ${s.info.version} is available`, s.info.notes || 'A new version has been published.', '', [
      {
        label: 'Download',
        primary: true,
        onClick: async () => {
          const r = await fletch.update.download();
          if (!r.ok) toast('Download failed', r.error, 'bad');
        },
      },
    ]);
  } else if (s.state === 'ready' && s.info) {
    toast(`Fletch ${s.info.version} is ready`, 'It will be applied when you restart.', '', [
      {
        label: 'Restart now',
        primary: true,
        onClick: async () => {
          const r = await fletch.update.install();
          if (!r.ok) toast('Could not install', r.error, 'bad');
        },
      },
    ]);
  }
}

// ---------------------------------------------------------------- first run

/**
 * Shown once, on first launch. Pairing the extension is the step that turns
 * Fletch into something that catches downloads, so it gets walked through
 * rather than buried in settings.
 */
let setupOpen = false;

function setupDialog(info) {
  if (setupOpen) return;
  setupOpen = true;
  modal('Set up the browser extension', (c, close) => {
    c.appendChild(el('p', null,
      'One step, and every download you click in your browser comes here instead. '
      + 'Fletch and the extension introduce themselves to each other — there is nothing to copy.'));

    const step = (n, title) => {
      const h = el('div');
      h.style.cssText = 'display:flex;align-items:center;gap:9px;margin:18px 0 8px';
      const badge = el('span', null, String(n));
      badge.style.cssText = 'width:21px;height:21px;border-radius:50%;display:grid;place-items:center;'
        + 'background:linear-gradient(135deg,var(--ember-1),var(--ember-3));color:#1A1005;'
        + 'font-size:11.5px;font-weight:700;flex:none';
      h.appendChild(badge);
      const t = el('div', null, title);
      t.style.cssText = 'font-weight:620;font-size:13.5px';
      h.appendChild(t);
      c.appendChild(h);
      return h;
    };

    // --- step 1: load it
    step(1, 'Load the extension');
    c.appendChild(el('p', null,
      'This opens your browser’s extensions page. Turn on Developer mode, '
      + 'choose "Load unpacked", and pick the folder below.'));

    const row1 = el('div');
    row1.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;margin-top:10px';
    for (const name of (info.browsers || [])) {
      const b = el('button', 'btn primary', `Open ${name}`);
      b.onclick = async () => {
        const r = await fletch.setup.openExtensionsPage(name);
        if (!r.ok) toast('Could not open the browser', r.error, 'bad');
      };
      row1.appendChild(b);
    }
    if (!(info.browsers || []).length) {
      row1.appendChild(el('p', null, 'No Chrome, Edge or Brave was found — open your browser’s extensions page yourself.'));
    }
    const openFolder = el('button', 'btn', 'Show the folder');
    openFolder.onclick = () => fletch.setup.openExtensionFolder();
    row1.appendChild(openFolder);
    c.appendChild(row1);

    const pathBox = el('code', 'snippet', info.extensionDir || '');
    pathBox.style.marginTop = '10px';
    c.appendChild(pathBox);

    // --- step 2: nothing, usually
    step(2, 'There is no step two');
    c.appendChild(el('p', null,
      'The extension pairs itself the moment it loads, as long as Fletch is running. '
      + 'The details below are only needed if that is refused — Details → Extension options.'));

    const grid = el('div', 'row2');
    grid.style.marginTop = '10px';
    const portF = el('label', 'field');
    portF.appendChild(el('span', 'lab', 'Port'));
    portF.appendChild(el('code', 'snippet', String(info.port || 47809)));
    grid.appendChild(portF);
    const tokF = el('label', 'field');
    tokF.appendChild(el('span', 'lab', 'Token'));
    const tok = el('code', 'snippet', info.token || '');
    tokF.appendChild(tok);
    grid.appendChild(tokF);
    c.appendChild(grid);

    const copy = el('button', 'btn', 'Copy token');
    copy.onclick = async () => {
      await fletch.setup.copyToken();
      copy.textContent = 'Copied';
      setTimeout(() => { copy.textContent = 'Copy token'; }, 1800);
    };
    c.appendChild(copy);

    // Pages are not files, and the helper that turns one into the other was
    // offered nowhere but a Settings card nobody had a reason to open. Missing
    // it does not look like a missing helper — it looks like downloads being
    // broken — so it is put in front of people once, here, while they are
    // already setting things up.
    const more = el('div');
    more.style.cssText = 'margin-top:20px;padding-top:16px;border-top:1px solid var(--line-soft)';

    const moreTitle = el('div', null, 'One more thing — video from web pages');
    moreTitle.style.cssText = 'font-weight:620;font-size:13.5px;margin-bottom:6px';
    more.appendChild(moreTitle);

    more.appendChild(el('p', null,
      'A page is not a file, so Fletch uses two helpers to get the video off one: yt-dlp to '
      + 'find it, and ffmpeg to put the picture and sound back together. Fletch fetches both '
      + 'by itself shortly after it starts, from their official releases, checking each '
      + 'against the checksum its project publishes. There is nothing for you to do — '
      + 'this is only here so you know what it is downloading.'));

    const toolRow = el('div');
    toolRow.style.cssText = 'display:flex;align-items:center;gap:10px;margin-top:10px';
    const toolBtn = el('button', 'btn primary', 'Install yt-dlp');
    const toolState = el('span');
    toolState.style.cssText = 'font-size:12px;color:var(--text-dim)';
    toolRow.appendChild(toolBtn);
    toolRow.appendChild(toolState);
    more.appendChild(toolRow);
    c.appendChild(more);

    const paintTool = (st) => {
      const have = Boolean(st && st.ytdlp && st.ytdlp.installed);
      toolBtn.hidden = have;
      toolState.textContent = have
        ? 'yt-dlp is installed. Links to pages will work.'
        : 'Fletch will fetch these shortly. This button only hurries it along.';
    };
    fletch.tools.status().then((r) => { if (r.ok) paintTool(r.data); });
    toolBtn.onclick = async () => {
      toolBtn.disabled = true;
      toolState.textContent = 'Fetching…';
      const r = await fletch.tools.installYtDlp();
      toolBtn.disabled = false;
      if (!r.ok) {
        toolState.textContent = r.error || 'That did not work. Settings → Helpers has another go.';
        return;
      }
      const after = await fletch.tools.status();
      if (after.ok) paintTool(after.data);
    };

    const note = el('p');
    note.style.cssText = 'margin-top:16px;font-size:11.5px;color:var(--text-dim);line-height:1.6';
    note.textContent = 'You can reopen this any time from Settings → Browser. '
      + 'Fletch works without the extension too — paste or drop links into the window.';
    c.appendChild(note);
  }, [
    { label: 'Remind me later', onClick: (close) => { setupOpen = false; close(); } },
    {
      label: 'Done',
      primary: true,
      onClick: (close) => { setupOpen = false; fletch.setup.markDone(); close(); },
    },
  ], true);
}

// ---------------------------------------------------------------- settings

function settingsDialog() {
  const s = state.settings;
  let currentTab = 'general';

  modal('Settings', (c, close) => {
    const tabs = el('div', 'tabs');
    tabs.style.margin = '-16px -18px 16px';
    const pane = el('div');

    const draw = () => {
      pane.replaceChildren();
      if (currentTab === 'general') drawGeneral(pane);
      else if (currentTab === 'speed') drawSpeed(pane);
      else if (currentTab === 'tools') drawTools(pane);
      else if (currentTab === 'updates') drawUpdates(pane);
      else drawBrowser(pane);
    };

    for (const [id, label] of [['general', 'General'], ['speed', 'Speed'], ['tools', 'Helpers'], ['browser', 'Browser'], ['updates', 'Updates']]) {
      const b = el('button', currentTab === id ? 'on' : '', label);
      b.onclick = () => {
        currentTab = id;
        [...tabs.children].forEach((x) => x.classList.toggle('on', x === b));
        draw();
      };
      tabs.appendChild(b);
    }

    c.appendChild(tabs);
    c.appendChild(pane);
    draw();
  }, [{ label: 'Done', onClick: (close) => close() }], true);

  const save = async (patch) => {
    Object.assign(state.settings, patch);
    await fletch.settings.set(patch);
  };

  function numberField(parent, key, label, hint, min, max) {
    const f = el('label', 'field');
    f.appendChild(el('span', 'lab', label));
    const i = el('input', 'input');
    i.type = 'number';
    i.min = String(min);
    i.max = String(max);
    i.value = String(s[key] ?? 0);
    i.onchange = () => {
      const v = Math.max(min, Math.min(max, Number(i.value) || 0));
      i.value = String(v);
      save({ [key]: v });
    };
    f.appendChild(i);
    if (hint) f.appendChild(el('span', 'hint', hint));
    parent.appendChild(f);
  }

  function checkField(parent, key, label, hint) {
    const w = el('label', 'check');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = Boolean(s[key]);
    cb.onchange = () => save({ [key]: cb.checked });
    w.appendChild(cb);
    const t = el('div');
    t.appendChild(el('div', 'lab', label));
    if (hint) t.appendChild(el('div', 'hint', hint));
    w.appendChild(t);
    parent.appendChild(w);
  }

  function drawGeneral(p) {
    const f = el('label', 'field');
    f.appendChild(el('span', 'lab', 'Save downloads to'));
    const row = el('div');
    row.style.display = 'flex';
    row.style.gap = '8px';
    const i = el('input', 'input');
    i.value = s.downloadDir || '';
    i.readOnly = true;
    const b = el('button', 'btn', 'Change…');
    b.onclick = async () => {
      const r = await fletch.settings.pickFolder();
      if (r.ok && r.data) { s.downloadDir = r.data; i.value = r.data; }
    };
    row.appendChild(i);
    row.appendChild(b);
    f.appendChild(row);
    p.appendChild(f);

    checkField(p, 'sortIntoCategories', 'File downloads into category folders',
      'Video, Audio, Documents, Programs, Archives and Images get their own subfolder.');
    checkField(p, 'watchClipboard', 'Watch the clipboard for links',
      'When you copy a link, Fletch offers to download it. Nothing starts without a click.');
    checkField(p, 'notifyOnFinish', 'Notify when a download finishes', '');
    checkField(p, 'minimiseToTray', 'Keep running in the tray when the window is closed', '');

    const tf = el('label', 'field');
    tf.appendChild(el('span', 'lab', 'Appearance'));
    const sel = el('select', 'input');
    for (const [v, t] of [['dark', 'Dark'], ['light', 'Light']]) {
      const o = el('option', null, t);
      o.value = v;
      if ((s.theme || 'dark') === v) o.selected = true;
      sel.appendChild(o);
    }
    sel.onchange = () => {
      document.documentElement.dataset.theme = sel.value;
      save({ theme: sel.value });
      renderGauge();
    };
    tf.appendChild(sel);
    p.appendChild(tf);
  }

  function drawSpeed(p) {
    const row = el('div', 'row2');
    const a = el('div');
    numberField(a, 'connections', 'Connections per download',
      'How many pieces a file is split into. 8 suits most connections; more is not always faster.', 1, 32);
    row.appendChild(a);
    const b = el('div');
    numberField(b, 'maxConcurrent', 'Downloads at once',
      'Beyond this, new links wait in the queue.', 1, 16);
    row.appendChild(b);
    p.appendChild(row);

    numberField(p, 'speedLimitKbps', 'Speed limit (KB/s)',
      'Across every download at once. Set to 0 to leave it uncapped.', 0, 1024 * 1024);

    const qf = el('label', 'field');
    qf.appendChild(el('span', 'lab', 'Default video quality'));
    const q = el('select', 'input');
    for (const [v, t] of [[0, 'Best available'], [2160, 'Up to 4K'], [1440, 'Up to 1440p'], [1080, 'Up to 1080p'], [720, 'Up to 720p'], [480, 'Up to 480p']]) {
      const o = el('option', null, t);
      o.value = String(v);
      if (Number(s.maxHeight || 0) === v) o.selected = true;
      q.appendChild(o);
    }
    q.onchange = () => save({ maxHeight: Number(q.value) || 0 });
    qf.appendChild(q);
    p.appendChild(qf);

    checkField(p, 'remuxHls', 'Repack streamed video as MP4',
      'Streams arrive as .ts segments. With ffmpeg present, Fletch rewraps them as MP4 so they seek properly. No re-encoding.');
  }

  function drawTools(p) {
    p.appendChild(el('p', null,
      'Fletch downloads files on its own. These two optional helpers extend it: one finds media on web pages, the other joins separate video and audio tracks.'));
    const holder = el('div');
    holder.style.marginTop = '14px';
    p.appendChild(holder);

    const refresh = async () => {
      holder.replaceChildren();
      const r = await fletch.tools.status();
      if (!r.ok) return;
      const st = r.data;

      const card = (name, info, blurb, onInstall, hint) => {
        const d = el('div', 'tool');
        d.appendChild(el('span', `pill ${info.installed ? 'yes' : 'no'}`, info.installed ? 'Ready' : 'Missing'));
        const body = el('div', 'info');
        body.appendChild(el('b', null, name));
        body.appendChild(el('p', null, info.installed ? info.path : blurb));
        d.appendChild(body);
        if (!info.installed && onInstall) {
          const b = el('button', 'btn sm primary', 'Install');
          b.onclick = async () => {
            b.disabled = true;
            b.textContent = 'Downloading…';
            const res = await onInstall();
            if (!res.ok) { toast('Install failed', res.error, 'bad'); b.disabled = false; b.textContent = 'Install'; }
            else { toast('Installed', `${name} is ready to use.`); refresh(); }
          };
          d.appendChild(b);
        }
        const pick = el('button', 'btn sm', info.installed ? 'Change…' : 'Locate…');
        pick.onclick = async () => {
          const res = await fletch.settings.pickBinary(name === 'ffmpeg' ? 'ffmpeg' : 'yt-dlp');
          if (res.ok && res.data) refresh();
        };
        d.appendChild(pick);
        holder.appendChild(d);
        if (!info.installed && hint) {
          const h = el('p');
          h.style.cssText = 'font-size:11.5px;color:var(--text-dim);margin:-4px 0 12px;line-height:1.5;user-select:text';
          h.textContent = hint;
          holder.appendChild(h);
        }
      };

      card('yt-dlp', st.ytdlp,
        'Needed for links to web pages rather than files. Fletch can fetch it from its official release.',
        () => fletch.tools.installYtDlp());
      card('ffmpeg', st.ffmpeg,
        'Needed to join separate video and audio tracks, and to repack streams as MP4.',
        st.ffmpeg.canAutoInstall ? () => fletch.tools.installFfmpeg() : null,
        st.ffmpeg.canAutoInstall ? '' : `Install it yourself, then point Fletch at it: ${st.ffmpeg.hint || ''}`);

      checkField(holder, 'autoHelpers', 'Keep these installed and up to date',
        'Fletch fetches them on first run and refreshes them weekly, checking each against '
        + 'the checksum its project publishes. Turn this off to manage them yourself.');

      const note = el('p');
      note.style.cssText = 'font-size:11.5px;color:var(--text-dim);line-height:1.6;user-select:text';
      note.textContent = `Helpers live in ${st.binDir}`;
      holder.appendChild(note);
    };
    refresh();
  }

  function drawUpdates(p) {
    const holder = el('div');
    p.appendChild(holder);

    const paint = (st) => {
      holder.replaceChildren();

      const card = el('div', 'tool');
      const states = {
        idle: ['yes', 'Up to date'], checking: ['no', 'Checking'],
        available: ['no', 'Update ready to download'], downloading: ['no', 'Downloading'],
        ready: ['no', 'Ready to install'], error: ['no', 'Check failed'],
      };
      const [pill, label] = states[st.state] || ['no', st.state];
      card.appendChild(el('span', `pill ${pill}`, label));
      const info = el('div', 'info');
      info.appendChild(el('b', null, `Fletch ${st.current}`));
      let line = 'You have the current version.';
      if (!st.usable) line = 'Update checks work in the installed app, not when run from source.';
      else if (st.state === 'available' && st.info) line = `Version ${st.info.version} is available. ${st.info.notes || ''}`;
      else if (st.state === 'downloading') line = `Downloading… ${Math.round(st.progress * 100)}%`;
      else if (st.state === 'ready' && st.info) line = `Version ${st.info.version} will be applied when you restart.`;
      else if (st.state === 'error') line = st.error || 'The update check did not succeed.';
      info.appendChild(el('p', null, line));
      card.appendChild(info);

      if (st.usable && (st.state === 'idle' || st.state === 'error')) {
        const b = el('button', 'btn sm', 'Check now');
        b.onclick = async () => {
          b.disabled = true;
          b.textContent = 'Checking…';
          const r = await fletch.update.check();
          if (r.ok) paint(r.data);
        };
        card.appendChild(b);
      }
      if (st.state === 'available') {
        const b = el('button', 'btn sm primary', 'Download');
        b.onclick = async () => { b.disabled = true; await fletch.update.download(); };
        card.appendChild(b);
      }
      if (st.state === 'ready') {
        const b = el('button', 'btn sm primary', 'Restart and install');
        b.onclick = () => fletch.update.install();
        card.appendChild(b);
      }
      holder.appendChild(card);

      checkField(holder, 'autoUpdate', 'Check for updates automatically',
        'Looks shortly after launch and every few hours. Fletch always asks before downloading or installing.');

      const note = el('p');
      note.style.cssText = 'font-size:11.5px;color:var(--text-dim);line-height:1.6;user-select:text';
      note.textContent = 'Updates are published as GitHub releases. Nothing is sent anywhere — Fletch only '
        + 'asks that page whether a newer version exists.';
      holder.appendChild(note);
    };

    paint(state.update || { state: 'idle', usable: false, current: '…' });
    fletch.update.status().then((r) => { if (r.ok) paint(r.data); });
    fletch.onUpdateStatus((st) => { if (document.querySelector('.modal')) paint(st); });
  }

  async function drawBrowser(p) {
    p.appendChild(el('p', null,
      'Fletch listens on your own machine so the browser extension can hand it links. Nothing is exposed to the network, and the token below is what keeps other pages out.'));
    const r = await fletch.app.bridge();
    const box = el('div');
    box.style.marginTop = '14px';
    if (r.ok && r.data.port) {
      const f1 = el('label', 'field');
      f1.appendChild(el('span', 'lab', 'Listening on'));
      f1.appendChild(Object.assign(el('code', 'snippet'), { textContent: `http://127.0.0.1:${r.data.port}` }));
      box.appendChild(f1);
      const f2 = el('label', 'field');
      f2.appendChild(el('span', 'lab', 'Pairing token'));
      f2.appendChild(Object.assign(el('code', 'snippet'), { textContent: r.data.token }));
      f2.appendChild(el('span', 'hint', 'Paste this into the extension’s options page once. Treat it like a password.'));
      box.appendChild(f2);
    } else {
      box.appendChild(el('p', null, 'The local endpoint could not start — another program may be using the port.'));
    }
    // Sites that gate video behind a login (Instagram, Facebook, X, private
    // YouTube) work only if Fletch can borrow the browser session.
    const cf = el('label', 'field');
    cf.appendChild(el('span', 'lab', 'Sign in as you, using your browser’s cookies'));
    const cs = el('select', 'input');
    for (const [v, t] of [
      ['', 'Don’t use cookies'],
      ['chrome', 'Chrome'], ['edge', 'Edge'], ['brave', 'Brave'],
      ['firefox', 'Firefox'], ['opera', 'Opera'], ['vivaldi', 'Vivaldi'],
    ]) {
      const o = el('option', null, t);
      o.value = v;
      if ((s.cookiesFromBrowser || '') === v) o.selected = true;
      cs.appendChild(o);
    }
    cs.onchange = () => save({ cookiesFromBrowser: cs.value });
    cf.appendChild(cs);
    cf.appendChild(el('span', 'hint',
      'Needed for anything that only plays when you are logged in — private or age-restricted video, '
      + 'Instagram, Facebook, X. Fletch reads the cookies on your machine and sends them only to that site. '
      + 'Close the browser first if it refuses to read them.'));
    box.appendChild(cf);

    const mf = el('label', 'field');
    mf.appendChild(el('span', 'lab', 'Magnet links'));
    const mb = el('button', 'btn', 'Open Windows default apps…');
    mb.onclick = () => fletch.setup.openDefaultApps();
    mf.appendChild(mb);
    mf.appendChild(el('span', 'hint',
      'Windows will not let any program make itself the handler for magnet links on its own — '
      + 'that choice is the user’s to make. Pick Fletch there to open magnets from anywhere. '
      + 'With the extension installed, magnet links you click in the browser already come straight here.'));
    box.appendChild(mf);

    const how = el('label', 'field');
    how.appendChild(el('span', 'lab', 'Installing the extension'));
    const walk = el('button', 'btn primary', 'Walk me through it');
    walk.onclick = async () => {
      const info = await fletch.setup.info();
      document.querySelector('.scrim')?.remove();
      if (info.ok) setupDialog(info.data);
    };
    how.appendChild(walk);
    how.appendChild(el('span', 'hint',
      'Opens your browser’s extensions page and shows you the folder to load and the token to paste.'));
    box.appendChild(how);
    p.appendChild(box);
  }
}

// ---------------------------------------------------------------- wiring

function applyTasks(list) {
  state.tasks = list;
  render();
}

function applyStats(stats) {
  state.stats = stats;
  state.history.push(stats.speed || 0);
  state.history.shift();
  renderGauge();
  const anyPaused = state.settings.paused;
  $('#btnPauseAll').textContent = anyPaused ? 'Resume all' : 'Pause all';
}

async function boot() {
  const s = await fletch.settings.get();
  if (s.ok) {
    state.settings = s.data;
    document.documentElement.dataset.theme = s.data.theme || 'dark';
  }

  const t = await fletch.tasks.list();
  if (t.ok) applyTasks(t.data);
  const st = await fletch.tasks.stats();
  if (st.ok) applyStats(st.data);

  fletch.onTasks(applyTasks);
  fletch.onStats(applyStats);
  fletch.onSetupShow((info) => setupDialog(info));

  // And ask, as well as waiting to be told. main sends setup:show the moment
  // the bridge is up, which on a quick machine is before this window has
  // finished starting and subscribed — so the one message that explains how
  // to load the add-on was being thrown away, silently, for exactly the
  // people whose machines start fastest.
  fletch.setup.info().then((r) => {
    if (r.ok && r.data && !r.data.done) setupDialog(r.data);
  });
  fletch.onUpdateStatus(handleUpdateStatus);
  fletch.update.status().then((r) => { if (r.ok) handleUpdateStatus(r.data); });

  fletch.onClipboardLink(({ url, likelyMedia }) => {
    if (state.seenClipboard.has(url)) return;
    state.seenClipboard.add(url);
    const short = url.length > 58 ? `${url.slice(0, 55)}…` : url;
    toast(likelyMedia ? 'Media link copied' : 'Link copied', short, '', [
      { label: 'Download', primary: true, onClick: () => fletch.tasks.add(url) },
      { label: 'Options…', onClick: () => addDialog(url) },
    ]);
  });

  $('#btnAdd').onclick = () => addDialog();
  $('#btnSettings').onclick = settingsDialog;
  $('#btnClear').onclick = () => fletch.tasks.clearCompleted();
  $('#btnPauseAll').onclick = async () => {
    const paused = state.settings.paused;
    paused ? await fletch.tasks.resumeAll() : await fletch.tasks.pauseAll();
    state.settings.paused = !paused;
    $('#btnPauseAll').textContent = state.settings.paused ? 'Resume all' : 'Pause all';
  };
  $('#search').oninput = (e) => { state.search = e.target.value; render(); };

  // Dropping a link or a page onto the window queues it.
  document.addEventListener('dragover', (e) => { e.preventDefault(); });
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    const text = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
    const urls = String(text || '').split(/\s+/).filter((u) => /^https?:\/\//i.test(u));
    if (urls.length) fletch.tasks.addMany(urls, {});
  });

  document.addEventListener('keydown', (e) => {
    const typing = /input|textarea/i.test(e.target.tagName);
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') { e.preventDefault(); addDialog(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v' && !typing) {
      fletch.app.clipboard().then((r) => { if (r.ok && /^https?:\/\//i.test(r.data)) addDialog(r.data); });
    }
    if (e.key === '/' && !typing) { e.preventDefault(); $('#search').focus(); }
  });

  renderGauge();
}

boot();
