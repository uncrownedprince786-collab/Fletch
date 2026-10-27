'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// The renderer gets this surface and nothing else: no Node, no fs, no
// arbitrary IPC. Every call maps to one named handler in the main process.

const call = (channel, payload) => ipcRenderer.invoke(channel, payload);

const on = (channel, fn) => {
  const wrapped = (_e, data) => fn(data);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
};

contextBridge.exposeInMainWorld('fletch', {
  tasks: {
    list: () => call('tasks:list'),
    stats: () => call('tasks:stats'),
    add: (url, opts) => call('tasks:add', { url, opts }),
    addMany: (urls, opts) => call('tasks:addMany', { urls, opts }),
    pause: (id) => call('tasks:pause', id),
    resume: (id) => call('tasks:resume', id),
    retry: (id) => call('tasks:retry', id),
    cancel: (id) => call('tasks:cancel', id),
    remove: (id, deleteFile) => call('tasks:remove', { id, deleteFile }),
    pauseAll: () => call('tasks:pauseAll'),
    resumeAll: () => call('tasks:resumeAll'),
    clearCompleted: () => call('tasks:clearCompleted'),
    chooseFormat: (id, formatId) => call('tasks:chooseFormat', { id, formatId }),
  },
  file: {
    open: (id) => call('file:open', id),
    reveal: (id) => call('file:reveal', id),
  },
  settings: {
    get: () => call('settings:get'),
    set: (patch) => call('settings:set', patch),
    pickFolder: () => call('settings:pickFolder'),
    pickBinary: (which) => call('settings:pickBinary', which),
  },
  tools: {
    status: () => call('tools:status'),
    installYtDlp: () => call('tools:installYtDlp'),
    ffmpegHint: () => call('tools:ffmpegHint'),
  },
  app: {
    info: () => call('app:info'),
    openExternal: (url) => call('app:openExternal', url),
    clipboard: () => call('app:clipboard'),
    bridge: () => call('bridge:info'),
  },
  setup: {
    info: () => call('setup:info'),
    openExtensionsPage: (which) => call('setup:openExtensionsPage', which),
    openExtensionFolder: () => call('setup:openExtensionFolder'),
    copyToken: () => call('setup:copyToken'),
    markDone: () => call('setup:markDone'),
    magnet: () => call('setup:magnet'),
    openDefaultApps: () => call('setup:openDefaultApps'),
  },
  update: {
    status: () => call('update:status'),
    check: () => call('update:check'),
    download: () => call('update:download'),
    install: () => call('update:install'),
  },
  onUpdateStatus: (fn) => on('update:status', fn),
  onSetupShow: (fn) => on('setup:show', fn),
  onTasks: (fn) => on('tasks:update', fn),
  onStats: (fn) => on('tasks:stats', fn),
  onClipboardLink: (fn) => on('clipboard:link', fn),
  onToolProgress: (fn) => on('tools:progress', fn),
});
