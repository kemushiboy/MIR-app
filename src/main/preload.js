'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const call = async (ch, ...args) => {
  const r = await ipcRenderer.invoke(ch, ...args);
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

contextBridge.exposeInMainWorld('api', {
  info: () => call('app:info'),
  caps: () => call('app:caps'),
  hw: () => call('app:hw'),
  openVideos: (multi) => call('dialog:openVideos', multi),
  openMedia: () => call('dialog:openMedia'),
  saveOutputDialog: (defaultPath, ext) => call('dialog:saveOutput', defaultPath, ext),
  probe: (file) => call('media:probe', file),
  frame: (file, time, maxWidth) => call('media:frame', file, time, maxWidth),
  plan: (job) => call('export:plan', job),
  previewFrame: (job, time) => call('export:previewFrame', job, time),
  startExport: (job) => call('export:start', job),
  cancelExport: () => call('export:cancel'),
  saveProject: (data, path) => call('project:save', data, path),
  openProject: () => call('project:open'),
  exists: (p) => call('fs:exists', p),
  showItem: (p) => call('shell:showItem', p),
  pathForFile: (file) => webUtils.getPathForFile(file),
  onProgress: (cb) => ipcRenderer.on('export:progress', (_e, d) => cb(d)),
  onLog: (cb) => ipcRenderer.on('export:log', (_e, d) => cb(d)),
  onDone: (cb) => ipcRenderer.on('export:done', (_e, d) => cb(d)),
  devReady: () => ipcRenderer.send('dev:ready-signal'),
});
