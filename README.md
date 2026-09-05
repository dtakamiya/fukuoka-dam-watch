# fukuoka-dam-watch

福岡市関連9ダム（南畑・五ケ山・脊振・曲渕・江川・久原・長谷・猪野・瑞梅寺）の
**貯水量・貯水率を1時間粒度で可視化する静的サイト**。

福岡市のオープンデータ（BODIK 配信）を毎正時取得・正規化し、
9ダム個別＋合計の現在値と 24h / 7d / 30d の推移グラフを表示する。

## 状態

初期セットアップ中。サイト本体・データ取得パイプラインはこれから実装する
（`org/weekend-lab/backlog.json` の `wl-dam-01`〜 を参照）。

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
