# Third-Party Notices / 同梱ソフトウェア

MIR-app (GPL-3.0-or-later) の配布物には、以下のソフトウェアが含まれています。

## FFmpeg

- 同梱物: `ffmpeg` / `ffprobe` 実行ファイル (アプリ内の `resources/ffmpeg/`)
- ライセンス: **GNU General Public License v3.0 以降**
  (`--enable-gpl --enable-version3` でビルドされた静的バイナリ。libx264 / libx265 / SVT-AV1 / libaom / libvpx などを含む)
- 著作権: FFmpeg developers および各ライブラリの著作者
- 公式サイト: https://ffmpeg.org/
- ソースコード: https://ffmpeg.org/download.html (Git: https://git.ffmpeg.org/ffmpeg.git)

同梱しているバイナリは次の第三者ビルドをそのまま使用しています。正確なバージョンと構成オプションは
`ffmpeg -version` で確認できます。各ビルドが使用したライブラリのソースとビルド手順は、それぞれの配布元で公開されています。

| 対象 | ビルド配布元 | ビルドスクリプト (ソース) |
|---|---|---|
| Windows x64 | https://github.com/BtbN/FFmpeg-Builds | https://github.com/BtbN/FFmpeg-Builds |
| macOS arm64 / x64 | https://ffmpeg.martin-riedl.de/ | https://git.martin-riedl.de/ffmpeg/build-script |

上記の入手先から対応するソースコードを取得できない場合は、本リポジトリの Issues でお知らせください。

## Electron / Chromium

- ライセンス: Electron は MIT License。Chromium と同梱ライブラリは各ライセンス
- 全文: アプリに同梱の `LICENSE.electron.txt` と `LICENSES.chromium.html`
- 公式サイト: https://www.electronjs.org/
- ソースコード: https://github.com/electron/electron
