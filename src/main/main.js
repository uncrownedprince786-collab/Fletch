'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const {
  app, BrowserWindow, ipcMain, shell, dialog, clipboard, Tray, Menu, nativeImage, Notification,
} = require('electron');

const { JsonStore } = require('./store');
const { DownloadManager } = require('./engine/manager');
const { Binaries, defaultBinDir, FFMPEG_HINTS } = require('./engine/binaries');
const { Bridge } = require('./bridge');
const { Updater } = require('./updater');
const { ensureMagnetHandler } = require('./protocol');
const { isHttpUrl, looksLikeMediaUrl } = require('./engine/util');
const { isTorrentSource } = require('./engine/torrent');

/** Anything on a command line that Fletch could take as a download. */
function linkFromArgv(argv) {
  return (argv || []).find((a) => isHttpUrl(a) || isTorrentSource(a)) || null;
}

const DEFAULTS = {
  downloadDir: path.join(os.homedir(), 'Downloads', 'Fletch'),
  connections: 8,
  maxConcurrent: 3,
  speedLimitKbps: 0,
  sortIntoCategories: true,
  maxHeight: 0,
  remuxHls: true,
  watchClipboard: true,
  minimiseToTray: true,
  notifyOnFinish: true,
  startPaused: false,
  cookiesFromBrowser: '',
  proxy: '',
  ytdlpPath: '',
  ffmpegPath: '',
  // Fletch fetches yt-dlp and ffmpeg itself and keeps them current. Off means
  // the user would rather install and update them their own way.
  autoHelpers: true,
  helpersCheckedAt: 0,
  theme: 'dark',
};

let win = null;
let tray = null;
let manager = null;
let bridge = null;
let settings = null;
let tasksStore = null;
let binaries = null;
let quitting = false;
let updater = null;
// The task id of a replacement installer this copy is fetching for itself.
let pendingInstaller = null;
let magnetState = { state: 'unknown' };
let lastClipboard = '';
let clipboardTimer = null;

const userData = app.getPath('userData');

function createWindow() {
  const bounds = settings.get('windowBounds', { width: 1180, height: 760 });
  win = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    minWidth: 900,
    minHeight: 560,
    show: false,
    backgroundColor: '#0e1116',
    title: 'Fletch',
    icon: path.join(__dirname, '..', '..', 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // The preload only uses contextBridge and ipcRenderer, both of which a
      // sandboxed preload still has. Sandboxing costs nothing here and takes
      // Node out of the renderer's reach entirely.
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());

  // Links in the UI open in the real browser, never inside the app shell.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isHttpUrl(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.on('close', (e) => {
    if (!quitting && settings.get('minimiseToTray', true) && tray) {
      e.preventDefault();
      win.hide();
      return;
    }
    const b = win.getBounds();
    settings.set('windowBounds', b);
  });

  win.on('closed', () => { win = null; });
}

function showWindow() {
  if (!win) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function trayIcon() {
  const assets = path.join(__dirname, '..', '..', 'assets');
  // macOS menu bars want a monochrome template image, which the system then
  // tints for light, dark and highlighted states. Everywhere else, colour.
  const names = process.platform === 'darwin'
    ? ['trayTemplate.png', 'tray.png', 'icon.png']
    : ['tray.png', 'icon.png'];
  for (const name of names) {
    const file = path.join(assets, name);
    if (fs.existsSync(file)) return nativeImage.createFromPath(file);
  }
  return nativeImage.createEmpty();
}

function buildTray() {
  try {
    tray = new Tray(trayIcon());
  } catch {
    return; // no tray on this desktop; the window still works
  }
  const refresh = () => {
    const s = manager.stats();
    tray.setToolTip(s.active ? `Fletch — ${s.active} downloading` : 'Fletch');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open Fletch', click: showWindow },
      { type: 'separator' },
      { label: 'Paste link and download', click: () => addFromClipboard(true) },
      {
        label: settings.get('paused', false) ? 'Resume all' : 'Pause all',
        click: () => {
          settings.get('paused', false) ? manager.resumeAll() : manager.pauseAll();
          refresh();
        },
      },
      { type: 'separator' },
      { label: 'Quit', click: () => { quitting = true; app.quit(); } },
    ]));
  };
  refresh();
  tray.on('click', showWindow);
  manager.on('tasks', refresh);
}

/** Where the unpacked extension lives, dev tree or installed app alike. */
function extensionDir() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'extension')
    : path.join(__dirname, '..', '..', 'extension');
}

// Both helpers are fetched the first time Fletch runs and refreshed on this
// cadence afterwards, so that nobody has to learn they exist. yt-dlp is the
// one that rots: sites change constantly, and a copy a month old starts
// failing on the places people actually use.
const HELPER_REFRESH_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Make sure the helpers are present, and not stale.
 *
 * Quiet by design. A failure here means Fletch is no worse off than it was a
 * moment ago — it tries again next launch rather than interrupting someone to
 * report that an optional download did not happen.
 */
async function ensureHelpers({ refresh = false } = {}) {
  if (!settings.get('autoHelpers', true)) return;
  const tell = (name, payload) => {
    if (win && !win.isDestroyed()) win.webContents.send('tools:progress', { ...payload, name });
  };

  for (const name of ['yt-dlp', 'ffmpeg']) {
    if (!binaries.canAutoInstall(name)) continue;
    try {
      const have = await binaries.resolve(name);
      // A copy from PATH belongs to whoever put it there; leave it alone.
      if (have && !(refresh && have.startsWith(binaries.binDir))) continue;
      await binaries.install(name, (payload) => tell(name, payload));
      manager.applySettings();
    } catch {
      // Offline, or the release moved. Nothing that was working has broken.
    }
  }

  settings.set('helpersCheckedAt', Date.now());
  if (win && !win.isDestroyed()) win.webContents.send('tools:progress', { done: true });
}

/** The version of the extension sitting in this build's resources. */
function bundledExtensionVersion() {
  try {
    const manifest = path.join(extensionDir(), 'manifest.json');
    return String(JSON.parse(fs.readFileSync(manifest, 'utf8')).version || '');
  } catch {
    return ''; // no bundled copy to compare against; say nothing rather than guess
  }
}

const BROWSERS = [
  { name: 'Chrome', page: 'chrome://extensions', paths: [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
  ] },
  { name: 'Edge', page: 'edge://extensions', paths: [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/microsoft-edge',
  ] },
  { name: 'Brave', page: 'brave://extensions', paths: [
    'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe',
    `${process.env.LOCALAPPDATA}/BraveSoftware/Brave-Browser/Application/brave.exe`,
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  ] },
];

function findBrowsers() {
  const found = [];
  for (const b of BROWSERS) {
    const exe = b.paths.find((p) => p && fs.existsSync(p));
    if (exe) found.push({ name: b.name, exe, page: b.page });
  }
  return found;
}

/**
 * Open the browser's extensions page. `chrome://` URLs cannot be handed to the
 * shell, so the browser is launched with the URL as an argument instead.
 */
function openExtensionsPage(which) {
  const browsers = findBrowsers();
  const target = browsers.find((b) => b.name === which) || browsers[0];
  if (!target) return { ok: false, error: 'No Chrome, Edge or Brave installation was found.' };
  try {
    spawn(target.exe, [target.page], { detached: true, stdio: 'ignore' }).unref();
    return { ok: true, browser: target.name };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function addFromClipboard(force = false) {
  const text = (clipboard.readText() || '').trim();
  if (!isHttpUrl(text)) {
    if (force) showWindow();
    return;
  }
  await manager.add(text).catch(() => {});
  if (force) showWindow();
}

/**
 * Watch the clipboard for media links and offer them, rather than grabbing
 * anything the user copies. Nothing is downloaded without a click.
 */
function startClipboardWatch() {
  clearInterval(clipboardTimer);
  clipboardTimer = setInterval(() => {
    if (!settings.get('watchClipboard', true)) return;
    const text = (clipboard.readText() || '').trim();
    if (!text || text === lastClipboard) return;
    lastClipboard = text;
    if (!isHttpUrl(text)) return;
    if (text.length > 2048) return;
    const already = manager.list().some((t) => t.sourceUrl === text);
    if (already) return;
    if (win && !win.isDestroyed()) {
      win.webContents.send('clipboard:link', { url: text, likelyMedia: looksLikeMediaUrl(text) });
    }
  }, 900);
}

// ---------------------------------------------------------------- IPC

function registerIpc() {
  const ok = (data) => ({ ok: true, data });
  const bad = (err) => ({ ok: false, error: err && err.message ? err.message : String(err) });

  ipcMain.handle('tasks:list', () => ok(manager.list()));
  ipcMain.handle('tasks:stats', () => ok(manager.stats()));

  ipcMain.handle('tasks:add', async (_e, { url, opts }) => {
    try { return ok(await manager.add(url, opts || {})); }
    catch (err) { return bad(err); }
  });

  ipcMain.handle('tasks:addMany', async (_e, { urls, opts }) => {
    const added = [];
    const failed = [];
    for (const url of urls || []) {
      try { added.push(await manager.add(url, opts || {})); }
      catch (err) { failed.push({ url, error: err.message }); }
    }
    return ok({ added, failed });
  });

  ipcMain.handle('tasks:pause', (_e, id) => { manager.pause(id); return ok(); });
  ipcMain.handle('tasks:resume', (_e, id) => { manager.resume(id); return ok(); });
  ipcMain.handle('tasks:retry', (_e, id) => { manager.retry(id); return ok(); });
  ipcMain.handle('tasks:cancel', (_e, id) => { manager.cancel(id); return ok(); });
  ipcMain.handle('tasks:remove', async (_e, { id, deleteFile }) => {
    await manager.remove(id, deleteFile);
    return ok();
  });
  ipcMain.handle('tasks:pauseAll', () => { manager.pauseAll(); return ok(); });
  ipcMain.handle('tasks:resumeAll', () => { manager.resumeAll(); return ok(); });
  ipcMain.handle('tasks:clearCompleted', () => { manager.clearCompleted(); return ok(); });
  ipcMain.handle('tasks:chooseFormat', async (_e, { id, formatId }) => {
    try { return ok(await manager.chooseFormat(id, formatId)); }
    catch (err) { return bad(err); }
  });

  ipcMain.handle('file:open', async (_e, id) => {
    const t = manager.get(id);
    if (!t || !fs.existsSync(t.filePath)) return bad(new Error('That file is no longer where Fletch left it.'));
    const err = await shell.openPath(t.filePath);
    return err ? bad(new Error(err)) : ok();
  });

  ipcMain.handle('file:reveal', (_e, id) => {
    const t = manager.get(id);
    if (!t) return bad(new Error('Unknown download.'));
    const target = fs.existsSync(t.filePath) ? t.filePath : t.folder;
    if (!fs.existsSync(target)) return bad(new Error('That folder no longer exists.'));
    shell.showItemInFolder(target);
    return ok();
  });

  ipcMain.handle('settings:get', () => ok(settings.data));
  ipcMain.handle('settings:set', (_e, patch) => {
    settings.merge(patch || {});
    manager.applySettings();
    if ('watchClipboard' in (patch || {})) startClipboardWatch();
    return ok(settings.data);
  });

  ipcMain.handle('settings:pickFolder', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Where should Fletch save downloads?',
      defaultPath: settings.get('downloadDir'),
      properties: ['openDirectory', 'createDirectory'],
    });
    if (r.canceled || !r.filePaths.length) return ok(null);
    settings.set('downloadDir', r.filePaths[0]);
    return ok(r.filePaths[0]);
  });

  ipcMain.handle('settings:pickBinary', async (_e, which) => {
    const r = await dialog.showOpenDialog(win, {
      title: `Locate ${which}`,
      properties: ['openFile'],
      filters: process.platform === 'win32' ? [{ name: 'Programs', extensions: ['exe'] }] : [],
    });
    if (r.canceled || !r.filePaths.length) return ok(null);
    settings.set(which === 'ffmpeg' ? 'ffmpegPath' : 'ytdlpPath', r.filePaths[0]);
    manager.applySettings();
    return ok(r.filePaths[0]);
  });

  ipcMain.handle('tools:status', async () => ok(await binaries.status()));

  ipcMain.handle('tools:installYtDlp', async () => {
    try {
      const r = await binaries.installYtDlp((p) => {
        if (win && !win.isDestroyed()) win.webContents.send('tools:progress', { ...p, name: 'yt-dlp' });
      });
      manager.applySettings();
      return ok(r);
    } catch (err) { return bad(err); }
  });

  ipcMain.handle('tools:installFfmpeg', async () => {
    try {
      const r = await binaries.install('ffmpeg', (p) => {
        if (win && !win.isDestroyed()) win.webContents.send('tools:progress', { ...p, name: 'ffmpeg' });
      });
      manager.applySettings();
      return ok(r);
    } catch (err) { return bad(err); }
  });

  ipcMain.handle('tools:ffmpegHint', () => ok(FFMPEG_HINTS[process.platform] || ''));

  ipcMain.handle('bridge:info', () => ok({
    port: bridge ? bridge.port : null,
    token: bridge ? bridge.token : '',
  }));

  ipcMain.handle('app:info', () => ok({
    version: app.getVersion(),
    platform: process.platform,
    downloadDir: settings.get('downloadDir'),
    userData,
  }));

  ipcMain.handle('app:openExternal', (_e, url) => {
    if (isHttpUrl(url)) shell.openExternal(url);
    return ok();
  });

  ipcMain.handle('app:clipboard', () => ok((clipboard.readText() || '').trim()));

  ipcMain.handle('setup:info', () => ok({
    extensionDir: extensionDir(),
    browsers: findBrowsers().map((b) => b.name),
    port: bridge ? bridge.port : null,
    token: bridge ? bridge.token : '',
    done: Boolean(settings.get('extensionSetUp', false)),
  }));

  ipcMain.handle('setup:openExtensionsPage', (_e, which) => {
    const r = openExtensionsPage(which);
    return r.ok ? ok(r) : bad(new Error(r.error));
  });

  ipcMain.handle('setup:openExtensionFolder', () => {
    const dir = extensionDir();
    if (!fs.existsSync(dir)) return bad(new Error('The extension folder is missing from this install.'));
    shell.openPath(dir);
    return ok(dir);
  });

  ipcMain.handle('setup:copyToken', () => {
    clipboard.writeText(bridge ? bridge.token : '');
    return ok();
  });

  ipcMain.handle('setup:markDone', () => {
    settings.set('extensionSetUp', true);
    return ok();
  });

  ipcMain.handle('setup:magnet', () => ok(magnetState));

  // Windows 11 keeps the real protocol choice behind a signed per-user key
  // that no installer may write, so the most an app can do is take the user
  // to the page where they can pick it.
  ipcMain.handle('setup:openDefaultApps', () => {
    if (process.platform === 'win32') {
      shell.openExternal('ms-settings:defaultapps').catch(() => {});
      return ok({ opened: 'settings' });
    }
    return bad(new Error('Default-app settings are only applicable on Windows.'));
  });

  ipcMain.handle('update:status', () => ok(updater.status()));
  ipcMain.handle('update:check', async () => {
    await updater.check(false);
    return ok(updater.status());
  });
  ipcMain.handle('update:download', async () => {
    try { await updater.download(); return ok(updater.status()); }
    catch (err) { return bad(err); }
  });
  // A portable copy, or one run from source, cannot replace itself in place.
  // It can still fetch its own replacement rather than sending the user off to
  // a web page to find it — this is a download manager, after all — and open
  // the installer the moment it lands.
  ipcMain.handle('update:fetchInstaller', async () => {
    const url = updater.installerUrl;
    if (!url) return bad(new Error('No installer has been published for that version yet.'));
    try {
      const task = await manager.add(url, {});
      pendingInstaller = task.id;
      updater.markInstaller('fetching');
      return ok({ id: task.id });
    } catch (err) {
      updater.markInstaller('failed', err.message);
      return bad(err);
    }
  });

  ipcMain.handle('update:install', () => {
    try { updater.install(); return ok(); }
    catch (err) { return bad(err); }
  });
}

// ---------------------------------------------------------------- boot

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    showWindow();
    // Clicking a magnet link, or a link passed on a second launch, lands here.
    const link = linkFromArgv(argv);
    if (link && manager) manager.add(link).catch(() => {});
  });

  // macOS delivers magnet: and other protocol links this way.
  app.on('open-url', (e, url) => {
    e.preventDefault();
    if (manager && (isHttpUrl(url) || isTorrentSource(url))) manager.add(url).catch(() => {});
    showWindow();
  });

  app.whenReady().then(async () => {
    settings = new JsonStore(path.join(userData, 'settings.json'), DEFAULTS);
    settings.load();
    tasksStore = new JsonStore(path.join(userData, 'downloads.json'), { tasks: [] });
    tasksStore.load();

    binaries = new Binaries(defaultBinDir(userData));
    manager = new DownloadManager({
      store: tasksStore,
      settings,
      binaries,
      tmpDir: path.join(app.getPath('temp'), 'Fletch'),
    });

    manager.on('tasks', (list) => {
      if (win && !win.isDestroyed()) {
        win.webContents.send('tasks:update', list);
        win.webContents.send('tasks:stats', manager.stats());
      }
    });

    manager.on('completed', (task) => {
      // The replacement this copy asked for: run it rather than leaving it in
      // the folder for the user to go and find.
      if (pendingInstaller && task.id === pendingInstaller) {
        pendingInstaller = null;
        updater.markInstaller('');
        shell.openPath(task.filePath);
        return;
      }
      if (!settings.get('notifyOnFinish', true)) return;
      if (!Notification.isSupported()) return;
      const n = new Notification({ title: 'Download finished', body: task.filename || task.title });
      n.on('click', () => { shell.showItemInFolder(task.filePath); });
      n.show();
    });

    manager.on('failed', (task) => {
      // The replacement never arrived. Say so on the update screen, which is
      // the only thing the user can see while it is up.
      if (pendingInstaller && task.id === pendingInstaller) {
        pendingInstaller = null;
        updater.markInstaller('failed', task.error || 'The installer did not download.');
        return;
      }
      if (!settings.get('notifyOnFinish', true) || !Notification.isSupported()) return;
      new Notification({ title: 'Download failed', body: `${task.title}\n${task.error}` }).show();
    });

    updater = new Updater({
      app,
      settings,
      policyUrl: process.env.FLETCH_POLICY_URL || '',
      bundledExtension: bundledExtensionVersion(),
    });
    updater.on('status', (s) => {
      if (win && !win.isDestroyed()) win.webContents.send('update:status', s);
      // Only interrupt for something the user can act on.
      if (s.state === 'ready' && Notification.isSupported()) {
        const n = new Notification({
          title: `Fletch ${s.info.version} is ready to install`,
          body: 'Open Fletch to apply it.',
        });
        n.on('click', showWindow);
        n.show();
      }
    });

    registerIpc();
    createWindow();
    buildTray();
    startClipboardWatch();

    bridge = new Bridge({
      manager,
      settings,
      onActivate: showWindow,
      onExtension: (version) => {
        if (updater) updater.noteExtension(version);
      },
      onPaired: () => {
        // The extension has introduced itself, so the setup panel has served
        // its purpose and should stop appearing.
        settings.set('extensionSetUp', true);
        if (win && !win.isDestroyed()) win.webContents.send('setup:paired', {});
      },
    });
    await bridge.start();

    // First run: walk the user straight into pairing the browser extension,
    // since that is what turns Fletch into a download catcher rather than a
    // place to paste links.
    if (!settings.get('extensionSetUp', false) && win && !win.isDestroyed()) {
      const send = () => win.webContents.send('setup:show', {
        extensionDir: extensionDir(),
        browsers: findBrowsers().map((b) => b.name),
        port: bridge.port,
        token: bridge.token,
      });
      win.webContents.isLoading()
        ? win.webContents.once('did-finish-load', send)
        : send();
    }

    magnetState = await ensureMagnetHandler({
      app,
      enabled: settings.get('handleMagnetLinks', true),
    }).catch((err) => ({ state: 'failed', error: err.message }));

    updater.startBackgroundChecks();

    // Shortly after launch, so it never competes with the window appearing.
    setTimeout(() => {
      const last = Number(settings.get('helpersCheckedAt', 0)) || 0;
      ensureHelpers({ refresh: Date.now() - last > HELPER_REFRESH_MS }).catch(() => {});
    }, 4000).unref?.();

    // A link handed to Fletch on the command line at first launch.
    const link = linkFromArgv(process.argv);
    if (link) manager.add(link).catch(() => {});
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' && !tray) app.quit();
  });

  app.on('activate', () => showWindow());

  app.on('before-quit', () => {
    quitting = true;
    clearInterval(clipboardTimer);
    if (win && !win.isDestroyed()) {
      try { settings.set('windowBounds', win.getBounds()); } catch { /* closing */ }
    }
    if (bridge) bridge.stop();
    if (updater) updater.stop();
    if (manager) manager.shutdown();
    settings.saveNow();
  });
}
