# MIR-app

動画を **切り出し（分割）→ 再配置 → 1 本の動画として書き出す** Electron アプリです。FFmpeg を同梱しています。

画面上部のタブで機能を切り替えます。

| タブ | できること |
|---|---|
| **レイアウト編集** | 複数の動画を切り出して並べ替え、1 本の動画として書き出す |
| **投影シミュレーター** | 大きな壁面 (既定 19.69m × 2.77m) に映像を投影した想定で、子供の身長と実寸で比べたり、子供目線で見え方を体験したりする |

代表的な用途は **Full HD 横長 4 本を、それぞれ左右に分割して上下 2 段に並べ、4K (3840×2160) で書き出す** ことです
（プリセット「左右分割 → 上下に配置」）。このほかにも、任意の本数のソースを任意の範囲で切り出して自由に配置できます。

```
 ソース1   ソース2   ソース3   ソース4            出力 3840×2160
┌──┬──┐ ┌──┬──┐ ┌──┬──┐ ┌──┬──┐       ┌──┬──┬──┬──┐
│1L│1R│ │2L│2R│ │3L│3R│ │4L│4R│  ──▶  │1L│2L│3L│4L│
└──┴──┘ └──┴──┘ └──┴──┘ └──┴──┘       ├──┼──┼──┼──┤
 1920×1080 × 4                         │1R│2R│3R│4R│
                                       └──┴──┴──┴──┘
```

## インストールと初回起動

[Releases](https://github.com/kemushiboy/MIR-app/releases) から使っている環境に合うファイルをダウンロードします。

| 環境 | ファイル |
|---|---|
| Windows (64bit) | `MIR-app-<ver>-win-x64-setup.exe` (インストーラ) または `MIR-app-<ver>-win-x64-portable.exe` (インストール不要) |
| Mac (Apple Silicon: M1 以降) | `MIR-app-<ver>-mac-arm64.dmg` |
| Mac (Intel) | `MIR-app-<ver>-mac-x64.dmg` |

MIR-app はコード署名をしていないため、初回だけ OS の警告が出ます。以下の手順で開いてください。

### Windows

1. ダウンロードした exe を実行すると「Windows によって PC が保護されました」と表示されます。
2. **「詳細情報」** をクリックし、表示された **「実行」** ボタンを押します。

ブラウザ (Edge など) がダウンロード時に「一般的にダウンロードされていません」と警告した場合は、
ダウンロード一覧の「…」→「保存」→「詳細表示」→「保持する」で保存できます。

### macOS

1. dmg を開き、MIR-app を「アプリケーション」フォルダへドラッグします。
2. MIR-app をダブルクリックします。「開いていません」「Apple は検証できませんでした」という警告が出たら **「完了」** を押します。
3. **「システム設定」→「プライバシーとセキュリティ」** を開き、一番下までスクロールします。
   「"MIR-app" は Mac を保護するためにブロックされました」の横の **「このまま開く」** を押します。
4. 確認ダイアログでもう一度 **「このまま開く」** を押し、Mac のパスワード (または Touch ID) で許可します。

2 回目以降は普通にダブルクリックで起動できます。

> macOS 14 (Sonoma) 以前では、Finder で MIR-app を右クリック →「開く」→「開く」でも起動できます。
> macOS 15 (Sequoia) 以降はこの方法が使えないため、上の手順で開いてください。

**「"MIR-app" は壊れているため開けません」と表示される場合** は、ターミナルで次を実行してから開き直してください
（ダウンロードしたファイルに付く「隔離」属性を外すコマンドです）。

```bash
xattr -dr com.apple.quarantine /Applications/MIR-app.app
```

## 開発環境のセットアップ

```bash
npm install
```

`npm install` の最後に `scripts/fetch-ffmpeg.js` が走り、FFmpeg / FFprobe の静的ビルド
（Windows / Linux は [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds) の最新安定版 GPL ビルド、
macOS は [ffmpeg.martin-riedl.de](https://ffmpeg.martin-riedl.de/) のリリースビルド）を
`vendor/ffmpeg/<platform>-<arch>/` に取得します。手動で取得し直す場合は `npm run fetch-ffmpeg -- --force`。

```bash
npm start
```

## アプリのビルド (Windows / macOS)

各 OS 用の FFmpeg を `vendor/ffmpeg/<platform>-<arch>/` に取得し、アプリの `resources/ffmpeg/` に同梱します。

| 対象 | 実行する場所 | コマンド | 出力 (`dist/`) |
|---|---|---|---|
| Windows x64 | Windows | `npm run dist:win` | `MIR-app-<ver>-win-x64-setup.exe` (インストーラ)<br>`MIR-app-<ver>-win-x64-portable.exe` (ポータブル) |
| macOS (Apple Silicon / Intel) | Mac | `npm run dist:mac` | `MIR-app-<ver>-mac-arm64.dmg` / `.zip`<br>`MIR-app-<ver>-mac-x64.dmg` / `.zip` |

> electron-builder の制約で、**macOS 版は macOS 上でしかビルドできません**（Windows で実行するとエラーになります）。
> Mac が手元にない場合は、下の GitHub Actions を使ってください。

FFmpeg の取得元: Windows は [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds)、
macOS は [ffmpeg.martin-riedl.de](https://ffmpeg.martin-riedl.de/)（arm64 / x64 それぞれネイティブの静的ビルド。VideoToolbox 対応）。
`node scripts/fetch-ffmpeg.js --mac --win` で両方をまとめて取得できます（取得時に実行ファイルの形式と CPU 種別を検証します）。

### GitHub Actions で両 OS をまとめてビルド

`.github/workflows/build.yml` を同梱しています。GitHub にリポジトリを push したうえで、

- Actions タブ →「Build」→「Run workflow」で手動実行 → 完了後、各ジョブの Artifacts からダウンロード
- `v1.0.0` のようなタグを push すると、ビルド後に GitHub Release を作成してインストーラを添付

Windows ランナーと macOS ランナー (Apple Silicon、x64 版も同時に作成) が並行して動きます。

### コード署名について

MIR-app はフリーウェアのため、**コード署名なしで配布** しています。そのため初回起動時に OS の警告が出ます。
開き方は [インストールと初回起動](#インストールと初回起動) を参照してください。

将来署名する場合に備えて、ワークフローは GitHub の Secrets に証明書を登録すれば自動で署名する設定になっています
（macOS: `MAC_CSC_LINK` / `MAC_CSC_KEY_PASSWORD`、公証: `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID`）。
未設定のままなら署名なしでビルドされます。

`npm run dist:dir` は現在の OS 向けに未パッケージのフォルダ (`dist/win-unpacked` など) だけを作ります。

## 使い方

### レイアウト編集

1. **ソース動画を追加**: 「＋ 追加」またはウィンドウへドラッグ＆ドロップ。
   各ソースの「開始」に秒数を入れると、そのソースの再生開始位置をずらせます（複数カメラの同期合わせ）。
2. **レイアウトを作る**
   - 左の **プリセット** をクリック → ダイアログでプレビューを確認して「適用」。
   - 「カスタム分割配置…」: 列数・行数、断片の並べ方（縦に積む / 横に並べる / 元の位置）、
     ソース同士の並べ方（横 / 縦 / グリッド）を自由に組み合わせられます。
   - 各ソースの「分割…」で 1 本だけを分割して既存レイアウトに追加することもできます。
   - キャンバス上のタイルはドラッグで移動（他タイル・キャンバス端にスナップ）。矢印キーで 2px、Shift+矢印で 20px 移動。
   - 右パネルで選択タイルの切り出し範囲・配置先を数値で編集できます。切り出しプレビュー上でドラッグすると切り出し位置が動きます。
3. **確認**: 下部の ▶ (または Space キー) で、全ソースを同期再生しながらレイアウトを確認できます。
   音声は「書き出し」タブで選んだ音声が鳴ります。アプリ内で再生できない形式 (ProRes・DNxHR など) のソースは静止画で表示されます。
   「実出力プレビュー」では、実際に書き出しに使う FFmpeg フィルタで 1 フレームを合成して表示します。
4. **書き出し**: 「書き出し」タブでコーデック等を確認し「書き出し開始」。
   実行される FFmpeg コマンドもそのまま表示・コピーできます。

レイアウトは「保存」で `.json` に保存できます。ソースのパスも保存されるので、同じ構成を別の素材で使う場合は
開いた後に各ソースの「差替」でファイルを入れ替えてください（タイル構成はそのまま残ります）。
投影シミュレーターの設定 (壁面・人物・視点) も同じファイルに保存されます。

### 投影シミュレーター

壁面に映像を投影したときの大きさを、子供の身長と比べて確かめるための機能です。

1. **映像を選ぶ** (左パネル): 「ソース動画 (横に並べる)」は、レイアウト編集タブで読み込んだソース動画を
   追加順に左から横に並べて投影します (プロジェクター 1 台 = ソース 1 本の想定。FHD × 4 本なら 20m × 2.8m)。
   レイアウト編集と同じく同期再生でき、立面図にはプロジェクターごとの境界 (S1, S2 …) を表示します。
   「ファイル」では任意の動画や画像を 1 つ選べます (アプリ内で再生できない形式は静止画で表示)。
   ファイルはウィンドウへドラッグ＆ドロップしても読み込めます。
2. **壁面を設定する**: 幅・映像の高さ・下端の高さ (m) と、映像の合わせ方 (全体を表示 / 全面に拡大 / 引き伸ばし)。
   既定値は絵コンテ (50cm 方眼) から読み取った実寸です: 幅 19.69m × 高さ 2.77m、下端は床面 (0m)。
   下端をマイナスにすると、映像の下端が床より下に入る (床に隠れる) 状態を再現できます。
   **インタラクション範囲** (左パネル) は壁に紫の帯で重ねて表示します。初期値は絵コンテの 2 か所 (3.43〜6.92m、12.36〜15.84m) です。
3. **人物を並べる** (右パネル): 2 歳〜大人までの平均身長の目安から追加でき、身長と位置 (壁の左端からの距離) は自由に変えられます。
4. **表示を切り替える** (ツールバー)

| 表示 | 内容 | 操作 |
|---|---|---|
| 実寸比較 | 壁の立面図に人物のシルエットを実寸で並べ、目線の高さを点線で示す | 人物をドラッグで移動・クリックで目線に設定、ホイールで拡大縮小、「人物に寄る」で人物の周辺を拡大 |
| 子供目線 | 選んだ人物の目の高さ・立ち位置 (既定は壁から 1.5m) から見た一人称視点 (3D、16:9) | ドラッグで見回す、W A S D / 矢印キーで歩く (Shift で速く)、ホイールで焦点距離 |
| 目線比較 | 2 人の視点を左右に並べて比べる | 子供目線と同じ |

右パネルには、目の高さ・映像の上端を見上げる角度・壁の高さが身長の何倍か・目線が映像のどの高さにあるか を表示します。
立ち位置は数値入力のほか、上から見た図をクリック・ドラッグしても変えられます。

目線の画角は **35mm 判換算の焦点距離** で指定します (画面は 16:9 で、焦点距離どおりの画角になります)。

| 焦点距離 | 水平画角 | 目安 |
|---|---|---|
| 50mm (既定) | 39.6° | 標準レンズ。人の目で注視したときの遠近感に近い |
| 35mm | 54.4° | 注視点の周りまで含めた見え方 |
| 24mm | 73.7° | 首を動かさずに見渡せる範囲の目安 |
| 17mm | 93.3° | 周辺視野まで (端がゆがんで見える) |

> 身長は日本の平均身長 (乳幼児身体発育調査・学校保健統計) をもとにした目安です。目の高さは頭身の比率から推定しています。

### ショートカット (レイアウト編集)

| キー | 動作 |
|---|---|
| Ctrl+S / Ctrl+Shift+S | 保存 / 名前を付けて保存 |
| Ctrl+O / Ctrl+N | 開く / 新規 |
| Ctrl+Z / Ctrl+Y | 元に戻す / やり直し |
| Ctrl+D | 選択タイルを複製 |
| Delete | 選択タイルを削除 |
| 矢印 (Shift) | 選択タイルを 2px (20px) 移動 |

## 画質とコーデックについて

### なぜ再圧縮が必要か

H.264 / HEVC / AV1 などは画面全体を一体として予測・圧縮しているため、圧縮データのまま画面の一部だけを
切り取って別の位置に貼り付けることはできません（特殊なタイル分割エンコードをした素材を除く）。
そのため **映像は必ず一度デコードして再エンコード** します。代わりに、劣化を最小限にする以下の設計にしています。

### 劣化を抑える仕組み

- **画素の並べ替えは無劣化**: 切り出しと配置は `crop` + `xstack`（重なりがある場合のみ `overlay`）で画素をそのままコピーします。
  等倍配置なら拡大縮小は一切行いません。座標・サイズは 4:2:0 の色差に合わせて偶数にスナップします。
- **ソースと同じコーデック・プロファイル・ピクセルフォーマット**:
  `コーデック = ソースと同じ` のとき、ソースが H.264 なら H.264、HEVC なら HEVC、ProRes なら同じ ProRes プロファイル（HQ / 4444 など）、
  DNxHD/HR なら DNxHR、10bit / 4:2:2 ならそのまま 10bit / 4:2:2 で出力します。
  エンコーダが非対応の形式だけ、最も近い形式（情報が減らない方向を優先）に変換します。
- **色情報の引き継ぎ**: color primaries / transfer / matrix / range をソースから引き継ぎます。
- **画質モード**

  | モード | 内容 |
  |---|---|
  | 視覚的ロスレス (既定) | x264 CRF 12 / x265 CRF 14 / NVENC CQ 16 など。テストでは各タイルが元素材に対し PSNR 53〜62 dB |
  | 高画質 | x264 CRF 17 / x265 CRF 19 など。サイズ控えめ |
  | 数学的ロスレス | x264 `-qp 0` / x265 `lossless=1` / VP9 `-lossless 1` など。ソースのデコード結果と完全一致 (PSNR ∞)。巨大で再生互換性は低め |
  | ビットレート指定 | 未入力ならソースのビットレートを面積比で合算した値（≈ソース相当）を使用 |

  完全に無劣化の中間ファイルが必要な場合は、コーデックを **FFV1** または **Ut Video** にしてください。
- **音声は無変換コピー**（コンテナに入らない形式のみ AAC 320k 等に変換）。
  ただしソースに「開始」オフセットを指定した場合、ストリームコピーではキーフレーム単位でしかシークできず音ズレの原因になるため、
  同じコーデックで再エンコードします（PCM / FLAC / ALAC は無劣化）。
- **コンテナ**: `自動` ではソースと同じ形式（MP4 / MOV / MKV …）。コーデックと合わない場合は適切な形式に切り替えます。

### ハードウェアエンコーダ

NVIDIA NVENC / Intel Quick Sync / AMD AMF（Windows）、Apple VideoToolbox（macOS、H.264 / HEVC）を
起動時に実際に試し、使えるものだけ選択肢に出します。VideoToolbox は品質指定が環境によって効かないため、
ソース相当ビットレートの 2 倍（視覚的ロスレス）/ 1.3 倍（高画質）で出力します。
ソフトウェアより大幅に速い一方、同じサイズなら画質はソフトウェア (x264 / x265) が上です。

## 開発・テスト用スクリプト

```bash
# テスト動画 (1920×1080, 4 本) を生成。codec: h264 | h264-10bit | hevc | prores
node scripts/make-test-videos.js test-videos h264 5

# GUI なしで書き出しし、各タイルが元素材の対応領域と一致するか PSNR で検証
node scripts/test-export.js test-videos/out.mp4 split-lr-stack test-videos/cam1_h264.mp4 test-videos/cam2_h264.mp4 test-videos/cam3_h264.mp4 test-videos/cam4_h264.mp4 [--quality=lossless] [--codec=hevc] [--hw=qsv] [--dry]

# overlay / 拡大縮小 / 単一タイル / プレビュー生成 の各経路を検証
node scripts/test-paths.js test-videos/cam1_h264.mp4 test-videos
```

環境変数 `FFMPEG_PATH` / `FFPROBE_PATH` を指定すると、同梱版の代わりにそのバイナリを使います。

## 構成

```
src/main/main.js             Electron メインプロセス (IPC・ダイアログ・書き出し管理)
src/main/preload.js          レンダラへ公開する API (contextIsolation)
src/main/ffmpeg.js           FFmpeg 実行 (probe / サムネイル / 機能検出 / 進捗付き書き出し)
src/main/command.js          レイアウト → FFmpeg フィルタグラフ・引数の生成 (純粋関数)
src/main/codecs.js           コーデック / エンコーダ / コンテナ / ピクセルフォーマットの対応と選択
src/renderer/shell.js        全タブ共通の土台 (共通ヘルパー・タブの切り替えとライフサイクル)
src/renderer/player.js       ソース動画の同期再生 (レイアウト編集と投影シミュレーターで共用)
src/renderer/workspaces.js   タブの登録 (タブを追加するときはここに 1 行)
src/renderer/style.css       デザイントークンと共通部品
src/renderer/app.js          レイアウト編集タブ (presets.js: 分割配置プリセット)
src/renderer/simulator*.js   投影シミュレータータブ (初めて開いたときに読み込む)
docs/DESIGN.md               デザインと実装のルール (タブを追加するときに参照)
scripts/                     FFmpeg 取得・テスト用スクリプト
```

## ライセンス

MIR-app は **GNU General Public License v3.0 以降 (GPL-3.0-or-later)** で公開しているフリーソフトウェアです。
全文は [LICENSE](LICENSE) を参照してください。

```
MIR-app
Copyright (C) 2026 ishikawa

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.
```

アプリには次のソフトウェアを同梱しています。取得元とソースコードの入手先は
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) にまとめています（配布するアプリにも同じ文書が入ります）。

| ソフトウェア | ライセンス |
|---|---|
| [FFmpeg](https://ffmpeg.org/) (libx264 / libx265 などを含む GPL ビルド) | GPL |
| [Electron](https://www.electronjs.org/) / Chromium | MIT / 各種 (アプリ内の `LICENSE.electron.txt` / `LICENSES.chromium.html`) |

MIR-app を改変して再配布する場合も GPL の条件（ソースコードの提供、同じライセンスでの公開など）に従ってください。
