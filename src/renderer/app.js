/* global Presets, api */
'use strict';

// api は preload (contextBridge) が window.api として公開している
const $ = (id) => document.getElementById(id);

const COLORS = ['#ff6b6b', '#51cf66', '#4dabf7', '#ffd43b', '#cc5de8', '#ff922b', '#22b8cf', '#f06595', '#94d82d', '#845ef7'];
const ALIGN = 2; // 4:2:0 を前提に座標とサイズは偶数に揃える

let uid = 1;
const newId = () => uid++;

const state = {
  sources: [], // { id, path, name, offset, probe, thumb:{img,scale,time}, color, missing }
  canvas: { width: 3840, height: 2160, fps: 'auto', background: '#000000' },
  tiles: [], // { id, sourceId, label, crop:{x,y,w,h}, dest:{x,y,w,h} }
  output: {
    path: '', container: 'auto', codec: 'source', hw: 'none', quality: 'visually_lossless', bitrateMbps: 0,
    pixFmt: 'source', audio: { mode: 'source', sourceId: null }, duration: { mode: 'shortest', seconds: 0 },
  },
  selected: null,
  previewTime: 0,
  projectPath: null,
  dirty: false,
  exporting: false,
};

let caps = null;
let lastPlan = null;

// ==================================================================
// 汎用
// ==================================================================

function setStatus(msg, kind = '') {
  const el = $('status');
  el.textContent = msg;
  el.className = kind;
}

function fmtTime(s) {
  if (!isFinite(s)) return '--:--';
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return `${String(m).padStart(2, '0')}:${sec.toFixed(2).padStart(5, '0')}`;
}

function fmtBytes(b) {
  if (!b) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(b) / Math.log(1024)));
  return `${(b / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
}

function fmtRate(r) {
  const [n, d] = String(r).split('/').map(Number);
  const v = d ? n / d : n;
  return Number.isInteger(v) ? String(v) : v.toFixed(3).replace(/0+$/, '');
}

const snapA = (v) => Math.round(v / ALIGN) * ALIGN;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const debounce = (fn, ms) => {
  let t = null;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
};

const sourceById = (id) => state.sources.find((s) => s.id === id);
const sourceIndex = (id) => state.sources.findIndex((s) => s.id === id);
const tileById = (id) => state.tiles.find((t) => t.id === id);

function codecLabel(p) {
  const names = { h264: 'H.264', hevc: 'HEVC', av1: 'AV1', vp9: 'VP9', prores: 'ProRes', dnxhd: 'DNxHD/HR', mpeg2video: 'MPEG-2', mjpeg: 'MJPEG', ffv1: 'FFV1' };
  return `${names[p.codec] || p.codec}${p.profile ? ' ' + p.profile : ''}`;
}

// ==================================================================
// 履歴 (元に戻す / やり直し)
// ==================================================================

const history = { stack: [], index: -1 };

function snapshot() {
  return JSON.stringify({
    sources: state.sources.map((s) => ({ id: s.id, offset: s.offset })),
    canvas: state.canvas,
    tiles: state.tiles,
    output: state.output,
  });
}

function commit() {
  const snap = snapshot();
  if (history.stack[history.index] === snap) return;
  history.stack = history.stack.slice(0, history.index + 1);
  history.stack.push(snap);
  if (history.stack.length > 200) history.stack.shift();
  history.index = history.stack.length - 1;
  state.dirty = history.index > 0;
  updateTitle();
  refreshAll();
}

function restore(snap) {
  const d = JSON.parse(snap);
  // ソースの追加/削除は履歴の対象外 (ファイル実体があるため)。存在するものだけ復元
  for (const s of d.sources) {
    const cur = sourceById(s.id);
    if (cur) cur.offset = s.offset;
  }
  state.canvas = d.canvas;
  state.tiles = d.tiles.filter((t) => sourceById(t.sourceId));
  state.output = d.output;
  if (!tileById(state.selected)) state.selected = null;
  refreshAll();
  syncFormsFromState();
}

function undo() {
  if (history.index <= 0) return;
  history.index--;
  restore(history.stack[history.index]);
}

function redo() {
  if (history.index >= history.stack.length - 1) return;
  history.index++;
  restore(history.stack[history.index]);
}

function updateTitle() {
  const name = state.projectPath ? state.projectPath.split(/[\\/]/).pop() : '無題';
  $('projectName').textContent = name + (state.dirty ? ' *' : '');
  document.title = `${name}${state.dirty ? ' *' : ''} - MovieLayout`;
}

// ==================================================================
// ソース
// ==================================================================

async function addSources(paths) {
  for (const p of paths) {
    setStatus(`読み込み中: ${p}`);
    try {
      const probe = await api.probe(p);
      const s = {
        id: newId(), path: p, name: probe.name, offset: 0, probe, thumb: null,
        color: COLORS[state.sources.length % COLORS.length], missing: false,
      };
      state.sources.push(s);
      if (state.output.audio.sourceId == null && probe.audio.length) state.output.audio.sourceId = s.id;
      if (probe.rotation) setStatus(`${probe.name}: 回転メタデータ (${probe.rotation}°) があります。表示上の向きではなく格納方向で処理されます。`, 'err');
      else setStatus(`追加しました: ${probe.name}`, 'ok');
      loadThumb(s);
    } catch (e) {
      setStatus(`読み込めません: ${p} — ${e.message}`, 'err');
    }
  }
  renderSources();
  commit();
}

async function replaceSource(s) {
  const files = await api.openVideos(false);
  if (!files.length) return;
  try {
    const probe = await api.probe(files[0]);
    const old = s.probe;
    Object.assign(s, { path: files[0], name: probe.name, probe, missing: false, thumb: null });
    if (old && (old.width !== probe.width || old.height !== probe.height)) {
      setStatus(`解像度が異なります (${old.width}×${old.height} → ${probe.width}×${probe.height})。タイルの切り出し範囲を確認してください。`, 'err');
    } else {
      setStatus(`差し替えました: ${probe.name}`, 'ok');
    }
    loadThumb(s);
    renderSources();
    commit();
  } catch (e) {
    setStatus(`読み込めません: ${e.message}`, 'err');
  }
}

function removeSource(s) {
  const used = state.tiles.filter((t) => t.sourceId === s.id).length;
  if (used && !confirm(`${s.name} を使っているタイルが ${used} 個あります。タイルごと削除しますか？`)) return;
  state.tiles = state.tiles.filter((t) => t.sourceId !== s.id);
  state.sources = state.sources.filter((x) => x !== s);
  if (state.output.audio.sourceId === s.id) {
    const a = state.sources.find((x) => x.probe && x.probe.audio.length);
    state.output.audio.sourceId = a ? a.id : null;
  }
  if (!tileById(state.selected)) state.selected = null;
  renderSources();
  commit();
}

const thumbQueue = new Map();
async function loadThumb(s) {
  if (!s.probe) return;
  const t = clamp(state.previewTime + (s.offset || 0), 0, Math.max(0, s.probe.duration - 0.05));
  const token = {};
  thumbQueue.set(s.id, token);
  try {
    const url = await api.frame(s.path, t, Math.min(s.probe.width, 1280));
    if (thumbQueue.get(s.id) !== token) return;
    const img = new Image();
    img.onload = () => {
      s.thumb = { img, url, scale: img.naturalWidth / s.probe.width, time: t };
      renderSources(true);
      drawStage();
      drawCrop();
      if ($('splitDialog').open) updateSplitPreview();
    };
    img.src = url;
  } catch (e) {
    console.warn('thumb', e);
  }
}

const reloadThumbs = debounce(() => state.sources.forEach(loadThumb), 200);

function renderSources(thumbOnly = false) {
  const list = $('sourceList');
  if (thumbOnly) {
    for (const s of state.sources) {
      if (!s.thumb) continue;
      const card = list.querySelector(`[data-id="${s.id}"]`);
      if (!card) continue;
      let img = card.querySelector('img');
      if (!img) {
        img = document.createElement('img');
        card.querySelector('.noimg').replaceWith(img);
      }
      if (img.src !== s.thumb.url) img.src = s.thumb.url;
    }
    return;
  }
  list.innerHTML = '';
  $('sourceEmpty').classList.toggle('hidden', state.sources.length > 0);
  state.sources.forEach((s, i) => {
    const card = document.createElement('div');
    card.className = 'source-card' + (s.missing ? ' missing' : '');
    card.dataset.id = s.id;
    card.style.setProperty('--c', s.color);
    const p = s.probe;
    const spec = p
      ? [
        `${p.width}×${p.height} · ${codecLabel(p)}`,
        `${p.pixFmt} · ${fmtRate(p.fps)}fps`,
        `${fmtTime(p.duration)}${p.bitrate ? ` · ${(p.bitrate / 1e6).toFixed(1)} Mbps` : ''}`,
        p.audio.length ? `音声: ${p.audio.map((a) => `${a.codec} ${a.channels}ch`).join(', ')}` : '音声なし',
      ].join('<br>')
      : '<span style="color:var(--danger)">ファイルが見つかりません。「差替」で指定してください。</span>';
    card.innerHTML = `
      <div class="top">
        ${s.thumb ? `<img src="${s.thumb.url}">` : '<div class="noimg">…</div>'}
        <div class="meta">
          <div class="name" title="${escapeHtml(s.path)}"><span class="tag">S${i + 1}</span>${escapeHtml(s.name)}</div>
          <div class="spec">${spec}</div>
        </div>
      </div>
      <div class="ctrl">
        <label title="このソースの再生開始位置 (秒)。複数カメラの同期合わせに使います">開始<input type="number" step="0.001" min="0" value="${s.offset}"></label>
        <button class="small" data-act="split" title="このソースだけを分割配置">分割…</button>
        <button class="small" data-act="replace" title="別のファイルに差し替え (タイルはそのまま)">差替</button>
        <button class="small danger" data-act="remove" title="削除">✕</button>
      </div>`;
    const off = card.querySelector('input');
    off.addEventListener('change', () => {
      s.offset = Math.max(0, Number(off.value) || 0);
      loadThumb(s);
      commit();
    });
    card.querySelector('[data-act=split]').onclick = () => openSplitDialog(null, s.id);
    card.querySelector('[data-act=replace]').onclick = () => replaceSource(s);
    card.querySelector('[data-act=remove]').onclick = () => removeSource(s);
    list.appendChild(card);
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ==================================================================
// プリセット / 分割ダイアログ
// ==================================================================

function renderPresets() {
  const list = $('presetList');
  list.innerHTML = '';
  for (const p of Presets.LIST) {
    const b = document.createElement('button');
    b.className = 'preset';
    b.innerHTML = `<b>${escapeHtml(p.name)}</b><span>${escapeHtml(p.desc)}</span>`;
    b.onclick = () => openSplitDialog(p);
    list.appendChild(b);
  }
}

let splitCtx = null;

function openSplitDialog(preset, onlySourceId = null) {
  const usable = state.sources.filter((s) => s.probe);
  if (!usable.length) {
    setStatus('先にソース動画を追加してください。', 'err');
    return;
  }
  splitCtx = { preset };
  $('splitTitle').textContent = preset ? preset.name : '分割・配置';
  $('splitDesc').textContent = preset ? preset.desc : '各ソースを列×行に分割し、指定した並べ方でキャンバスに配置します。';
  const sel = $('spTarget');
  sel.innerHTML = `<option value="all">すべてのソース (${usable.length} 本・追加順)</option>` +
    usable.map((s) => `<option value="${s.id}">S${sourceIndex(s.id) + 1}: ${escapeHtml(s.name)}</option>`).join('');
  sel.value = onlySourceId ? String(onlySourceId) : 'all';
  const p = preset ? preset.params : { cols: 2, rows: 1, pieceFlow: 'vertical', blockFlow: 'horizontal' };
  $('spCols').value = p.cols;
  $('spRows').value = p.rows;
  $('spPieceFlow').value = p.pieceFlow;
  $('spBlockFlow').value = p.blockFlow;
  $('spGridCols').value = p.blockGridCols || Math.ceil(Math.sqrt(usable.length));
  $('spReverse').checked = !!p.reverse;
  $('spMode').value = onlySourceId && state.tiles.length ? 'append' : 'replace';
  $('spOx').value = 0;
  $('spOy').value = 0;
  if (onlySourceId && state.tiles.length) {
    // 追加時は既存タイルの右側に置く
    $('spOx').value = snapA(Math.max(0, ...state.tiles.map((t) => t.dest.x + t.dest.w)));
  }
  $('spFitCanvas').checked = !onlySourceId || !state.tiles.length;
  $('splitDialog').showModal();
  updateSplitPreview(); // 表示後でないとプレビュー canvas のサイズが 0 になる
}

function splitParams() {
  return {
    cols: Number($('spCols').value) || 1,
    rows: Number($('spRows').value) || 1,
    pieceFlow: $('spPieceFlow').value,
    blockFlow: $('spBlockFlow').value,
    blockGridCols: Number($('spGridCols').value) || 2,
    reverse: $('spReverse').checked,
  };
}

function computeSplit() {
  const target = $('spTarget').value;
  const srcs = target === 'all' ? state.sources.filter((s) => s.probe) : [sourceById(Number(target))];
  const lay = Presets.splitArrange(srcs.map((s) => s.probe), splitParams());
  const append = $('spMode').value === 'append';
  const ox = append ? snapA(Number($('spOx').value) || 0) : 0;
  const oy = append ? snapA(Number($('spOy').value) || 0) : 0;
  const tiles = lay.tiles.map((t) => ({
    id: newId(),
    sourceId: srcs[t.source].id,
    label: t.label,
    crop: t.crop,
    dest: { ...t.dest, x: t.dest.x + ox, y: t.dest.y + oy },
  }));
  const all = append ? [...state.tiles, ...tiles] : tiles;
  const W = Math.max(...all.map((t) => t.dest.x + t.dest.w));
  const H = Math.max(...all.map((t) => t.dest.y + t.dest.h));
  return { tiles, all, W: snapA(W), H: snapA(H), append };
}

function updateSplitPreview() {
  $('spGridColsRow').classList.toggle('hidden', $('spBlockFlow').value !== 'grid');
  $('spOriginRow').classList.toggle('hidden', $('spMode').value !== 'append');
  const r = computeSplit();
  const cv = $('spPreview');
  const ctx = setupCanvas(cv);
  const cw = cv.clientWidth;
  const ch = cv.clientHeight;
  ctx.clearRect(0, 0, cw, ch);
  const fit = $('spFitCanvas').checked;
  const W = fit ? r.W : state.canvas.width;
  const H = fit ? r.H : state.canvas.height;
  const bw = Math.max(W, r.W);
  const bh = Math.max(H, r.H);
  const sc = Math.min((cw - 20) / bw, (ch - 20) / bh);
  const ox = (cw - bw * sc) / 2;
  const oy = (ch - bh * sc) / 2;
  ctx.fillStyle = '#000';
  ctx.fillRect(ox, oy, W * sc, H * sc);
  ctx.strokeStyle = '#555';
  ctx.strokeRect(ox + 0.5, oy + 0.5, W * sc, H * sc);
  r.all.forEach((t) => {
    const s = sourceById(t.sourceId);
    const isNew = r.tiles.includes(t);
    const x = ox + t.dest.x * sc;
    const y = oy + t.dest.y * sc;
    const w = t.dest.w * sc;
    const h = t.dest.h * sc;
    if (s.thumb) {
      ctx.globalAlpha = isNew ? 1 : 0.35;
      ctx.drawImage(s.thumb.img, t.crop.x * s.thumb.scale, t.crop.y * s.thumb.scale, t.crop.w * s.thumb.scale, t.crop.h * s.thumb.scale, x, y, w, h);
      ctx.globalAlpha = 1;
    }
    ctx.strokeStyle = s.color;
    ctx.lineWidth = isNew ? 2 : 1;
    ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
    ctx.fillStyle = 'rgba(0,0,0,.65)';
    const label = `S${sourceIndex(s.id) + 1} ${t.label || ''}`;
    ctx.font = '600 11px "Segoe UI", sans-serif';
    const tw = ctx.measureText(label).width + 8;
    ctx.fillRect(x + 3, y + 3, tw, 16);
    ctx.fillStyle = s.color;
    ctx.fillText(label, x + 7, y + 15);
  });
  const outside = r.all.some((t) => t.dest.x + t.dest.w > W || t.dest.y + t.dest.h > H);
  $('spResult').innerHTML = `タイル ${r.tiles.length} 枚 → レイアウト ${r.W}×${r.H}` +
    (fit ? '' : ` / キャンバス ${W}×${H}`) +
    (outside ? ' <span style="color:var(--danger)">(キャンバス外にはみ出します)</span>' : '');
}

['spTarget', 'spCols', 'spRows', 'spPieceFlow', 'spBlockFlow', 'spGridCols', 'spReverse', 'spMode', 'spOx', 'spOy', 'spFitCanvas']
  .forEach((id) => $(id).addEventListener('input', updateSplitPreview));

$('splitDialog').addEventListener('close', () => {
  if ($('splitDialog').returnValue !== 'apply') return;
  const r = computeSplit();
  state.tiles = r.all;
  if ($('spFitCanvas').checked) {
    state.canvas.width = r.W;
    state.canvas.height = r.H;
  }
  state.selected = null;
  commit();
  syncFormsFromState();
  setStatus(`${r.tiles.length} 枚のタイルを配置しました (${state.canvas.width}×${state.canvas.height})`, 'ok');
});

// ==================================================================
// ステージ (キャンバス編集)
// ==================================================================

const stage = { scale: 1, ox: 0, oy: 0, drag: null, guides: [] };

function setupCanvas(cv) {
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth;
  const h = cv.clientHeight;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
  }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingQuality = 'high';
  return ctx;
}

function tileProblems() {
  const bad = new Set();
  const W = state.canvas.width;
  const H = state.canvas.height;
  state.tiles.forEach((t, i) => {
    const s = sourceById(t.sourceId);
    const d = t.dest;
    const c = t.crop;
    if (d.x < 0 || d.y < 0 || d.x + d.w > W || d.y + d.h > H) bad.add(t.id);
    if (!s || !s.probe || c.x < 0 || c.y < 0 || c.x + c.w > s.probe.width || c.y + c.h > s.probe.height) bad.add(t.id);
    state.tiles.forEach((u, j) => {
      if (j > i && d.x < u.dest.x + u.dest.w && u.dest.x < d.x + d.w && d.y < u.dest.y + u.dest.h && u.dest.y < d.y + d.h) {
        bad.add(`ov${t.id}`);
        bad.add(`ov${u.id}`);
      }
    });
  });
  return bad;
}

function drawStage() {
  const cv = $('stageCanvas');
  const ctx = setupCanvas(cv);
  const cw = cv.clientWidth;
  const ch = cv.clientHeight;
  ctx.clearRect(0, 0, cw, ch);
  $('stageEmpty').classList.toggle('hidden', state.tiles.length > 0);
  const W = state.canvas.width;
  const H = state.canvas.height;
  const pad = 28;
  stage.scale = Math.min((cw - pad * 2) / W, (ch - pad * 2) / H);
  stage.ox = Math.round((cw - W * stage.scale) / 2);
  stage.oy = Math.round((ch - H * stage.scale) / 2);
  const sc = stage.scale;
  const X = (v) => stage.ox + v * sc;
  const Y = (v) => stage.oy + v * sc;

  // キャンバス
  ctx.fillStyle = state.canvas.background;
  ctx.fillRect(X(0), Y(0), W * sc, H * sc);

  const bad = tileProblems();
  const showLabels = $('optLabels').checked;
  state.tiles.forEach((t, i) => {
    const s = sourceById(t.sourceId);
    const x = X(t.dest.x);
    const y = Y(t.dest.y);
    const w = t.dest.w * sc;
    const h = t.dest.h * sc;
    if (s && s.thumb) {
      const k = s.thumb.scale;
      ctx.drawImage(s.thumb.img, t.crop.x * k, t.crop.y * k, t.crop.w * k, t.crop.h * k, x, y, w, h);
    } else {
      ctx.fillStyle = (s ? s.color : '#888') + '33';
      ctx.fillRect(x, y, w, h);
    }
    const isBad = bad.has(t.id);
    const isOv = bad.has(`ov${t.id}`);
    ctx.lineWidth = 1.5;
    ctx.setLineDash(isBad || isOv ? [6, 4] : []);
    ctx.strokeStyle = isBad ? '#ff4d4f' : isOv ? '#f5a524' : s ? s.color : '#888';
    ctx.strokeRect(x + 0.75, y + 0.75, w - 1.5, h - 1.5);
    ctx.setLineDash([]);
    if (showLabels && w > 30 && h > 18) {
      const label = `${i + 1}  S${sourceIndex(t.sourceId) + 1} ${t.label || ''}`;
      ctx.font = '600 12px "Segoe UI", "Yu Gothic UI", sans-serif';
      const tw = ctx.measureText(label).width + 10;
      ctx.fillStyle = 'rgba(0,0,0,.7)';
      ctx.fillRect(x + 4, y + 4, Math.min(tw, w - 8), 18);
      ctx.fillStyle = s ? s.color : '#fff';
      ctx.save();
      ctx.beginPath();
      ctx.rect(x + 4, y + 4, w - 8, 18);
      ctx.clip();
      ctx.fillText(label, x + 9, y + 17);
      ctx.restore();
    }
  });

  if ($('optGrid').checked) {
    ctx.strokeStyle = 'rgba(255,255,255,.18)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const t of state.tiles) {
      for (const xx of [t.dest.x, t.dest.x + t.dest.w]) { ctx.moveTo(X(xx) + 0.5, Y(0)); ctx.lineTo(X(xx) + 0.5, Y(H)); }
      for (const yy of [t.dest.y, t.dest.y + t.dest.h]) { ctx.moveTo(X(0), Y(yy) + 0.5); ctx.lineTo(X(W), Y(yy) + 0.5); }
    }
    ctx.stroke();
  }

  // 選択枠
  const sel = tileById(state.selected);
  if (sel) {
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.strokeRect(X(sel.dest.x) - 1, Y(sel.dest.y) - 1, sel.dest.w * sc + 2, sel.dest.h * sc + 2);
  }

  // スナップガイド
  ctx.strokeStyle = '#22d3ee';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 3]);
  for (const g of stage.guides) {
    ctx.beginPath();
    if (g.axis === 'x') { ctx.moveTo(X(g.v) + 0.5, 0); ctx.lineTo(X(g.v) + 0.5, ch); }
    else { ctx.moveTo(0, Y(g.v) + 0.5); ctx.lineTo(cw, Y(g.v) + 0.5); }
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // キャンバス枠
  ctx.strokeStyle = '#6b7280';
  ctx.lineWidth = 1;
  ctx.strokeRect(X(0) - 0.5, Y(0) - 0.5, W * sc + 1, H * sc + 1);

  $('canvasInfo').textContent = `${W}×${H} · 表示 ${(sc * 100).toFixed(1)}% · タイル ${state.tiles.length} 枚`;
}

function hitTile(px, py) {
  const x = (px - stage.ox) / stage.scale;
  const y = (py - stage.oy) / stage.scale;
  for (let i = state.tiles.length - 1; i >= 0; i--) {
    const d = state.tiles[i].dest;
    if (x >= d.x && x < d.x + d.w && y >= d.y && y < d.y + d.h) return state.tiles[i];
  }
  return null;
}

function snapMove(t, nx, ny) {
  stage.guides = [];
  if (!$('optSnap').checked) return { x: snapA(nx), y: snapA(ny) };
  const th = 10 / stage.scale;
  const xs = [0, state.canvas.width];
  const ys = [0, state.canvas.height];
  for (const u of state.tiles) {
    if (u === t) continue;
    xs.push(u.dest.x, u.dest.x + u.dest.w);
    ys.push(u.dest.y, u.dest.y + u.dest.h);
  }
  const best = (pos, size, cands, axis) => {
    let r = null;
    for (const c of cands) {
      for (const [edge, off] of [[pos, 0], [pos + size, size]]) {
        const d = Math.abs(edge - c);
        if (d < th && (!r || d < r.d)) r = { d, v: c - off, g: c };
      }
    }
    if (r) {
      stage.guides.push({ axis, v: r.g });
      return r.v;
    }
    return snapA(pos);
  };
  return { x: best(nx, t.dest.w, xs, 'x'), y: best(ny, t.dest.h, ys, 'y') };
}

const stageCv = $('stageCanvas');
stageCv.addEventListener('mousedown', (e) => {
  const r = stageCv.getBoundingClientRect();
  const t = hitTile(e.clientX - r.left, e.clientY - r.top);
  selectTile(t ? t.id : null);
  if (t) {
    stage.drag = { t, sx: e.clientX, sy: e.clientY, x0: t.dest.x, y0: t.dest.y, moved: false };
  }
});
window.addEventListener('mousemove', (e) => {
  const d = stage.drag;
  if (!d) {
    const r = stageCv.getBoundingClientRect();
    if (e.target === stageCv) stageCv.style.cursor = hitTile(e.clientX - r.left, e.clientY - r.top) ? 'move' : 'default';
    return;
  }
  const dx = (e.clientX - d.sx) / stage.scale;
  const dy = (e.clientY - d.sy) / stage.scale;
  if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 3) return;
  d.moved = true;
  let { x, y } = snapMove(d.t, d.x0 + dx, d.y0 + dy);
  x = clamp(x, 0, Math.max(0, state.canvas.width - d.t.dest.w));
  y = clamp(y, 0, Math.max(0, state.canvas.height - d.t.dest.h));
  d.t.dest.x = x;
  d.t.dest.y = y;
  drawStage();
  renderTileProps();
});
window.addEventListener('mouseup', () => {
  if (!stage.drag) return;
  const moved = stage.drag.moved;
  stage.drag = null;
  stage.guides = [];
  drawStage();
  if (moved) commit();
});

new ResizeObserver(() => drawStage()).observe($('stage'));

// ==================================================================
// タイル
// ==================================================================

function selectTile(id) {
  state.selected = id;
  drawStage();
  renderTileList();
  renderTileProps();
}

function addTile() {
  const s = (tileById(state.selected) && sourceById(tileById(state.selected).sourceId)) || state.sources.find((x) => x.probe);
  if (!s) {
    setStatus('先にソース動画を追加してください。', 'err');
    return;
  }
  const w = Math.min(s.probe.width, state.canvas.width);
  const h = Math.min(s.probe.height, state.canvas.height);
  const t = { id: newId(), sourceId: s.id, label: '', crop: { x: 0, y: 0, w: snapA(w), h: snapA(h) }, dest: { x: 0, y: 0, w: snapA(w), h: snapA(h) } };
  state.tiles.push(t);
  state.selected = t.id;
  commit();
}

function renderTileList() {
  const list = $('tileList');
  const bad = tileProblems();
  list.innerHTML = '';
  if (!state.tiles.length) {
    list.innerHTML = '<div class="muted" style="padding:6px">タイルはまだありません</div>';
    return;
  }
  state.tiles.forEach((t, i) => {
    const s = sourceById(t.sourceId);
    const row = document.createElement('div');
    row.className = 'tile-row' + (t.id === state.selected ? ' sel' : '') + (bad.has(t.id) ? ' bad' : '');
    row.style.setProperty('--c', s ? s.color : '#888');
    row.innerHTML = `<span class="num">${i + 1}</span><span class="sw"></span><span>S${sourceIndex(t.sourceId) + 1} ${escapeHtml(t.label || '')}</span>` +
      `<span class="geo">${t.dest.x},${t.dest.y} ${t.dest.w}×${t.dest.h}</span>`;
    row.onclick = () => selectTile(t.id);
    list.appendChild(row);
  });
}

function renderTileProps() {
  const t = tileById(state.selected);
  $('tileProps').classList.toggle('hidden', !t);
  if (!t) return;
  const idx = state.tiles.indexOf(t);
  $('tileTitle').textContent = `#${idx + 1}`;
  const sel = $('tileSource');
  sel.innerHTML = state.sources.map((s, i) => `<option value="${s.id}">S${i + 1}: ${escapeHtml(s.name)}</option>`).join('');
  sel.value = String(t.sourceId);
  const setIf = (id, v) => {
    if (document.activeElement !== $(id)) $(id).value = v;
  };
  setIf('tileLabel', t.label || '');
  setIf('cropX', t.crop.x); setIf('cropY', t.crop.y); setIf('cropW', t.crop.w); setIf('cropH', t.crop.h);
  setIf('destX', t.dest.x); setIf('destY', t.dest.y); setIf('destW', t.dest.w); setIf('destH', t.dest.h);
  const note = $('tileScaleNote');
  const scaled = t.crop.w !== t.dest.w || t.crop.h !== t.dest.h;
  note.classList.toggle('hidden', !scaled);
  if (scaled) note.textContent = `拡大縮小されます: ${t.crop.w}×${t.crop.h} → ${t.dest.w}×${t.dest.h}。画質を保つには「等倍」を推奨します。`;
  drawCrop();
}

function bindNum(id, apply) {
  $(id).addEventListener('change', () => {
    const t = tileById(state.selected);
    if (!t) return;
    const v = Math.round(Number($(id).value) || 0);
    apply(t, v);
    commit();
  });
}
bindNum('cropX', (t, v) => (t.crop.x = Math.max(0, v)));
bindNum('cropY', (t, v) => (t.crop.y = Math.max(0, v)));
bindNum('cropW', (t, v) => {
  const native = t.crop.w === t.dest.w;
  t.crop.w = Math.max(ALIGN, v);
  if (native) t.dest.w = t.crop.w;
});
bindNum('cropH', (t, v) => {
  const native = t.crop.h === t.dest.h;
  t.crop.h = Math.max(ALIGN, v);
  if (native) t.dest.h = t.crop.h;
});
bindNum('destX', (t, v) => (t.dest.x = v));
bindNum('destY', (t, v) => (t.dest.y = v));
bindNum('destW', (t, v) => (t.dest.w = Math.max(ALIGN, v)));
bindNum('destH', (t, v) => (t.dest.h = Math.max(ALIGN, v)));
$('tileSource').addEventListener('change', () => {
  const t = tileById(state.selected);
  if (!t) return;
  t.sourceId = Number($('tileSource').value);
  commit();
});
$('tileLabel').addEventListener('change', () => {
  const t = tileById(state.selected);
  if (!t) return;
  t.label = $('tileLabel').value;
  commit();
});
$('btnTileNative').onclick = () => {
  const t = tileById(state.selected);
  if (!t) return;
  t.dest.w = t.crop.w;
  t.dest.h = t.crop.h;
  commit();
};
function moveTileZ(front) {
  const t = tileById(state.selected);
  if (!t) return;
  state.tiles = state.tiles.filter((x) => x !== t);
  if (front) state.tiles.push(t);
  else state.tiles.unshift(t);
  commit();
}
$('btnTileFront').onclick = () => moveTileZ(true);
$('btnTileBack').onclick = () => moveTileZ(false);
function dupTile() {
  const t = tileById(state.selected);
  if (!t) return;
  const n = JSON.parse(JSON.stringify(t));
  n.id = newId();
  n.dest.x = clamp(n.dest.x + 40, 0, Math.max(0, state.canvas.width - n.dest.w));
  n.dest.y = clamp(n.dest.y + 40, 0, Math.max(0, state.canvas.height - n.dest.h));
  state.tiles.push(n);
  state.selected = n.id;
  commit();
}
function delTile() {
  const t = tileById(state.selected);
  if (!t) return;
  state.tiles = state.tiles.filter((x) => x !== t);
  state.selected = null;
  commit();
}
$('btnTileDup').onclick = dupTile;
$('btnTileDel').onclick = delTile;
$('btnAddTile').onclick = addTile;

// --- 切り出しミニエディタ ---
const crop = { scale: 1, ox: 0, oy: 0, drag: null };
function drawCrop() {
  const t = tileById(state.selected);
  const cv = $('cropCanvas');
  if (!t || cv.offsetParent === null) return;
  const s = sourceById(t.sourceId);
  const ctx = setupCanvas(cv);
  const cw = cv.clientWidth;
  const ch = cv.clientHeight;
  ctx.clearRect(0, 0, cw, ch);
  if (!s || !s.probe) return;
  const W = s.probe.width;
  const H = s.probe.height;
  crop.scale = Math.min((cw - 8) / W, (ch - 8) / H);
  crop.ox = (cw - W * crop.scale) / 2;
  crop.oy = (ch - H * crop.scale) / 2;
  if (s.thumb) {
    ctx.globalAlpha = 0.45;
    ctx.drawImage(s.thumb.img, crop.ox, crop.oy, W * crop.scale, H * crop.scale);
    ctx.globalAlpha = 1;
    const k = s.thumb.scale;
    ctx.drawImage(s.thumb.img, t.crop.x * k, t.crop.y * k, t.crop.w * k, t.crop.h * k,
      crop.ox + t.crop.x * crop.scale, crop.oy + t.crop.y * crop.scale, t.crop.w * crop.scale, t.crop.h * crop.scale);
  }
  // 他のタイルが同じソースのどこを使っているか
  ctx.setLineDash([3, 3]);
  ctx.strokeStyle = 'rgba(255,255,255,.35)';
  for (const u of state.tiles) {
    if (u === t || u.sourceId !== t.sourceId) continue;
    ctx.strokeRect(crop.ox + u.crop.x * crop.scale + 0.5, crop.oy + u.crop.y * crop.scale + 0.5, u.crop.w * crop.scale - 1, u.crop.h * crop.scale - 1);
  }
  ctx.setLineDash([]);
  ctx.strokeStyle = s.color;
  ctx.lineWidth = 2;
  ctx.strokeRect(crop.ox + t.crop.x * crop.scale, crop.oy + t.crop.y * crop.scale, t.crop.w * crop.scale, t.crop.h * crop.scale);
  ctx.strokeStyle = '#666';
  ctx.lineWidth = 1;
  ctx.strokeRect(crop.ox - 0.5, crop.oy - 0.5, W * crop.scale + 1, H * crop.scale + 1);
}
$('cropCanvas').addEventListener('mousedown', (e) => {
  const t = tileById(state.selected);
  if (!t) return;
  crop.drag = { t, sx: e.clientX, sy: e.clientY, x0: t.crop.x, y0: t.crop.y, moved: false };
});
window.addEventListener('mousemove', (e) => {
  const d = crop.drag;
  if (!d) return;
  const s = sourceById(d.t.sourceId);
  if (!s || !s.probe) return;
  d.moved = true;
  d.t.crop.x = clamp(snapA(d.x0 + (e.clientX - d.sx) / crop.scale), 0, s.probe.width - d.t.crop.w);
  d.t.crop.y = clamp(snapA(d.y0 + (e.clientY - d.sy) / crop.scale), 0, s.probe.height - d.t.crop.h);
  renderTileProps();
  drawStage();
});
window.addEventListener('mouseup', () => {
  if (crop.drag && crop.drag.moved) commit();
  crop.drag = null;
});

// ==================================================================
// キャンバス設定
// ==================================================================

function syncCanvasForm() {
  const c = state.canvas;
  $('canvasW').value = c.width;
  $('canvasH').value = c.height;
  const key = `${c.width}x${c.height}`;
  $('canvasPreset').value = [...$('canvasPreset').options].some((o) => o.value === key) ? key : 'custom';
  $('canvasFps').value = c.fps;
  if ($('canvasFps').value !== String(c.fps)) {
    const o = document.createElement('option');
    o.value = c.fps;
    o.textContent = fmtRate(c.fps);
    $('canvasFps').appendChild(o);
    $('canvasFps').value = c.fps;
  }
  $('canvasBg').value = c.background;
}
$('canvasPreset').addEventListener('change', () => {
  const v = $('canvasPreset').value;
  if (v === 'custom') return;
  const [w, h] = v.split('x').map(Number);
  state.canvas.width = w;
  state.canvas.height = h;
  commit();
  syncCanvasForm();
});
$('canvasW').addEventListener('change', () => {
  state.canvas.width = Math.max(ALIGN, snapA(Number($('canvasW').value) || 0));
  commit();
  syncCanvasForm();
});
$('canvasH').addEventListener('change', () => {
  state.canvas.height = Math.max(ALIGN, snapA(Number($('canvasH').value) || 0));
  commit();
  syncCanvasForm();
});
$('canvasFps').addEventListener('change', () => {
  state.canvas.fps = $('canvasFps').value;
  commit();
});
$('canvasBg').addEventListener('change', () => {
  state.canvas.background = $('canvasBg').value;
  commit();
});
$('btnFitCanvas').onclick = () => {
  if (!state.tiles.length) return;
  state.canvas.width = snapA(Math.max(...state.tiles.map((t) => t.dest.x + t.dest.w)));
  state.canvas.height = snapA(Math.max(...state.tiles.map((t) => t.dest.y + t.dest.h)));
  commit();
  syncCanvasForm();
};
['optLabels', 'optGrid'].forEach((id) => $(id).addEventListener('change', drawStage));

// ==================================================================
// プレビュー時間
// ==================================================================

function timelineRange() {
  const used = [...new Set(state.tiles.map((t) => t.sourceId))].map(sourceById).filter((s) => s && s.probe);
  const list = (used.length ? used : state.sources.filter((s) => s.probe)).map((s) => Math.max(0, s.probe.duration - (s.offset || 0)));
  if (!list.length) return 0;
  const d = state.output.duration;
  if (d.mode === 'custom' && d.seconds > 0) return d.seconds;
  return d.mode === 'longest' ? Math.max(...list) : Math.min(...list);
}
function syncTimeline() {
  const max = timelineRange();
  const sl = $('timeSlider');
  sl.max = Math.max(0.01, max);
  if (state.previewTime > max) state.previewTime = 0;
  sl.value = state.previewTime;
  $('timeLabel').textContent = `${fmtTime(state.previewTime)} / ${fmtTime(max)}`;
}
$('timeSlider').addEventListener('input', () => {
  state.previewTime = Number($('timeSlider').value);
  $('timeLabel').textContent = `${fmtTime(state.previewTime)} / ${fmtTime(timelineRange())}`;
  reloadThumbs();
});

$('btnRealPreview').onclick = async () => {
  const btn = $('btnRealPreview');
  btn.disabled = true;
  setStatus('FFmpeg で合成フレームを生成しています…');
  try {
    const url = await api.previewFrame(buildJob(), state.previewTime);
    $('previewImg').src = url;
    $('previewInfo').textContent = `${state.canvas.width}×${state.canvas.height} @ ${fmtTime(state.previewTime)}`;
    $('previewDialog').showModal();
    setStatus('実出力プレビューを生成しました', 'ok');
  } catch (e) {
    setStatus(`プレビュー失敗: ${e.message}`, 'err');
  } finally {
    btn.disabled = false;
  }
};

// ==================================================================
// 書き出し設定
// ==================================================================

function buildJob() {
  const out = state.output;
  let outPath = out.path;
  if (!outPath) {
    const first = state.tiles.length ? sourceById(state.tiles[0].sourceId) : state.sources[0];
    if (first) {
      const dir = first.path.replace(/[\\/][^\\/]*$/, '');
      const base = first.name.replace(/\.[^.]+$/, '');
      const sep = first.path.includes('\\') ? '\\' : '/';
      outPath = `${dir}${sep}${base}_layout_${state.canvas.width}x${state.canvas.height}.mp4`;
    }
  }
  return {
    sources: state.sources.map((s) => ({ path: s.path, offset: s.offset || 0, probe: s.probe })),
    canvas: { ...state.canvas },
    tiles: state.tiles.map((t) => ({ source: sourceIndex(t.sourceId), crop: t.crop, dest: t.dest, label: t.label })),
    output: {
      ...out,
      path: outPath,
      audio: { mode: out.audio.mode, source: sourceIndex(out.audio.sourceId) },
    },
  };
}

function populateExportForm() {
  const codec = $('outCodec');
  codec.innerHTML = '<option value="source">ソースと同じ</option>' +
    Object.entries(caps.codecs).map(([k, c]) => `<option value="${k}">${escapeHtml(c.label)}</option>`).join('');
  const q = $('outQuality');
  q.innerHTML = Object.entries(caps.qualities).map(([k, c]) => `<option value="${k}">${escapeHtml(c.label)}</option>`).join('');
  const cont = $('outContainer');
  cont.innerHTML = '<option value="auto">自動 (ソースと同じ形式)</option>' +
    Object.entries(caps.containers).map(([k, c]) => `<option value="${k}">${escapeHtml(c.label)}</option>`).join('');
  updateHwOptions();
}

function currentCodecKey() {
  const v = state.output.codec;
  if (v !== 'source') return v;
  const t = state.tiles[0];
  const s = t ? sourceById(t.sourceId) : state.sources[0];
  return (s && s.probe && caps && caps.sourceCodecMap[s.probe.codec]) || 'h264';
}

function updateHwOptions() {
  if (!caps) return;
  const def = caps.codecs[currentCodecKey()];
  const sel = $('outHw');
  const opts = ['<option value="none">ソフトウェア (最高画質)</option>'];
  for (const [hw, label] of Object.entries(caps.hwLabels)) {
    // この FFmpeg に該当種類のエンコーダが一つもなければ (例: Windows の VideoToolbox) 表示しない
    if (!Object.values(caps.codecs).some((c) => c.hw[hw] && caps.encoders[c.hw[hw]])) continue;
    const enc = def && def.hw[hw];
    const pending = !caps.hwWorking;
    const ok = enc && !pending && caps.hwWorking.includes(enc);
    const why = !enc ? '非対応コーデック' : pending ? '確認中…' : ok ? enc : '利用不可';
    opts.push(`<option value="${hw}" ${ok ? '' : 'disabled'}>${label} (${why})</option>`);
  }
  sel.innerHTML = opts.join('');
  sel.value = state.output.hw;
  if (sel.value !== state.output.hw || sel.selectedOptions[0].disabled) sel.value = 'none';
}

function renderAudioOptions() {
  const sel = $('outAudio');
  const opts = ['<option value="none">なし</option>'];
  state.sources.forEach((s, i) => {
    if (s.probe && s.probe.audio.length) {
      const a = s.probe.audio[0];
      opts.push(`<option value="src:${s.id}">S${i + 1} の音声 (${a.codec} ${a.channels}ch・可能なら無変換)</option>`);
    }
  });
  if (state.sources.filter((s) => s.probe && s.probe.audio.length).length > 1) opts.push('<option value="mix">全ソースの音声をミックス</option>');
  sel.innerHTML = opts.join('');
  const a = state.output.audio;
  sel.value = a.mode === 'source' ? `src:${a.sourceId}` : a.mode;
  if (!sel.value) sel.value = 'none';
}

function syncExportForm() {
  const o = state.output;
  $('outCodec').value = o.codec;
  updateHwOptions();
  $('outQuality').value = o.quality;
  $('bitrateRow').classList.toggle('hidden', o.quality !== 'bitrate');
  $('outBitrate').value = o.bitrateMbps || '';
  $('outPixFmt').value = o.pixFmt;
  $('outContainer').value = o.container;
  renderAudioOptions();
  $('outDurMode').value = o.duration.mode;
  $('durSecRow').classList.toggle('hidden', o.duration.mode !== 'custom');
  $('outDurSec').value = o.duration.seconds || '';
  $('outPath').value = o.path;
}

function syncFormsFromState() {
  syncCanvasForm();
  if (caps) syncExportForm();
  renderTileProps();
}

const onOut = (id, fn) => $(id).addEventListener('change', () => {
  fn($(id).value);
  commit();
  syncExportForm();
});
onOut('outCodec', (v) => (state.output.codec = v));
onOut('outHw', (v) => (state.output.hw = v));
onOut('outQuality', (v) => (state.output.quality = v));
onOut('outBitrate', (v) => (state.output.bitrateMbps = Math.max(0, Number(v) || 0)));
onOut('outPixFmt', (v) => (state.output.pixFmt = v));
onOut('outContainer', (v) => (state.output.container = v));
onOut('outAudio', (v) => {
  if (v.startsWith('src:')) state.output.audio = { mode: 'source', sourceId: Number(v.slice(4)) };
  else state.output.audio = { mode: v, sourceId: state.output.audio.sourceId };
});
onOut('outDurMode', (v) => (state.output.duration.mode = v));
onOut('outDurSec', (v) => (state.output.duration.seconds = Math.max(0, Number(v) || 0)));
onOut('outPath', (v) => (state.output.path = v.trim()));

$('btnBrowseOut').onclick = async () => {
  const job = buildJob();
  const ext = lastPlan && lastPlan.info ? caps.containers[lastPlan.info.containerKey].ext : 'mp4';
  const p = await api.saveOutputDialog(job.output.path ? job.output.path.replace(/\.[^.\\/]+$/, '.' + ext) : undefined, ext);
  if (!p) return;
  state.output.path = p;
  commit();
  syncExportForm();
};

const refreshPlan = debounce(async () => {
  if (!caps) return;
  const box = $('planSummary');
  if (!state.tiles.length) {
    box.innerHTML = '<div class="note info">タイルを配置すると書き出し内容が表示されます。</div>';
    $('planCommand').textContent = '';
    $('btnStartExport').disabled = true;
    lastPlan = null;
    return;
  }
  try {
    const plan = await api.plan(buildJob());
    lastPlan = plan;
    const i = plan.info;
    const rows = [
      ['出力サイズ', `${i.size} @ ${fmtRate(i.fps)}fps`],
      ['コーデック', `${escapeHtml(i.codec)}${i.profile ? ` (${escapeHtml(i.profile)})` : ''}`],
      ['エンコーダ', escapeHtml(i.encoder)],
      ['画質', escapeHtml(i.quality) + (i.bitrate ? ` ${(i.bitrate / 1e6).toFixed(1)} Mbps` : '')],
      ['ピクセル形式', escapeHtml(i.pixFmt)],
      ['参考ビットレート', `ソース相当 ≈ ${(i.estimatedBitrate / 1e6).toFixed(1)} Mbps`],
      ['コンテナ', escapeHtml(i.container)],
      ['音声', escapeHtml(i.audio)],
      ['尺', fmtTime(plan.duration)],
      ['合成方式', i.compositor === 'xstack' ? 'xstack (画素コピー・無劣化)' : i.compositor === 'pad' ? 'pad (画素コピー・無劣化)' : 'overlay (重なりあり)'],
      ['出力ファイル', `<span class="path">${escapeHtml(plan.outPath)}</span>`],
    ];
    box.innerHTML = `<table>${rows.map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join('')}</table>` +
      plan.notes.map((n) => `<div class="note info">${escapeHtml(n)}</div>`).join('') +
      plan.warnings.map((n) => `<div class="note warn">${escapeHtml(n)}</div>`).join('');
    $('planCommand').textContent = plan.command;
    $('btnStartExport').disabled = state.exporting;
    $('statusRight').textContent = `${i.codec} · ${i.encoder} · ${i.container}`;
  } catch (e) {
    lastPlan = null;
    box.innerHTML = `<div class="note err">${escapeHtml(e.message)}</div>`;
    $('planCommand').textContent = '';
    $('btnStartExport').disabled = true;
    $('statusRight').textContent = '';
  }
}, 250);

$('btnCopyCmd').onclick = () => {
  navigator.clipboard.writeText($('planCommand').textContent);
  setStatus('コマンドをコピーしました', 'ok');
};

// ==================================================================
// 書き出し実行
// ==================================================================

const logBuf = [];
function appendLog(s) {
  logBuf.push(s);
  if (logBuf.length > 400) logBuf.splice(0, logBuf.length - 400);
  const el = $('logView');
  if ($('logDetails').open) {
    el.textContent = logBuf.join('');
    el.scrollTop = el.scrollHeight;
  }
}
$('logDetails').addEventListener('toggle', () => {
  $('logView').textContent = logBuf.join('');
  $('logView').scrollTop = $('logView').scrollHeight;
});

async function startExport() {
  if (state.exporting) return;
  showTab('export');
  logBuf.length = 0;
  $('logView').textContent = '';
  $('doneBox').classList.add('hidden');
  try {
    const r = await api.startExport(buildJob());
    if (!r.started) return;
    state.exporting = true;
    $('btnStartExport').classList.add('hidden');
    $('btnCancelExport').classList.remove('hidden');
    $('progressBox').classList.remove('hidden');
    $('progressBar').style.width = '0%';
    $('progressText').textContent = '開始しています…';
    setStatus(`書き出し中: ${r.outPath}`);
  } catch (e) {
    setStatus(`書き出しを開始できません: ${e.message}`, 'err');
  }
}

api.onProgress((p) => {
  $('progressBar').style.width = `${(p.ratio * 100).toFixed(1)}%`;
  $('progressText').innerHTML =
    `${(p.ratio * 100).toFixed(1)}% · ${p.frame} フレーム · ${p.fps ? p.fps.toFixed(1) : '-'} fps · ${p.speed || '-'}<br>` +
    `経過 ${fmtTime(p.elapsed)} · 残り ${p.eta != null ? fmtTime(p.eta) : '--:--'} · ${fmtBytes(p.size)}${p.bitrate && p.bitrate !== 'N/A' ? ` · ${p.bitrate}` : ''}`;
  $('statusRight').textContent = `書き出し ${(p.ratio * 100).toFixed(1)}%`;
});
api.onLog(appendLog);
api.onDone((r) => {
  state.exporting = false;
  $('btnStartExport').classList.remove('hidden');
  $('btnCancelExport').classList.add('hidden');
  $('btnStartExport').disabled = !lastPlan;
  const box = $('doneBox');
  box.classList.remove('hidden');
  if (r.ok) {
    $('progressBar').style.width = '100%';
    box.innerHTML = `<div class="note info">完了しました (${fmtTime(r.elapsed)})<br><span class="path">${escapeHtml(r.outPath)}</span></div>` +
      '<button class="small" id="btnShowOut">フォルダを開く</button>';
    $('btnShowOut').onclick = () => api.showItem(r.outPath);
    setStatus('書き出しが完了しました', 'ok');
  } else if (r.cancelled) {
    box.innerHTML = '<div class="note warn">中止しました。途中までのファイルは削除しました。</div>';
    setStatus('書き出しを中止しました');
  } else {
    box.innerHTML = `<div class="note err">失敗しました:<br>${escapeHtml(r.error || '')}</div>`;
    $('logDetails').open = true;
    setStatus('書き出しに失敗しました', 'err');
  }
  $('statusRight').textContent = '';
});
$('btnStartExport').onclick = startExport;
$('btnExportTop').onclick = () => {
  showTab('export');
  refreshPlan();
};
$('btnCancelExport').onclick = () => api.cancelExport();

// ==================================================================
// プロジェクト保存・読み込み
// ==================================================================

function projectData() {
  return {
    app: 'MovieLayout',
    version: 1,
    sources: state.sources.map((s) => ({ path: s.path, offset: s.offset || 0 })),
    canvas: state.canvas,
    tiles: state.tiles.map((t) => ({ source: sourceIndex(t.sourceId), label: t.label, crop: t.crop, dest: t.dest })),
    output: { ...state.output, audio: { mode: state.output.audio.mode, source: sourceIndex(state.output.audio.sourceId) } },
  };
}

async function saveProject(as = false) {
  try {
    const p = await api.saveProject(projectData(), as ? null : state.projectPath);
    if (!p) return;
    state.projectPath = p;
    state.dirty = false;
    history.stack = [snapshot()];
    history.index = 0;
    updateTitle();
    setStatus(`保存しました: ${p}`, 'ok');
  } catch (e) {
    setStatus(`保存できません: ${e.message}`, 'err');
  }
}

async function openProject() {
  if (state.dirty && !confirm('変更が保存されていません。破棄して開きますか？')) return;
  let r;
  try {
    r = await api.openProject();
  } catch (e) {
    setStatus(`開けません: ${e.message}`, 'err');
    return;
  }
  if (!r) return;
  const d = r.data;
  if (d.app !== 'MovieLayout') {
    setStatus('MovieLayout のプロジェクトファイルではありません', 'err');
    return;
  }
  resetState();
  const missing = [];
  for (const [i, src] of (d.sources || []).entries()) {
    const s = { id: newId(), path: src.path, name: src.path.split(/[\\/]/).pop(), offset: src.offset || 0, probe: null, thumb: null, color: COLORS[i % COLORS.length], missing: true };
    try {
      if (await api.exists(src.path)) {
        s.probe = await api.probe(src.path);
        s.missing = false;
      }
    } catch { /* missing */ }
    if (s.missing) missing.push(s.name);
    state.sources.push(s);
  }
  state.canvas = { ...state.canvas, ...d.canvas };
  state.tiles = (d.tiles || []).filter((t) => state.sources[t.source]).map((t) => ({
    id: newId(), sourceId: state.sources[t.source].id, label: t.label || '', crop: t.crop, dest: t.dest,
  }));
  const o = d.output || {};
  state.output = {
    ...state.output, ...o,
    audio: { mode: (o.audio && o.audio.mode) || 'source', sourceId: o.audio && state.sources[o.audio.source] ? state.sources[o.audio.source].id : null },
    duration: { ...state.output.duration, ...(o.duration || {}) },
  };
  state.projectPath = r.path;
  history.stack = [];
  history.index = -1;
  renderSources();
  commit();
  state.dirty = false;
  updateTitle();
  syncFormsFromState();
  state.sources.forEach(loadThumb);
  if (missing.length) setStatus(`見つからないソースがあります: ${missing.join(', ')} — 「差替」で指定してください`, 'err');
  else setStatus(`開きました: ${r.path}`, 'ok');
}

function resetState() {
  state.sources = [];
  state.tiles = [];
  state.selected = null;
  state.canvas = { width: 3840, height: 2160, fps: 'auto', background: '#000000' };
  state.output = {
    path: '', container: 'auto', codec: 'source', hw: 'none', quality: 'visually_lossless', bitrateMbps: 0,
    pixFmt: 'source', audio: { mode: 'source', sourceId: null }, duration: { mode: 'shortest', seconds: 0 },
  };
  state.previewTime = 0;
  state.projectPath = null;
}

function newProject() {
  if (state.dirty && !confirm('変更が保存されていません。破棄して新規作成しますか？')) return;
  resetState();
  history.stack = [];
  history.index = -1;
  renderSources();
  commit();
  syncFormsFromState();
}

$('btnNew').onclick = newProject;
$('btnOpen').onclick = openProject;
$('btnSave').onclick = () => saveProject(false);
$('btnSaveAs').onclick = () => saveProject(true);
$('btnUndo').onclick = undo;
$('btnRedo').onclick = redo;

// ==================================================================
// タブ・キーボード・ドロップ
// ==================================================================

function showTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $('tab-layout').classList.toggle('hidden', name !== 'layout');
  $('tab-export').classList.toggle('hidden', name !== 'export');
  if (name === 'layout') drawCrop();
  else refreshPlan();
}
document.querySelectorAll('.tab').forEach((t) => (t.onclick = () => showTab(t.dataset.tab)));

window.addEventListener('keydown', (e) => {
  const inField = /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName);
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); saveProject(e.shiftKey); return; }
  if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); openProject(); return; }
  if (mod && e.key.toLowerCase() === 'n') { e.preventDefault(); newProject(); return; }
  if (inField || document.querySelector('dialog[open]')) return;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
  if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); dupTile(); return; }
  const t = tileById(state.selected);
  if (!t) return;
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); delTile(); return; }
  const step = e.shiftKey ? 20 : ALIGN;
  const mv = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
  if (mv) {
    e.preventDefault();
    t.dest.x = clamp(t.dest.x + mv[0], 0, Math.max(0, state.canvas.width - t.dest.w));
    t.dest.y = clamp(t.dest.y + mv[1], 0, Math.max(0, state.canvas.height - t.dest.h));
    commitNudge();
    drawStage();
    renderTileProps();
  }
  if (e.key === 'Escape') selectTile(null);
});
const commitNudge = debounce(commit, 400);

window.addEventListener('dragover', (e) => {
  e.preventDefault();
  document.body.classList.add('dragover');
});
window.addEventListener('dragleave', (e) => {
  if (e.relatedTarget == null) document.body.classList.remove('dragover');
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  document.body.classList.remove('dragover');
  const paths = [...e.dataTransfer.files].map((f) => api.pathForFile(f)).filter(Boolean);
  if (paths.length) addSources(paths);
});
$('btnAddSource').onclick = async () => {
  const files = await api.openVideos(true);
  if (files.length) addSources(files);
};
$('btnCustomSplit').onclick = () => openSplitDialog(null);

window.addEventListener('beforeunload', (e) => {
  if (state.dirty) e.returnValue = false;
});

// ==================================================================
// 全体更新
// ==================================================================

function refreshAll() {
  drawStage();
  renderTileList();
  renderTileProps();
  syncTimeline();
  if (caps) {
    renderAudioOptions();
    updateHwOptions();
  }
  refreshPlan();
}

(async function init() {
  renderPresets();
  renderSources();
  syncCanvasForm();
  commit();
  try {
    const info = await api.info();
    const badge = $('ffmpegBadge');
    if (info.ffmpegVersion) {
      badge.textContent = info.ffmpegVersion.replace(/^ffmpeg version (\S+).*/, 'FFmpeg $1').slice(0, 40);
      badge.title = `${info.ffmpegVersion}\n${info.ffmpegPath}`;
    } else {
      badge.textContent = 'FFmpeg が見つかりません';
      badge.classList.add('err');
    }
    caps = await api.caps();
    populateExportForm();
    syncExportForm();
    if (!caps.hwWorking) {
      setStatus('準備完了 (ハードウェアエンコーダを確認中…)');
      api.hw().then((hw) => {
        caps.hwWorking = hw;
        updateHwOptions();
        refreshPlan();
        setStatus(hw.length ? `利用可能な HW エンコーダ: ${hw.join(', ')}` : '準備完了 (HW エンコーダなし)', 'ok');
      }).catch(() => {
        caps.hwWorking = [];
        updateHwOptions();
      });
    }
    // 開発用: 環境変数でファイルとプリセットを渡して起動
    if (info.devFiles.length) {
      await addSources(info.devFiles);
      if (info.devPreset) {
        // 末尾に ! を付けるとダイアログを開いたままにする
        const p = Presets.LIST.find((x) => x.id === info.devPreset.replace(/!$/, ''));
        if (p) {
          openSplitDialog(p);
          if (!info.devPreset.endsWith('!')) $('splitDialog').close('apply');
        }
      }
      setTimeout(() => {
        if (info.devTab) showTab(info.devTab);
        if (info.devSelect && state.tiles[info.devSelect - 1]) selectTile(state.tiles[info.devSelect - 1].id);
        api.devReady();
      }, 300);
    } else {
      api.devReady();
    }
    refreshAll();
  } catch (e) {
    setStatus(`初期化エラー: ${e.message}`, 'err');
    api.devReady();
  }
})();
