/**
 * README 用スクリーンショットの撮影ハーネス (scripts/make-screenshots.js から起動される)。
 * 本物の main.js を読み込んでアプリを起動し、画面を操作しながら docs/images/ に保存する。
 */
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'docs', 'images');
require(path.join(ROOT, 'src', 'main', 'main.js'));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  let w;
  for (let i = 0; i < 50 && !(w = BrowserWindow.getAllWindows()[0]); i++) await wait(200);
  w.setContentSize(1600, 920);
  w.center();
  const js = (code) => w.webContents.executeJavaScript(code);
  const shot = async (name) => {
    // ステータスバーに環境固有の情報 (ファイルのパスや GPU 名) が出ないようにする
    await js("setStatus('準備完了')");
    await wait(400);
    const img = await w.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, `${name}.png`), img.toPNG());
    console.log('saved', name);
  };
  try {
    await wait(6000); // ソースの読み込み・プリセット適用 (MIR_APP_OPEN / MIR_APP_PRESET) を待つ
    // レイアウト編集: 再生位置を少し進めた状態
    await js("Player.seek(2.5); $('timeSlider').value = 2.5; $('timeSlider').dispatchEvent(new Event('input'))");
    await wait(1500);
    await shot('layout');
    // 書き出しタブ (出力先は例として一般的なパスにする)
    await js("showTab('export'); { const el = $('outPath'); el.value = 'C:\\\\Videos\\\\testpattern_layout_3840x2160.mp4'; el.dispatchEvent(new Event('change')); }");
    await wait(1500);
    await shot('export');
    await js("showTab('layout')");
    // 投影シミュレーター: 人物・インタラクション範囲・グリッドを表示
    await js("App.show('simulator')");
    await wait(1500);
    await js("['simOptFigures', 'simOptZones', 'simOptGrid'].forEach((id) => { const el = $(id); if (!el.checked) el.click(); })");
    await wait(1000);
    await shot('simulator-elevation');
    // 目線の画面は、壁と人物が収まるよう少し下がって広角 (壁から 4m・24mm) で撮る
    await js("{ const el = $('simPosZ'); el.value = 4; el.dispatchEvent(new Event('change')); } $('simFocalSeg').querySelector('[data-v=\"24\"]').click();");
    await js("SimulatorWorkspace.setView('eye')");
    await wait(1200);
    await shot('simulator-eye');
    await js("SimulatorWorkspace.setView('compare')");
    await wait(1200);
    await shot('simulator-compare');
  } catch (e) {
    console.error('ERROR', e);
    app.exit(1);
    return;
  }
  app.exit(0);
});
