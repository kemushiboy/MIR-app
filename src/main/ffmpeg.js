'use strict';
/**
 * 同梱 FFmpeg の実行まわり (パス解決 / probe / フレーム抽出 / 機能検出 / 書き出し)。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');
const C = require('./codecs');

const exe = process.platform === 'win32' ? '.exe' : '';

function resolveBinary(name) {
  const envKey = name === 'ffmpeg' ? 'FFMPEG_PATH' : 'FFPROBE_PATH';
  if (process.env[envKey] && fs.existsSync(process.env[envKey])) return process.env[envKey];
  const platformKey = `${process.platform}-${process.arch}`;
  const candidates = [];
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'ffmpeg', name + exe));
  candidates.push(path.join(__dirname, '..', '..', 'vendor', 'ffmpeg', platformKey, name + exe));
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return name + exe; // PATH 上のものにフォールバック
}

const FFMPEG = resolveBinary('ffmpeg');
const FFPROBE = resolveBinary('ffprobe');

function run(bin, args, { maxBuffer = 64 * 1024 * 1024, encoding = 'utf8', timeout = 0 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { maxBuffer, encoding, timeout, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr ? stderr.toString() : '';
        reject(err);
      } else resolve({ stdout, stderr });
    });
  });
}

async function version() {
  try {
    const { stdout } = await run(FFMPEG, ['-hide_banner', '-version']);
    return stdout.split('\n')[0].trim();
  } catch (e) {
    return null;
  }
}

// ------------------------------------------------------------------
// probe
// ------------------------------------------------------------------

function rotationOf(stream) {
  const sd = (stream.side_data_list || []).find((d) => d.rotation != null);
  if (sd) return Number(sd.rotation) || 0;
  if (stream.tags && stream.tags.rotate) return Number(stream.tags.rotate) || 0;
  return 0;
}

async function probe(file) {
  const { stdout } = await run(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  const j = JSON.parse(stdout);
  const streams = j.streams || [];
  const v = streams.find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
  if (!v) throw new Error('映像ストリームが見つかりません。');
  const fmt = j.format || {};
  const rRate = v.r_frame_rate && v.r_frame_rate !== '0/0' ? v.r_frame_rate : null;
  const aRate = v.avg_frame_rate && v.avg_frame_rate !== '0/0' ? v.avg_frame_rate : null;
  const rv = (r) => { const [n, d] = String(r).split('/').map(Number); return d ? n / d : n; };
  // r_frame_rate がフィールドレート等で極端に大きい場合は avg を採用
  let fps = rRate || aRate || '30';
  if (rRate && aRate && rv(rRate) > rv(aRate) * 1.9) fps = aRate;
  const audio = streams
    .filter((s) => s.codec_type === 'audio')
    .map((a) => ({
      index: a.index,
      codec: a.codec_name,
      channels: a.channels,
      layout: a.channel_layout,
      sampleRate: Number(a.sample_rate) || 0,
      bitrate: Number(a.bit_rate) || 0,
    }));
  let bitrate = Number(v.bit_rate) || 0;
  if (!bitrate && fmt.bit_rate) {
    bitrate = Number(fmt.bit_rate) - audio.reduce((s, a) => s + (a.bitrate || 0), 0);
  }
  const duration = Number(v.duration) || Number(fmt.duration) || 0;
  return {
    path: file,
    name: path.basename(file),
    size: Number(fmt.size) || 0,
    container: fmt.format_name,
    codec: v.codec_name,
    codecLong: v.codec_long_name,
    profile: v.profile || '',
    width: v.width,
    height: v.height,
    pixFmt: v.pix_fmt,
    bitDepth: (C.pixFmtInfo(v.pix_fmt) || {}).depth || 8,
    fps,
    fpsValue: rv(fps),
    duration,
    bitrate: bitrate > 0 ? bitrate : 0,
    fieldOrder: v.field_order || 'progressive',
    sar: v.sample_aspect_ratio || '1:1',
    rotation: rotationOf(v),
    color: {
      primaries: v.color_primaries && v.color_primaries !== 'unknown' ? v.color_primaries : null,
      transfer: v.color_transfer && v.color_transfer !== 'unknown' ? v.color_transfer : null,
      space: v.color_space && v.color_space !== 'unknown' ? v.color_space : null,
      range: v.color_range && v.color_range !== 'unknown' ? v.color_range : null,
    },
    audio,
  };
}

// ------------------------------------------------------------------
// フレーム抽出 (プレビュー用、全コーデック対応のため ffmpeg でデコード)
// ------------------------------------------------------------------

function extractFrame(file, time, maxWidth = 1280) {
  return new Promise((resolve, reject) => {
    const args = ['-hide_banner', '-loglevel', 'error'];
    if (time > 0) args.push('-ss', String(time));
    args.push('-i', file, '-frames:v', '1', '-vf', `scale='min(${maxWidth},iw)':-2:flags=bilinear`, '-f', 'image2pipe', '-c:v', 'mjpeg', '-q:v', '3', '-');
    const p = spawn(FFMPEG, args, { windowsHide: true });
    const chunks = [];
    let err = '';
    p.stdout.on('data', (c) => chunks.push(c));
    p.stderr.on('data', (c) => (err += c));
    p.on('error', reject);
    p.on('close', (code) => {
      const buf = Buffer.concat(chunks);
      if (code === 0 && buf.length) resolve('data:image/jpeg;base64,' + buf.toString('base64'));
      else reject(new Error(err.trim() || `フレームを取得できませんでした (code ${code})`));
    });
  });
}

// ------------------------------------------------------------------
// 機能検出
// ------------------------------------------------------------------

const CANDIDATE_ENCODERS = [...new Set(Object.values(C.CODECS).flatMap((c) => [...c.sw, ...Object.values(c.hw)]))];
const HW_ENCODERS = [...new Set(Object.values(C.CODECS).flatMap((c) => Object.values(c.hw)))];

async function testHwEncoder(enc) {
  const pix = /qsv/.test(enc) ? 'nv12' : 'yuv420p';
  try {
    await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=1280x720:r=30:d=0.2',
      '-frames:v', '3', '-pix_fmt', pix, '-c:v', enc, '-f', 'null', '-'], { timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

let encodersPromise = null;
let hwPromise = null;
let hwResult = null;

/** 同梱 FFmpeg に含まれるエンコーダと対応ピクセルフォーマット (高速) */
function encoderCaps() {
  if (encodersPromise) return encodersPromise;
  encodersPromise = (async () => {
    const encoders = {};
    let listed = '';
    try {
      listed = (await run(FFMPEG, ['-hide_banner', '-encoders'], { timeout: 20000 })).stdout;
    } catch {
      return { encoders, ok: false };
    }
    const names = new Set(listed.split('\n').map((l) => l.trim().split(/\s+/)[1]).filter(Boolean));
    await Promise.all(
      CANDIDATE_ENCODERS.filter((e) => names.has(e)).map(async (e) => {
        try {
          const { stdout } = await run(FFMPEG, ['-hide_banner', '-h', `encoder=${e}`], { timeout: 20000 });
          const m = stdout.match(/Supported pixel formats:\s*(.+)/);
          encoders[e] = { pixFmts: m ? m[1].trim().split(/\s+/) : null };
        } catch {
          encoders[e] = { pixFmts: null };
        }
      })
    );
    return { encoders, ok: true };
  })();
  return encodersPromise;
}

/** 実際にエンコードを試して使える HW エンコーダを調べる (GPU/ドライバ次第で数秒かかる) */
function hwCaps() {
  if (hwPromise) return hwPromise;
  hwPromise = (async () => {
    const { encoders } = await encoderCaps();
    const list = HW_ENCODERS.filter((e) => encoders[e]);
    const ok = await Promise.all(list.map(testHwEncoder));
    hwResult = list.filter((_, i) => ok[i]);
    return hwResult;
  })();
  return hwPromise;
}

/** エンコーダ情報 + HW 検出結果 (すべて完了まで待つ) */
async function capabilities() {
  const [e, hw] = await Promise.all([encoderCaps(), hwCaps()]);
  return { ...e, hwWorking: hw };
}

/** HW 検出を待たずに返す (未完了なら hwWorking は null = 未確認) */
async function capabilitiesNow() {
  const e = await encoderCaps();
  return { ...e, hwWorking: hwResult };
}

// ------------------------------------------------------------------
// 書き出し
// ------------------------------------------------------------------

class ExportJob {
  constructor(args, duration, totalFrames, { onProgress, onLog }) {
    this.args = args;
    this.duration = duration;
    this.totalFrames = totalFrames;
    this.onProgress = onProgress;
    this.onLog = onLog;
    this.proc = null;
    this.cancelled = false;
    this.tail = [];
  }

  start() {
    return new Promise((resolve) => {
      const started = Date.now();
      this.proc = spawn(FFMPEG, this.args, { windowsHide: true });
      let buf = '';
      const state = {};
      this.proc.stdout.on('data', (chunk) => {
        buf += chunk.toString();
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          const eq = line.indexOf('=');
          if (eq < 0) continue;
          const k = line.slice(0, eq);
          const v = line.slice(eq + 1);
          state[k] = v;
          if (k === 'progress') {
            // 音声コピー時は out_time が映像より先行するため、映像のフレーム数で進捗を出す
            const frame = Number(state.frame) || 0;
            const us = Number(state.out_time_us || state.out_time_ms || 0);
            const t = us > 0 ? us / 1e6 : 0;
            const ratio = v === 'end' ? 1 : this.totalFrames > 0 ? Math.min(1, frame / this.totalFrames)
              : this.duration > 0 ? Math.min(1, t / this.duration) : 0;
            const elapsed = (Date.now() - started) / 1000;
            this.onProgress({
              ratio,
              time: t,
              frame,
              fps: Number(state.fps) || 0,
              speed: state.speed,
              bitrate: state.bitrate,
              size: Number(state.total_size) || 0,
              elapsed,
              eta: ratio > 0.001 ? (elapsed / ratio) * (1 - ratio) : null,
              done: v === 'end',
            });
          }
        }
      });
      this.proc.stderr.on('data', (chunk) => {
        const s = chunk.toString();
        this.tail.push(s);
        if (this.tail.length > 200) this.tail.shift();
        this.onLog(s);
      });
      this.proc.on('error', (e) => resolve({ ok: false, error: e.message }));
      this.proc.on('close', (code) => {
        if (this.cancelled) resolve({ ok: false, cancelled: true });
        else if (code === 0) resolve({ ok: true, elapsed: (Date.now() - started) / 1000 });
        else resolve({ ok: false, error: lastError(this.tail.join('')) || `ffmpeg が終了コード ${code} で終了しました。` });
      });
    });
  }

  cancel() {
    if (!this.proc || this.proc.exitCode != null) return;
    this.cancelled = true;
    try {
      this.proc.stdin.write('q');
    } catch { /* ignore */ }
    setTimeout(() => {
      if (this.proc.exitCode == null) this.proc.kill();
    }, 3000);
  }
}

function lastError(log) {
  const lines = log.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const errs = lines.filter((l) => /error|invalid|failed|not supported|unable|cannot/i.test(l));
  return (errs.length ? errs.slice(-3) : lines.slice(-3)).join('\n');
}

async function renderPreview(args) {
  const tmp = args[args.length - 1];
  try {
    await run(FFMPEG, args, { timeout: 120000 });
    const data = fs.readFileSync(tmp);
    return 'data:image/png;base64,' + data.toString('base64');
  } catch (e) {
    throw new Error(lastError(e.stderr || e.message));
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

function tempFile(ext) {
  return path.join(os.tmpdir(), `movielayout-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`);
}

module.exports = {
  FFMPEG, FFPROBE, version, probe, extractFrame, capabilities, capabilitiesNow, encoderCaps, hwCaps,
  ExportJob, renderPreview, tempFile,
};
