#!/usr/bin/env node
/**
 * 動作確認用のテスト動画 (1920×1080, 4 本) を生成する。
 *   node scripts/make-test-videos.js <出力ディレクトリ> [codec=h264] [秒数=5]
 * codec: h264 | hevc | prores | h264-10bit
 */
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { FFMPEG } = require('../src/main/ffmpeg');

const outDir = path.resolve(process.argv[2] || 'test-videos');
const codec = process.argv[3] || 'h264';
const secs = Number(process.argv[4] || 5);
fs.mkdirSync(outDir, { recursive: true });

const enc = {
  h264: { ext: 'mp4', args: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k'] },
  'h264-10bit': { ext: 'mp4', args: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv422p10le', '-c:a', 'aac', '-b:a', '192k'] },
  hevc: { ext: 'mp4', args: ['-c:v', 'libx265', '-preset', 'fast', '-crf', '20', '-pix_fmt', 'yuv420p10le', '-tag:v', 'hvc1', '-c:a', 'aac', '-b:a', '192k'] },
  prores: { ext: 'mov', args: ['-c:v', 'prores_ks', '-profile:v', '3', '-pix_fmt', 'yuv422p10le', '-c:a', 'pcm_s24le'] },
}[codec];
if (!enc) throw new Error('unknown codec ' + codec);

const font = process.platform === 'win32' ? ":fontfile='C\\:/Windows/Fonts/arial.ttf'" : '';
const colors = ['0xE53935', '0x43A047', '0x1E88E5', '0xFDD835'];
for (let i = 0; i < 4; i++) {
  const file = path.join(outDir, `cam${i + 1}_${codec}.${enc.ext}`);
  const vf = [
    `drawbox=x=0:y=0:w=960:h=1080:color=${colors[i]}@0.35:t=fill`,
    `drawbox=x=960:y=0:w=960:h=1080:color=white@0.15:t=fill`,
    `drawbox=x=8:y=8:w=1904:h=1064:color=${colors[i]}:t=16`,
    `drawtext=text='CAM ${i + 1} L':x=480-text_w/2:y=420${font}:fontsize=120:fontcolor=white:borderw=6`,
    `drawtext=text='CAM ${i + 1} R':x=1440-text_w/2:y=420${font}:fontsize=120:fontcolor=white:borderw=6`,
  ].join(',');
  execFileSync(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc2=s=1920x1080:r=30000/1001:d=${secs}`,
    '-f', 'lavfi', '-i', `sine=frequency=${440 + i * 110}:sample_rate=48000:duration=${secs}`,
    '-vf', vf, ...enc.args, '-shortest', file,
  ], { stdio: 'inherit' });
  console.log('生成:', file);
}
