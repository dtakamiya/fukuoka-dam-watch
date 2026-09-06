/*
 * fukuoka-dam-watch — フロントエンド
 *
 * wl-dam-04（現在値ビュー）の責務:
 *   - data/latest.json を fetch し、9ダム個別カード＋合計サマリを描画する
 *   - 前時点比（増減）は data/history.json の series 末尾2点の差分から算出する
 *     （latest.json 単体には前時点の値が無いため）
 *   - 最終更新の表示は latest.observedAt（毎正時の観測時刻）を使う。
 *     generatedAt は「データが最後に変化した時刻」なので最終更新には使わない。
 *   - 実データ取得に失敗したら data/*.sample.json にフォールバックし、
 *     「サンプルデータ表示中」バッジを出す
 *   - bootstrapping: true のときは時系列の蓄積状況を注記する
 *
 * wl-dam-05（推移グラフ）の責務:
 *   - data/history.json の series を Chart.js（CDN・1本）で折れ線描画する
 *   - 期間トグル 24h / 7d / 30d、指標トグル（貯水率 / 貯水量）、系列 on/off
 *     （既定は合計のみ）を提供する
 *   - bootstrapping 中で series が要求期間に満たないときは、ある分だけ描画し注記する
 */

"use strict";

// CSV の列順に合わせたダム定義（合計は別扱い）
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

/*
 * 貯水率の色分けしきい値（暫定）
 *   平常 rate >= 60 … 通常運用の目安
 *   注意 30 <= rate < 60 … 節水呼びかけ・監視を強める水準
 *   渇水 rate < 30 … 取水制限・減圧給水が現実味を帯びる水準
 * 根拠: 福岡市の渇水対応（取水制限の検討）は貯水率がおおむね 30% 前後で
 *       俎上に載ることが多く、60% を平常の下限の目安として置いた暫定値。
 *       正式なダム別の基準値が入手でき次第、ダム個別に置き換える。
 */
var RATE_NORMAL_MIN = 60;
var RATE_CAUTION_MIN = 30;

function rateClass(rate) {
  if (rate == null || isNaN(rate)) return "is-unknown";
  if (rate >= RATE_NORMAL_MIN) return "is-normal";
  if (rate >= RATE_CAUTION_MIN) return "is-caution";
  return "is-drought";
}

function rateLabel(rate) {
  if (rate == null || isNaN(rate)) return "不明";
  if (rate >= RATE_NORMAL_MIN) return "平常";
  if (rate >= RATE_CAUTION_MIN) return "注意";
  return "渇水";
}

// 数値を "12,345" 形式に
function fmtInt(n) {
  if (n == null || isNaN(n)) return "—";
  return Math.round(n).toLocaleString("ja-JP");
}

// 貯水率を "51.1%" 形式に（小数第1位まで）
function fmtRate(n) {
  if (n == null || isNaN(n)) return "—";
  return (Math.round(n * 10) / 10).toFixed(1) + "%";
}

// 増減を符号付き数値文字列に。unit は "千m³" or "pt"。
// 方向の矢印は付けない（向きは makeIndicator が形状アイコン＋色で別途示す）。
function fmtDelta(n, unit, digits) {
  if (n == null || isNaN(n)) return null;
  var rounded = digits ? Math.round(n * 10) / 10 : Math.round(n);
  if (rounded === 0) return "±0 " + unit;
  var body = digits ? Math.abs(rounded).toFixed(1) : fmtInt(Math.abs(rounded));
  return (rounded > 0 ? "+" : "-") + body + " " + unit;
}

/*
 * 「横ばい」と見なす増減のしきい値。
 *   貯水率 |Δrate| < 0.1pt … BODIK 公表の貯水率は小数第1位までの精度なので、
 *     0.1pt 未満の差は丸め・表記ゆれの範囲。方向を示す意味がないため横ばい扱い。
 *   貯水量 |Δstorage| < 1千m³ … 貯水量の公表値は 1千m³ 単位。1千m³ 未満は
 *     報告粒度を下回るため横ばい扱い。
 */
var FLAT_RATE_PT = 0.1;
var FLAT_STORAGE_KM3 = 1;

// 増減の向きを返す: "up" | "down" | "flat"（値が無ければ null）
function deltaDirection(n, kind) {
  if (n == null || isNaN(n)) return null;
  var flat = kind === "rate" ? FLAT_RATE_PT : FLAT_STORAGE_KM3;
  if (Math.abs(n) < flat) return "flat";
  return n > 0 ? "up" : "down";
}

var DIR_ICON = { up: "▲", down: "▼", flat: "→" };
var DIR_WORD = {
  storage: { up: "増加", down: "減少", flat: "横ばい" },
  rate: { up: "上昇", down: "下降", flat: "横ばい" }
};

// aria-label 用の読み上げ文言（"0.3ポイント" / "1,234千立方メートル"）
function spokenDelta(n, kind) {
  return kind === "rate"
    ? (Math.round(Math.abs(n) * 10) / 10).toFixed(1) + "ポイント"
    : fmtInt(Math.abs(n)) + "千立方メートル";
}

/*
 * 目立つ方向グリフを1つ生成して返す（大きな数字の隣に置く用）。
 *   - 形状アイコン（▲上昇 / ▼下降 / →横ばい）＋色（緑 / 赤 / グレー）＋差分の絶対値を表示
 *   - しきい値・色・文言は deltaDirection / DIR_ICON / DIR_WORD / spokenDelta を流用（重複実装しない）
 *   - 前時点比データが無ければ null を返す（詳細チップ行が "—" を出すのでグリフは省略）
 */
function makeDeltaGlyph(n, kind, metricLabel) {
  var dir = deltaDirection(n, kind);
  if (!dir) return null;

  var glyph = document.createElement("span");
  glyph.className = "delta-glyph is-" + dir;
  glyph.setAttribute("role", "img");

  var arrow = document.createElement("span");
  arrow.className = "delta-glyph-arrow";
  arrow.setAttribute("aria-hidden", "true");
  arrow.textContent = DIR_ICON[dir];

  var value = document.createElement("span");
  value.className = "delta-glyph-value";
  value.setAttribute("aria-hidden", "true");
  var unit = kind === "rate" ? "pt" : "千m³";
  value.textContent = dir === "flat"
    ? "±0" + unit
    : (kind === "rate"
        ? (Math.round(Math.abs(n) * 10) / 10).toFixed(1) + unit
        : fmtInt(Math.abs(n)) + unit);

  glyph.appendChild(arrow);
  glyph.appendChild(value);

  glyph.setAttribute(
    "aria-label",
    dir === "flat"
      ? metricLabel + " 横ばい 増減なし"
      : metricLabel + " " + DIR_WORD[kind][dir] + " " + spokenDelta(n, kind)
  );
  return glyph;
}

/*
 * 増減インジケータ（チップ）を1つ生成して返す。
 *   - 形状アイコン（▲上昇 / ▼下降 / →横ばい）＋色（緑 / 赤 / グレー）＋差分値を表示
 *   - 色だけに依存しないよう、チップ全体に「貯水率 上昇 0.3ポイント」等の aria-label を持たせ、
 *     アイコンは aria-hidden にしてスクリーンリーダーでの重複読みを防ぐ
 * kind: "storage" | "rate" / metricLabel: 画面表示名（"貯水量" / "貯水率"）
 */
function makeIndicator(n, kind, metricLabel) {
  var dir = deltaDirection(n, kind);
  var chip = document.createElement("span");
  chip.className = "delta-chip";
  // 非対話要素だが aria-label を確実に読み上げさせるため role="img" を付ける
  chip.setAttribute("role", "img");

  if (!dir) {
    chip.classList.add("is-flat");
    chip.textContent = metricLabel + " —";
    chip.setAttribute("aria-label", metricLabel + " の前時点比データなし");
    return chip;
  }
  chip.classList.add("is-" + dir);

  var unit = kind === "rate" ? "pt" : "千m³";
  var valueText = dir === "flat" ? "±0 " + unit : fmtDelta(n, unit, kind === "rate");

  var icon = document.createElement("span");
  icon.className = "delta-arrow";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = DIR_ICON[dir];

  var label = document.createElement("span");
  label.className = "delta-metric";
  label.textContent = metricLabel;

  var value = document.createElement("span");
  value.className = "delta-value";
  value.textContent = valueText;

  chip.appendChild(icon);
  chip.appendChild(label);
  chip.appendChild(value);

  if (dir === "flat") {
    chip.setAttribute("aria-label", metricLabel + " 横ばい 増減なし");
  } else {
    chip.setAttribute("aria-label", metricLabel + " " + DIR_WORD[kind][dir] + " " + spokenDelta(n, kind));
  }
  return chip;
}

// JST の ISO 文字列（+09:00 付き）を "2026-09-06 14:00 (JST)" に
function fmtObservedAt(iso) {
  if (!iso) return "—";
  var m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return String(iso);
  return m[1] + "-" + m[2] + "-" + m[3] + " " + m[4] + ":" + m[5] + " (JST)";
}

// history.series の末尾2点から key ごとの前時点比を作る
function buildDeltas(history) {
  var out = {};
  if (!history || !Array.isArray(history.series) || history.series.length < 2) {
    return out;
  }
  var prev = history.series[history.series.length - 2];
  var last = history.series[history.series.length - 1];
  function diff(bucket, k) {
    if (!last[bucket] || !prev[bucket]) return null;
    var a = last[bucket][k];
    var b = prev[bucket][k];
    if (a == null || b == null) return null;
    return a - b;
  }
  var keys = DAMS.map(function (d) { return d.key; }).concat(["total"]);
  keys.forEach(function (k) {
    out[k] = { storage: diff("storage", k), rate: diff("rate", k) };
  });
  return out;
}

function renderSummary(total, delta) {
  if (!total) return;
  var card = document.getElementById("summary-card");

  // 大きな貯水率の数字 ＋ その隣に前時点比の方向グリフ（合計サマリ）
  var rateEl = document.getElementById("summary-rate");
  rateEl.textContent = "";
  var rateNum = document.createElement("span");
  rateNum.className = "summary-rate-num";
  rateNum.textContent = fmtRate(total.rate);
  rateEl.appendChild(rateNum);
  var summaryGlyph = delta ? makeDeltaGlyph(delta.rate, "rate", "貯水率") : null;
  if (summaryGlyph) rateEl.appendChild(summaryGlyph);

  document.getElementById("summary-detail").textContent =
    "貯水量 " + fmtInt(total.storage) + " 千m³ ／ 総容量 " + fmtInt(total.capacity) + " 千m³";

  card.classList.remove("is-normal", "is-caution", "is-drought", "is-unknown");
  card.classList.add(rateClass(total.rate));

  var deltaEl = document.getElementById("summary-delta");
  deltaEl.textContent = "";
  if (delta && (delta.storage != null || delta.rate != null)) {
    var lead = document.createElement("span");
    lead.className = "delta-label";
    lead.textContent = "前時点比";
    deltaEl.appendChild(lead);
    deltaEl.appendChild(makeIndicator(delta.storage, "storage", "貯水量"));
    deltaEl.appendChild(makeIndicator(delta.rate, "rate", "貯水率"));
  } else {
    deltaEl.textContent = "前時点比 データなし";
  }
}

function renderDamList(dams, deltas) {
  var list = document.getElementById("dam-list");
  if (!list) return;
  list.innerHTML = "";
  var byKey = {};
  (dams || []).forEach(function (d) { byKey[d.key] = d; });

  var frag = document.createDocumentFragment();
  DAMS.forEach(function (def) {
    var d = byKey[def.key];
    var li = document.createElement("li");
    li.dataset.dam = def.key;
    li.classList.add(d ? rateClass(d.rate) : "is-unknown");

    var name = document.createElement("span");
    name.className = "dam-name";
    name.textContent = def.label;

    var badge = document.createElement("span");
    badge.className = "dam-badge";
    badge.textContent = d ? rateLabel(d.rate) : "—";

    // 大きな貯水率の数字 ＋ その隣に前時点比の方向グリフ（ダム別カード）
    var rateRow = document.createElement("div");
    rateRow.className = "dam-rate-row";
    var rate = document.createElement("span");
    rate.className = "dam-rate";
    rate.textContent = d ? fmtRate(d.rate) : "—";
    rateRow.appendChild(rate);
    var dd = deltas[def.key];
    var rateGlyph = d && dd ? makeDeltaGlyph(dd.rate, "rate", "貯水率") : null;
    if (rateGlyph) rateRow.appendChild(rateGlyph);

    var storage = document.createElement("span");
    storage.className = "dam-storage";
    storage.textContent = d
      ? "貯水量 " + fmtInt(d.storage) + " ／ 容量 " + fmtInt(d.capacity) + " 千m³"
      : "貯水量 —";

    var delta = document.createElement("span");
    delta.className = "dam-delta";
    if (dd && (dd.storage != null || dd.rate != null)) {
      var lead = document.createElement("span");
      lead.className = "delta-label";
      lead.textContent = "前時点比";
      delta.appendChild(lead);
      delta.appendChild(makeIndicator(dd.storage, "storage", "貯水量"));
      delta.appendChild(makeIndicator(dd.rate, "rate", "貯水率"));
    } else {
      delta.textContent = "前時点比 —";
    }

    var head = document.createElement("div");
    head.className = "dam-head";
    head.appendChild(name);
    head.appendChild(badge);

    li.appendChild(head);
    li.appendChild(rateRow);
    li.appendChild(storage);
    li.appendChild(delta);
    frag.appendChild(li);
  });
  list.appendChild(frag);
}

function renderStatus(state, latest) {
  var banner = document.getElementById("data-status");
  var text = document.getElementById("data-status-text");
  banner.classList.remove("is-ok", "is-warn", "is-error");

  if (state === "ok" || state === "sample") {
    banner.classList.add(state === "sample" ? "is-warn" : "is-ok");
    var srcName = latest && latest.source ? latest.source.name : "福岡市オープンデータ / BODIK";
    text.textContent =
      (state === "sample" ? "サンプルデータを表示中。" : "") +
      "データ取得元: " + srcName +
      "／観測時刻: " + fmtObservedAt(latest && latest.observedAt);
  } else {
    banner.classList.add("is-error");
    text.textContent = "データを取得できませんでした（実データ・サンプルとも読み込み失敗）。";
  }
}

function renderBootstrapNote(latest, history) {
  var el = document.getElementById("bootstrap-note");
  var isBootstrapping =
    (latest && latest.bootstrapping) || (history && history.bootstrapping);
  if (!isBootstrapping) {
    el.hidden = true;
    return;
  }
  var span = history && typeof history.spanDays === "number" ? history.spanDays : 0;
  var remain = Math.max(1, Math.ceil(30 - span));
  el.textContent =
    "時系列は蓄積中です（現在およそ " + (Math.round(span * 10) / 10) +
    " 日分・あと約 " + remain + " 日で30日分）。長期の推移グラフは順次充実します。";
  el.hidden = false;
}

function renderUpdatedLine(latest, usedSample) {
  var el = document.getElementById("updated-line");
  if (!latest) { el.textContent = ""; return; }
  el.textContent =
    "最終更新（観測時刻）: " + fmtObservedAt(latest.observedAt) +
    (usedSample ? "（サンプル）" : "");
}

// 実データ → 失敗時 sample の順で JSON を取得
function loadJson(realPath, samplePath) {
  return fetch(realPath, { cache: "no-store" })
    .then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json().then(function (data) { return { data: data, sample: false }; });
    })
    .catch(function () {
      return fetch(samplePath, { cache: "no-store" })
        .then(function (res) {
          if (!res.ok) throw new Error("HTTP " + res.status);
          return res.json().then(function (data) { return { data: data, sample: true }; });
        });
    });
}

/*
 * 自動更新（クライアント側）
 *   サーバ側は GitHub Actions が毎時データを更新する（README「自動更新」参照）。
 *   ページを開きっぱなしでも最新値が出るよう、以下の2契機で再取得する:
 *     - REFRESH_MS ごとの定期ポーリング
 *     - タブがバックグラウンドから復帰したとき（直近取得から一定時間空いていれば）
 *   再取得時はグラフのトグル状態（期間・指標・系列 on/off）を壊さないよう
 *   initChart（トグルの再バインド）は呼ばず、renderChart だけを更新する。
 */
var REFRESH_MS = 10 * 60 * 1000;          // 定期再取得の間隔
var VISIBILITY_MIN_GAP_MS = 2 * 60 * 1000; // タブ復帰で再取得する最小経過時間
var dataState = { loading: false, lastLoadAt: 0 };

function load(isRefresh) {
  if (dataState.loading) return;
  dataState.loading = true;
  Promise.all([
    loadJson("data/latest.json", "data/latest.sample.json"),
    loadJson("data/history.json", "data/history.sample.json")
  ]).then(function (results) {
    var latestRes = results[0];
    var historyRes = results[1];
    var latest = latestRes.data;
    var history = historyRes.data;
    var usedSample = latestRes.sample || historyRes.sample;

    var deltas = buildDeltas(history);
    renderStatus(usedSample ? "sample" : "ok", latest);
    document.getElementById("sample-badge").hidden = !usedSample;
    renderSummary(latest.total, deltas.total);
    renderDamList(latest.dams, deltas);
    renderBootstrapNote(latest, history);
    renderUpdatedLine(latest, usedSample);
    if (isRefresh) {
      chartState.history = history;
      renderChart();
    } else {
      initChart(history);
    }
    dataState.lastLoadAt = Date.now();
  }).catch(function (err) {
    // 初回のみエラー表示。再取得の一時失敗は現在の表示を維持する
    if (!isRefresh) renderStatus("error", null);
    if (window.console) console.error("[fukuoka-dam-watch] データ取得に失敗:", err);
  }).then(function () {
    dataState.loading = false;
  });
}

function init() {
  load(false);
  setInterval(function () { load(true); }, REFRESH_MS);
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible" &&
        Date.now() - dataState.lastLoadAt > VISIBILITY_MIN_GAP_MS) {
      load(true);
    }
  });
}

/* =====================================================================
 * wl-dam-05 — 推移グラフ（Chart.js / CDN 1本）
 * ===================================================================== */

// ダムごとの線色（合計は太めの濃色）。9ダム＋合計。
var SERIES_COLORS = {
  total: "#0b6e99",
  minamibata: "#e6550d",
  gokayama: "#31a354",
  sefuri: "#756bb1",
  magaribuchi: "#e377c2",
  egawa: "#c23b3b",
  kubara: "#2b8cbe",
  hase: "#8c6d31",
  ino: "#17becf",
  zuibaiji: "#d4a017"
};

var SERIES_KEYS = DAMS.map(function (d) { return d.key; }).concat(["total"]);
var SERIES_LABELS = { total: "9ダム合計" };
DAMS.forEach(function (d) { SERIES_LABELS[d.key] = d.label; });

// 期間ごとの「末尾から何点使うか」（毎正時＝1点/時）
var RANGE_POINTS = { "24h": 24, "7d": 24 * 7, "30d": 24 * 30 };

var chartState = {
  range: "30d",
  metric: "rate", // "rate" | "storage"
  visible: { total: true }, // 既定は合計のみ
  history: null,
  chart: null
};

// observedAt(+09:00) を軸ラベルへ。24h は "H時"、それ以上は "M/D"
function fmtAxisLabel(iso, range) {
  var m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return String(iso);
  if (range === "24h") return String(Number(m[4])) + "時";
  return String(Number(m[2])) + "/" + String(Number(m[3]));
}

// 現在の range に対応する series の抜粋（データが足りなければある分だけ）
function slicedSeries() {
  var all = (chartState.history && chartState.history.series) || [];
  var want = RANGE_POINTS[chartState.range] || all.length;
  return all.length > want ? all.slice(all.length - want) : all.slice();
}

function buildDatasets(rows) {
  var metric = chartState.metric;
  return SERIES_KEYS.filter(function (k) { return chartState.visible[k]; })
    .map(function (k) {
      var color = SERIES_COLORS[k] || "#888";
      return {
        label: SERIES_LABELS[k],
        data: rows.map(function (s) {
          return s[metric] && s[metric][k] != null ? s[metric][k] : null;
        }),
        borderColor: color,
        backgroundColor: color,
        borderWidth: k === "total" ? 2.5 : 1.5,
        pointRadius: rows.length > 48 ? 0 : 2,
        pointHoverRadius: 4,
        tension: 0.25,
        spanGaps: true
      };
    });
}

function renderChart() {
  if (typeof Chart === "undefined") {
    if (window.console) console.error("[fukuoka-dam-watch] Chart.js の読み込みに失敗");
    return;
  }
  var rows = slicedSeries();
  var labels = rows.map(function (s) { return fmtAxisLabel(s.observedAt, chartState.range); });
  var datasets = buildDatasets(rows);
  var isRate = chartState.metric === "rate";

  var data = { labels: labels, datasets: datasets };
  var options = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: { display: true, position: "bottom" },
      tooltip: {
        callbacks: {
          label: function (ctx) {
            var v = ctx.parsed.y;
            if (v == null) return ctx.dataset.label + ": —";
            return ctx.dataset.label + ": " + v + (isRate ? " %" : " 千m³");
          }
        }
      }
    },
    scales: {
      x: {
        ticks: {
          autoSkip: true,
          maxRotation: 0,
          maxTicksLimit: chartState.range === "24h" ? 12 : 10
        },
        grid: { display: false }
      },
      y: {
        beginAtZero: isRate,
        suggestedMin: isRate ? 0 : undefined,
        suggestedMax: isRate ? 100 : undefined,
        title: { display: true, text: isRate ? "貯水率 (%)" : "貯水量 (千m³)" }
      }
    }
  };

  if (chartState.chart) {
    chartState.chart.data = data;
    chartState.chart.options = options;
    chartState.chart.update();
  } else {
    var canvas = document.getElementById("trend-chart");
    if (!canvas) return;
    chartState.chart = new Chart(canvas.getContext("2d"), {
      type: "line",
      data: data,
      options: options
    });
  }

  // bootstrapping 中でデータが要求期間に満たない場合の注記
  var note = document.getElementById("chart-note");
  var all = (chartState.history && chartState.history.series) || [];
  var want = RANGE_POINTS[chartState.range] || all.length;
  if (all.length < want) {
    var haveH = all.length;
    note.textContent =
      "この期間はまだデータが不足しています（保有 " + haveH + " 時間分＝約 " +
      (Math.round(haveH / 24 * 10) / 10) + " 日）。取得済みの範囲だけを表示しています。";
    note.hidden = false;
  } else {
    note.hidden = true;
  }
}

function wireToggle(containerId, attr, apply) {
  var box = document.getElementById(containerId);
  if (!box) return;
  box.addEventListener("click", function (e) {
    var btn = e.target.closest("button[" + attr + "]");
    if (!btn) return;
    var buttons = box.querySelectorAll("button[" + attr + "]");
    buttons.forEach(function (b) { b.classList.toggle("is-active", b === btn); });
    apply(btn.getAttribute(attr));
    renderChart();
  });
}

function renderSeriesToggle() {
  var box = document.getElementById("series-toggle");
  if (!box) return;
  var legend = box.querySelector("legend");
  box.innerHTML = "";
  if (legend) box.appendChild(legend);

  SERIES_KEYS.forEach(function (k) {
    var id = "series-" + k;
    var label = document.createElement("label");
    label.className = "series-option";
    label.htmlFor = id;

    var cb = document.createElement("input");
    cb.type = "checkbox";
    cb.id = id;
    cb.checked = !!chartState.visible[k];
    cb.addEventListener("change", function () {
      if (cb.checked) chartState.visible[k] = true;
      else delete chartState.visible[k];
      renderChart();
    });

    var sw = document.createElement("span");
    sw.className = "series-swatch";
    sw.style.background = SERIES_COLORS[k] || "#888";

    var txt = document.createElement("span");
    txt.textContent = SERIES_LABELS[k];

    label.appendChild(cb);
    label.appendChild(sw);
    label.appendChild(txt);
    box.appendChild(label);
  });
}

function initChart(history) {
  chartState.history = history;
  renderSeriesToggle();
  wireToggle("range-toggle", "data-range", function (v) { chartState.range = v; });
  wireToggle("metric-toggle", "data-metric", function (v) { chartState.metric = v; });
  renderChart();
}

document.addEventListener("DOMContentLoaded", init);
