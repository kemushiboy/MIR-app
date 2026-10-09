#!/usr/bin/env node
/**
 * README 用のスクリーンショットを docs/images/ に撮り直す。
 *   node scripts/make-screenshots.js
 * テストパターン (7680×1080) がなければ先に生成し、「左右分割 → 上下に配置」プリセットを適用した状態で撮影する。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const electron = require('electron'); // electron 実行ファイルのパス

const ROOT = path.resolve(__dirname, '..');
const pattern = path.join(ROOT, 'test-videos', 'testpattern_7680x1080.mp4');
if (!fs.existsSync(pattern)) execFileSync(process.execPath, [path.join(__dirname, 'make-test-pattern.js'), pattern], { stdio: 'inherit' });

const r = spawnSync(electron, [path.join(__dirname, 'screenshot-harness')], {
  stdio: 'inherit',
  env: { ...process.env, MIR_APP_OPEN: pattern, MIR_APP_PRESET: 'split-lr-stack' },
  timeout: 120000,
});
process.exit(r.status == null ? 1 : r.status);
