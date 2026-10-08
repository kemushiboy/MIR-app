/**
 * 分割・配置プリセット。レンダラ (window.Presets) と Node (require) の両方から使う。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Presets = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const even = (v) => Math.round(v / 2) * 2;

  /** 0..n の境界を偶数に丸めて返す */
  function bounds(total, n) {
    const b = [];
    for (let i = 0; i <= n; i++) b.push(i === n ? total : even((total * i) / n));
    return b;
  }

  /**
   * 各ソースを cols×rows に分割し、ソースごとのブロックにまとめて並べる汎用レイアウト。
   * @param {Array<{width:number,height:number}>} sources ソースの寸法 (probe)
   * @param {object} o
   *   cols, rows      : 1 ソースあたりの分割数
   *   pieceFlow       : 'vertical' | 'horizontal' | 'grid'  ブロック内での断片の並べ方
   *   blockFlow       : 'horizontal' | 'vertical' | 'grid'  ブロック (=ソース) の並べ方
   *   blockGridCols   : blockFlow=grid のときの列数
   *   reverse         : 断片の順番を逆にする
   * @returns {{canvas:{width,height}, tiles:Array}}
   */
  function splitArrange(sources, o) {
    const cols = Math.max(1, o.cols | 0);
    const rows = Math.max(1, o.rows | 0);
    const blocks = sources.map((s, si) => {
      const xb = bounds(s.width, cols);
      const yb = bounds(s.height, rows);
      let pieces = [];
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          pieces.push({ r, c, crop: { x: xb[c], y: yb[r], w: xb[c + 1] - xb[c], h: yb[r + 1] - yb[r] } });
        }
      }
      if (o.reverse) pieces = pieces.reverse();
      let x = 0;
      let y = 0;
      let bw = 0;
      let bh = 0;
      const tiles = pieces.map((p) => {
        let dx;
        let dy;
        if (o.pieceFlow === 'vertical') {
          dx = 0; dy = y; y += p.crop.h;
        } else if (o.pieceFlow === 'horizontal') {
          dx = x; dy = 0; x += p.crop.w;
        } else {
          dx = p.crop.x; dy = p.crop.y;
        }
        bw = Math.max(bw, dx + p.crop.w);
        bh = Math.max(bh, dy + p.crop.h);
        return { source: si, crop: { ...p.crop }, rel: { x: dx, y: dy }, label: pieceLabel(cols, rows, p.r, p.c) };
      });
      return { w: bw, h: bh, tiles };
    });

    const n = blocks.length;
    const gridCols = o.blockFlow === 'grid' ? Math.max(1, o.blockGridCols || Math.ceil(Math.sqrt(n))) : 0;
    const cellW = Math.max(0, ...blocks.map((b) => b.w));
    const cellH = Math.max(0, ...blocks.map((b) => b.h));
    let ox = 0;
    let oy = 0;
    let W = 0;
    let H = 0;
    const tiles = [];
    blocks.forEach((b, i) => {
      let bx;
      let by;
      if (o.blockFlow === 'vertical') {
        bx = 0; by = oy; oy += b.h;
      } else if (o.blockFlow === 'grid') {
        bx = (i % gridCols) * cellW; by = Math.floor(i / gridCols) * cellH;
      } else {
        bx = ox; by = 0; ox += b.w;
      }
      for (const t of b.tiles) {
        const dest = { x: bx + t.rel.x, y: by + t.rel.y, w: t.crop.w, h: t.crop.h };
        W = Math.max(W, dest.x + dest.w);
        H = Math.max(H, dest.y + dest.h);
        tiles.push({ source: t.source, crop: t.crop, dest, label: t.label });
      }
    });
    return { canvas: { width: even(W), height: even(H) }, tiles };
  }

  function pieceLabel(cols, rows, r, c) {
    if (cols === 1 && rows === 1) return '全体';
    if (rows === 1 && cols === 2) return c === 0 ? '左' : '右';
    if (cols === 1 && rows === 2) return r === 0 ? '上' : '下';
    if (rows === 1 && cols === 3) return ['左', '中', '右'][c];
    if (cols === 1 && rows === 3) return ['上', '中', '下'][r];
    return `${r + 1}-${c + 1}`;
  }

  const LIST = [
    {
      id: 'split-lr-stack',
      name: '左右分割 → 上下に配置 (FHD×4 → 4K)',
      desc: '各ソースを左右に分割し、左半分を上段・右半分を下段に置きます。ソースは横に並びます。1920×1080×4 本 → 3840×2160。',
      params: { cols: 2, rows: 1, pieceFlow: 'vertical', blockFlow: 'horizontal' },
    },
    {
      id: 'split-tb-side',
      name: '上下分割 → 左右に配置 (上の逆変換)',
      desc: '各ソースを上下に分割し、上半分を左・下半分を右に置きます。ソースは縦に並びます。',
      params: { cols: 1, rows: 2, pieceFlow: 'horizontal', blockFlow: 'vertical' },
    },
    {
      id: 'grid',
      name: 'グリッドに並べる (2×2 など)',
      desc: '分割せずにソースをグリッド状に並べます。FHD×4 → 4K の 2×2 マルチ画面。',
      params: { cols: 1, rows: 1, pieceFlow: 'grid', blockFlow: 'grid', blockGridCols: 2 },
    },
    {
      id: 'row',
      name: '横一列に並べる',
      desc: '分割せずにソースを横一列に並べます。',
      params: { cols: 1, rows: 1, pieceFlow: 'grid', blockFlow: 'horizontal' },
    },
    {
      id: 'column',
      name: '縦一列に並べる',
      desc: '分割せずにソースを縦一列に並べます。',
      params: { cols: 1, rows: 1, pieceFlow: 'grid', blockFlow: 'vertical' },
    },
  ];

  return { LIST, splitArrange };
});
