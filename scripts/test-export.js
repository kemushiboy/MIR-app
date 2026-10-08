#!/usr/bin/env node
/**
 * GUI を使わずにレイアウト書き出しを検証する。
 *   node scripts/test-export.js <出力ファイル> <preset-id> <src1> [src2 ...] [--quality=lossless] [--codec=hevc] [--hw=nvenc] [--dry]
 * 書き出し後、各タイルの領域がソースの対応領域と一致するかを PSNR で検証する。
 */
const path = require('path');
const { spawnSync } = require('child_process');
const ff = require('../src/main/ffmpeg');
const { buildPlan } = require('../src/main/command');
const Presets = require('../src/renderer/presets');

(async () => {
  const pos = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const flags = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => {
    const [k, v] = a.slice(2).split('=');
    return [k, v ?? true];
  }));
  const [out, presetId, ...files] = pos;
  const caps = await ff.capabilities();
  console.log('HW エンコーダ:', caps.hwWorking.join(', ') || 'なし');
  const sources = [];
  for (const f of files) sources.push({ path: path.resolve(f), offset: 0, probe: await ff.probe(path.resolve(f)) });
  const preset = Presets.LIST.find((p) => p.id === presetId);
  const lay = Presets.splitArrange(sources.map((s) => s.probe), preset.params);
  const job = {
    sources,
    canvas: { ...lay.canvas, fps: 'auto', background: '#000000' },
    tiles: lay.tiles,
    output: {
      path: path.resolve(out), container: 'auto', codec: flags.codec || 'source', hw: flags.hw || 'none',
      quality: flags.quality || 'visually_lossless', bitrateMbps: 0, pixFmt: 'source',
      audio: { mode: flags.audio || 'source', source: 0 }, duration: { mode: 'shortest' },
    },
  };
  const plan = buildPlan(job, caps);
  console.log(JSON.stringify(plan.info, null, 2));
  [...plan.notes, ...plan.warnings].forEach((n) => console.log('注意:', n));
  console.log('ffmpeg', plan.args.map((a) => (/[\s;|\[]/.test(a) ? `"${a}"` : a)).join(' '));
  if (flags.dry) return;

  const t0 = Date.now();
  const r = await new ff.ExportJob(plan.args, plan.duration, plan.totalFrames, {
    onProgress: (p) => process.stdout.write(`\r  ${(p.ratio * 100).toFixed(1)}%  ${p.fps} fps  speed ${p.speed}   `),
    onLog: () => {},
  }).start();
  console.log('\n結果:', r, ((Date.now() - t0) / 1000).toFixed(1) + 's');
  if (!r.ok) process.exit(1);

  const op = await ff.probe(plan.outPath);
  console.log(`出力: ${op.width}x${op.height} ${op.codec} ${op.profile} ${op.pixFmt} ${op.fps} ${op.duration.toFixed(3)}s ` +
    `${(op.bitrate / 1e6).toFixed(1)} Mbps, audio=${op.audio.map((a) => a.codec).join(',')}`);

  // タイルごとの PSNR 検証 (出力の dest 領域 vs ソースの crop 領域)
  for (const [i, t] of job.tiles.entries()) {
    const src = sources[t.source].path;
    const log = spawnSync(ff.FFMPEG, ['-hide_banner', '-i', plan.outPath, '-i', src, '-filter_complex',
      `[0:v]crop=${t.dest.w}:${t.dest.h}:${t.dest.x}:${t.dest.y}[a];[1:v]crop=${t.crop.w}:${t.crop.h}:${t.crop.x}:${t.crop.y},format=${op.pixFmt}[b];[a][b]psnr`,
      '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
    const m = log.match(/PSNR .*average:(\S+)/);
    console.log(`  タイル${i + 1} (src${t.source + 1} ${t.label}) PSNR avg: ${m ? m[1] : '?'} dB`);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
