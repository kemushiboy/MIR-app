'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const fs = require('fs');
const path = require('path');
const ff = require('./ffmpeg');
const { buildPlan } = require('./command');
const C = require('./codecs');

let win = null;
let currentJob = null;

const VIDEO_EXTS = ['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi', 'mxf', 'ts', 'm2ts', 'mts', 'mpg', 'mpeg', 'wmv', 'flv', 'y4m'];
const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'];

function createWindow() {
  win = new BrowserWindow({
    width: 1500,
    height: 920,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#16181d',
    title: 'MIR-app',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // macOS はメニューが無いと Cmd+Q / Cmd+C・V などが効かないため最小限のメニューを置く
  Menu.setApplicationMenu(process.platform === 'darwin'
    ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }])
    : null);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.on('close', (e) => {
    if (currentJob) {
      const r = dialog.showMessageBoxSync(win, {
        type: 'warning', buttons: ['書き出しを中止して終了', 'キャンセル'], defaultId: 1, cancelId: 1,
        message: '書き出し中です。終了しますか？',
      });
      if (r !== 0) e.preventDefault();
      else currentJob.cancel();
    }
  });

  // 開発用: MIR_APP_SCREENSHOT=<png> で起動するとスクリーンショットを保存して終了
  if (process.env.MIR_APP_SCREENSHOT) {
    win.webContents.on('console-message', (e) => console.log(`[renderer:${e.level}] ${e.message}`));
    let shot = false;
    const capture = async () => {
      if (shot) return;
      shot = true;
      await new Promise((r) => setTimeout(r, Number(process.env.MIR_APP_SCREENSHOT_DELAY || 2500)));
      const img = await win.webContents.capturePage();
      fs.writeFileSync(process.env.MIR_APP_SCREENSHOT, img.toPNG());
      app.exit(0);
    };
    ipcMain.once('dev:ready', capture);
    setTimeout(capture, 30000);
  }
}

const safe = (fn) => async (_e, ...args) => {
  try {
    return { ok: true, value: await fn(...args) };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
};

ipcMain.handle('app:info', safe(async () => ({
  version: app.getVersion(),
  ffmpegPath: ff.FFMPEG,
  ffmpegVersion: await ff.version(),
  platform: process.platform,
  devFiles: process.env.MIR_APP_OPEN ? process.env.MIR_APP_OPEN.split(path.delimiter) : [],
  devPreset: process.env.MIR_APP_PRESET || null,
  devTab: process.env.MIR_APP_TAB || null,
  devSelect: Number(process.env.MIR_APP_SELECT) || 0,
  devWs: process.env.MIR_APP_WS || null,
  devSimView: process.env.MIR_APP_SIMVIEW || null,
})));

ipcMain.handle('app:hw', safe(() => ff.hwCaps()));

ipcMain.handle('app:caps', safe(async () => {
  const caps = await ff.capabilitiesNow();
  return {
    ...caps,
    codecs: C.CODECS,
    containers: C.CONTAINERS,
    qualities: C.QUALITY_PRESETS,
    hwLabels: C.HW_LABELS,
    sourceCodecMap: C.SOURCE_CODEC_MAP,
  };
}));

ipcMain.handle('dialog:openVideos', safe(async (multi = true) => {
  const r = await dialog.showOpenDialog(win, {
    title: 'ソース動画を選択',
    properties: multi ? ['openFile', 'multiSelections'] : ['openFile'],
    filters: [{ name: '動画', extensions: VIDEO_EXTS }, { name: 'すべてのファイル', extensions: ['*'] }],
  });
  return r.canceled ? [] : r.filePaths;
}));

ipcMain.handle('dialog:openMedia', safe(async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '映像または画像を選択',
    properties: ['openFile'],
    filters: [
      { name: '動画・画像', extensions: [...VIDEO_EXTS, ...IMAGE_EXTS] },
      { name: 'すべてのファイル', extensions: ['*'] },
    ],
  });
  return r.canceled ? null : r.filePaths[0];
}));

ipcMain.handle('dialog:saveOutput', safe(async (defaultPath, ext) => {
  const r = await dialog.showSaveDialog(win, {
    title: '書き出し先',
    defaultPath,
    filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
  });
  return r.canceled ? null : r.filePath;
}));

ipcMain.handle('media:probe', safe((file) => ff.probe(file)));
ipcMain.handle('media:frame', safe((file, time, maxWidth) => ff.extractFrame(file, time, maxWidth)));

ipcMain.handle('export:plan', safe(async (job) => {
  const caps = await ff.capabilitiesNow();
  const plan = buildPlan(job, caps);
  return { ...plan, command: formatCommand(plan.args) };
}));

ipcMain.handle('export:previewFrame', safe(async (job, time) => {
  const caps = await ff.capabilitiesNow();
  const file = ff.tempFile('png');
  const plan = buildPlan(job, caps, { preview: { time, file } });
  return ff.renderPreview(plan.args);
}));

ipcMain.handle('export:start', safe(async (job) => {
  if (currentJob) throw new Error('書き出し中です。');
  const caps = await ff.capabilities();
  const plan = buildPlan(job, caps);
  if (!plan.outPath) throw new Error('書き出し先が指定されていません。');
  const usedInputs = new Set(job.sources.map((s) => path.resolve(s.path).toLowerCase()));
  if (usedInputs.has(path.resolve(plan.outPath).toLowerCase())) throw new Error('書き出し先がソース動画と同じです。');
  if (fs.existsSync(plan.outPath)) {
    const r = await dialog.showMessageBox(win, {
      type: 'question', buttons: ['上書き', 'キャンセル'], defaultId: 1, cancelId: 1,
      message: `${path.basename(plan.outPath)} は既に存在します。上書きしますか？`,
    });
    if (r.response !== 0) return { started: false };
  }
  fs.mkdirSync(path.dirname(plan.outPath), { recursive: true });
  const send = (ch, data) => win && !win.isDestroyed() && win.webContents.send(ch, data);
  const job2 = new ff.ExportJob(plan.args, plan.duration, plan.totalFrames, {
    onProgress: (p) => {
      if (win && !win.isDestroyed()) win.setProgressBar(Math.max(0.0001, p.ratio));
      send('export:progress', p);
    },
    onLog: (s) => send('export:log', s),
  });
  currentJob = job2;
  send('export:log', `$ ${formatCommand(plan.args)}\n\n`);
  win.setProgressBar(0.0001);
  job2.start().then((res) => {
    currentJob = null;
    if (win && !win.isDestroyed()) win.setProgressBar(-1);
    if (res.cancelled) fs.rmSync(plan.outPath, { force: true }); // 中断時は不完全なファイルを消す
    send('export:done', { ...res, outPath: plan.outPath });
  });
  return { started: true, outPath: plan.outPath, info: plan.info };
}));

ipcMain.handle('export:cancel', safe(() => {
  if (currentJob) currentJob.cancel();
  return true;
}));

ipcMain.handle('project:save', safe(async (data, currentPath) => {
  let file = currentPath;
  if (!file) {
    const r = await dialog.showSaveDialog(win, {
      title: 'レイアウトを保存',
      defaultPath: 'layout.mlayout.json',
      filters: [{ name: 'MIR-app プロジェクト', extensions: ['json'] }],
    });
    if (r.canceled) return null;
    file = r.filePath;
  }
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  return file;
}));

ipcMain.handle('project:open', safe(async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'レイアウトを開く',
    properties: ['openFile'],
    filters: [{ name: 'MIR-app プロジェクト', extensions: ['json'] }],
  });
  if (r.canceled) return null;
  const file = r.filePaths[0];
  return { path: file, data: JSON.parse(fs.readFileSync(file, 'utf8')) };
}));

ipcMain.handle('fs:exists', safe((p) => fs.existsSync(p)));
ipcMain.handle('shell:showItem', safe((p) => shell.showItemInFolder(p)));
ipcMain.on('dev:ready-signal', () => ipcMain.emit('dev:ready'));

function formatCommand(args) {
  const q = (a) => (/[\s"'&|<>^;\[\]()]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
  return ['ffmpeg', ...args.map(q)].join(' ');
}

app.whenReady().then(() => {
  ff.hwCaps(); // 起動時に機能検出を始めておく
  createWindow();
});
app.on('window-all-closed', () => app.quit());
