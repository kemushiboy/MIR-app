#!/usr/bin/env node
/**
 * README のスクリーンショット用テストパターン: Full HD 4 本分の横長動画 (7680×1080)。
 * 1920px ごとの区画に色と番号 (1〜4) を付ける。
 *
 *   node scripts/make-test-pattern.js [出力ファイル=test-videos/testpattern_7680x1080.mp4] [秒数=6]
 */
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { FFMPEG } = require('../src/main/ffmpeg');

const out = path.resolve(process.argv[2] || 'test-videos/testpattern_7680x1080.mp4');
const secs = Number(process.argv[3] || 6);
fs.mkdirSync(path.dirname(out), { recursive: true });

const font = process.platform === 'win32' ? ":fontfile='C\\:/Windows/Fonts/arial.ttf'" : '';
const colors = ['0xE53935', '0x43A047', '0x1E88E5', '0xFDD835'];
const vf = [];
for (let i = 0; i < 4; i++) {
  const x = i * 1920;
  vf.push(
    `drawbox=x=${x}:y=0:w=1920:h=1080:color=${colors[i]}@0.45:t=fill`,
    `drawbox=x=${x + 6}:y=6:w=1908:h=1068:color=${colors[i]}:t=12`,
    `drawtext=text='${i + 1}'${font}:x=${x + 960}-text_w/2:y=300:fontsize=380:fontcolor=white:borderw=12:bordercolor=black@0.6`,
    `drawtext=text='Full HD ${i + 1}'${font}:x=${x + 960}-text_w/2:y=760:fontsize=72:fontcolor=white:borderw=5:bordercolor=black@0.6`,
  );
}
execFileSync(FFMPEG, [
  '-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'lavfi', '-i', `testsrc2=s=7680x1080:r=30:d=${secs}`,
  '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${secs}`,
  '-vf', vf.join(','),
  '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-b:a', '192k', '-shortest', out,
], { stdio: 'inherit' });
console.log('生成:', out);
