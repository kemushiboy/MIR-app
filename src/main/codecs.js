'use strict';
/**
 * コーデック・エンコーダ・コンテナ・ピクセルフォーマットの対応表と選択ロジック。
 * Electron に依存しない純粋なモジュール (テストスクリプトからも使う)。
 */

/** 出力コーデック定義。sw はソフトウェアエンコーダの優先順。 */
const CODECS = {
  h264: { label: 'H.264 / AVC', sw: ['libx264'], hw: { nvenc: 'h264_nvenc', qsv: 'h264_qsv', amf: 'h264_amf', videotoolbox: 'h264_videotoolbox' }, containers: ['mp4', 'mov', 'mkv', 'ts'] },
  hevc: { label: 'H.265 / HEVC', sw: ['libx265'], hw: { nvenc: 'hevc_nvenc', qsv: 'hevc_qsv', amf: 'hevc_amf', videotoolbox: 'hevc_videotoolbox' }, containers: ['mp4', 'mov', 'mkv', 'ts'] },
  av1: { label: 'AV1', sw: ['libsvtav1', 'libaom-av1'], hw: { nvenc: 'av1_nvenc', qsv: 'av1_qsv', amf: 'av1_amf' }, containers: ['mp4', 'mkv', 'webm'] },
  vp9: { label: 'VP9', sw: ['libvpx-vp9'], hw: {}, containers: ['webm', 'mkv', 'mp4'] },
  prores: { label: 'Apple ProRes', sw: ['prores_ks'], hw: {}, containers: ['mov', 'mkv'], intra: true },
  dnxhr: { label: 'Avid DNxHR', sw: ['dnxhd'], hw: {}, containers: ['mov', 'mkv'], intra: true },
  mpeg2: { label: 'MPEG-2', sw: ['mpeg2video'], hw: {}, containers: ['ts', 'mkv', 'mov'] },
  mjpeg: { label: 'Motion JPEG', sw: ['mjpeg'], hw: {}, containers: ['mov', 'mkv', 'avi'], intra: true },
  ffv1: { label: 'FFV1 (完全ロスレス)', sw: ['ffv1'], hw: {}, containers: ['mkv'], lossless: true },
  utvideo: { label: 'Ut Video (完全ロスレス)', sw: ['utvideo'], hw: {}, containers: ['mkv', 'avi', 'mov'], lossless: true },
};

/** ffprobe の codec_name → 出力コーデックキー */
const SOURCE_CODEC_MAP = {
  h264: 'h264',
  hevc: 'hevc',
  av1: 'av1',
  vp9: 'vp9',
  prores: 'prores',
  dnxhd: 'dnxhr',
  mpeg2video: 'mpeg2',
  mjpeg: 'mjpeg',
  ffv1: 'ffv1',
  utvideo: 'utvideo',
};

const HW_LABELS = { nvenc: 'NVIDIA NVENC', qsv: 'Intel Quick Sync', amf: 'AMD AMF', videotoolbox: 'Apple VideoToolbox' };

const CONTAINERS = {
  mp4: { label: 'MP4', ext: 'mp4', muxer: 'mp4' },
  mov: { label: 'QuickTime (MOV)', ext: 'mov', muxer: 'mov' },
  mkv: { label: 'Matroska (MKV)', ext: 'mkv', muxer: 'matroska' },
  webm: { label: 'WebM', ext: 'webm', muxer: 'webm' },
  ts: { label: 'MPEG-TS', ext: 'ts', muxer: 'mpegts' },
  avi: { label: 'AVI', ext: 'avi', muxer: 'avi' },
};

const EXT_TO_CONTAINER = {
  mp4: 'mp4', m4v: 'mp4', mov: 'mov', qt: 'mov', mkv: 'mkv', webm: 'webm',
  ts: 'ts', m2ts: 'ts', mts: 'ts', avi: 'avi',
};

/** コンテナにそのまま (-c:a copy) 入れられる音声コーデック。null は制限なし */
const AUDIO_COPY_OK = {
  mp4: ['aac', 'mp3', 'ac3', 'eac3', 'opus', 'flac', 'alac'],
  mov: ['aac', 'mp3', 'ac3', 'eac3', 'alac', 'pcm_s16le', 'pcm_s16be', 'pcm_s24le', 'pcm_s24be', 'pcm_s32le', 'pcm_s32be', 'pcm_f32le', 'pcm_f32be'],
  mkv: null,
  webm: ['opus', 'vorbis'],
  ts: ['aac', 'mp3', 'ac3', 'eac3', 'mp2', 'opus'],
  avi: ['mp3', 'ac3', 'mp2', 'pcm_s16le', 'pcm_s24le'],
};

const QUALITY_PRESETS = {
  visually_lossless: { label: '視覚的ロスレス (推奨)' },
  high: { label: '高画質 (ファイルサイズ控えめ)' },
  lossless: { label: '数学的ロスレス (巨大・互換性注意)' },
  bitrate: { label: 'ビットレート指定' },
};

// ------------------------------------------------------------------
// ピクセルフォーマット
// ------------------------------------------------------------------

const HW_PIXFMTS = new Set(['cuda', 'd3d11', 'd3d12', 'dxva2_vld', 'qsv', 'vaapi', 'amf', 'videotoolbox_vld', 'vulkan', 'drm_prime', 'opencl', 'mediacodec']);

/** ピクセルフォーマット名から {chroma, depth, alpha, family} を推定する */
function pixFmtInfo(name) {
  if (!name) return null;
  let m;
  if ((m = name.match(/^yuv(a?)j?(4\d\d)p(\d+)?/))) {
    return { chroma: m[2], depth: m[3] ? Number(m[3]) : 8, alpha: m[1] === 'a', family: 'yuv', full: name.includes('yuvj') };
  }
  const semi = {
    nv12: ['420', 8], nv21: ['420', 8], nv16: ['422', 8], nv24: ['444', 8], nv42: ['444', 8],
    nv20le: ['422', 10], nv20be: ['422', 10],
    p010le: ['420', 10], p010be: ['420', 10], p012le: ['420', 12], p016le: ['420', 16],
    p210le: ['422', 10], p212le: ['422', 12], p216le: ['422', 16],
    p410le: ['444', 10], p412le: ['444', 12], p416le: ['444', 16],
    y210le: ['422', 10], y212le: ['422', 12], yuyv422: ['422', 8], uyvy422: ['422', 8],
  }[name];
  if (semi) return { chroma: semi[0], depth: semi[1], alpha: false, family: 'semi' };
  if ((m = name.match(/^gbra?p(\d+)?/))) {
    return { chroma: 'rgb', depth: m[1] ? Number(m[1]) : 8, alpha: name.startsWith('gbrap'), family: 'gbr' };
  }
  if ((m = name.match(/^gray(\d+)?/))) return { chroma: 'gray', depth: m[1] ? Number(m[1]) : 8, alpha: false, family: 'gray' };
  if (/^(x2rgb10|x2bgr10)/.test(name)) return { chroma: 'rgb', depth: 10, alpha: false, family: 'packed' };
  if (/^(rgb48|bgr48)/.test(name)) return { chroma: 'rgb', depth: 16, alpha: false, family: 'packed' };
  if (/^(rgba64|bgra64)/.test(name)) return { chroma: 'rgb', depth: 16, alpha: true, family: 'packed' };
  if (/^(rgb24|bgr24|rgb0|bgr0|0rgb|0bgr)$/.test(name)) return { chroma: 'rgb', depth: 8, alpha: false, family: 'packed' };
  if (/^(rgba|bgra|argb|abgr)$/.test(name)) return { chroma: 'rgb', depth: 8, alpha: true, family: 'packed' };
  return null;
}

const CHROMA_RANK = { gray: 0, '410': 1, '411': 2, '420': 3, '440': 4, '422': 5, '444': 6, rgb: 6 };

/**
 * エンコーダが対応するフォーマットの中から、ソースに最も近いものを選ぶ。
 * 同じクロマ・同じビット深度 > 情報量が増える方向 > 減る方向 の順で優先。
 */
function choosePixFmt(sourceFmt, supported) {
  const list = (supported || []).filter((f) => !HW_PIXFMTS.has(f));
  if (!list.length) return { pixFmt: sourceFmt || 'yuv420p', exact: true };
  const normalized = sourceFmt ? sourceFmt.replace(/^yuvj/, 'yuv') : 'yuv420p';
  if (list.includes(sourceFmt)) return { pixFmt: sourceFmt, exact: true };
  if (list.includes(normalized)) return { pixFmt: normalized, exact: true };
  const src = pixFmtInfo(normalized) || { chroma: '420', depth: 8, alpha: false, family: 'yuv' };
  let best = null;
  let bestScore = -Infinity;
  for (const f of list) {
    const info = pixFmtInfo(f);
    if (!info) continue;
    let score = 0;
    const isRgbSrc = src.chroma === 'rgb';
    const isRgbDst = info.chroma === 'rgb';
    if (info.chroma === src.chroma) score += 1000;
    else if (isRgbSrc !== isRgbDst) score -= 2000; // RGB⇔YUV 変換は極力避ける
    else {
      const d = CHROMA_RANK[info.chroma] - CHROMA_RANK[src.chroma];
      score += d > 0 ? 500 - d * 10 : -500 + d * 10;
    }
    const dd = info.depth - src.depth;
    score += dd === 0 ? 200 : dd > 0 ? 100 - dd : -100 + dd * 10;
    if (info.alpha === src.alpha) score += 20;
    if (info.family === src.family) score += 10;
    if (info.family === 'yuv' || info.family === 'gbr') score += 5;
    if (score > bestScore) {
      bestScore = score;
      best = f;
    }
  }
  return { pixFmt: best || list[0], exact: false };
}

/** フィルタ処理用に、セミプレーナ (nv12 など) を等価なプレーナ形式へ。並べ替えは無劣化で行える */
function planarEquivalent(fmt) {
  const map = {
    nv12: 'yuv420p', nv21: 'yuv420p', nv16: 'yuv422p', nv24: 'yuv444p', nv42: 'yuv444p',
    p010le: 'yuv420p10le', p012le: 'yuv420p12le', p016le: 'yuv420p16le',
    p210le: 'yuv422p10le', p212le: 'yuv422p12le', p216le: 'yuv422p16le',
    p410le: 'yuv444p10le', p412le: 'yuv444p12le', p416le: 'yuv444p16le',
    nv20le: 'yuv422p10le', yuyv422: 'yuv422p', uyvy422: 'yuv422p', y210le: 'yuv422p10le',
    yuv444p10msble: 'yuv444p10le', yuv444p12msble: 'yuv444p12le', gbrp10msble: 'gbrp10le',
    bgr0: 'gbrp', rgb0: 'gbrp', bgra: 'gbrap', rgba: 'gbrap', rgb24: 'gbrp', bgr24: 'gbrp',
  };
  return map[fmt] || fmt;
}

/** overlay フィルタの format オプション (重なりがある場合の合成に使用) */
function overlayFormatFor(fmt) {
  return {
    yuv420p: 'yuv420', yuvj420p: 'yuv420', yuv420p10le: 'yuv420p10',
    yuv422p: 'yuv422', yuvj422p: 'yuv422', yuv422p10le: 'yuv422p10',
    yuv444p: 'yuv444', yuvj444p: 'yuv444', yuv444p10le: 'yuv444p10',
    gbrp: 'gbrp',
  }[fmt];
}

/** クロマサブサンプリングによる座標・サイズの最小単位 */
function chromaAlign(fmt) {
  const info = pixFmtInfo(fmt);
  if (!info) return { x: 2, y: 2 };
  switch (info.chroma) {
    case '420': return { x: 2, y: 2 };
    case '422': return { x: 2, y: 1 };
    case '440': return { x: 1, y: 2 };
    case '411': return { x: 4, y: 1 };
    case '410': return { x: 4, y: 4 };
    default: return { x: 1, y: 1 };
  }
}

// ------------------------------------------------------------------
// コーデック固有のプロファイル
// ------------------------------------------------------------------

function proresProfileFrom(sourceCodec, sourceProfile, srcInfo) {
  if (sourceCodec === 'prores' && sourceProfile) {
    const p = sourceProfile.toLowerCase();
    if (p.includes('xq')) return 5;
    if (p.includes('4444')) return 4;
    if (p.includes('hq')) return 3;
    if (p.includes('lt')) return 1;
    if (p.includes('proxy')) return 0;
    return 2;
  }
  if (srcInfo && (srcInfo.chroma === '444' || srcInfo.chroma === 'rgb')) return 4;
  return 3; // HQ
}
const PRORES_NAMES = ['Proxy', 'LT', 'Standard', 'HQ', '4444', '4444 XQ'];

function dnxhrProfileFrom(sourceCodec, sourceProfile, srcInfo) {
  if (sourceCodec === 'dnxhd' && sourceProfile) {
    const p = sourceProfile.toLowerCase();
    if (p.includes('444')) return 'dnxhr_444';
    if (p.includes('hqx')) return 'dnxhr_hqx';
    if (p.includes('hq')) return 'dnxhr_hq';
    if (p.includes('sq')) return 'dnxhr_sq';
    if (p.includes('lb')) return 'dnxhr_lb';
  }
  // DNxHD (1080 専用) や他コーデックから: ビット深度とクロマで決める
  if (srcInfo && (srcInfo.chroma === '444' || srcInfo.chroma === 'rgb')) return 'dnxhr_444';
  if (srcInfo && srcInfo.depth > 8) return 'dnxhr_hqx';
  return 'dnxhr_hq';
}
const DNXHR_PIXFMT = {
  dnxhr_lb: 'yuv422p', dnxhr_sq: 'yuv422p', dnxhr_hq: 'yuv422p', dnxhr_hqx: 'yuv422p10le', dnxhr_444: 'yuv444p10le',
};

// ------------------------------------------------------------------
// 画質パラメータ
// ------------------------------------------------------------------

function rateArgs(bitrate) {
  const b = Math.max(1, Math.round(bitrate / 1000));
  return ['-b:v', `${b}k`, '-maxrate', `${Math.round(b * 1.5)}k`, '-bufsize', `${b * 3}k`];
}

/**
 * エンコーダ別の画質引数を返す。
 * @param {string} encoder
 * @param {string} quality visually_lossless | high | lossless | bitrate
 * @param {{bitrate:number}} ctx
 */
function qualityArgs(encoder, quality, ctx) {
  const vl = quality === 'visually_lossless';
  const br = quality === 'bitrate';
  const ll = quality === 'lossless';
  switch (encoder) {
    case 'libx264':
      if (ll) return ['-preset', 'slow', '-qp', '0'];
      if (br) return ['-preset', 'slow', ...rateArgs(ctx.bitrate)];
      return ['-preset', 'slow', '-crf', vl ? '12' : '17'];
    case 'libx265':
      if (ll) return ['-preset', 'medium', '-x265-params', 'lossless=1:log-level=warning'];
      if (br) return ['-preset', 'medium', ...rateArgs(ctx.bitrate), '-x265-params', 'log-level=warning'];
      return ['-preset', 'medium', '-crf', vl ? '14' : '19', '-x265-params', 'log-level=warning'];
    case 'libsvtav1':
      if (br) return ['-preset', '6', ...rateArgs(ctx.bitrate).slice(0, 2)];
      return ['-preset', '6', '-crf', vl ? '16' : '24'];
    case 'libaom-av1':
      if (ll) return ['-cpu-used', '4', '-row-mt', '1', '-aom-params', 'lossless=1'];
      if (br) return ['-cpu-used', '4', '-row-mt', '1', ...rateArgs(ctx.bitrate).slice(0, 2)];
      return ['-cpu-used', '4', '-row-mt', '1', '-crf', vl ? '16' : '24', '-b:v', '0'];
    case 'libvpx-vp9':
      if (ll) return ['-lossless', '1', '-deadline', 'good', '-cpu-used', '2', '-row-mt', '1'];
      if (br) return [...rateArgs(ctx.bitrate), '-deadline', 'good', '-cpu-used', '2', '-row-mt', '1'];
      return ['-crf', vl ? '12' : '20', '-b:v', '0', '-deadline', 'good', '-cpu-used', '2', '-row-mt', '1'];
    case 'h264_nvenc':
    case 'hevc_nvenc':
    case 'av1_nvenc':
      if (br) return ['-preset', 'p6', '-tune', 'hq', '-rc', 'vbr', '-spatial-aq', '1', ...rateArgs(ctx.bitrate)];
      return ['-preset', 'p6', '-tune', 'hq', '-rc', 'vbr', '-cq', vl ? '16' : '21', '-b:v', '0', '-spatial-aq', '1'];
    case 'h264_qsv':
    case 'hevc_qsv':
    case 'av1_qsv':
      if (br) return ['-preset', 'veryslow', ...rateArgs(ctx.bitrate)];
      return ['-preset', 'veryslow', '-global_quality', vl ? '16' : '21'];
    case 'h264_amf':
    case 'hevc_amf':
    case 'av1_amf': {
      if (br) return ['-quality', 'quality', '-rc', 'vbr_peak', ...rateArgs(ctx.bitrate)];
      const q = vl ? 16 : 21;
      const a = ['-quality', 'quality', '-rc', 'cqp', '-qp_i', String(q), '-qp_p', String(q + 2)];
      if (encoder !== 'av1_amf') a.push('-qp_b', String(q + 4));
      return a;
    }
    case 'h264_videotoolbox':
    case 'hevc_videotoolbox': {
      // 品質指定 (-q:v) は Apple Silicon でしか効かないため、ソース相当ビットレートの倍率で指定する
      const factor = br ? 1 : vl ? 2 : 1.3;
      return ['-realtime', '0', ...rateArgs(ctx.bitrate * factor)];
    }
    case 'mpeg2video':
      if (br) return [...rateArgs(ctx.bitrate)];
      return ['-qmin', '1', '-q:v', vl || ll ? '1' : '2', '-intra_vlc', '1', '-non_linear_quant', '1'];
    case 'mjpeg':
      return ['-qmin', '1', '-q:v', vl || ll ? '1' : '3'];
    case 'ffv1':
      return ['-level', '3', '-g', '1', '-slices', '24', '-slicecrc', '1', '-context', '1'];
    case 'utvideo':
      return ['-pred', 'median'];
    default:
      return [];
  }
}

module.exports = {
  CODECS,
  SOURCE_CODEC_MAP,
  HW_LABELS,
  CONTAINERS,
  EXT_TO_CONTAINER,
  AUDIO_COPY_OK,
  QUALITY_PRESETS,
  PRORES_NAMES,
  DNXHR_PIXFMT,
  pixFmtInfo,
  choosePixFmt,
  planarEquivalent,
  overlayFormatFor,
  chromaAlign,
  proresProfileFrom,
  dnxhrProfileFrom,
  qualityArgs,
};
