'use strict';
/**
 * レイアウトジョブ → ffmpeg 引数 への変換。
 * Electron に依存しない純粋関数 (scripts/test-export.js からも使う)。
 *
 * ジョブ形式:
 * {
 *   sources: [{ path, offset, probe }],
 *   canvas:  { width, height, fps: 'auto' | '30000/1001' | '60', background: '#000000' },
 *   tiles:   [{ source, crop: {x,y,w,h}, dest: {x,y,w,h} }],
 *   output:  { path, container, codec, hw, quality, bitrateMbps, pixFmt,
 *              audio: { mode: 'none'|'source'|'mix', source },
 *              duration: { mode: 'shortest'|'longest'|'custom', seconds } }
 * }
 */
const path = require('path');
const C = require('./codecs');

function parseRate(r) {
  if (r == null) return 0;
  if (typeof r === 'number') return r;
  const [n, d] = String(r).split('/').map(Number);
  if (!d) return n || 0;
  return n / d;
}

function hexColor(c) {
  const m = /^#?([0-9a-f]{6})$/i.exec(c || '');
  return m ? `0x${m[1]}` : '0x000000';
}

function rectsOverlap(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function containerOfPath(p) {
  const ext = path.extname(p || '').slice(1).toLowerCase();
  return C.EXT_TO_CONTAINER[ext] || null;
}

function fmtSec(s) {
  return (Math.max(0, s) || 0).toFixed(6).replace(/\.?0+$/, '') || '0';
}

/** 出力に使うソース (最初のタイルのソース) */
function primarySourceIndex(job) {
  const t = job.tiles.find((t) => job.sources[t.source]);
  return t ? t.source : 0;
}

/** タイルが使うソース領域のビットレートを面積比で積算した推定値 (bps) */
function estimateBitrate(job, outFps) {
  let total = 0;
  for (const t of job.tiles) {
    const s = job.sources[t.source];
    if (!s || !s.probe) continue;
    const p = s.probe;
    const fps = p.fpsValue || 30;
    const br = p.bitrate || p.width * p.height * fps * 0.15; // 不明なら 0.15 bpp
    const bpp = br / (p.width * p.height * fps);
    total += bpp * t.dest.w * t.dest.h * (outFps || fps);
  }
  return Math.round(total * 1.15); // 再圧縮ぶんの余裕
}

function resolveDuration(job) {
  const lens = [];
  const used = new Set(job.tiles.map((t) => t.source));
  for (const i of used) {
    const s = job.sources[i];
    if (s && s.probe && s.probe.duration > 0) lens.push(Math.max(0, s.probe.duration - (s.offset || 0)));
  }
  const d = job.output.duration || { mode: 'shortest' };
  if (d.mode === 'custom' && d.seconds > 0) return d.seconds;
  if (!lens.length) return 0;
  return d.mode === 'longest' ? Math.max(...lens) : Math.min(...lens);
}

/**
 * 映像エンコード設定を決める。
 * @returns {{codecKey, encoder, pixFmt, filterFmt, args, profileLabel, notes:string[]}}
 */
function resolveVideoEncoding(job, caps, notes) {
  const out = job.output;
  const prim = job.sources[primarySourceIndex(job)].probe;
  const srcCodec = prim.codec;
  let codecKey = out.codec === 'source' || !out.codec ? C.SOURCE_CODEC_MAP[srcCodec] : out.codec;
  if (!codecKey) {
    codecKey = 'h264';
    notes.push(`ソースのコーデック「${srcCodec}」には対応するエンコーダがないため H.264 で出力します。`);
  }
  const def = C.CODECS[codecKey];
  const has = (e) => !caps || !caps.encoders || !!caps.encoders[e];
  const hwOk = (e) => !caps || !caps.hwWorking || caps.hwWorking.includes(e);

  let quality = out.quality || 'visually_lossless';
  let encoder = null;
  const hw = out.hw && out.hw !== 'none' ? out.hw : null;
  if (hw && def.hw[hw]) {
    const e = def.hw[hw];
    if (quality === 'lossless') notes.push('ロスレスはハードウェアエンコーダ非対応のため、ソフトウェアエンコーダを使用します。');
    else if (has(e) && hwOk(e)) encoder = e;
    else notes.push(`${C.HW_LABELS[hw]} (${e}) が利用できないため、ソフトウェアエンコーダを使用します。`);
  } else if (hw) {
    notes.push(`${def.label} は ${C.HW_LABELS[hw]} に対応していないため、ソフトウェアエンコーダを使用します。`);
  }
  if (!encoder) {
    let list = def.sw;
    if (quality === 'lossless' && codecKey === 'av1') list = ['libaom-av1']; // SVT-AV1 はロスレス非対応
    encoder = list.find(has);
    if (!encoder) throw new Error(`${def.label} のエンコーダ (${list.join(', ')}) がこの FFmpeg に含まれていません。`);
  }
  if (quality === 'lossless' && def.intra && !def.lossless) {
    notes.push(`${def.label} にロスレスモードはありません。ソースと同じプロファイルで最高品質のまま再エンコードします。`);
  }

  const srcInfo = C.pixFmtInfo(prim.pixFmt);
  const wantFmt = out.pixFmt && out.pixFmt !== 'source' ? out.pixFmt : prim.pixFmt;
  let pixFmt;
  const args = [];
  let profileLabel = '';

  if (codecKey === 'prores') {
    const prof = C.proresProfileFrom(srcCodec, prim.profile, srcInfo);
    profileLabel = `ProRes ${C.PRORES_NAMES[prof]}`;
    const wantInfo = C.pixFmtInfo(wantFmt);
    pixFmt = prof >= 4 ? (wantInfo && wantInfo.alpha ? 'yuva444p10le' : 'yuv444p10le') : 'yuv422p10le';
    args.push('-profile:v', String(prof), '-vendor', 'apl0');
  } else if (codecKey === 'dnxhr') {
    const prof = C.dnxhrProfileFrom(srcCodec, prim.profile, srcInfo);
    profileLabel = prof.replace('dnxhr_', 'DNxHR ').toUpperCase();
    pixFmt = C.DNXHR_PIXFMT[prof];
    args.push('-profile:v', prof);
  } else {
    const supported = caps && caps.encoders && caps.encoders[encoder] ? caps.encoders[encoder].pixFmts : null;
    const r = C.choosePixFmt(wantFmt, supported);
    pixFmt = r.pixFmt;
    // nv12 / p010 などは yuv420p / yuv420p10le と並びが違うだけ (無劣化) なので注意を出さない
    if (!r.exact && C.planarEquivalent(pixFmt) !== wantFmt.replace(/^yuvj/, 'yuv')) notes.push(`${encoder} は ${wantFmt} に非対応のため ${pixFmt} に変換します。`);
  }

  const outFps = parseRate(resolveFps(job));
  const bitrate = out.bitrateMbps > 0 ? out.bitrateMbps * 1e6 : estimateBitrate(job, outFps);
  args.push(...C.qualityArgs(encoder, quality, { bitrate }));
  if (quality === 'bitrate' && def.intra) notes.push(`${def.label} はプロファイルでビットレートが決まるため、ビットレート指定は無視されます。`);

  return { codecKey, encoder, pixFmt, filterFmt: C.planarEquivalent(pixFmt), args, profileLabel, bitrate, quality };
}

function resolveFps(job) {
  const f = job.canvas.fps;
  if (f && f !== 'auto') return String(f);
  const prim = job.sources[primarySourceIndex(job)].probe;
  return prim.fps || '30';
}

function resolveContainer(job, codecKey, notes) {
  const def = C.CODECS[codecKey];
  let c = job.output.container;
  if (!c || c === 'auto') {
    const prim = job.sources[primarySourceIndex(job)];
    const srcC = containerOfPath(prim.path);
    c = srcC && def.containers.includes(srcC) ? srcC : def.containers[0];
  } else if (!def.containers.includes(c)) {
    notes.push(`${C.CONTAINERS[c].label} は ${def.label} と相性が悪いため ${C.CONTAINERS[def.containers[0]].label} に変更しました。`);
    c = def.containers[0];
  }
  return c;
}

/** レイアウトを検証する。エラーは throw、注意点は warnings へ */
function validate(job, alignFmt, warnings) {
  if (!job.sources.length) throw new Error('ソース動画がありません。');
  if (!job.tiles.length) throw new Error('タイルがありません。');
  const W = job.canvas.width;
  const H = job.canvas.height;
  if (!(W > 0 && H > 0)) throw new Error('出力サイズが不正です。');
  const al = C.chromaAlign(alignFmt);
  if (W % al.x || H % al.y) throw new Error(`出力サイズ ${W}×${H} は ${alignFmt} では ${al.x}×${al.y} の倍数である必要があります。`);
  job.tiles.forEach((t, i) => {
    const s = job.sources[t.source];
    const n = `タイル ${i + 1}`;
    if (!s || !s.probe) throw new Error(`${n}: ソースが指定されていません。`);
    const { crop: c, dest: d } = t;
    if (c.w <= 0 || c.h <= 0 || d.w <= 0 || d.h <= 0) throw new Error(`${n}: サイズが 0 です。`);
    if (c.x < 0 || c.y < 0 || c.x + c.w > s.probe.width || c.y + c.h > s.probe.height) {
      throw new Error(`${n}: 切り出し範囲がソース (${s.probe.width}×${s.probe.height}) の外にはみ出しています。`);
    }
    if (d.x < 0 || d.y < 0 || d.x + d.w > W || d.y + d.h > H) {
      throw new Error(`${n}: 配置先がキャンバス (${W}×${H}) の外にはみ出しています。`);
    }
    if (d.w !== c.w || d.h !== c.h) warnings.push(`${n}: ${c.w}×${c.h} → ${d.w}×${d.h} に拡大縮小されます (等倍ではありません)。`);
    if (c.x % al.x || c.y % al.y || c.w % al.x || c.h % al.y || d.x % al.x || d.y % al.y || d.w % al.x || d.h % al.y) {
      warnings.push(`${n}: 座標/サイズが ${al.x}×${al.y} の倍数でないため、色差が半画素ずれる可能性があります。`);
    }
  });
}

/**
 * ffmpeg 引数を組み立てる。
 * @param {object} job
 * @param {object} caps   { encoders: {name:{pixFmts}}, hwWorking: [encoder] }
 * @param {object} [opts] { preview: { time, file } } を渡すと 1 フレームの PNG を出力する
 */
function buildPlan(job, caps, opts = {}) {
  const notes = [];
  const warnings = [];
  const preview = opts.preview || null;
  if (!job.sources.length) throw new Error('ソース動画がありません。');
  if (!job.tiles.length) throw new Error('タイルがありません。');
  if (!job.sources[primarySourceIndex(job)] || !job.sources[primarySourceIndex(job)].probe) throw new Error('ソースが読み込まれていません。');
  const enc = resolveVideoEncoding(job, caps, notes);
  validate(job, enc.filterFmt, warnings);
  const container = resolveContainer(job, enc.codecKey, notes);
  const fps = resolveFps(job);
  const fpsVal = parseRate(fps);
  const duration = resolveDuration(job);
  if (!preview && !(duration > 0)) throw new Error('出力の長さを決められません (ソースの長さが不明です)。尺を指定してください。');

  const W = job.canvas.width;
  const H = job.canvas.height;
  const bg = hexColor(job.canvas.background);

  // ---- 入力 ----
  const inputs = []; // { source, index }
  const inputOf = new Map();
  const addInput = (srcIdx) => {
    if (!inputOf.has(srcIdx)) {
      inputOf.set(srcIdx, inputs.length);
      inputs.push(srcIdx);
    }
    return inputOf.get(srcIdx);
  };
  job.tiles.forEach((t) => addInput(t.source));

  const audio = job.output.audio || { mode: 'none' };
  const audioInputs = [];
  if (!preview) {
    if (audio.mode === 'source') {
      const s = job.sources[audio.source];
      if (s && s.probe && s.probe.audio.length) audioInputs.push(addInput(audio.source));
      else if (s) notes.push('選択したソースに音声がないため、音声なしで出力します。');
    } else if (audio.mode === 'mix') {
      job.sources.forEach((s, i) => {
        if (s.probe && s.probe.audio.length) audioInputs.push(addInput(i));
      });
    }
  }

  const args = ['-hide_banner', '-y'];
  for (const srcIdx of inputs) {
    const s = job.sources[srcIdx];
    let ss = s.offset || 0;
    if (preview) {
      const maxT = Math.max(0, (s.probe.duration || 0) - 0.05);
      ss = Math.min(ss + preview.time, maxT || ss + preview.time);
    }
    if (ss > 0) args.push('-ss', fmtSec(ss));
    args.push('-i', s.path);
  }

  // ---- フィルタグラフ ----
  const g = ['sws_flags=lanczos+accurate_rnd+full_chroma_int'];
  const uses = new Map(); // input index → count
  job.tiles.forEach((t) => {
    const ii = inputOf.get(t.source);
    uses.set(ii, (uses.get(ii) || 0) + 1);
  });
  const streamLabels = new Map(); // input index → [labels]
  for (const [ii, count] of uses) {
    const s = job.sources[inputs[ii]];
    // シーク後の先頭フレームの時刻を 0 に揃える (ソース間の同期と overlay の先頭フレーム欠けを防ぐ)
    const chain = ['setpts=PTS-STARTPTS'];
    if (Math.abs((s.probe.fpsValue || fpsVal) - fpsVal) > 0.001) chain.push(`fps=${fps}`);
    const labels = Array.from({ length: count }, (_, k) => `s${ii}_${k}`);
    if (count > 1) chain.push(`split=${count}`);
    g.push(`[${ii}:v:0]${chain.join(',')}${labels.map((l) => `[${l}]`).join('')}`);
    streamLabels.set(ii, labels);
  }

  const overlaps = [];
  job.tiles.forEach((a, i) => job.tiles.forEach((b, j) => j > i && rectsOverlap(a.dest, b.dest) && overlaps.push([i + 1, j + 1])));
  const useOverlay = overlaps.length > 0;

  const tileLabels = [];
  job.tiles.forEach((t, k) => {
    const ii = inputOf.get(t.source);
    const s = job.sources[t.source];
    const inLabel = streamLabels.get(ii).shift();
    const chain = [];
    const { crop: c, dest: d } = t;
    if (c.x !== 0 || c.y !== 0 || c.w !== s.probe.width || c.h !== s.probe.height) chain.push(`crop=${c.w}:${c.h}:${c.x}:${c.y}`);
    if (c.w !== d.w || c.h !== d.h) chain.push(`scale=${d.w}:${d.h}`);
    chain.push('setsar=1', `format=${enc.filterFmt}`);
    g.push(`[${inLabel}]${chain.join(',')}[t${k}]`);
    tileLabels.push(`t${k}`);
  });

  let compositor;
  if (useOverlay) {
    compositor = 'overlay';
    const ofmt = C.overlayFormatFor(enc.filterFmt);
    if (!ofmt) warnings.push(`タイルの重なりがあるため overlay で合成します。${enc.filterFmt} は overlay 非対応のため内部で変換されます。`);
    else warnings.push(`タイル ${overlaps.map((p) => p.join('と')).join(', ')} が重なっています。後ろのタイルが上に描画されます。`);
    const d = preview ? 1 : duration + 1;
    g.push(`color=c=${bg}:s=${W}x${H}:r=${fps}:d=${fmtSec(d)},format=${enc.filterFmt}[base]`);
    let prev = 'base';
    job.tiles.forEach((t, k) => {
      const outL = k === job.tiles.length - 1 ? 'vcomp' : `o${k}`;
      g.push(`[${prev}][t${k}]overlay=x=${t.dest.x}:y=${t.dest.y}:format=${ofmt || 'auto'}:eof_action=repeat[${outL}]`);
      prev = outL;
    });
    g.push(`[vcomp]format=${enc.filterFmt}[vout]`);
  } else if (tileLabels.length === 1) {
    compositor = 'pad';
    const t = job.tiles[0];
    g.push(`[t0]pad=${W}:${H}:${t.dest.x}:${t.dest.y}:color=${bg}[vout]`);
  } else {
    compositor = 'xstack';
    const layout = job.tiles.map((t) => `${t.dest.x}_${t.dest.y}`).join('|');
    const bw = Math.max(...job.tiles.map((t) => t.dest.x + t.dest.w));
    const bh = Math.max(...job.tiles.map((t) => t.dest.y + t.dest.h));
    const shortest = (job.output.duration || {}).mode === 'shortest' ? 1 : 0;
    const stack = `${tileLabels.map((l) => `[${l}]`).join('')}xstack=inputs=${tileLabels.length}:layout=${layout}:fill=${bg}:shortest=${shortest}`;
    if (bw === W && bh === H) g.push(`${stack}[vout]`);
    else g.push(`${stack},pad=${W}:${H}:0:0:color=${bg}[vout]`);
  }

  // ---- 音声 ----
  let audioDesc = 'なし';
  const outArgs = [];
  if (!preview && audioInputs.length) {
    const okList = C.AUDIO_COPY_OK[container];
    const srcA = audioInputs.map((ii) => job.sources[inputs[ii]].probe.audio[0]);
    const fallbackCodec = container === 'webm' ? ['libopus', '-b:a', '256k'] : ['aac', '-b:a', '320k'];
    if (audioInputs.length === 1) {
      const a = srcA[0];
      const offset = job.sources[inputs[audioInputs[0]]].offset || 0;
      const same = sameAudioEncoder(a);
      outArgs.push('-map', `${audioInputs[0]}:a:0`);
      if (offset > 0 && (!okList || okList.includes(a.codec)) && same) {
        // ストリームコピーはキーフレーム単位でしかシークできず音ズレの原因になるため、
        // 開始オフセット指定時は同じコーデックで再エンコードして正確に切り出す
        outArgs.push('-c:a', ...same.args);
        audioDesc = `${same.desc} (開始オフセットを正確に反映するため再エンコード)`;
      } else if (!okList || okList.includes(a.codec)) {
        outArgs.push('-c:a', 'copy');
        audioDesc = `${a.codec} (無変換コピー)`;
      } else {
        outArgs.push('-c:a', ...fallbackCodec);
        audioDesc = `${fallbackCodec[0]} ${fallbackCodec[2]} (${a.codec} は ${container} に入れられないため変換)`;
      }
    } else {
      g.push(`${audioInputs.map((ii) => `[${ii}:a:0]`).join('')}amix=inputs=${audioInputs.length}:duration=longest:normalize=0[aout]`);
      outArgs.push('-map', '[aout]');
      const firstPcm = srcA.find((a) => /^pcm_/.test(a.codec));
      if (firstPcm && (!okList || okList.includes('pcm_s24le'))) {
        outArgs.push('-c:a', 'pcm_s24le');
        audioDesc = `pcm_s24le (${audioInputs.length} 本をミックス)`;
      } else {
        outArgs.push('-c:a', ...fallbackCodec);
        audioDesc = `${fallbackCodec[0]} ${fallbackCodec[2]} (${audioInputs.length} 本をミックス)`;
      }
    }
  }

  args.push('-filter_complex', g.join(';'));
  args.push('-map', '[vout]');

  if (preview) {
    args.push('-frames:v', '1', '-c:v', 'png', '-pix_fmt', 'rgb24', '-f', 'image2', '-update', '1', preview.file);
    return { args, notes, warnings, compositor };
  }

  args.push('-c:v', enc.encoder, ...enc.args, '-pix_fmt', enc.pixFmt);
  const col = job.sources[primarySourceIndex(job)].probe.color || {};
  if (col.primaries) args.push('-color_primaries', col.primaries);
  if (col.transfer) args.push('-color_trc', col.transfer);
  if (col.space) args.push('-colorspace', col.space);
  if (col.range) args.push('-color_range', col.range);
  else if (/^yuvj/.test(job.sources[primarySourceIndex(job)].probe.pixFmt || '')) args.push('-color_range', 'pc');
  if (enc.codecKey === 'hevc' && (container === 'mp4' || container === 'mov')) args.push('-tag:v', 'hvc1');
  args.push(...outArgs);
  args.push('-t', fmtSec(duration));
  if (container === 'mp4' || container === 'mov') args.push('-movflags', '+faststart+write_colr');
  args.push('-map_chapters', '-1', '-max_muxing_queue_size', '4096');

  const cdef = C.CONTAINERS[container];
  const outPath = job.output.path ? replaceExt(job.output.path, cdef.ext) : '';
  args.push('-f', cdef.muxer, '-progress', 'pipe:1', '-stats_period', '0.5', '-nostats', outPath);

  return {
    args,
    notes,
    warnings,
    compositor,
    outPath,
    duration,
    totalFrames: Math.round(duration * fpsVal),
    info: {
      codec: C.CODECS[enc.codecKey].label,
      codecKey: enc.codecKey,
      encoder: enc.encoder,
      profile: enc.profileLabel,
      pixFmt: enc.pixFmt,
      quality: C.QUALITY_PRESETS[enc.quality].label,
      bitrate: enc.quality === 'bitrate' ? enc.bitrate : null,
      estimatedBitrate: estimateBitrate(job, fpsVal),
      container: cdef.label,
      containerKey: container,
      fps,
      size: `${W}×${H}`,
      audio: audioDesc,
      compositor,
    },
  };
}

/** ソース音声と同じコーデックで再エンコードする場合の引数 (PCM/FLAC/ALAC は無劣化) */
function sameAudioEncoder(a) {
  if (/^pcm_/.test(a.codec)) return { args: [a.codec], desc: `${a.codec} (無劣化)` };
  const map = {
    flac: { args: ['flac'], desc: 'flac (無劣化)' },
    alac: { args: ['alac'], desc: 'alac (無劣化)' },
    aac: { args: ['aac', '-b:a', '320k'], desc: 'aac 320k' },
    mp3: { args: ['libmp3lame', '-b:a', '320k'], desc: 'mp3 320k' },
    ac3: { args: ['ac3', '-b:a', '640k'], desc: 'ac3 640k' },
    eac3: { args: ['eac3', '-b:a', '1024k'], desc: 'eac3 1024k' },
    opus: { args: ['libopus', '-b:a', '320k'], desc: 'opus 320k' },
    vorbis: { args: ['libvorbis', '-q:a', '8'], desc: 'vorbis q8' },
    mp2: { args: ['mp2', '-b:a', '384k'], desc: 'mp2 384k' },
  };
  return map[a.codec] || null;
}

function replaceExt(p, ext) {
  const cur = path.extname(p);
  return (cur ? p.slice(0, -cur.length) : p) + '.' + ext;
}

module.exports = { buildPlan, parseRate, estimateBitrate, resolveDuration, replaceExt, primarySourceIndex };
