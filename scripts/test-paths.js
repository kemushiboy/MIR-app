#!/usr/bin/env node
/**
 * 合成経路 (overlay / 拡縮 / 単一タイル / プレビュー) の動作確認。
 *   node scripts/test-paths.js <src.mp4> <出力ディレクトリ>
 */
const path = require('path');
const fs = require('fs');
const ff = require('../src/main/ffmpeg');
const { buildPlan } = require('../src/main/command');

(async () => {
  const [src, outDir] = process.argv.slice(2).map((p) => path.resolve(p));
  const caps = await ff.capabilities();
  const probe = await ff.probe(src);
  const base = (tiles, canvas, extra = {}) => ({
    sources: [{ path: src, offset: 1, probe }],
    canvas: { fps: 'auto', background: '#202020', ...canvas },
    tiles,
    output: {
      container: 'auto', codec: 'source', hw: 'none', quality: 'high', bitrateMbps: 0, pixFmt: 'source',
      audio: { mode: 'source', source: 0 }, duration: { mode: 'custom', seconds: 1 }, ...extra,
    },
  });
  const cases = {
    overlap: base([
      { source: 0, crop: { x: 0, y: 0, w: 1920, h: 1080 }, dest: { x: 0, y: 0, w: 1920, h: 1080 } },
      { source: 0, crop: { x: 960, y: 0, w: 960, h: 1080 }, dest: { x: 600, y: 200, w: 960, h: 1080 } },
    ], { width: 1920, height: 1280 }),
    scaled: base([
      { source: 0, crop: { x: 0, y: 0, w: 960, h: 540 }, dest: { x: 0, y: 0, w: 1920, h: 1080 } },
    ], { width: 1920, height: 1080 }, { codec: 'hevc', container: 'mkv' }),
    portrait: base([
      { source: 0, crop: { x: 0, y: 0, w: 960, h: 1080 }, dest: { x: 0, y: 0, w: 960, h: 1080 } },
      { source: 0, crop: { x: 960, y: 0, w: 960, h: 1080 }, dest: { x: 0, y: 1080, w: 960, h: 1080 } },
    ], { width: 1080, height: 2160 }, { codec: 'ffv1', audio: { mode: 'none' } }),
  };
  for (const [name, job] of Object.entries(cases)) {
    job.output.path = path.join(outDir, `path_${name}.mp4`);
    const plan = buildPlan(job, caps);
    console.log(`== ${name}: ${plan.info.compositor} ${plan.info.encoder} ${plan.info.container} audio=${plan.info.audio}`);
    [...plan.notes, ...plan.warnings].forEach((n) => console.log('   注意:', n));
    const r = await new ff.ExportJob(plan.args, plan.duration, plan.totalFrames, { onProgress() {}, onLog() {} }).start();
    if (!r.ok) throw new Error(`${name}: ${r.error}`);
    const p = await ff.probe(plan.outPath);
    console.log(`   → ${path.basename(plan.outPath)} ${p.width}x${p.height} ${p.codec} ${p.pixFmt} ${p.duration.toFixed(2)}s`);
    const file = ff.tempFile('png');
    const pv = buildPlan(job, caps, { preview: { time: 0.5, file } });
    const url = await ff.renderPreview(pv.args);
    const png = path.join(outDir, `preview_${name}.png`);
    fs.writeFileSync(png, Buffer.from(url.split(',')[1], 'base64'));
    console.log(`   preview → ${png}`);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
