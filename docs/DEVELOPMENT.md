# MIR-app 開発者向けガイド

アプリの使い方は [README](../README.md) を参照してください。ここでは開発・ビルド・リリースと内部の仕組みをまとめます。
画面デザインとタブ (ワークスペース) 追加のルールは [DESIGN.md](DESIGN.md) を参照してください。

## 開発環境のセットアップ

Node.js 22 以降が必要です。

```bash
npm install
```

`npm install` の最後に `scripts/fetch-ffmpeg.js` が走り、FFmpeg / FFprobe の静的ビルドを
`vendor/ffmpeg/<platform>-<arch>/` に取得します。

| OS | 取得元 |
|---|---|
| Windows / Linux | [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds) の最新安定版 GPL ビルド |
| macOS (arm64 / x64) | [ffmpeg.martin-riedl.de](https://ffmpeg.martin-riedl.de/) のリリースビルド (それぞれネイティブ、VideoToolbox 対応) |

- 取り直す場合: `npm run fetch-ffmpeg -- --force`
- 別 OS 向けもまとめて取得: `node scripts/fetch-ffmpeg.js --mac --win` (取得時に実行ファイルの形式と CPU 種別を検証します)
- 環境変数 `FFMPEG_PATH` / `FFPROBE_PATH` を指定すると、同梱版の代わりにそのバイナリを使います

```bash
npm start
```

## ビルド

FFmpeg はアプリの `resources/ffmpeg/` に同梱されます。

| 対象 | 実行する場所 | コマンド | 出力 (`dist/`) |
|---|---|---|---|
| Windows x64 | Windows | `npm run dist:win` | `MIR-app-<ver>-win-x64-setup.exe` (インストーラ)<br>`MIR-app-<ver>-win-x64-portable.exe` (ポータブル) |
| macOS (Apple Silicon / Intel) | Mac | `npm run dist:mac` | `MIR-app-<ver>-mac-arm64.dmg` / `.zip`<br>`MIR-app-<ver>-mac-x64.dmg` / `.zip` |
| 現在の OS (未パッケージ) | — | `npm run dist:dir` | `dist/win-unpacked` など |

> electron-builder の制約で、**macOS 版は macOS 上でしかビルドできません** (Windows で実行するとエラーになります)。
> Mac が手元にない場合は GitHub Actions を使ってください。

ローカルビルドのバージョンは `package.json` の `version` です。

### GitHub Actions とリリース

`.github/workflows/build.yml` で、Windows ランナーと macOS ランナー (Apple Silicon、x64 版も同時に作成) が並行してビルドします。

- **手動実行**: Actions タブ →「Build」→「Run workflow」。完了後、各ジョブの Artifacts からダウンロードできます。
- **リリース**: `v1.2.0` のようなタグを push すると、ビルド後に GitHub Release を作成してインストーラを添付します。
  - アプリのバージョンと成果物のファイル名はタグに合わせます (`v1.2.0` → `MIR-app-1.2.0-…`)。
  - Release の本文は、README の「インストールと初回起動」の節 (`scripts/release-notes.js` で生成) と、
    GitHub が自動生成する変更履歴です。**README のこの見出しは変えないでください** (スクリプトが見出しで探します)。

```bash
git tag -a v1.2.0 -m "MIR-app 1.2.0"
git push origin v1.2.0
```

### コード署名

フリーウェアのため、現在は **コード署名なしで配布** しています (利用者には初回起動時に OS の警告が出ます)。
ワークフローは GitHub の Secrets に証明書を登録すれば自動で署名します。未設定なら署名なしでビルドします。

| 用途 | Secrets |
|---|---|
| macOS 署名 (Developer ID Application 証明書 .p12 の base64 とパスワード) | `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD` |
| macOS 公証 | `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` |
| Windows 署名 (.pfx の base64 とパスワード) | `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD` |

- macOS では Hardened Runtime を有効にしてあり、同梱の ffmpeg / ffprobe もアプリと一緒に署名されます。
- Windows の新しい OV/EV 証明書は鍵をハードウェアに保管する必要があり、.pfx を Secrets に入れる方式は使えません。
  署名する場合は、クラウド署名サービスに合わせてワークフローの変更が必要です。

## 書き出しの仕組み (画質を保つための設計)

H.264 / HEVC / AV1 などは画面全体をまとめて予測・圧縮しているため、圧縮データのまま画面の一部を切り取って
別の位置に貼ることはできません。そのため映像は一度デコードして再エンコードし、劣化を次の方法で最小限にしています。

- **画素の並べ替えは無劣化**: `crop` + `xstack` (タイルが重なる場合のみ `overlay`) で画素をそのままコピーします。
  等倍配置なら拡大縮小はしません。座標・サイズは 4:2:0 の色差に合わせて偶数にスナップします。
- **ソースと同じコーデック・プロファイル・ピクセルフォーマット**: H.264 → H.264、HEVC → HEVC、ProRes → 同じプロファイル (HQ / 4444 など)、
  DNxHD/HR → DNxHR、10bit / 4:2:2 はそのまま。エンコーダが非対応の形式だけ、情報が減らない方向で最も近い形式に変換します。
- **色情報**: color primaries / transfer / matrix / range をソースから引き継ぎます。
- **画質モード**

  | モード | 主な設定 |
  |---|---|
  | 視覚的ロスレス (既定) | x264 CRF 12 / x265 CRF 14 / NVENC CQ 16 など。テストでは各タイルが元素材に対し PSNR 53〜62 dB |
  | 高画質 | x264 CRF 17 / x265 CRF 19 など |
  | 数学的ロスレス | x264 `-qp 0` / x265 `lossless=1` / VP9 `-lossless 1` など。デコード結果と完全一致 (PSNR ∞) |
  | ビットレート指定 | 未入力ならソースのビットレートを面積比で合算した値 |

  完全に無劣化の中間ファイルが必要な場合は FFV1 / Ut Video を選びます。
- **音声**: 無変換コピー (コンテナに入らない形式のみ AAC 320k 等に変換)。ソースに「開始」オフセットがある場合は、
  ストリームコピーではキーフレーム単位でしかシークできず音ズレするため、同じコーデックで再エンコードします (PCM / FLAC / ALAC は無劣化)。
- **コンテナ**: 既定はソースと同じ形式。コーデックと合わない場合は適切な形式に切り替えます。
- **ハードウェアエンコーダ**: NVENC / Quick Sync / AMF (Windows)、VideoToolbox (macOS、H.264 / HEVC) を起動時に実際に試し、
  使えるものだけ選択肢に出します。VideoToolbox は品質指定が環境によって効かないため、ソース相当ビットレートの 2 倍 (視覚的ロスレス) /
  1.3 倍 (高画質) で出力します。

## 投影シミュレーターの前提

- 壁面の既定値は絵コンテ (`絵コンテ.pptx`、レイアウト名「50cmメモリ」) の方眼から読み取りました:
  50cm = 63.49px → 画像 2500 × 352px = **19.69m × 2.77m**。インタラクション範囲 (紫) は 3.43〜6.92m と 12.36〜15.84m。
- 身長は日本の平均身長 (乳幼児身体発育調査・学校保健統計の男女平均) の概数、目の高さは頭身の比率から推定 (`simulator-figures.js`)。
- 目線の画角は 35mm 判換算の焦点距離で指定し、画面を 16:9 に固定して横 36mm を画面幅に対応させています。

## テスト用スクリプト

```bash
# テスト動画 (1920×1080, 4 本) を生成。codec: h264 | h264-10bit | hevc | prores
node scripts/make-test-videos.js test-videos h264 5

# GUI なしで書き出しし、各タイルが元素材の対応領域と一致するか PSNR で検証
node scripts/test-export.js test-videos/out.mp4 split-lr-stack test-videos/cam1_h264.mp4 test-videos/cam2_h264.mp4 test-videos/cam3_h264.mp4 test-videos/cam4_h264.mp4 [--quality=lossless] [--codec=hevc] [--hw=qsv] [--dry]

# overlay / 拡大縮小 / 単一タイル / プレビュー生成 の各経路を検証
node scripts/test-paths.js test-videos/cam1_h264.mp4 test-videos
```

### README のスクリーンショット

`docs/images/` の画像は、次のコマンドで撮り直せます (画面を変更したときに実行してください)。

```bash
node scripts/make-screenshots.js
```

- Full HD 4 本分のテストパターン (7680×1080、`scripts/make-test-pattern.js` で `test-videos/` に生成) を読み込み、
  「左右分割 → 上下に配置」を適用した状態で、レイアウト編集・書き出し・投影シミュレーターの 3 表示を撮影します。
- 撮影の手順は `scripts/screenshot-harness/main.js` にあります。ユーザー名などを含むパスが写らないよう、
  出力先は例のパスに置き換え、ステータスバーは「準備完了」にしてから撮ります。

### 開発用の環境変数

起動直後の状態を指定して画面を確認するためのものです (`MIR_APP_SCREENSHOT` を付けると画面を保存して終了します)。

| 変数 | 内容 |
|---|---|
| `MIR_APP_OPEN` | 起動時に読み込む動画 (`;` 区切り) |
| `MIR_APP_PRESET` | 適用するプリセット ID (`split-lr-stack` など。末尾 `!` でダイアログを開いたまま) |
| `MIR_APP_WS` | 開くタブ (`layout` / `simulator`) |
| `MIR_APP_TAB` | レイアウト編集の右パネルのタブ (`layout` / `export`) |
| `MIR_APP_SELECT` | 選択するタイル番号 |
| `MIR_APP_SIMVIEW` | シミュレーターの表示 (`elevation` / `eye` / `compare`) |
| `MIR_APP_PLAY` | 起動後に再生を開始する |
| `MIR_APP_SCREENSHOT` / `MIR_APP_SCREENSHOT_DELAY` | 画面を保存する PNG のパス / 保存までの待ち時間 (ms) |

## 構成

```
src/main/main.js             Electron メインプロセス (IPC・ダイアログ・書き出し管理・終了時の確認)
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
scripts/                     FFmpeg 取得・リリースノート生成・スクリーンショット・テスト用スクリプト
docs/images/                 README のスクリーンショット (scripts/make-screenshots.js で生成)
.github/workflows/build.yml  Windows / macOS のビルドと Release 作成
```
