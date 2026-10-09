/* global App, Figures, SimGL, Player, api, $, setStatus, fmtTime, clamp, debounce, escapeHtml, setupCanvas, cssVar, fileUrl */
/**
 * 投影シミュレーター: 壁面 (既定 20m × 3m) に映像を投影した想定で、
 *   - 実寸比較: 立面図に人物のシルエットを実寸で並べる
 *   - 子供目線: 選んだ人物の目の高さからの一人称視点 (WebGL)
 *   - 目線比較: 2 人の視点を左右に並べる
 *
 * パフォーマンス方針 (docs/DESIGN.md):
 *   - 描画は invalidate() で要求されたときだけ。継続描画は「移動キーを押している間」「動画の再生中」のみ
 *   - hide() で描画ループ停止・動画一時停止・キー入力の解除
 */
'use strict';

window.SimulatorWorkspace = (() => {
  let seq = 1;
  const DEG = Math.PI / 180;
  // 人物目線の既定: 壁から 1.5m、視線は水平、焦点距離 50mm (人の目に近い標準)
  const DEFAULT_CAM = { z: 1.5, yaw: 0, pitch: 0, focal: 50 };

  // ------------------------------------------------------------------
  // 状態 (プロジェクトファイルに保存される)
  // ------------------------------------------------------------------
  function defaults() {
    const figs = [
      ['3歳', 95, 6.5], ['5歳', 109, 8], ['8歳 (小3)', 128, 9.5], ['大人', 165, 11.5],
    ].map(([label, height, x], i) => ({ id: seq++, label, height, x, z: DEFAULT_CAM.z, color: Figures.COLORS[i % Figures.COLORS.length] }));
    return {
      // 絵コンテ (50cm 方眼) から読み取った実寸: 映像全体 19.69m × 2.77m。下端は床面 (0m)
      wall: { width: 19.69, height: 2.77, bottom: 0, fit: 'contain' },
      // インタラクション範囲 (壁の左端からの距離 m)。絵コンテの紫の範囲
      zones: [{ id: seq++, x0: 3.43, x1: 6.92 }, { id: seq++, x0: 12.36, x1: 15.84 }],
      source: { kind: 'sources', path: null },
      figures: figs,
      viewerId: figs[1].id,
      compareId: figs[3].id,
      cam: { ...DEFAULT_CAM, x: figs[1].x }, // 目線の人物 (5歳) の立ち位置
      view: 'elevation',
      showGrid: false,
      showFigures: false,
      showZones: false,
    };
  }

  let S = defaults();

  // ------------------------------------------------------------------
  // 視点の画角: 35mm 判換算の焦点距離で指定する (横 36mm のフィルム幅を画面の横幅に対応させる)
  // ------------------------------------------------------------------
  const FOCAL_PRESETS = [
    { mm: 50, desc: '標準レンズ。人の目で注視したときの遠近感に近い' },
    { mm: 35, desc: 'やや広め。注視点の周りまで含めた見え方' },
    { mm: 24, desc: '広角。首を動かさずに見渡せる範囲の目安' },
    { mm: 17, desc: '超広角。周辺視野までを含めた広さ (端がゆがんで見えます)' },
  ];
  const hfovDeg = (mm) => (2 * Math.atan(18 / mm)) / DEG;
  const focalNote = (mm) => {
    const p = FOCAL_PRESETS.find((x) => x.mm === mm);
    return `水平画角 ${hfovDeg(mm).toFixed(1)}°${p ? ` — ${p.desc}` : ''}`;
  };

  // ------------------------------------------------------------------
  // 実行時の状態
  // ------------------------------------------------------------------
  const content = { el: null, w: 0, h: 0, video: null, duration: 0, still: false, label: '' };
  let gl = null; // SimGL.Renderer (3D 表示を初めて使うときに作る)
  let glError = null;
  let raf = 0;
  let visible = false;
  let contentDirty = true;
  const keys = new Set();
  let lastTick = 0;
  const view2d = { zoom: 1, panX: 0, panY: 0, drag: null, base: null };
  let look = null; // 3D の視点ドラッグ

  const cv2d = () => $('simCanvas2d');
  const cvGl = () => $('simCanvasGl');
  const figById = (id) => S.figures.find((f) => f.id === id);
  const viewerFig = () => figById(S.viewerId) || S.figures[0];
  const compareFig = () => figById(S.compareId) || S.figures[S.figures.length - 1];

  const ZONE = { fill: 'rgba(142, 127, 191, .42)', edge: 'rgba(201, 191, 255, .95)', text: '#d9d1ff' }; // = --zone

  function colors() {
    return {
      text: cssVar('--text'), text2: cssVar('--text-2'), muted: cssVar('--muted'), line: cssVar('--line'),
      surface: cssVar('--surface'), sunken: cssVar('--sunken'), accent: cssVar('--accent'), guide: cssVar('--guide'),
    };
  }

  // ------------------------------------------------------------------
  // 描画の要求 (必要なときだけ描く)
  // ------------------------------------------------------------------
  function invalidate() {
    if (!visible || raf) return;
    raf = requestAnimationFrame(frame);
  }

  function frame(t) {
    raf = 0;
    if (!visible) return;
    const dt = lastTick ? Math.min(0.1, (t - lastTick) / 1000) : 0;
    lastTick = t;
    const moving = S.view !== 'elevation' && keys.size > 0;
    if (moving) walk(dt);
    const playing = content.video && !content.video.paused;
    if (playing) {
      contentDirty = true;
      syncTimeUi();
    }
    if (S.view === 'elevation') draw2d();
    else draw3d();
    drawMinimap();
    if (moving || playing) raf = requestAnimationFrame(frame);
    else lastTick = 0;
  }

  // ------------------------------------------------------------------
  // 映像ソース
  // ------------------------------------------------------------------
  function placeholder(msg) {
    const c = document.createElement('canvas');
    c.width = 2000;
    c.height = 300;
    const x = c.getContext('2d');
    const g = x.createLinearGradient(0, 0, c.width, 0);
    g.addColorStop(0, '#1d3557');
    g.addColorStop(0.5, '#2a6f97');
    g.addColorStop(1, '#1d3557');
    x.fillStyle = g;
    x.fillRect(0, 0, c.width, c.height);
    x.fillStyle = 'rgba(255,255,255,.85)';
    x.font = '600 56px "Segoe UI", "Yu Gothic UI", sans-serif';
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    x.fillText(msg, c.width / 2, c.height / 2);
    return c;
  }

  function releaseVideo() {
    if (content.video) {
      content.video.pause();
      content.video.removeAttribute('src');
      content.video.load();
      content.video = null;
    }
  }

  function setContent(el, w, h, label, { video = null, duration = 0, still = false } = {}) {
    Object.assign(content, { el, w, h, label, video, duration, still });
    contentDirty = true;
    updateSourceUi();
    invalidate();
  }

  /**
   * ソース動画を追加順に左から横に並べた「帯」(プロジェクター 1 台 = ソース 1 本の想定)。
   * 再生中は毎フレーム描き直す。幅は GPU に送りやすい 4096px 以内に収める。
   */
  const strip = { canvas: document.createElement('canvas'), segs: [], h: 0 };

  function loadSourcesContent() {
    releaseVideo();
    const list = window.LayoutWorkspace ? window.LayoutWorkspace.projectionSources() : [];
    if (!list.length) {
      strip.segs = [];
      setContent(placeholder('レイアウト編集タブでソース動画を追加すると、ここに投影されます'), 2000, 300, 'ソース動画がありません');
      return;
    }
    const sumAspect = list.reduce((a, s) => a + s.width / s.height, 0);
    const h = Math.max(64, Math.min(1080, Math.floor(4096 / sumAspect)));
    let x = 0;
    strip.segs = list.map((src) => {
      const w = Math.round((h * src.width) / src.height);
      const seg = { src, x, w };
      x += w;
      return seg;
    });
    strip.h = h;
    strip.canvas.width = x;
    strip.canvas.height = h;
    paintStrip();
    setContent(strip.canvas, x, h, `ソース動画 ${list.length} 本`);
  }

  function paintStrip() {
    const ctx = strip.canvas.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, strip.canvas.width, strip.canvas.height);
    for (const seg of strip.segs) {
      const fr = seg.src.frame();
      if (fr) ctx.drawImage(fr.img, 0, 0, seg.src.width * fr.scale, seg.src.height * fr.scale, seg.x, 0, seg.w, strip.h);
    }
    contentDirty = true;
  }

  /** 共通プレーヤーからの通知 (ソース動画を投影しているときだけ使う) */
  function onPlayer(type) {
    if (S.source.kind !== 'sources') return;
    if (type === 'frame' || type === 'ready') {
      paintStrip();
      invalidate();
    }
    if (type !== 'frame') syncTimeUi();
    else if (Player.playing) syncTimeUi();
  }

  const IMAGE_RE = /\.(png|jpe?g|webp|bmp|gif)$/i;

  async function loadFileContent(path) {
    releaseVideo();
    if (!path) {
      setContent(placeholder('映像ファイルを選択してください'), 2000, 300, 'ファイル未選択');
      return;
    }
    const name = path.split(/[\\/]/).pop();
    if (IMAGE_RE.test(path)) {
      const img = new Image();
      img.onload = () => setContent(img, img.naturalWidth, img.naturalHeight, name);
      img.onerror = () => setStatus(`画像を読み込めません: ${name}`, 'err');
      img.src = fileUrl(path);
      return;
    }
    // まずブラウザで再生を試み、対応していないコーデック (ProRes など) は FFmpeg で静止画を取り出す
    const v = document.createElement('video');
    v.muted = true;
    v.loop = true;
    v.playsInline = true;
    v.preload = 'auto';
    const ok = await new Promise((resolve) => {
      v.onloadeddata = () => resolve(true);
      v.onerror = () => resolve(false);
      v.src = fileUrl(path);
    });
    if (S.source.path !== path) return; // 読み込み中に別のファイルが選ばれた
    if (ok && v.videoWidth) {
      v.addEventListener('timeupdate', syncTimeUi);
      setContent(v, v.videoWidth, v.videoHeight, name, { video: v, duration: v.duration });
      return;
    }
    try {
      const p = await api.probe(path);
      content.duration = p.duration;
      await loadStill(path, 0, name);
      setStatus(`${name} はこの画面では再生できない形式のため、静止画で表示します (再生位置スライダーでフレームを選べます)`);
    } catch (e) {
      setStatus(`読み込めません: ${e.message}`, 'err');
    }
  }

  async function loadStill(path, t, name) {
    const url = await api.frame(path, t, 3840);
    const img = new Image();
    await new Promise((r) => {
      img.onload = r;
      img.src = url;
    });
    setContent(img, img.naturalWidth, img.naturalHeight, name, { duration: content.duration, still: true });
  }

  const seekStill = debounce((t) => {
    if (S.source.kind === 'file' && content.still) loadStill(S.source.path, t, content.label);
  }, 200);

  function reloadContent() {
    if (S.source.kind === 'sources') loadSourcesContent();
    else loadFileContent(S.source.path);
  }

  /** 壁面上の映像の位置 (m) と、テクスチャの UV 範囲 */
  function contentPlacement() {
    const { width: W, height: H, bottom: B, fit } = S.wall;
    const cw = content.w || 1;
    const ch = content.h || 1;
    if (fit === 'stretch') return { x: 0, y: B, w: W, h: H, crop: [0, 0, 1, 1] };
    if (fit === 'cover') {
      const wallA = W / H;
      const imgA = cw / ch;
      // 余った方向を切り取る (crop は画像の左上原点 [x0, y0, x1, y1])
      if (imgA > wallA) {
        const f = wallA / imgA;
        return { x: 0, y: B, w: W, h: H, crop: [(1 - f) / 2, 0, (1 + f) / 2, 1] };
      }
      const f = imgA / wallA;
      return { x: 0, y: B, w: W, h: H, crop: [0, (1 - f) / 2, 1, (1 + f) / 2] };
    }
    const k = Math.min(W / cw, H / ch);
    const w = cw * k;
    const h = ch * k;
    return { x: (W - w) / 2, y: B + (H - h) / 2, w, h, crop: [0, 0, 1, 1] };
  }

  // ------------------------------------------------------------------
  // 実寸比較 (立面図、Canvas 2D)
  // ------------------------------------------------------------------
  function sceneTop() {
    const tallest = Math.max(0, ...S.figures.map((f) => f.height / 100));
    return Math.max(S.wall.bottom + S.wall.height, tallest) + 0.6;
  }

  function fit2d(cw, ch) {
    const padL = 48;
    const padR = 56;
    const padT = 36;
    const padB = 64;
    const W = S.wall.width + 2;
    const Hm = sceneTop();
    const scale = Math.min((cw - padL - padR) / W, (ch - padT - padB) / Hm);
    return { scale, ox: padL + (cw - padL - padR - W * scale) / 2 + scale, oy: ch - padB - (ch - padT - padB - Hm * scale) / 2 };
  }

  function tf2d() {
    const cv = cv2d();
    const b = fit2d(cv.clientWidth, cv.clientHeight);
    view2d.base = b;
    const scale = b.scale * view2d.zoom;
    return { scale, ox: b.ox + view2d.panX, oy: b.oy + view2d.panY };
  }

  function figureBox(f, T) {
    const hPx = (f.height / 100) * T.scale;
    const w = Figures.shape(f.height).width * hPx;
    const cx = T.ox + f.x * T.scale;
    return { x: cx - w / 2 - 4, y: T.oy - hPx - 18, w: w + 8, h: hPx + 18, cx, hPx };
  }

  function draw2d() {
    const cv = cv2d();
    const ctx = setupCanvas(cv);
    const cw = cv.clientWidth;
    const ch = cv.clientHeight;
    const col = colors();
    const T = tf2d();
    const X = (m) => T.ox + m * T.scale;
    const Y = (m) => T.oy - m * T.scale;
    const { width: W, height: H, bottom: B } = S.wall;

    ctx.clearRect(0, 0, cw, ch);
    // 壁と床
    ctx.fillStyle = '#23262d';
    ctx.fillRect(0, 0, cw, Y(0));
    ctx.fillStyle = '#17191e';
    ctx.fillRect(0, Y(0), cw, ch - Y(0));
    // 床より下 (映像の下端が床にかかる部分) は描かない
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, cw, Y(0));
    ctx.clip();
    // 投影範囲と映像
    ctx.fillStyle = '#08090b';
    ctx.fillRect(X(0), Y(B + H), W * T.scale, H * T.scale);
    if (content.el && content.w) {
      const p = contentPlacement();
      const [cx0, cy0, cx1, cy1] = p.crop;
      ctx.drawImage(content.el, cx0 * content.w, cy0 * content.h, (cx1 - cx0) * content.w, (cy1 - cy0) * content.h,
        X(p.x), Y(p.y + p.h), p.w * T.scale, p.h * T.scale);
    }
    // プロジェクター (ソース動画) ごとの境界
    if (S.source.kind === 'sources' && strip.segs.length > 1 && content.el === strip.canvas) {
      const p = contentPlacement();
      const [c0, , c1] = p.crop;
      const toX = (u) => X(p.x + ((u - c0) / (c1 - c0)) * p.w);
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = 'rgba(255,255,255,.55)';
      ctx.lineWidth = 1;
      for (const seg of strip.segs) {
        const u0 = seg.x / strip.canvas.width;
        const u1 = (seg.x + seg.w) / strip.canvas.width;
        if (u1 <= c0 || u0 >= c1) continue;
        if (seg.x > 0 && u0 > c0) {
          ctx.beginPath();
          ctx.moveTo(Math.round(toX(u0)) + 0.5, Y(p.y + p.h));
          ctx.lineTo(Math.round(toX(u0)) + 0.5, Y(p.y));
          ctx.stroke();
        }
        if (T.scale > 12) label(ctx, seg.src.label, toX(Math.max(u0, c0)) + 6, Y(p.y + p.h) + 20, col.text, 'left');
      }
      ctx.setLineDash([]);
    }
    // インタラクション範囲
    if (S.showZones) {
      const y0 = Math.max(B, 0);
      for (const z of S.zones) {
        const x = X(z.x0);
        const w = (z.x1 - z.x0) * T.scale;
        ctx.fillStyle = ZONE.fill;
        ctx.fillRect(x, Y(B + H), w, (B + H - y0) * T.scale);
        ctx.strokeStyle = ZONE.edge;
        ctx.lineWidth = 1.5;
        ctx.strokeRect(Math.round(x) + 0.5, Math.round(Y(B + H)) + 0.5, Math.round(w), Math.round((B + H - y0) * T.scale));
        if (w > 60) label(ctx, `インタラクション ${(z.x1 - z.x0).toFixed(2)}m`, x + w / 2, Y(y0) - 6, ZONE.text, 'center');
      }
    }
    // 1m グリッド
    if (S.showGrid) {
      ctx.strokeStyle = 'rgba(255,255,255,.14)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      const top = sceneTop();
      for (let m = Math.ceil(-1); m <= W + 1; m++) {
        ctx.moveTo(Math.round(X(m)) + 0.5, Y(0));
        ctx.lineTo(Math.round(X(m)) + 0.5, Y(top));
      }
      for (let m = 1; m <= top; m++) {
        ctx.moveTo(X(-1), Math.round(Y(m)) + 0.5);
        ctx.lineTo(X(W + 1), Math.round(Y(m)) + 0.5);
      }
      ctx.stroke();
    }
    // 投影範囲の枠
    ctx.strokeStyle = col.muted;
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(X(0)) + 0.5, Math.round(Y(B + H)) + 0.5, Math.round(W * T.scale), Math.round(H * T.scale));
    ctx.restore();
    // 床の線
    ctx.strokeStyle = col.text2;
    ctx.beginPath();
    ctx.moveTo(0, Math.round(Y(0)) + 0.5);
    ctx.lineTo(cw, Math.round(Y(0)) + 0.5);
    ctx.stroke();

    rulers(ctx, T, cw, ch, col);
    dimensions(ctx, T, col);

    // 目線の高さ (選択中の人物)
    const vf = viewerFig();
    if (vf) {
      const ey = Y(Figures.eyeHeight(vf.height) / 100);
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = col.guide;
      ctx.beginPath();
      ctx.moveTo(X(-1), Math.round(ey) + 0.5);
      ctx.lineTo(X(W + 1), Math.round(ey) + 0.5);
      ctx.stroke();
      ctx.setLineDash([]);
      label(ctx, `${vf.label}の目線 ${Math.round(Figures.eyeHeight(vf.height))}cm`, X(0) + 6, ey - 4, col.guide, 'left');
    }
    // 人物
    if (S.showFigures) {
      const placed = [];
      ctx.font = '600 12px "Segoe UI", "Yu Gothic UI", sans-serif';
      const order = [...S.figures].sort((a, b) => a.x - b.x);
      for (const f of order) {
        const b = figureBox(f, T);
        Figures.draw(ctx, b.cx, Y(0), b.hPx, f.height, f.color);
        if (f.id === S.viewerId) {
          ctx.strokeStyle = col.guide;
          ctx.lineWidth = 1.5;
          ctx.strokeRect(b.x + 0.5, b.y + 14.5, b.w, b.h - 14);
        }
      }
      for (const f of order) {
        const text = `${f.label} ${f.height}cm`;
        const w = ctx.measureText(text).width + 8;
        const b = figureBox(f, T);
        let y = Y(f.height / 100) - 6;
        const hit = (yy) => placed.some((p) => Math.abs(p.cx - b.cx) < (p.w + w) / 2 + 2 && Math.abs(p.y - yy) < 19);
        while (hit(y)) y -= 20;
        placed.push({ cx: b.cx, w, y });
        if (y < Y(f.height / 100) - 8) {
          // ずらしたラベルと頭を細い線で結ぶ
          ctx.strokeStyle = f.color;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(Math.round(b.cx) + 0.5, y);
          ctx.lineTo(Math.round(b.cx) + 0.5, Y(f.height / 100) - 2);
          ctx.stroke();
        }
        label(ctx, text, b.cx, y, f.color, 'center');
      }
    }
    $('simInfo').textContent = `壁面 ${W}m × ${H}m`;
  }

  function label(ctx, text, x, y, color, align) {
    ctx.font = '600 12px "Segoe UI", "Yu Gothic UI", sans-serif';
    ctx.textAlign = align;
    ctx.textBaseline = 'bottom';
    const w = ctx.measureText(text).width;
    const bx = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
    ctx.fillStyle = 'rgba(17,19,23,.78)';
    ctx.fillRect(bx - 4, y - 16, w + 8, 18);
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  }

  function rulers(ctx, T, cw, ch, col) {
    const X = (m) => T.ox + m * T.scale;
    const Y = (m) => T.oy - m * T.scale;
    const W = S.wall.width;
    const step = T.scale > 60 ? 1 : T.scale > 25 ? 2 : 5;
    ctx.font = '11px "Segoe UI", sans-serif';
    ctx.fillStyle = col.muted;
    ctx.strokeStyle = col.muted;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.beginPath();
    for (let m = 0; m <= W; m++) {
      const x = Math.round(X(m)) + 0.5;
      const major = m % step === 0 || m === W;
      ctx.moveTo(x, Y(0));
      ctx.lineTo(x, Y(0) + (major ? 8 : 4));
      if (major) ctx.fillText(`${m}m`, x, Y(0) + 11);
    }
    ctx.stroke();
    // 縦の目盛り (左端)
    const top = sceneTop();
    const x0 = Math.max(8, X(-1) - 4);
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.beginPath();
    for (let cm = 0; cm <= top * 100; cm += 50) {
      const y = Math.round(Y(cm / 100)) + 0.5;
      ctx.moveTo(x0, y);
      ctx.lineTo(x0 + (cm % 100 === 0 ? 8 : 4), y);
      if (cm % 100 === 0) ctx.fillText(`${cm / 100}m`, x0 - 2, y);
    }
    ctx.stroke();
  }

  function dimensions(ctx, T, col) {
    const X = (m) => T.ox + m * T.scale;
    const Y = (m) => T.oy - m * T.scale;
    const { width: W, height: H, bottom: B } = S.wall;
    ctx.strokeStyle = col.text2;
    ctx.fillStyle = col.text2;
    ctx.lineWidth = 1;
    // 幅 (目盛りの下。投影範囲の上は人物のラベルに使う)
    const yDim = Y(0) + 36;
    arrow(ctx, X(0), yDim, X(W), yDim);
    label(ctx, `幅 ${W}m`, (X(0) + X(W)) / 2, yDim + 8, col.text, 'center');
    // 高さ (投影範囲の右)
    const xR = X(W) + 14;
    const yb = Math.max(B, 0);
    arrow(ctx, xR, Y(yb), xR, Y(B + H));
    ctx.save();
    ctx.translate(xR + 4, (Y(yb) + Y(B + H)) / 2);
    ctx.rotate(-Math.PI / 2);
    label(ctx, B < 0 ? `床から ${(B + H).toFixed(2)}m` : `高さ ${H}m`, 0, -2, col.text, 'center');
    ctx.restore();
  }

  function arrow(ctx, x1, y1, x2, y2) {
    const a = Math.atan2(y2 - y1, x2 - x1);
    const head = (x, y, ang) => {
      ctx.moveTo(x, y);
      ctx.lineTo(x - 6 * Math.cos(ang - 0.4), y - 6 * Math.sin(ang - 0.4));
      ctx.moveTo(x, y);
      ctx.lineTo(x - 6 * Math.cos(ang + 0.4), y - 6 * Math.sin(ang + 0.4));
    };
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    head(x2, y2, a);
    head(x1, y1, a + Math.PI);
    ctx.stroke();
  }

  // ------------------------------------------------------------------
  // 子供目線 / 目線比較 (WebGL)
  // ------------------------------------------------------------------
  function ensureGl() {
    if (gl || glError) return gl;
    try {
      gl = new SimGL.Renderer(cvGl());
    } catch (e) {
      glError = e.message;
      setStatus(`3D 表示を初期化できません: ${e.message}`, 'err');
    }
    return gl;
  }

  function draw3d() {
    const r = ensureGl();
    if (!r) return;
    if (contentDirty && content.el && content.w) {
      r.setContent(content.el, content.w, content.h);
      contentDirty = false;
    }
    const p = contentPlacement();
    const [cx0, cy0, cx1, cy1] = p.crop;
    const scene = {
      wall: S.wall,
      content: content.el ? { x: p.x, y: p.y, w: p.w, h: p.h, uv: [cx0, 1 - cy1, cx1, 1 - cy0] } : null,
      figures: S.showFigures ? S.figures.filter((f) => f.id !== S.viewerId && !(S.view === 'compare' && f.id === S.compareId))
        .map((f) => ({ x: f.x, z: f.z, height: f.height, color: f.color })) : [], // 人物はその場に立ったまま
      grid: S.showGrid,
      zones: S.showZones ? S.zones.map((z) => ({ x0: z.x0, x1: z.x1, y0: Math.max(S.wall.bottom, 0), y1: S.wall.bottom + S.wall.height })) : [],
      colors: {
        floor: SimGL.hex('#1b1d22'), wall: SimGL.hex('#2a2d34'), screen: SimGL.hex('#08090b'),
        fog: SimGL.hex('#111317'), grid: [1, 1, 1, 0.16], zone: SimGL.hex('#8e7fbf', 0.4), zoneEdge: SimGL.hex('#c9bfff', 0.95),
      },
    };
    const cv = cvGl();
    const w = cv.clientWidth;
    const h = cv.clientHeight;
    const cam = S.cam;
    // 16:9 の枠を領域 (ax, aw) の中央に置く。余りは黒帯
    const fit169 = (ax, aw) => {
      const vw = Math.floor(Math.min(aw, (h * 16) / 9));
      const vh = Math.floor((vw * 9) / 16);
      return { x: ax + Math.floor((aw - vw) / 2), y: Math.floor((h - vh) / 2), w: vw, h: vh };
    };
    const mk = (fig, box) => ({
      ...box, eye: [cam.x, Figures.eyeHeight(fig.height) / 100, cam.z], yaw: cam.yaw, pitch: cam.pitch, hfov: hfovDeg(cam.focal) * DEG,
    });
    const vf = viewerFig();
    const views = [];
    if (S.view === 'compare') {
      const half = Math.floor((w - 8) / 2);
      views.push(mk(vf, fit169(0, half)), mk(compareFig(), fit169(w - half, half)));
    } else {
      views.push(mk(vf, fit169(0, w)));
    }
    r.render(scene, views);
    hud(views);
    $('simInfo').textContent = `壁まで ${cam.z.toFixed(1)}m · 焦点距離 ${cam.focal}mm (水平 ${hfovDeg(cam.focal).toFixed(0)}°)`;
  }

  function hud(views) {
    const one = (f) => `<b>${escapeHtml(f.label)}の目線</b><br>目の高さ ${Math.round(Figures.eyeHeight(f.height))}cm`;
    const place = (el, v) => {
      el.style.left = `${v.x + 12}px`;
      el.style.top = `${v.y + 12}px`;
    };
    const l = $('simHudL');
    const r = $('simHudR');
    l.innerHTML = one(viewerFig());
    l.classList.remove('hidden');
    place(l, views[0]);
    r.classList.toggle('hidden', S.view !== 'compare');
    if (S.view === 'compare') {
      r.innerHTML = one(compareFig());
      place(r, views[1]);
    }
  }

  function walk(dt) {
    const speed = (keys.has('Shift') ? 4 : 1.4) * dt; // 歩く速さ 1.4m/s
    let f = 0;
    let s = 0;
    if (keys.has('w') || keys.has('ArrowUp')) f += 1;
    if (keys.has('s') || keys.has('ArrowDown')) f -= 1;
    if (keys.has('d') || keys.has('ArrowRight')) s += 1;
    if (keys.has('a') || keys.has('ArrowLeft')) s -= 1;
    const c = S.cam;
    c.x += (Math.sin(c.yaw) * f + Math.cos(c.yaw) * s) * speed;
    c.z += (-Math.cos(c.yaw) * f + Math.sin(c.yaw) * s) * speed;
    clampCam();
    syncViewInputs();
  }

  function clampCam() {
    const c = S.cam;
    c.x = clamp(c.x, -10, S.wall.width + 10);
    c.z = clamp(c.z, 0.3, 30);
    c.pitch = clamp(c.pitch, -80 * DEG, 80 * DEG);
    c.focal = Math.round(clamp(c.focal, 10, 200));
    // 目線の人物 = 自分。視点を動かすとその人物の立ち位置も動く (ほかの人物は動かない)
    const vf = viewerFig();
    if (vf) {
      vf.x = Math.round(c.x * 100) / 100;
      vf.z = Math.round(c.z * 100) / 100;
    }
  }

  // ------------------------------------------------------------------
  // ミニマップ (上から見た図) と数値
  // ------------------------------------------------------------------
  const mini = { T: null, drag: false };

  function drawMinimap() {
    const cv = $('simMinimap');
    const ctx = setupCanvas(cv);
    const cw = cv.clientWidth;
    const ch = cv.clientHeight;
    const col = colors();
    const W = S.wall.width;
    const depth = Math.max(8, S.cam.z + 2);
    const pad = 12;
    const scale = Math.min((cw - pad * 2) / (W + 2), (ch - pad * 2 - 6) / depth);
    const ox = (cw - (W + 2) * scale) / 2 + scale;
    const oy = pad + 6;
    mini.T = { scale, ox, oy };
    const X = (m) => ox + m * scale;
    const Z = (m) => oy + m * scale;
    ctx.clearRect(0, 0, cw, ch);
    // 床グリッド
    ctx.strokeStyle = 'rgba(255,255,255,.06)';
    ctx.beginPath();
    for (let m = -1; m <= W + 1; m++) { ctx.moveTo(X(m) + 0.5, Z(0)); ctx.lineTo(X(m) + 0.5, Z(depth)); }
    for (let m = 1; m <= depth; m++) { ctx.moveTo(X(-1), Z(m) + 0.5); ctx.lineTo(X(W + 1), Z(m) + 0.5); }
    ctx.stroke();
    // 壁と投影範囲
    ctx.fillStyle = col.line;
    ctx.fillRect(X(-1), Z(0) - 4, (W + 2) * scale, 4);
    ctx.fillStyle = col.accent;
    ctx.fillRect(X(0), Z(0) - 4, W * scale, 4);
    if (S.showZones) {
      ctx.fillStyle = ZONE.fill;
      for (const z of S.zones) ctx.fillRect(X(z.x0), Z(0) - 4, (z.x1 - z.x0) * scale, 10);
    }
    // 人物
    for (const f of S.figures) {
      ctx.fillStyle = f.color;
      ctx.beginPath();
      ctx.arc(X(f.x), Z(f.z), 3, 0, Math.PI * 2);
      ctx.fill();
    }
    // 視点と視野
    if (S.view !== 'elevation') {
      const c = S.cam;
      const half = (hfovDeg(c.focal) * DEG) / 2;
      const len = 3.5 * scale;
      ctx.fillStyle = 'rgba(34, 211, 238, .18)';
      ctx.beginPath();
      ctx.moveTo(X(c.x), Z(c.z));
      for (const a of [c.yaw - half, c.yaw + half]) ctx.lineTo(X(c.x) + Math.sin(a) * len, Z(c.z) - Math.cos(a) * len);
      ctx.closePath();
      ctx.fill();
    }
    ctx.fillStyle = col.guide;
    ctx.beginPath();
    ctx.arc(X(S.cam.x), Z(S.cam.z), 4.5, 0, Math.PI * 2);
    ctx.fill();
  }

  function updateMetrics() {
    const f = viewerFig();
    const el = $('simMetrics');
    if (!f) {
      el.innerHTML = '';
      return;
    }
    const eye = Figures.eyeHeight(f.height) / 100;
    const { height: H, bottom: B } = S.wall;
    const top = B + H;
    const up = Math.atan2(top - eye, S.cam.z) / DEG;
    const vb = Math.max(B, 0); // 床から上に見えている範囲で比べる
    const pos = clamp(((eye - vb) / (top - vb)) * 100, 0, 100);
    const items = [
      ['目の高さ', Math.round(eye * 100), 'cm'],
      ['映像上端の見上げ角', up.toFixed(0), '°'],
      ['壁の高さ ÷ 身長', (top / (f.height / 100)).toFixed(1), '倍'],
      ['目線は映像の下から', pos.toFixed(0), '%'],
    ];
    el.innerHTML = items.map(([k, v, u]) => `<div class="metric"><div class="v">${v}<small>${u}</small></div><div class="k">${k}</div></div>`).join('');
  }

  // ------------------------------------------------------------------
  // パネル (左右) の表示と入力
  // ------------------------------------------------------------------
  function setSeg(id, value) {
    $(id).querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.v === value));
  }

  function updateSourceUi() {
    setSeg('simSourceSeg', S.source.kind);
    $('simFileRow').classList.toggle('hidden', S.source.kind !== 'file');
    $('simFileName').textContent = S.source.path ? S.source.path.split(/[\\/]/).pop() : '未選択';
    $('simFileName').title = S.source.path || '';
    const note = $('simSourceNote');
    const bad = Player.unplayable().length;
    note.textContent = S.source.kind === 'sources'
      ? `レイアウト編集タブで読み込んだソース動画を、追加順に左から横に並べて投影します (プロジェクター ${strip.segs.length || 'N'} 台の想定)。` +
        (bad ? ' 再生できない形式のソースは静止画で表示します。' : '')
      : content.still ? 'この形式はアプリ内で再生できないため静止画で表示します。再生位置スライダーでフレームを選べます。' : '動画は再生ボタンで再生できます (音声なし)。';
    const ratio = content.w ? content.w / content.h : 0;
    const below = S.wall.bottom < 0 ? ` / 映像の下端 ${(-S.wall.bottom).toFixed(2)}m は床より下 (隠れる部分)` : '';
    $('simAspect').textContent = ratio
      ? `映像 ${content.w}×${content.h} (横縦比 ${ratio.toFixed(2)}) / 壁面の横縦比 ${(S.wall.width / S.wall.height).toFixed(2)}${below}`
      : '';
    syncTimeUi();
  }

  function syncTimeUi() {
    if (S.source.kind === 'sources') {
      const has = strip.segs.length > 0 && Player.duration > 0;
      $('simPlay').disabled = !has;
      $('simPlay').textContent = Player.playing ? '❚❚' : '▶';
      $('simTime').disabled = !has;
      $('simTime').max = Math.max(0.01, Player.duration || 1);
      if (document.activeElement !== $('simTime')) $('simTime').value = Player.time;
      $('simTimeLabel').textContent = has ? `${fmtTime(Player.time)} / ${fmtTime(Player.duration)}` : '--:--';
      return;
    }
    const v = content.video;
    const dur = v ? v.duration : content.duration;
    const playable = !!v;
    const seekable = playable || content.still;
    $('simPlay').disabled = !playable;
    $('simPlay').textContent = v && !v.paused ? '❚❚' : '▶';
    $('simTime').disabled = !seekable;
    const t = v ? v.currentTime : Number($('simTime').value) || 0;
    $('simTime').max = Math.max(0.01, dur || 1);
    if (document.activeElement !== $('simTime')) $('simTime').value = t;
    $('simTimeLabel').textContent = seekable ? `${fmtTime(t)} / ${fmtTime(dur)}` : '静止画';
  }

  function renderFigures() {
    const list = $('simFigureList');
    list.innerHTML = '';
    for (const f of S.figures) {
      const row = document.createElement('div');
      row.className = 'figure-row' + (f.id === S.viewerId ? ' viewer' : '');
      row.style.setProperty('--c', f.color);
      row.innerHTML = `
        <span class="swatch"></span>
        <span class="name" title="クリックでこの人物の目線にする">${escapeHtml(f.label)}${f.id === S.viewerId ? '<small>目線</small>' : ''}</span>
        <input type="number" min="40" max="220" step="1" value="${f.height}" aria-label="${escapeHtml(f.label)}の身長 (cm)">
        <input type="number" step="0.1" value="${f.x}" aria-label="${escapeHtml(f.label)}の位置 (m)">
        <input type="number" step="0.1" min="0.3" value="${f.z}" aria-label="${escapeHtml(f.label)}の壁からの距離 (m)">
        <button class="small icon ghost danger" title="削除" aria-label="${escapeHtml(f.label)}を削除">✕</button>`;
      const [hIn, xIn, zIn] = row.querySelectorAll('input');
      row.querySelector('.name').onclick = () => {
        setViewer(f.id);
        changed();
      };
      hIn.onchange = () => {
        f.height = clamp(Math.round(Number(hIn.value) || f.height), 40, 220);
        changed();
      };
      xIn.onchange = () => {
        f.x = clamp(Number(xIn.value) || 0, -5, S.wall.width + 5);
        if (f.id === S.viewerId) S.cam.x = f.x;
        changed();
      };
      zIn.onchange = () => {
        f.z = clamp(Number(zIn.value) || DEFAULT_CAM.z, 0.3, 30);
        if (f.id === S.viewerId) S.cam.z = f.z;
        changed();
      };
      row.querySelector('button').onclick = () => {
        if (S.figures.length <= 1) return setStatus('人物は 1 人以上必要です', 'err');
        S.figures = S.figures.filter((x) => x !== f);
        if (!figById(S.viewerId)) S.viewerId = S.figures[0].id;
        if (!figById(S.compareId)) S.compareId = S.figures[S.figures.length - 1].id;
        changed();
      };
      list.appendChild(row);
    }
    const opts = S.figures.map((f) => `<option value="${f.id}">${escapeHtml(f.label)} (${f.height}cm)</option>`).join('');
    $('simViewer').innerHTML = opts;
    $('simCompare').innerHTML = opts;
    $('simViewer').value = String(S.viewerId);
    $('simCompare').value = String(S.compareId);
  }

  /** 目線の人物を切り替え、視点をその人物の立ち位置に移す */
  function setViewer(id) {
    S.viewerId = id;
    const f = viewerFig();
    if (f) {
      S.cam.x = f.x;
      S.cam.z = f.z;
    }
  }

  function renderZones() {
    const list = $('simZoneList');
    list.innerHTML = '';
    S.zones.forEach((z, i) => {
      const row = document.createElement('div');
      row.className = 'zone-row';
      row.innerHTML = `
        <span class="swatch zone-swatch"></span>
        <input type="number" step="0.01" value="${z.x0}" aria-label="範囲${i + 1}の開始 (m)">
        <input type="number" step="0.01" value="${z.x1}" aria-label="範囲${i + 1}の終了 (m)">
        <span class="w">${(z.x1 - z.x0).toFixed(2)}m</span>
        <button class="small icon ghost danger" title="削除" aria-label="範囲${i + 1}を削除">✕</button>`;
      const [a, b] = row.querySelectorAll('input');
      const apply = () => {
        const v0 = Number(a.value);
        const v1 = Number(b.value);
        if (Number.isFinite(v0) && Number.isFinite(v1)) {
          z.x0 = Math.min(v0, v1);
          z.x1 = Math.max(v0, v1);
        }
        changed({ figures: false });
      };
      a.onchange = apply;
      b.onchange = apply;
      row.querySelector('button').onclick = () => {
        S.zones = S.zones.filter((x) => x !== z);
        changed({ figures: false });
      };
      list.appendChild(row);
    });
    if (!S.zones.length) list.innerHTML = '<div class="small-text">範囲はありません</div>';
  }

  function syncViewInputs() {
    const set = (id, v) => {
      if (document.activeElement !== $(id)) $(id).value = v;
    };
    set('simPosX', S.cam.x.toFixed(1));
    set('simPosZ', S.cam.z.toFixed(1));
    set('simFocal', S.cam.focal);
    setSeg('simFocalSeg', String(S.cam.focal));
    $('simFocalNote').textContent = focalNote(S.cam.focal);
    updateMetrics();
  }

  function syncAll() {
    $('simWallW').value = S.wall.width;
    $('simWallH').value = S.wall.height;
    $('simWallB').value = S.wall.bottom;
    setSeg('simFitSeg', S.wall.fit);
    setSeg('simViewSeg', S.view);
    $('simOptGrid').checked = S.showGrid;
    $('simOptFigures').checked = S.showFigures;
    $('simOptZones').checked = S.showZones;
    applyView();
    renderFigures();
    renderZones();
    syncViewInputs();
    updateSourceUi();
  }

  /** 状態が変わった: 再描画し、未保存の印を付ける */
  function changed({ figures = true } = {}) {
    if (figures) renderFigures();
    renderZones();
    syncViewInputs();
    updateSourceUi();
    App.markDirty();
    invalidate();
  }

  function applyView() {
    const eye = S.view !== 'elevation';
    cv2d().hidden = eye;
    cvGl().hidden = !eye;
    if (!eye) {
      $('simHudL').classList.add('hidden');
      $('simHudR').classList.add('hidden');
    }
    $('simHint').textContent = eye
      ? 'ドラッグで見回す · W A S D / 矢印キーで歩く (Shift で速く) · ホイールで視野角'
      : '人物をドラッグで移動 · 人物をクリックで目線に設定 · ホイールで拡大縮小 · 背景をドラッグでスクロール';
    $('simCompare').disabled = S.view !== 'compare';
    $('simZoomFigures').hidden = eye;
    $('simResetView').textContent = eye ? '視点をリセット' : '全体を表示';
  }

  function bindInputs() {
    const num = (id, fn) => $(id).addEventListener('change', () => {
      const v = Number($(id).value);
      if (Number.isFinite(v)) fn(v);
      changed();
    });
    num('simWallW', (v) => (S.wall.width = clamp(v, 1, 200)));
    num('simWallH', (v) => (S.wall.height = clamp(v, 0.5, 50)));
    num('simWallB', (v) => (S.wall.bottom = clamp(v, -5, 20)));
    num('simPosX', (v) => (S.cam.x = v));
    num('simPosZ', (v) => (S.cam.z = v));
    num('simFocal', (v) => (S.cam.focal = v));
    ['simPosX', 'simPosZ', 'simFocal'].forEach((id) => $(id).addEventListener('change', clampCam));
    $('simFocalSeg').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      S.cam.focal = Number(b.dataset.v);
      changed({ figures: false });
    });
    $('simOptZones').addEventListener('change', () => {
      S.showZones = $('simOptZones').checked;
      changed({ figures: false });
    });
    $('simAddZone').onclick = () => {
      const last = S.zones.length ? Math.max(...S.zones.map((z) => z.x1)) : 0;
      const x0 = Math.min(last + 1, Math.max(0, S.wall.width - 3.5));
      S.zones.push({ id: seq++, x0, x1: Math.min(S.wall.width, x0 + 3.5) });
      changed({ figures: false });
    };

    $('simFitSeg').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      S.wall.fit = b.dataset.v;
      setSeg('simFitSeg', S.wall.fit);
      contentDirty = true;
      changed({ figures: false });
    });
    $('simViewSeg').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      S.view = b.dataset.v;
      setSeg('simViewSeg', S.view);
      applyView();
      changed({ figures: false });
    });
    $('simSourceSeg').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b || b.dataset.v === S.source.kind) return;
      S.source.kind = b.dataset.v;
      reloadContent();
      App.markDirty();
    });
    $('simPickFile').onclick = async () => {
      const p = await api.openMedia();
      if (p) openFile(p);
    };
    $('simOptGrid').addEventListener('change', () => {
      S.showGrid = $('simOptGrid').checked;
      changed({ figures: false });
    });
    $('simOptFigures').addEventListener('change', () => {
      S.showFigures = $('simOptFigures').checked;
      changed({ figures: false });
    });
    $('simViewer').addEventListener('change', () => {
      setViewer(Number($('simViewer').value));
      changed();
    });
    $('simCompare').addEventListener('change', () => {
      S.compareId = Number($('simCompare').value);
      changed();
    });
    $('simAddPreset').innerHTML = Figures.PRESETS.map((p) => `<option value="${p.id}">${escapeHtml(p.label)} (${p.height}cm)</option>`).join('');
    $('simAddPreset').value = 'age5';
    $('simAddFigure').onclick = () => {
      const p = Figures.PRESETS.find((x) => x.id === $('simAddPreset').value);
      const used = S.figures.map((f) => f.x);
      const x = used.length ? Math.min(S.wall.width, Math.max(...used) + 1.5) : S.wall.width / 2;
      const f = { id: seq++, label: p.label, height: p.height, x, z: DEFAULT_CAM.z, color: Figures.COLORS[S.figures.length % Figures.COLORS.length] };
      S.figures.push(f);
      changed();
    };
    $('simZoomFigures').onclick = () => {
      const cv = cv2d();
      const cw = cv.clientWidth;
      const ch = cv.clientHeight;
      const base = fit2d(cw, ch);
      const xs = S.figures.map((f) => f.x);
      const x0 = Math.min(...xs) - 1;
      const x1 = Math.max(...xs) + 1;
      const tallest = Math.max(...S.figures.map((f) => f.height / 100));
      const top = Math.max(tallest, Math.min(S.wall.bottom + S.wall.height, tallest * 1.6)) + 0.4;
      const sc = Math.min((cw - 120) / (x1 - x0), (ch - 90) / top);
      view2d.zoom = clamp(sc / base.scale, 0.5, 12);
      const s1 = base.scale * view2d.zoom;
      view2d.panX = cw / 2 - ((x0 + x1) / 2) * s1 - base.ox;
      view2d.panY = ch - 50 - base.oy;
      invalidate();
    };
    $('simResetView').onclick = () => {
      view2d.zoom = 1;
      view2d.panX = 0;
      view2d.panY = 0;
      Object.assign(S.cam, { ...DEFAULT_CAM, x: viewerFig() ? viewerFig().x : S.wall.width / 2 });
      clampCam();
      changed({ figures: false });
    };
    $('simPlay').onclick = () => {
      if (S.source.kind === 'sources') {
        Player.toggle();
        return;
      }
      const v = content.video;
      if (!v) return;
      if (v.paused) v.play();
      else v.pause();
      syncTimeUi();
      invalidate();
    };
    $('simTime').addEventListener('input', () => {
      const t = Number($('simTime').value);
      if (S.source.kind === 'sources') {
        Player.seek(t);
        return;
      }
      if (content.video) {
        content.video.currentTime = t;
        contentDirty = true;
        content.video.addEventListener('seeked', invalidate, { once: true });
      } else if (content.still) {
        seekStill(t);
      }
      $('simTimeLabel').textContent = `${fmtTime(t)} / ${fmtTime(content.duration || (content.video && content.video.duration))}`;
    });
  }

  // ------------------------------------------------------------------
  // マウス・キーボード
  // ------------------------------------------------------------------
  function bindPointer() {
    const c2 = cv2d();
    c2.addEventListener('pointerdown', (e) => {
      const r = c2.getBoundingClientRect();
      const px = e.clientX - r.left;
      const py = e.clientY - r.top;
      const T = tf2d();
      const hit = S.showFigures && [...S.figures].reverse().find((f) => {
        const b = figureBox(f, T);
        return px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h;
      });
      c2.setPointerCapture(e.pointerId);
      view2d.drag = hit
        ? { kind: 'figure', f: hit, sx: e.clientX, x0: hit.x, moved: false }
        : { kind: 'pan', sx: e.clientX, sy: e.clientY, px: view2d.panX, py: view2d.panY };
    });
    c2.addEventListener('pointermove', (e) => {
      const d = view2d.drag;
      const r = c2.getBoundingClientRect();
      if (!d) {
        const T = tf2d();
        const over = S.showFigures && S.figures.some((f) => {
          const b = figureBox(f, T);
          const px = e.clientX - r.left;
          const py = e.clientY - r.top;
          return px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h;
        });
        c2.style.cursor = over ? 'ew-resize' : 'grab';
        return;
      }
      if (d.kind === 'figure') {
        const T = tf2d();
        const dx = (e.clientX - d.sx) / T.scale;
        if (Math.abs(e.clientX - d.sx) > 2) d.moved = true;
        d.f.x = Math.round(clamp(d.x0 + dx, -1, S.wall.width + 1) * 10) / 10; // 10cm 単位
        if (d.f.id === S.viewerId) S.cam.x = d.f.x;
      } else {
        view2d.panX = d.px + (e.clientX - d.sx);
        view2d.panY = d.py + (e.clientY - d.sy);
      }
      invalidate();
    });
    c2.addEventListener('pointerup', () => {
      const d = view2d.drag;
      view2d.drag = null;
      if (!d) return;
      if (d.kind === 'figure') {
        if (!d.moved) setViewer(d.f.id); // クリック = 目線に設定
        changed();
      }
    });
    c2.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = c2.getBoundingClientRect();
      const px = e.clientX - r.left;
      const py = e.clientY - r.top;
      const before = tf2d();
      const k = Math.exp(-e.deltaY * 0.0015);
      view2d.zoom = clamp(view2d.zoom * k, 0.5, 12);
      // カーソル位置を中心に拡大縮小する
      const b = view2d.base;
      const s1 = b.scale * view2d.zoom;
      const mx = (px - before.ox) / before.scale;
      const my = (before.oy - py) / before.scale;
      view2d.panX = px - mx * s1 - b.ox;
      view2d.panY = py + my * s1 - b.oy;
      invalidate();
    }, { passive: false });

    const cg = cvGl();
    cg.addEventListener('pointerdown', (e) => {
      cg.setPointerCapture(e.pointerId);
      look = { sx: e.clientX, sy: e.clientY, yaw: S.cam.yaw, pitch: S.cam.pitch };
    });
    cg.addEventListener('pointermove', (e) => {
      if (!look) return;
      const k = (hfovDeg(S.cam.focal) / 90) * 0.004;
      S.cam.yaw = look.yaw + (e.clientX - look.sx) * k;
      S.cam.pitch = look.pitch - (e.clientY - look.sy) * k;
      clampCam();
      invalidate();
    });
    cg.addEventListener('pointerup', () => {
      if (look) App.markDirty();
      look = null;
      syncViewInputs();
    });
    cg.addEventListener('wheel', (e) => {
      e.preventDefault();
      // ホイールで焦点距離を変える (ズーム)
      S.cam.focal = Math.round(clamp(S.cam.focal * Math.exp(Math.sign(e.deltaY) * -0.1), 10, 200));
      syncViewInputs();
      invalidate();
    }, { passive: false });

    const mm = $('simMinimap');
    const moveTo = (e) => {
      const T = mini.T;
      if (!T) return;
      const r = mm.getBoundingClientRect();
      S.cam.x = Math.round(((e.clientX - r.left - T.ox) / T.scale) * 10) / 10;
      S.cam.z = Math.round(((e.clientY - r.top - T.oy) / T.scale) * 10) / 10;
      clampCam();
      syncViewInputs();
      invalidate();
    };
    mm.addEventListener('pointerdown', (e) => {
      mm.setPointerCapture(e.pointerId);
      mini.drag = true;
      moveTo(e);
    });
    mm.addEventListener('pointermove', (e) => mini.drag && moveTo(e));
    mm.addEventListener('pointerup', () => {
      if (mini.drag) {
        renderFigures();
        App.markDirty();
      }
      mini.drag = false;
    });

    new ResizeObserver(() => invalidate()).observe($('simStage'));
    new ResizeObserver(() => invalidate()).observe(mm);
  }

  const WALK_KEYS = new Set(['w', 'a', 's', 'd', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Shift']);
  function onKeyDown(e) {
    if (!visible || S.view === 'elevation') return;
    if (/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName) || document.querySelector('dialog[open]')) return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (!WALK_KEYS.has(k) || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    if (!keys.has(k)) {
      keys.add(k);
      invalidate();
    }
  }
  function onKeyUp(e) {
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (keys.delete(k) && keys.size === 0) {
      renderFigures();
      App.markDirty();
    }
  }

  // ------------------------------------------------------------------
  // ワークスペースのライフサイクル
  // ------------------------------------------------------------------
  function openFile(path) {
    S.source = { kind: 'file', path };
    App.markDirty();
    loadFileContent(path);
  }

  return {
    init() {
      bindInputs();
      bindPointer();
      window.addEventListener('keydown', onKeyDown);
      window.addEventListener('keyup', onKeyUp);
      window.addEventListener('blur', () => keys.clear());
      syncAll();
    },
    show() {
      visible = true;
      Player.on(onPlayer);
      // ソース動画の構成は変わっている可能性があるので、表示のたびに並べ直す
      if (S.source.kind === 'sources' || !content.el) reloadContent();
      syncAll();
      invalidate();
    },
    hide() {
      visible = false;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      lastTick = 0;
      keys.clear();
      look = null;
      view2d.drag = null;
      if (content.video) content.video.pause();
      Player.pause(); // 非表示のタブでは再生しない
      Player.off(onPlayer);
    },
    /** 表示の切り替え ('elevation' | 'eye' | 'compare') */
    setView(v) {
      S.view = v;
      syncAll();
      invalidate();
    },
    onDropFiles(paths) {
      if (paths[0]) openFile(paths[0]);
    },
    getState() {
      return JSON.parse(JSON.stringify(S));
    },
    setState(s) {
      const d = defaults();
      S = { ...d, ...s, wall: { ...d.wall, ...(s.wall || {}) }, cam: { ...d.cam, ...(s.cam || {}) }, source: { ...d.source, ...(s.source || {}) } };
      if (S.source.kind !== 'file') S.source.kind = 'sources'; // 旧版の 'layout' (合成結果) はソース動画に置き換え
      if (!Array.isArray(S.zones)) S.zones = d.zones;
      if (!(S.cam.focal > 0)) S.cam.focal = s.cam && s.cam.hfov ? Math.round(18 / Math.tan((s.cam.hfov * DEG) / 2)) : DEFAULT_CAM.focal; // 旧版は視野角 (°)
      delete S.cam.hfov;
      seq = Math.max(seq, ...S.zones.map((z) => (z.id || 0) + 1));
      if (!Array.isArray(S.figures) || !S.figures.length) S.figures = d.figures;
      S.figures.forEach((f) => { if (!(f.z > 0)) f.z = DEFAULT_CAM.z; });
      seq = Math.max(seq, ...S.figures.map((f) => f.id + 1));
      syncAll();
      releaseVideo();
      content.el = null;
      if (visible) reloadContent(); // 非表示なら次に表示したときに読み込む
    },
    reset() {
      releaseVideo();
      S = defaults();
      content.el = null;
      syncAll();
      if (visible) reloadContent();
    },
  };
})();
