/* global App */
/**
 * ワークスペース (タブ) の登録。新しいタブを追加するときは:
 *   1. index.html にタブボタン (.ws-tab) と <main class="workspace" data-ws="…"> を追加
 *   2. 実装スクリプトを作り、window.XxxWorkspace = { init, show, hide, … } を公開
 *   3. ここで App.register() する (scripts に書いたファイルは初めて開いたときに読み込まれる)
 * 詳しくは docs/DESIGN.md を参照。
 */
'use strict';

App.register({ id: 'layout', module: () => window.LayoutWorkspace });

App.register({
  id: 'simulator',
  scripts: ['simulator-figures.js', 'simulator-gl.js', 'simulator.js'],
  module: () => window.SimulatorWorkspace,
});

App.show('layout');
