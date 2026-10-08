/**
 * アプリ全体の土台: 全タブ共通のヘルパーと、ワークスペース (タブ) の切り替え管理。
 *
 * ワークスペースのライフサイクル (docs/DESIGN.md も参照)
 *   init()  : 初めて表示されたときに 1 回だけ。scripts を指定したタブはこの直前にスクリプトを読み込む (遅延読み込み)
 *   show()  : 表示されるたび。描画や監視を再開する
 *   hide()  : 非表示になるたび。描画ループ・動画再生・タイマーなどを必ず止める
 *   getState() / setState(s) / reset() : プロジェクトファイルへの保存・読み込み (任意)
 *
 * 非表示のタブは何も処理しないことで、タブを増やしてもアプリ全体が重くならないようにする。
 */
'use strict';

// ==================================================================
// 共通ヘルパー
// ==================================================================

const $ = (id) => document.getElementById(id);

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

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

const debounce = (fn, ms) => {
  let t = null;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
};

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** canvas を表示サイズ × devicePixelRatio に合わせ、CSS ピクセル座標で描ける 2D コンテキストを返す */
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

/** デザイントークン (style.css の :root) を JS から読む。canvas 描画の色を CSS と揃えるため */
function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** ローカルファイルのパスを file:// URL に変換する */
function fileUrl(p) {
  let s = String(p).replace(/\\/g, '/');
  if (!s.startsWith('/')) s = '/' + s;
  return 'file://' + s.split('/').map((seg) => encodeURIComponent(seg).replace(/%3A/gi, ':')).join('/');
}

// ==================================================================
// ワークスペース (タブ) 管理
// ==================================================================

const App = (() => {
  const spaces = new Map(); // id → { def, impl, ready, pending }
  let active = null;
  let dirtyListener = () => {};

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error(`${src} を読み込めません`));
      document.body.appendChild(s);
    });
  }

  /**
   * @param {object} def
   *   id      : 'layout' など
   *   module  : () => ワークスペース実装オブジェクト (init/show/hide…)
   *   scripts : 初回表示時に読み込むスクリプト (遅延読み込み)
   */
  function register(def) {
    spaces.set(def.id, { def, impl: null, ready: false, pending: undefined });
  }

  async function ensureReady(ws) {
    if (ws.ready) return;
    for (const src of ws.def.scripts || []) await loadScript(src);
    ws.impl = ws.def.module();
    if (ws.impl.init) await ws.impl.init();
    ws.ready = true;
    if (ws.pending !== undefined) {
      if (ws.pending === null) ws.impl.reset && ws.impl.reset();
      else ws.impl.setState && ws.impl.setState(ws.pending);
      ws.pending = undefined;
    }
  }

  async function show(id) {
    const next = spaces.get(id);
    if (!next || active === id) return;
    const prev = spaces.get(active);
    if (prev && prev.ready && prev.impl.hide) prev.impl.hide();
    document.querySelectorAll('.workspace').forEach((el) => (el.hidden = el.dataset.ws !== id));
    document.querySelectorAll('.ws-tab').forEach((t) => {
      const on = t.dataset.ws === id;
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    active = id;
    try {
      await ensureReady(next);
      if (active === id && next.impl.show) next.impl.show();
    } catch (e) {
      setStatus(`タブを開けません: ${e.message}`, 'err');
    }
  }

  /** プロジェクト保存用: 各タブの状態。未初期化のタブは読み込み済みの状態をそのまま返す */
  function collectState() {
    const out = {};
    for (const [id, ws] of spaces) {
      if (ws.ready && ws.impl.getState) out[id] = ws.impl.getState();
      else if (ws.pending) out[id] = ws.pending;
    }
    return out;
  }

  /** プロジェクト読み込み: 未初期化のタブには初期化時に渡す (読み込みのためだけに初期化しない) */
  function applyState(all) {
    for (const [id, ws] of spaces) {
      if (id === 'layout') continue; // レイアウト編集は app.js が直接扱う
      const s = all ? all[id] : null;
      if (ws.ready) {
        if (s && ws.impl.setState) ws.impl.setState(s);
        else if (!s && ws.impl.reset) ws.impl.reset();
      } else {
        ws.pending = s || null;
      }
    }
  }

  function resetAll() {
    applyState(null);
  }

  /** ウィンドウにドロップされたファイルを、表示中のタブに渡す */
  function dropFiles(paths) {
    const ws = spaces.get(active);
    if (ws && ws.ready && ws.impl.onDropFiles) ws.impl.onDropFiles(paths);
  }

  return {
    register,
    show,
    dropFiles,
    collectState,
    applyState,
    resetAll,
    get active() {
      return active;
    },
    isActive: (id) => active === id,
    /** 各タブが「保存されていない変更がある」ことを知らせる */
    markDirty: () => dirtyListener(),
    onDirty: (fn) => (dirtyListener = fn),
  };
})();

document.querySelectorAll('.ws-tab').forEach((t) => t.addEventListener('click', () => App.show(t.dataset.ws)));
