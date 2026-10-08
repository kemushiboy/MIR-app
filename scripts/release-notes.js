#!/usr/bin/env node
/**
 * GitHub Release の本文を作る (GitHub Actions の release ジョブで使用)。
 * README の「インストールと初回起動」の節を取り出し、ファイル名の <ver> を実際のバージョンに置き換える。
 *
 *   node scripts/release-notes.js 1.2.0 > release-notes.md
 */
const fs = require('fs');
const path = require('path');

const version = (process.argv[2] || require('../package.json').version).replace(/^v/, '');
const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8').replace(/\r\n/g, '\n');

const start = readme.indexOf('\n## インストールと初回起動');
if (start < 0) throw new Error('README に「## インストールと初回起動」の節がありません');
const next = readme.indexOf('\n## ', start + 1);
let section = readme.slice(start + 1, next < 0 ? undefined : next).trim();

section = section
  .replace(/^## インストールと初回起動\n+/, '')
  .replace(/<ver>/g, version)
  // Release ページ自身へのリンクは不要なので文言だけ残す
  .replace(/\[Releases\]\([^)]*\) から/, '下の「Assets」から')
  // 見出しを 1 段下げる (Release 本文の中で大きくなりすぎないように)
  .replace(/^### /gm, '#### ');

const out = `## インストールと初回起動

${section}

詳しい使い方は [README](https://github.com/kemushiboy/MIR-app#readme) を参照してください。
`;
process.stdout.write(out);
