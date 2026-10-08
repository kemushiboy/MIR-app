/**
 * 投影シミュレーター: 一人称視点の 3D 描画 (WebGL2、外部ライブラリなし)。
 *
 * 座標系 (単位 m): x = 壁に沿って右 (壁の左端が 0)、y = 上 (床が 0)、z = 壁から手前 (壁面が z = 0)。
 * 描画は呼ばれたときだけ行う (常時ループしない)。
 */
'use strict';

window.SimGL = (() => {
  const VS = `#version 300 es
in vec3 aPos;
in vec2 aUv;
uniform mat4 uMVP;
out vec2 vUv;
out vec3 vWorld;
void main() {
  vUv = aUv;
  vWorld = aPos;
  gl_Position = uMVP * vec4(aPos, 1.0);
}`;

  const FS = `#version 300 es
precision highp float;
in vec2 vUv;
in vec3 vWorld;
uniform int uMode;          // 0: 単色, 1: テクスチャ, 2: テクスチャ (透明部分を抜く)
uniform vec4 uColor;
uniform sampler2D uTex;
uniform float uGrid;        // 0 ならグリッドなし。>0 ならグリッド間隔 (m)
uniform int uGridPlane;     // 0: 床 (xz), 1: 壁 (xy)
uniform vec4 uGridColor;
uniform vec3 uCam;
uniform vec3 uFogColor;
out vec4 outColor;

float gridLine(vec2 p) {
  vec2 g = abs(fract(p - 0.5) - 0.5) / fwidth(p);
  return 1.0 - min(min(g.x, g.y), 1.0);
}

void main() {
  vec4 c = uColor;
  if (uMode >= 1) {
    c = texture(uTex, vUv);
    if (uMode == 2 && c.a < 0.5) discard;
  }
  if (uGrid > 0.0) {
    vec2 p = (uGridPlane == 0 ? vWorld.xz : vWorld.xy) / uGrid;
    c.rgb = mix(c.rgb, uGridColor.rgb, gridLine(p) * uGridColor.a);
  }
  float fog = smoothstep(18.0, 45.0, distance(vWorld, uCam));
  outColor = vec4(mix(c.rgb, uFogColor, fog), 1.0);
}`;

  // ---- 行列 (列優先) ----
  function perspective(fovy, aspect, near, far) {
    const f = 1 / Math.tan(fovy / 2);
    const m = new Float32Array(16);
    m[0] = f / aspect;
    m[5] = f;
    m[10] = (far + near) / (near - far);
    m[11] = -1;
    m[14] = (2 * far * near) / (near - far);
    return m;
  }
  function lookDir(eye, yaw, pitch) {
    const f = [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)];
    const zx = -f[0], zy = -f[1], zz = -f[2];
    // x = normalize(cross(up, z))
    let xx = zz, xy = 0, xz = -zx;
    const xl = Math.hypot(xx, xy, xz) || 1;
    xx /= xl; xz /= xl;
    // y = cross(z, x)
    const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
    const m = new Float32Array(16);
    m[0] = xx; m[1] = yx; m[2] = zx;
    m[4] = xy; m[5] = yy; m[6] = zy;
    m[8] = xz; m[9] = yz; m[10] = zz;
    m[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2]);
    m[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2]);
    m[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2]);
    m[15] = 1;
    return m;
  }
  function mul(a, b) {
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
      }
    }
    return o;
  }

  const hex = (h, a = 1) => {
    const n = parseInt(h.replace('#', ''), 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, a];
  };

  class Renderer {
    constructor(canvas) {
      const gl = canvas.getContext('webgl2', { antialias: true, alpha: false });
      if (!gl) throw new Error('この環境では WebGL2 が使えません');
      this.gl = gl;
      this.canvas = canvas;
      this.prog = this._program(VS, FS);
      this.loc = {};
      for (const n of ['uMVP', 'uMode', 'uColor', 'uTex', 'uGrid', 'uGridPlane', 'uGridColor', 'uCam', 'uFogColor']) {
        this.loc[n] = gl.getUniformLocation(this.prog, n);
      }
      this.vao = gl.createVertexArray();
      this.vbo = gl.createBuffer();
      gl.bindVertexArray(this.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
      const aPos = gl.getAttribLocation(this.prog, 'aPos');
      const aUv = gl.getAttribLocation(this.prog, 'aUv');
      gl.enableVertexAttribArray(aPos);
      gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 20, 0);
      gl.enableVertexAttribArray(aUv);
      gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 20, 12);
      this.aniso = gl.getExtension('EXT_texture_filter_anisotropic');
      this.maxTex = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), 4096);
      this.contentTex = this._texture();
      this.spriteTex = new Map(); // key → { tex, aspect }
      this.scratch = document.createElement('canvas');
    }

    _program(vs, fs) {
      const gl = this.gl;
      const sh = (type, src) => {
        const s = gl.createShader(type);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
        return s;
      };
      const p = gl.createProgram();
      gl.attachShader(p, sh(gl.VERTEX_SHADER, vs));
      gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
      return p;
    }

    _texture() {
      const gl = this.gl;
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      if (this.aniso) gl.texParameterf(gl.TEXTURE_2D, this.aniso.TEXTURE_MAX_ANISOTROPY_EXT, 8);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
      return t;
    }

    _upload(tex, src, w, h) {
      const gl = this.gl;
      let img = src;
      // GPU の上限 (かつ 4096px) を超える場合は縮小してから転送する
      if (w > this.maxTex || h > this.maxTex) {
        const k = this.maxTex / Math.max(w, h);
        this.scratch.width = Math.round(w * k);
        this.scratch.height = Math.round(h * k);
        this.scratch.getContext('2d').drawImage(src, 0, 0, this.scratch.width, this.scratch.height);
        img = this.scratch;
      }
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      gl.generateMipmap(gl.TEXTURE_2D);
    }

    /** 壁に映す映像を更新する (動画は再生中に毎フレーム呼ぶ) */
    setContent(src, w, h) {
      if (src && w && h) this._upload(this.contentTex, src, w, h);
    }

    _sprite(heightCm, color) {
      const key = `${heightCm}|${color}`;
      let s = this.spriteTex.get(key);
      if (!s) {
        const sp = window.Figures.sprite(heightCm, color, 256);
        const tex = this._texture();
        this._upload(tex, sp.canvas, sp.canvas.width, sp.canvas.height);
        s = { tex, aspect: sp.aspect };
        this.spriteTex.set(key, s);
        if (this.spriteTex.size > 64) {
          const first = this.spriteTex.keys().next().value;
          this.gl.deleteTexture(this.spriteTex.get(first).tex);
          this.spriteTex.delete(first);
        }
      }
      return s;
    }

    _quad(p0, p1, p2, p3, uv = [0, 0, 1, 1]) {
      // p0: 左下, p1: 右下, p2: 右上, p3: 左上 / uv = [u0, v0, u1, v1] (v は下が 0)
      const [u0, v0, u1, v1] = uv;
      const d = new Float32Array([
        ...p0, u0, v0, ...p1, u1, v0, ...p2, u1, v1,
        ...p0, u0, v0, ...p2, u1, v1, ...p3, u0, v1,
      ]);
      const gl = this.gl;
      gl.bufferData(gl.ARRAY_BUFFER, d, gl.DYNAMIC_DRAW);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    _set(mode, color, grid = 0, plane = 0) {
      const gl = this.gl;
      gl.uniform1i(this.loc.uMode, mode);
      gl.uniform4fv(this.loc.uColor, color || [1, 1, 1, 1]);
      gl.uniform1f(this.loc.uGrid, grid);
      gl.uniform1i(this.loc.uGridPlane, plane);
    }

    /**
     * @param {object} scene { wall:{width,height,bottom}, content:{x,y,w,h,uv}, figures:[{x,z,height,color}], grid, colors }
     * @param {Array} views [{ x, y, w, h (CSS px), eye:[x,y,z], yaw, pitch, hfov (rad) }]
     */
    render(scene, views) {
      const gl = this.gl;
      const dpr = window.devicePixelRatio || 1;
      const cw = Math.round(this.canvas.clientWidth * dpr);
      const ch = Math.round(this.canvas.clientHeight * dpr);
      if (this.canvas.width !== cw || this.canvas.height !== ch) {
        this.canvas.width = cw;
        this.canvas.height = ch;
      }
      const C = scene.colors;
      gl.useProgram(this.prog);
      gl.bindVertexArray(this.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
      gl.enable(gl.DEPTH_TEST);
      gl.enable(gl.SCISSOR_TEST);
      gl.activeTexture(gl.TEXTURE0);
      gl.uniform1i(this.loc.uTex, 0);
      gl.uniform3fv(this.loc.uFogColor, C.fog.slice(0, 3));
      gl.uniform4fv(this.loc.uGridColor, C.grid);

      const { width: W, height: H, bottom: B } = scene.wall;
      const L = -25;
      const R = W + 25;
      const top = Math.max(B + H + 2.5, 6);
      const depth = 45;

      for (const v of views) {
        const vx = Math.round(v.x * dpr);
        const vy = Math.round(ch - (v.y + v.h) * dpr);
        const vw = Math.round(v.w * dpr);
        const vh = Math.round(v.h * dpr);
        gl.viewport(vx, vy, vw, vh);
        gl.scissor(vx, vy, vw, vh);
        gl.clearColor(...C.fog.slice(0, 3), 1);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        const aspect = vw / vh;
        const fovy = 2 * Math.atan(Math.tan(v.hfov / 2) / aspect);
        const mvp = mul(perspective(fovy, aspect, 0.05, 200), lookDir(v.eye, v.yaw, v.pitch));
        gl.uniformMatrix4fv(this.loc.uMVP, false, mvp);
        gl.uniform3fv(this.loc.uCam, v.eye);

        // 床 (1m グリッド)
        this._set(0, C.floor, scene.grid ? 1 : 0, 0);
        this._quad([L, 0, depth], [R, 0, depth], [R, 0, 0], [L, 0, 0]);
        // 壁
        this._set(0, C.wall, scene.grid ? 1 : 0, 1);
        this._quad([L, 0, 0], [R, 0, 0], [R, top, 0], [L, top, 0]);
        // 投影範囲 (映像のない部分はプロジェクターの黒)
        this._set(0, C.screen, scene.grid ? 1 : 0, 1);
        this._quad([0, B, 0.002], [W, B, 0.002], [W, B + H, 0.002], [0, B + H, 0.002]);
        // 映像
        const c = scene.content;
        if (c) {
          gl.bindTexture(gl.TEXTURE_2D, this.contentTex);
          this._set(1, null, scene.grid ? 1 : 0, 1);
          this._quad([c.x, c.y, 0.004], [c.x + c.w, c.y, 0.004], [c.x + c.w, c.y + c.h, 0.004], [c.x, c.y + c.h, 0.004], c.uv);
        }
        // 人物 (壁と平行に立つ板)
        for (const f of scene.figures) {
          const sp = this._sprite(f.height, f.color);
          const h = f.height / 100;
          const w = h * sp.aspect;
          gl.bindTexture(gl.TEXTURE_2D, sp.tex);
          this._set(2, null);
          this._quad([f.x - w / 2, 0, f.z], [f.x + w / 2, 0, f.z], [f.x + w / 2, h, f.z], [f.x - w / 2, h, f.z]);
        }
      }
      gl.disable(gl.SCISSOR_TEST);
    }

    dispose() {
      const ext = this.gl.getExtension('WEBGL_lose_context');
      if (ext) ext.loseContext();
    }
  }

  return { Renderer, hex };
})();
