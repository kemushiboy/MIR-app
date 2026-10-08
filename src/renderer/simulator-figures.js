/**
 * 投影シミュレーター: 人物 (身長・目の高さ・シルエット)
 */
'use strict';

window.Figures = (() => {
  /**
   * 年齢別の身長の目安 (cm)。日本の平均身長 (乳幼児身体発育調査・学校保健統計の男女平均) をもとにした概数。
   */
  const PRESETS = [
    { id: 'age2', label: '2歳', height: 87 },
    { id: 'age3', label: '3歳', height: 95 },
    { id: 'age4', label: '4歳', height: 102 },
    { id: 'age5', label: '5歳', height: 109 },
    { id: 'age6', label: '6歳 (小1)', height: 117 },
    { id: 'age8', label: '8歳 (小3)', height: 128 },
    { id: 'age10', label: '10歳 (小5)', height: 139 },
    { id: 'age12', label: '12歳 (中1)', height: 152 },
    { id: 'adult', label: '大人', height: 165 },
  ];

  const COLORS = ['#ffb86b', '#7ee0a1', '#8fc3ff', '#f7a6d6', '#ffe08a', '#b9a6ff', '#7fe3e3', '#ff9b9b'];

  function lerpTable(table, x) {
    if (x <= table[0][0]) return table[0][1];
    for (let i = 1; i < table.length; i++) {
      if (x <= table[i][0]) {
        const [x0, y0] = table[i - 1];
        const [x1, y1] = table[i];
        return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
      }
    }
    return table[table.length - 1][1];
  }

  /** 頭身 (身長 ÷ 頭の高さ)。幼児は約 4〜5 頭身、大人は約 7 頭身 */
  const headsTall = (h) => lerpTable([[80, 4.3], [95, 4.8], [110, 5.3], [130, 5.9], [150, 6.5], [165, 7.1], [185, 7.5]], h);
  /** 股下の比率 (身長に対する脚の長さ) */
  const legRatio = (h) => lerpTable([[80, 0.38], [110, 0.42], [140, 0.45], [165, 0.47]], h);

  /** 目の高さ (cm)。頭頂から目までは頭の高さの約 45% */
  function eyeHeight(h) {
    return h - (h / headsTall(h)) * 0.45;
  }

  /** シルエットの寸法 (身長 1 を基準とした比率) */
  function shape(heightCm) {
    const u = 1 / headsTall(heightCm); // 頭の高さ
    const t = Math.max(0, Math.min(1, (heightCm - 85) / 80)); // 0: 幼児 〜 1: 大人
    const shoulder = u * (1.25 + 0.55 * t);
    const arm = u * (0.3 - 0.04 * t);
    return { u, t, shoulder, arm, leg: legRatio(heightCm), width: shoulder + arm * 2.4 };
  }

  /**
   * 人物のシルエットを描く。
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} cx 足元の中心 x (px)
   * @param {number} footY 足元の y (px)
   * @param {number} H 身長 (px)
   * @param {number} heightCm 身長 (cm)。体型の比率に使う
   * @param {string} color
   */
  function draw(ctx, cx, footY, H, heightCm, color) {
    const s = shape(heightCm);
    const u = s.u * H;
    const top = footY - H;
    const sw = s.shoulder * H;
    const hip = sw * 0.84;
    const armW = s.arm * H;
    const legLen = s.leg * H;
    const crotchY = footY - legLen;
    const shoulderY = top + u * 1.12;
    const legW = hip * 0.46;
    ctx.save();
    ctx.fillStyle = color;
    // 頭
    ctx.beginPath();
    ctx.ellipse(cx, top + u * 0.5, u * (0.44 - 0.04 * s.t), u * 0.5, 0, 0, Math.PI * 2);
    ctx.fill();
    // 首
    ctx.fillRect(cx - u * 0.13, top + u * 0.9, u * 0.26, u * 0.3);
    // 胴体 (肩から腰へ少しすぼまる)
    const r = Math.min(sw * 0.25, u * 0.3);
    ctx.beginPath();
    ctx.moveTo(cx - sw / 2 + r, shoulderY);
    ctx.lineTo(cx + sw / 2 - r, shoulderY);
    ctx.quadraticCurveTo(cx + sw / 2, shoulderY, cx + sw / 2, shoulderY + r);
    ctx.lineTo(cx + hip / 2, crotchY + u * 0.1);
    ctx.lineTo(cx - hip / 2, crotchY + u * 0.1);
    ctx.lineTo(cx - sw / 2, shoulderY + r);
    ctx.quadraticCurveTo(cx - sw / 2, shoulderY, cx - sw / 2 + r, shoulderY);
    ctx.fill();
    // 腕
    const armLen = (crotchY - shoulderY) * 1.05;
    for (const side of [-1, 1]) {
      const ax = cx + side * (sw / 2 + armW * 0.45);
      roundRect(ctx, ax - armW / 2, shoulderY + u * 0.05, armW, armLen, armW / 2);
    }
    // 脚
    for (const side of [-1, 1]) {
      const lx = cx + side * (hip / 2 - legW / 2);
      roundRect(ctx, lx - legW / 2 + side * u * 0.02, crotchY - u * 0.05, legW, legLen + u * 0.05, legW * 0.35);
    }
    ctx.restore();
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    ctx.fill();
  }

  /** シルエットを描いた画像 (WebGL テクスチャ用)。幅は身長に対する比率で決まる */
  function sprite(heightCm, color, pxHeight = 512) {
    const s = shape(heightCm);
    const w = Math.ceil(s.width * pxHeight * 1.1);
    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = pxHeight;
    draw(cv.getContext('2d'), w / 2, pxHeight, pxHeight * 0.995, heightCm, color);
    return { canvas: cv, aspect: w / pxHeight };
  }

  return { PRESETS, COLORS, eyeHeight, headsTall, shape, draw, sprite };
})();
