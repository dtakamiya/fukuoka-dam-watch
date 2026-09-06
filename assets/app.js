/*
 * fukuoka-dam-watch — フロントエンド
 *
 * wl-dam-01（雛形）時点の責務:
 *   - 9ダム＋合計の名前一覧を描画する
 *   - データ未取得のプレースホルダ表示を保つ
 *
 * 後続タスクの予定:
 *   - wl-dam-02: GitHub Actions が正規化した data/latest.json 等を fetch して現在値を埋める
 *   - wl-dam-03: 推移グラフ（24h / 7d / 30d）を #chart に描画する
 *       採用予定ライブラリ: Chart.js（CDN 参照 / バンドラなし）
 *       例: <script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
 *       ライブラリは1つだけに保つこと。
 */

"use strict";

// CSV の列順に合わせたダム定義（合計は is-total として別扱い）
var DAMS = [
  { key: "minamibata", label: "南畑ダム" },
  { key: "gokayama", label: "五ケ山ダム" },
  { key: "sefuri", label: "脊振ダム" },
  { key: "magaribuchi", label: "曲渕ダム" },
  { key: "egawa", label: "江川ダム" },
  { key: "kubara", label: "久原ダム" },
  { key: "hase", label: "長谷ダム" },
  { key: "ino", label: "猪野ダム" },
  { key: "zuibaiji", label: "瑞梅寺ダム" }
];

var TOTAL = { key: "total", label: "合計" };

function renderDamList() {
  var list = document.getElementById("dam-list");
  if (!list) return;

  var entries = DAMS.concat([TOTAL]);
  var frag = document.createDocumentFragment();

  entries.forEach(function (dam) {
    var li = document.createElement("li");
    li.dataset.dam = dam.key;
    if (dam.key === "total") li.classList.add("is-total");

    var name = document.createElement("span");
    name.className = "dam-name";
    name.textContent = dam.label;

    var value = document.createElement("span");
    value.className = "dam-value";
    value.textContent = "貯水量 —／貯水率 —";

    li.appendChild(name);
    li.appendChild(value);
    frag.appendChild(li);
  });

  list.appendChild(frag);
}

// TODO(wl-dam-02): data/*.json を fetch して各 li の .dam-value と #data-status を更新する
// function loadLatest() { ... }

// TODO(wl-dam-03): Chart.js（CDN）で #chart に 24h / 7d / 30d の推移を描画する
// function renderChart(series) { ... }

document.addEventListener("DOMContentLoaded", function () {
  renderDamList();
});
