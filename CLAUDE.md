# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

福岡市関連9ダムの貯水量・貯水率を可視化する静的サイト（GitHub Pages・`main` ルート配信）。詳細仕様は `README.md` が正。

## コマンド

ビルドステップ・package.json・依存パッケージは無い（Node 18+ 標準モジュールのみ、CI は Node 22.11.0）。

```sh
python3 -m http.server 8000                 # ローカル確認 → http://localhost:8000/
node --check assets/app.js                  # フロント JS の構文チェック（lint/typecheck の代わり）
node --test scripts/history-retention.test.mjs   # テスト（現状これが唯一のテスト）
node --test --test-name-pattern "<名前>" scripts/history-retention.test.mjs  # 単一テスト
node scripts/fetch-dams.mjs                 # BODIK CSV → data/latest.json・history.json を生成/追記
node scripts/fetch-weather.mjs              # Open-Meteo → data/weather.json
node scripts/make-sample-data.mjs           # data/*.sample.json（フロント開発用ダミー）を再生成
```

`fetch-dams.mjs` のオフライン/テスト用 env: `FETCH_DAMS_LOCAL_DIR`（`<dir>/YYYYMMdata.csv` を読む）、`FETCH_DAMS_BASE_URL`、`FETCH_DAMS_RETAIN_DAYS`（既定400）、`FETCH_DAMS_HOURLY_DAYS`（既定35）。

## アーキテクチャ

データ生成（Node スクリプト）とフロント（素の HTML/CSS/JS）が `data/*.json` だけで疎結合になっている。

- **データパイプライン**: `.github/workflows/update-data.yml` が `fetch-dams.mjs` → `fetch-weather.mjs`（`continue-on-error`）を実行し、差分があるときだけ bot がコミット。
  - トリガーは2系統: 主はローカル Mac の launchd（`scripts/dispatch-update-data.sh` が `gh workflow run` で dispatch、plist も `scripts/` に追跡）、保険が GitHub `schedule`。
  - BODIK の CSV は **常に当月分のローリングのみ**（過去月 URL なし）。よって `history.json` は毎回既存ファイルに追記して自前で累積する。
  - 失敗時は既存 JSON を書き換えず exit 1。成功時は一時ファイル経由で原子的に差し替え。観測値が変わらなければファイルも変えない（無駄コミット防止）。
- **保持ポリシー**: `scripts/history-retention.mjs` の `applyRetention()` を `fetch-dams.mjs` と `make-sample-data.mjs` が共用。直近35日は毎正時、それ以前400日までは JST 暦日1点（12:00最寄り）。冪等であることが前提。
- **貯水率**: 利水容量の定数テーブル（`fetch-dams.mjs` の `DAMS[].capacity`）で算出。改訂時は README の表と両方更新。
- **フロント**: `index.html` + `assets/app.js`（ES5 風 `var`/`function`、モジュールなし、単一ファイル）+ `assets/style.css`。外部依存は CDN の Chart.js 1本のみに限定。
  - `app.js` 前半が現在値ビュー（`load()` / `render*`）、後半 `wl-dam-05` セクションが推移グラフ（`initChart` / `renderChart`）。
  - 実データ取得失敗時は `data/*.sample.json` にフォールバック（バッジ表示）。天気は失敗しても天気欄を隠すだけ。
  - 期間切り出しは点数でなく最新観測からの時刻差。90日/1年は `aggregateDaily()` で1日1点に集約。
  - 10分ごと・タブ復帰時に再取得。`withCacheBuster()` で data に `?t=` 付与。
- 実データ `data/latest.json` / `history.json` / `weather.json` は `.gitignore` 対象（CI が `git add -f`）。ローカルでコミットしない。`*.sample.json` のみ手動管理。

## 必須ルール

- **`assets/app.js` か `assets/style.css` を変えたら `index.html` の `?v=YYYYMMDD`（2か所）を必ず更新**。怠ると Pages のキャッシュで新旧版ズレ → 描画例外が起きる（過去事故あり）。
- **`git clean -fd` を無条件に実行しない**（未追跡の運用ファイル消失で launchd が停止した事故あり）。先に `git clean -nd` で確認。運用に必要なファイルは Git 管理下に置く。
- しきい値 70/50/30% は公的根拠のない表示用の仮値（`app.js` の `RATE_*_MIN`）。
- UI 変更時はライト/ダーク（`prefers-color-scheme`）とスマホ幅（`<= 540px`）の両方で確認する。
