# fukuoka-dam-watch

福岡市関連9ダム（南畑・五ケ山・脊振・曲渕・江川・久原・長谷・猪野・瑞梅寺）の
**貯水量・貯水率を1時間粒度で可視化する静的サイト**。

福岡市のオープンデータ（BODIK 配信）を毎正時取得・正規化し、
9ダム個別＋合計の現在値と 24h / 7d / 30d の推移グラフを表示する。

## 状態

サイト雛形（`wl-dam-01`）を配置済み。ヘッダ・9ダム名一覧・「データ未取得」プレースホルダ・
出典フッタのみの静的ページ。データ取得パイプライン（`wl-dam-02`）と推移グラフ（`wl-dam-03`）は未実装
（`org/weekend-lab/backlog.json` を参照）。

## 公開 URL（予定）

<https://dtakamiya.github.io/fukuoka-dam-watch/>

GitHub Pages（`main` ブランチのルート）で公開する想定。ルート直下に `index.html` と
`.nojekyll`（Jekyll 処理を無効化）を置いてある。Pages の有効化操作は別途行う。

## ローカル確認手順

ビルドステップはない。以下のいずれかで確認できる。

```sh
# 方法1: ファイルを直接開く
open index.html

# 方法2: 簡易 HTTP サーバ（相対パス・fetch を伴う後続タスクの確認向け）
python3 -m http.server 8000
# → http://localhost:8000/ をブラウザで開く
```

確認ポイント: ヘッダ「福岡市関連9ダム 貯水状況」／9ダム名＋「合計」のカード一覧／
「データ未取得」バナー／フッタの出典表記（福岡市オープンデータ / BODIK）が表示されること。
JS 構文チェックは `node --check assets/app.js`。

## スクリーンショット

![サイト雛形（wl-dam-01）](docs/screenshots/scaffold-site.png)

## 使用ライブラリ

- 推移グラフは **Chart.js**（CDN 参照・バンドラなし）を採用予定。ライブラリは1つに限定する。
  `wl-dam-03` で `assets/app.js` に実装する。

## データソース

| 項目 | 内容 |
| --- | --- |
| データセット | [福岡市関連9ダム貯水量（BODIK）](https://data.bodik.jp/dataset/d54fb22e-5b64-485c-8816-69f27ed1aaf1) |
| CSV | `https://data.bodik.jp/dataset/d54fb22e-5b64-485c-8816-69f27ed1aaf1/resource/a5b26052-26d1-4c7a-b63f-5736de453bc1/download/YYYYMMdata.csv` |
| 粒度 | 毎正時1時間ごと・当月分ローリング |
| 文字コード | Shift_JIS（BOMなし） |
| 列 | `観測日時, 南畑ダム, 五ケ山ダム, 脊振ダム, 曲渕ダム, 江川ダム, 久原ダム, 長谷ダム, 猪野ダム, 瑞梅寺ダム, 合計`（値は貯水量の整数） |
| 参考（出典表記用） | [福岡市「きょうのダム状況」](https://www.city.fukuoka.lg.jp/mizu/mizukanri/machi/002.html) |

- 貯水率は CSV に含まれないため、満水容量の定数から算出するか、
  同データセットの HTML リソース（`realtimelist.html`）を併用する。
- 月初は前月分 CSV も取得して 7d / 30d グラフの月境界を繋ぐ。
- 静的サイトからの直接 fetch は CORS と文字コードの都合で不可。
  GitHub Actions で毎正時 `CSV → UTF-8 JSON` に正規化してコミットし、
  サイトはその JSON を読む方式にする。

## 開発

週末ラボ（`~/.ryoko/org/weekend-lab/`）のプロダクト。土日の2枠で少しずつ進める。

## ライセンス

MIT（本リポジトリのコード）。ダムのデータは福岡市オープンデータの利用条件に従う。
