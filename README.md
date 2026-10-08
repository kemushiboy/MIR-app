# MIR-app

動画を **切り出し（分割）→ 再配置 → 1 本の動画として書き出す** Electron アプリです。FFmpeg を同梱しています。

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

## セットアップ

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

### 署名と公証 (任意)

署名なしでもビルドはできますが、配布先では次の警告が出ます。

- **Windows**: SmartScreen の「Windows によって PC が保護されました」→「詳細情報」→「実行」で起動できます。
- **macOS**: 署名・公証のないアプリは Gatekeeper にブロックされます。Finder でアプリを右クリック →「開く」、
  または「システム設定 → プライバシーとセキュリティ」で「このまま開く」を選びます。
  「壊れているため開けません」と表示される場合は、ターミナルで `xattr -dr com.apple.quarantine /Applications/MIR-app.app` を実行してください。

警告なしで配布するには、GitHub の Secrets (または手元の環境変数) に次を設定します。

| 用途 | Secrets 名 (Actions) | 手元でのビルド時の環境変数 |
|---|---|---|
| macOS 署名 (Developer ID Application 証明書 .p12 の base64 とパスワード) | `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD` | `CSC_LINK`, `CSC_KEY_PASSWORD` (キーチェーンに証明書があれば不要) |
| macOS 公証 | `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | 同名 |
| Windows 署名 (.pfx の base64 とパスワード) | `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD` | `CSC_LINK`, `CSC_KEY_PASSWORD` |

macOS では Hardened Runtime を有効にしてあり、同梱の ffmpeg / ffprobe もアプリと一緒に署名されます。

`npm run dist:dir` は現在の OS 向けに未パッケージのフォルダ (`dist/win-unpacked` など) だけを作ります。

## 使い方

1. **ソース動画を追加**: 「＋ 追加」またはウィンドウへドラッグ＆ドロップ。
   各ソースの「開始」に秒数を入れると、そのソースの再生開始位置をずらせます（複数カメラの同期合わせ）。
2. **レイアウトを作る**
   - 左の **プリセット** をクリック → ダイアログでプレビューを確認して「適用」。
   - 「カスタム分割配置…」: 列数・行数、断片の並べ方（縦に積む / 横に並べる / 元の位置）、
     ソース同士の並べ方（横 / 縦 / グリッド）を自由に組み合わせられます。
   - 各ソースの「分割…」で 1 本だけを分割して既存レイアウトに追加することもできます。
   - キャンバス上のタイルはドラッグで移動（他タイル・キャンバス端にスナップ）。矢印キーで 2px、Shift+矢印で 20px 移動。
   - 右パネルで選択タイルの切り出し範囲・配置先を数値で編集できます。切り出しプレビュー上でドラッグすると切り出し位置が動きます。
3. **確認**: 「実出力プレビュー」で、実際に書き出しに使う FFmpeg フィルタで 1 フレームを合成して表示します。
4. **書き出し**: 「書き出し」タブでコーデック等を確認し「書き出し開始」。
   実行される FFmpeg コマンドもそのまま表示・コピーできます。

レイアウトは「保存」で `.json` に保存できます。ソースのパスも保存されるので、同じ構成を別の素材で使う場合は
開いた後に各ソースの「差替」でファイルを入れ替えてください（タイル構成はそのまま残ります）。

### ショートカット

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
src/main/main.js      Electron メインプロセス (IPC・ダイアログ・書き出し管理)
src/main/preload.js   レンダラへ公開する API (contextIsolation)
src/main/ffmpeg.js    FFmpeg 実行 (probe / サムネイル / 機能検出 / 進捗付き書き出し)
src/main/command.js   レイアウト → FFmpeg フィルタグラフ・引数の生成 (純粋関数)
src/main/codecs.js    コーデック / エンコーダ / コンテナ / ピクセルフォーマットの対応と選択
src/renderer/         UI (index.html / style.css / app.js / presets.js)
scripts/              FFmpeg 取得・テスト用スクリプト
```

## ライセンスに関する注意

同梱している FFmpeg は libx264 / libx265 などを含む **GPL ビルド** です。このアプリを配布する場合は
GPL の条件（ソースコードの提供など）に従ってください。FFmpeg のライセンス文は `vendor/ffmpeg/*/LICENSE.txt` に、
取得元 URL は `SOURCE.txt` に保存されます。
