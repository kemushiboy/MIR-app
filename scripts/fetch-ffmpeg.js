#!/usr/bin/env node
/**
 * FFmpeg / FFprobe の静的ビルドを vendor/ffmpeg/<platform>-<arch>/ に取得する。
 *
 *   node scripts/fetch-ffmpeg.js                     # 現在のプラットフォーム
 *   node scripts/fetch-ffmpeg.js --mac               # macOS arm64 + x64 の両方
 *   node scripts/fetch-ffmpeg.js --win               # Windows x64
 *   node scripts/fetch-ffmpeg.js --target darwin-x64 # 個別指定 (複数可)
 *   node scripts/fetch-ffmpeg.js --force             # 取得済みでも再取得
 *
 * Windows / Linux : BtbN/FFmpeg-Builds (GPL, 最新の安定リリースブランチ)
 * macOS           : ffmpeg.martin-riedl.de (arm64 / x64 の静的リリースビルド)
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const HOST = `${process.platform}-${process.arch}`;
const argv = process.argv.slice(2);
const force = argv.includes('--force');

function parseTargets() {
  const t = new Set();
  argv.forEach((a, i) => {
    if (a === '--mac') ['darwin-arm64', 'darwin-x64'].forEach((x) => t.add(x));
    if (a === '--win') t.add('win32-x64');
    if (a === '--linux') t.add('linux-x64');
    if (a === '--target' && argv[i + 1]) t.add(argv[i + 1]);
  });
  if (!t.size) t.add(HOST);
  return [...t];
}

function get(url, { json = false } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'MIR-app-fetch-ffmpeg' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        resolve(get(new URL(res.headers.location, url).toString(), { json }));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}: ${url}`));
        return;
      }
      if (json) {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
        });
      } else {
        resolve(res);
      }
    });
    req.on('error', reject);
  });
}

async function download(url, file) {
  const res = await get(url);
  const total = Number(res.headers['content-length'] || 0);
  let done = 0;
  let lastPct = -1;
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(file);
    res.on('data', (chunk) => {
      done += chunk.length;
      if (total) {
        const pct = Math.floor((done / total) * 100);
        if (pct !== lastPct && pct % 5 === 0) {
          process.stdout.write(`\r  ${pct}% (${(done / 1e6).toFixed(0)} / ${(total / 1e6).toFixed(0)} MB)`);
          lastPct = pct;
        }
      }
    });
    res.pipe(out);
    out.on('finish', resolve);
    out.on('error', reject);
    res.on('error', reject);
  });
  process.stdout.write('\n');
}

function findFile(dir, name) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const r = findFile(p, name);
      if (r) return r;
    } else if (entry.name === name) {
      return p;
    }
  }
  return null;
}

function versionOf(name) {
  const m = name.match(/-n(\d+)\.(\d+)-/);
  return m ? Number(m[1]) * 1000 + Number(m[2]) : -1;
}

async function resolveBtbNAssets(target) {
  const key = { 'win32-x64': 'win64', 'win32-arm64': 'winarm64', 'linux-x64': 'linux64', 'linux-arm64': 'linuxarm64' }[target];
  const rel = await get('https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/tags/latest', { json: true });
  const ext = target.startsWith('win32') ? 'zip' : 'tar\\.xz';
  const re = new RegExp(`^ffmpeg-n\\d+\\.\\d+-latest-${key}-gpl-\\d+\\.\\d+\\.${ext}$`);
  const assets = rel.assets.filter((a) => re.test(a.name)).sort((a, b) => versionOf(b.name) - versionOf(a.name));
  if (!assets.length) throw new Error(`BtbN のリリースに ${key} 向けアセットが見つかりません`);
  return [{ name: assets[0].name, url: assets[0].browser_download_url }];
}

function resolveMacAssets(target) {
  const arch = target === 'darwin-arm64' ? 'arm64' : 'amd64';
  const base = `https://ffmpeg.martin-riedl.de/redirect/latest/macos/${arch}/release`;
  return [
    { name: 'ffmpeg.zip', url: `${base}/ffmpeg.zip` },
    { name: 'ffprobe.zip', url: `${base}/ffprobe.zip` },
  ];
}

async function resolveAssets(target) {
  if (['win32-x64', 'win32-arm64', 'linux-x64', 'linux-arm64'].includes(target)) return resolveBtbNAssets(target);
  if (['darwin-arm64', 'darwin-x64'].includes(target)) return resolveMacAssets(target);
  throw new Error(`未対応のプラットフォーム: ${target}  (環境変数 FFMPEG_PATH / FFPROBE_PATH を指定してください)`);
}

/** 取得したバイナリが目的の OS / CPU 向けかをヘッダで確認する */
function checkBinary(file, target) {
  const b = Buffer.alloc(20);
  const fd = fs.openSync(file, 'r');
  fs.readSync(fd, b, 0, 20, 0);
  fs.closeSync(fd);
  if (target.startsWith('win32')) {
    if (b.toString('latin1', 0, 2) !== 'MZ') throw new Error(`${file} は Windows 実行ファイルではありません`);
  } else if (target.startsWith('darwin')) {
    const magic = b.readUInt32LE(0);
    if (magic !== 0xfeedfacf) throw new Error(`${file} は 64bit Mach-O ではありません (universal 等は未対応)`);
    const cpu = b.readUInt32LE(4);
    const want = target === 'darwin-arm64' ? 0x0100000c : 0x01000007;
    if (cpu !== want) throw new Error(`${file} の CPU 種別が ${target} と一致しません`);
  } else if (b.toString('latin1', 1, 4) !== 'ELF') {
    throw new Error(`${file} は ELF ではありません`);
  }
}

async function fetchTarget(target) {
  const exe = target.startsWith('win32') ? '.exe' : '';
  const destDir = path.join(ROOT, 'vendor', 'ffmpeg', target);
  const ffmpegOut = path.join(destDir, `ffmpeg${exe}`);
  const ffprobeOut = path.join(destDir, `ffprobe${exe}`);
  if (!force && fs.existsSync(ffmpegOut) && fs.existsSync(ffprobeOut)) {
    console.log(`[${target}] 取得済み: ${destDir}`);
    return;
  }
  const assets = await resolveAssets(target);

  // ダウンロード物は専用の空ディレクトリに展開する
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mir-app-ffmpeg-'));
  try {
    for (const a of assets) {
      const archive = path.join(work, a.name);
      console.log(`[${target}] ダウンロード: ${a.url}`);
      await download(a.url, archive);
      const extractDir = path.join(work, 'x-' + path.basename(a.name).replace(/\W/g, '_'));
      fs.mkdirSync(extractDir);
      // Windows 10 以降 / macOS / Linux の tar (bsdtar / GNU tar) は zip・tar.xz の両方を展開できる
      execFileSync('tar', ['-xf', archive, '-C', extractDir], { stdio: 'inherit' });
    }
    fs.mkdirSync(destDir, { recursive: true });
    for (const name of [`ffmpeg${exe}`, `ffprobe${exe}`]) {
      const found = findFile(work, name);
      if (!found) throw new Error(`アーカイブ内に ${name} が見つかりません`);
      checkBinary(found, target);
      const dst = path.join(destDir, name);
      fs.copyFileSync(found, dst);
      if (!exe) fs.chmodSync(dst, 0o755);
    }
    const license = findFile(work, 'LICENSE.txt');
    if (license) fs.copyFileSync(license, path.join(destDir, 'LICENSE.txt'));
    fs.writeFileSync(path.join(destDir, 'SOURCE.txt'), assets.map((a) => a.url).join('\n') + '\n');
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
  let ver = '(別プラットフォーム向けのため実行確認はスキップ)';
  if (target === HOST || (HOST === 'darwin-arm64' && target === 'darwin-x64')) {
    try {
      ver = execFileSync(ffmpegOut, ['-hide_banner', '-version']).toString().split('\n')[0];
    } catch (e) {
      ver = `実行確認に失敗: ${e.message}`;
    }
  }
  console.log(`[${target}] 完了: ${destDir}\n  ${ver}`);
}

(async () => {
  for (const t of parseTargets()) await fetchTarget(t);
})().catch((e) => {
  console.error('FFmpeg の取得に失敗しました:', e.message);
  process.exit(1);
});
