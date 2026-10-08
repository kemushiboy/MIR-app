/* global fileUrl, clamp */
/**
 * ソース動画の同期再生 (レイアウト編集・投影シミュレーターで共用)。
 *
 * - ソースごとに <video> を 1 つ持ち、共通の再生位置 (タイムライン時刻) に各ソースの「開始」オフセットを足して合わせる
 * - ブラウザで再生できない形式 (ProRes など) は ok=false になり、呼び出し側は静止画で代用する
 * - 再生中だけ requestAnimationFrame を回し、ずれたソースを補正して 'frame' を通知する。停止中は何もしない
 */
'use strict';

window.Player = (() => {
  const entries = new Map(); // sourceId → { el, path, offset, ok: null|true|false }
  const listeners = new Set();
  let t = 0;
  let duration = 0;
  let playing = false;
  let raf = 0;
  let t0 = 0;
  let wall0 = 0;
  let audioIds = new Set();

  function emit(type) {
    for (const fn of listeners) fn(type);
  }

  function expected(e) {
    const d = e.el.duration || Infinity;
    return clamp(t + e.offset, 0, Math.max(0, d - 0.02));
  }

  function create(id, path, offset) {
    const el = document.createElement('video');
    el.preload = 'auto';
    el.playsInline = true;
    el.muted = true;
    const e = { el, path, offset, ok: null };
    el.addEventListener('loadeddata', () => {
      // 音声だけ読めて映像をデコードできない形式 (ProRes の mov など) は videoWidth が 0 になる
      e.ok = el.videoWidth > 0;
      if (!e.ok) {
        dispose(e);
        emit('ready');
        return;
      }
      el.currentTime = expected(e);
      applyAudio();
      emit('ready');
    });
    el.addEventListener('error', () => {
      e.ok = false;
      emit('ready');
    });
    el.addEventListener('seeked', () => {
      if (!playing) emit('frame'); // 停止中のシーク結果を描き直す
    });
    el.src = fileUrl(path);
    return e;
  }

  function dispose(e) {
    e.el.pause();
    e.el.removeAttribute('src');
    e.el.load();
  }

  /** ソースの一覧を反映する (変化がなければ何もしない) */
  function sync(list) {
    const keep = new Set();
    for (const s of list) {
      keep.add(s.id);
      const cur = entries.get(s.id);
      if (cur && cur.path === s.path) {
        if (cur.offset !== s.offset) {
          cur.offset = s.offset;
          if (cur.ok) cur.el.currentTime = expected(cur);
        }
        continue;
      }
      if (cur) dispose(cur);
      entries.set(s.id, create(s.id, s.path, s.offset));
    }
    for (const [id, e] of entries) {
      if (!keep.has(id)) {
        dispose(e);
        entries.delete(id);
      }
    }
  }

  /** 音を出すソース (それ以外はミュート) */
  function setAudio(ids) {
    audioIds = new Set(ids);
    applyAudio();
  }
  function applyAudio() {
    for (const [id, e] of entries) e.el.muted = !audioIds.has(id);
  }

  function setDuration(d) {
    duration = Math.max(0, d || 0);
    if (t > duration) seek(0);
  }

  function play() {
    if (!duration || playing) return;
    if (t >= duration - 0.05) t = 0;
    playing = true;
    t0 = t;
    wall0 = performance.now();
    for (const e of entries.values()) {
      if (!e.ok) continue;
      e.el.currentTime = expected(e);
      e.el.play().catch(() => {});
    }
    raf = requestAnimationFrame(tick);
    emit('state');
  }

  function pause() {
    if (!playing) return;
    playing = false;
    cancelAnimationFrame(raf);
    raf = 0;
    for (const e of entries.values()) e.el.pause();
    emit('state');
    emit('frame');
  }

  function seek(nt) {
    t = clamp(nt, 0, duration || 0);
    for (const e of entries.values()) if (e.ok) e.el.currentTime = expected(e);
    if (playing) {
      t0 = t;
      wall0 = performance.now();
    }
    emit('time');
  }

  function tick(now) {
    raf = 0;
    if (!playing) return;
    t = t0 + (now - wall0) / 1000;
    if (t >= duration) {
      // 最後まで来たら先頭に戻ってループ再生
      seek(0);
    }
    for (const e of entries.values()) {
      if (!e.ok || e.el.readyState < 2) continue;
      const exp = expected(e);
      const end = e.el.duration && t + e.offset >= e.el.duration - 0.02;
      if (end) continue; // 短いソースは最後のフレームで止めておく
      if (Math.abs(e.el.currentTime - exp) > 0.15) e.el.currentTime = exp; // ずれを補正
      if (e.el.paused) e.el.play().catch(() => {});
    }
    emit('time');
    emit('frame');
    raf = requestAnimationFrame(tick);
  }

  /** 描画に使える動画要素 (再生できない・まだ読み込み中なら null) */
  function drawable(id) {
    const e = entries.get(id);
    return e && e.ok && e.el.readyState >= 2 ? e.el : null;
  }

  return {
    sync,
    setAudio,
    setDuration,
    play,
    pause,
    toggle: () => (playing ? pause() : play()),
    seek,
    drawable,
    /** 再生できない形式のソース */
    unplayable: () => [...entries].filter(([, e]) => e.ok === false).map(([id]) => id),
    get time() {
      return t;
    },
    get duration() {
      return duration;
    },
    get playing() {
      return playing;
    },
    on: (fn) => listeners.add(fn),
    off: (fn) => listeners.delete(fn),
  };
})();
