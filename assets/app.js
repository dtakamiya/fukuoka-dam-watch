/*
 * fukuoka-dam-watch — フロントエンド（デザイン提案 v1 反映）
 *
 * wl-dam-04（現在値ビュー）の責務:
 *   - data/latest.json を fetch し、9ダム個別カード＋合計サマリを描画する
 *   - 貯水率は SVG 円形リングゲージ（充填量＝貯水率・中央に数値）で可視化する（依存追加なし）
 *   - 合計サマリは「リング＋内訳セグメントバー（安全/注意/警戒/危険の本数）＋直近30日スパークライン」
 *   - 前時点比は貯水率のみ 1 系統に集約し、数値の下に「▲+0.2pt」相当を出す
 *     （前時点は latest.json 単体には無いため data/history.json の series 末尾2点の差分から算出）
 *   - 最終更新の表示は latest.observedAt（毎正時の観測時刻）を使う。
 *   - 実データ取得に失敗したら data/*.sample.json にフォールバックし、
 *     「サンプルデータ表示中」バッジを出す
 *   - bootstrapping: true のときは時系列の蓄積状況を注記する
 *
 * wl-dam-05（推移グラフ）の責務:
 *   - data/history.json の series を Chart.js（CDN・1本）で折れ線描画する
 *   - 期間トグル 24h / 7d / 30d、指標トグル（貯水率 / 貯水量）、系列 on/off（既定は合計のみ）
 *   - 貯水率表示時は背景にしきい値ゾーン帯（安全/注意/警戒/危険）を敷き、y 軸を 0–100 に固定、
 *     平常ライン（60%）を破線、末尾に現在値マーカーを打つ（プラグイン追加なし・自前の inline plugin）
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
 * 貯水率の色分けしきい値（4 段階・暫定）
 *   安全 rate >= 70 … 通常運用。特段の呼びかけは不要な水準
 *   注意 50 <= rate < 70 … 平常だが監視強化。降雨が少なければ下振れしやすい帯
 *   警戒 30 <= rate < 50 … 取水制限の検討ライン。節水呼びかけを強化
 *   危険 rate < 30 … 取水制限の強化・減圧給水が視野。強い節水要請
 *
 * 【仮値】境界値 70 / 50 / 30 は運用検討用のたたき台。
 *   福岡市の渇水対応（取水制限の検討）は貯水率がおおむね 30% 前後で俎上に載ることが多く、
 *   平常の下限を 60% としてきた従来値を、状況の温度差が出るよう 50 / 70 で二分した。
 *   正式なダム別の基準値が入手でき次第、ダム個別の値に置き換える。
 */
var RATE_SAFE_MIN = 70;
var RATE_WATCH_MIN = 50;
var RATE_ALERT_MIN = 30;

function rateClass(rate) {
  if (rate == null || isNaN(rate)) return "is-unknown";
  if (rate >= RATE_SAFE_MIN) return "is-safe";
  if (rate >= RATE_WATCH_MIN) return "is-watch";
  if (rate >= RATE_ALERT_MIN) return "is-alert";
  return "is-crit";
}

function rateLabel(rate) {
  if (rate == null || isNaN(rate)) return "不明";
  if (rate >= RATE_SAFE_MIN) return "安全";
  if (rate >= RATE_WATCH_MIN) return "注意";
  if (rate >= RATE_ALERT_MIN) return "警戒";
  return "危険";
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
 * 貯水率の円形リングゲージを SVG で生成して返す（依存追加なし）。
 *   size: "sm"（カード用 64px）/ "lg"（合計サマリ用 128px）
 *   リングの充填量 = 貯水率。色は rateClass に対応（CSS 側で track/prog を着色）。
 *   中央に貯水率の数値。色に依存しないよう aria-label に「貯水率 73.5%（安全）」を持たせる。
 */
function makeRing(rate, size) {
  var big = size === "lg";
  var box = big ? 128 : 64;
  var r = big ? 52 : 26;
  var sw = big ? 12 : 7;
  var c = 2 * Math.PI * r;
  var pct = (rate == null || isNaN(rate)) ? 0 : Math.max(0, Math.min(100, rate));
  var dash = (pct / 100) * c;

  var NS = "http://www.w3.org/2000/svg";
  var svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 " + box + " " + box);
  svg.setAttribute("width", String(box));
  svg.setAttribute("height", String(box));
  svg.setAttribute("class", "ring-svg " + rateClass(rate));
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "貯水率 " + fmtRate(rate) + "（" + rateLabel(rate) + "）");

  var mid = box / 2;
  var round1 = function (v) { return Math.round(v * 10) / 10; };

  var track = document.createElementNS(NS, "circle");
  track.setAttribute("cx", String(mid));
  track.setAttribute("cy", String(mid));
  track.setAttribute("r", String(r));
  track.setAttribute("fill", "none");
  track.setAttribute("stroke-width", String(sw));
  track.setAttribute("class", "ring-track");

  var prog = document.createElementNS(NS, "circle");
  prog.setAttribute("cx", String(mid));
  prog.setAttribute("cy", String(mid));
  prog.setAttribute("r", String(r));
  prog.setAttribute("fill", "none");
  prog.setAttribute("stroke-width", String(sw));
  prog.setAttribute("stroke-linecap", "round");
  prog.setAttribute("class", "ring-prog");
  prog.setAttribute("stroke-dasharray", round1(dash) + " " + round1(c));
  prog.setAttribute("transform", "rotate(-90 " + mid + " " + mid + ")");

  var text = document.createElementNS(NS, "text");
  text.setAttribute("x", String(mid));
  text.setAttribute("y", String(mid));
  text.setAttribute("text-anchor", "middle");
  text.setAttribute("dominant-baseline", "central");
  text.setAttribute("class", "ring-text");
  text.setAttribute("font-size", String(big ? 30 : 15));
  text.textContent = (rate == null || isNaN(rate))
    ? "—"
    : (Math.round(rate * 10) / 10).toFixed(1);

  svg.appendChild(track);
  svg.appendChild(prog);
  svg.appendChild(text);
  return svg;
}

/*
 * 前時点比を 1 系統に集約した表示（貯水率のみ）。
 *   「前時点比 ▲ +0.2pt」を出す。向きは形状（▲▼→）＋色。
 *   色に依存しないよう要素全体に aria-label（"前時点比 貯水率 上昇 0.2ポイント" 等）を持たせ、
 *   アイコンは aria-hidden にしてスクリーンリーダーでの重複読みを防ぐ。
 *   前時点比データが無ければ「前時点比 —」。
 */
function makeDeltaLine(deltaRate) {
  var el = document.createElement("span");
  el.className = "delta-line";
  el.setAttribute("role", "img");

  var lead = document.createElement("span");
  lead.className = "delta-line-lead";
  lead.textContent = "前時点比";
  el.appendChild(lead);

  var dir = deltaDirection(deltaRate, "rate");
  if (!dir) {
    el.classList.add("is-flat");
    el.appendChild(document.createTextNode(" —"));
    el.setAttribute("aria-label", "前時点比 貯水率のデータなし");
    return el;
  }
  el.classList.add("is-" + dir);

  var icon = document.createElement("span");
  icon.className = "delta-line-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = DIR_ICON[dir];

  var val = document.createElement("span");
  val.className = "delta-line-val";
  val.textContent = dir === "flat"
    ? "±0pt"
    : (deltaRate > 0 ? "+" : "-") + (Math.round(Math.abs(deltaRate) * 10) / 10).toFixed(1) + "pt";

  el.appendChild(icon);
  el.appendChild(val);
  el.setAttribute(
    "aria-label",
    dir === "flat"
      ? "前時点比 貯水率 横ばい 増減なし"
      : "前時点比 貯水率 " + DIR_WORD.rate[dir] + " " + spokenDelta(deltaRate, "rate")
  );
  return el;
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

/*
 * 9ダム内訳のセグメントバー（安全/注意/警戒/危険の本数）を描画する。
 */
function renderBreakdown(dams) {
  var host = document.getElementById("summary-breakdown");
  if (!host) return;
  host.innerHTML = "";

  var order = ["is-safe", "is-watch", "is-alert", "is-crit"];
  var labels = { "is-safe": "安全", "is-watch": "注意", "is-alert": "警戒", "is-crit": "危険" };
  var counts = { "is-safe": 0, "is-watch": 0, "is-alert": 0, "is-crit": 0, "is-unknown": 0 };
  (dams || []).forEach(function (d) { counts[rateClass(d.rate)]++; });
  var denom = (dams || []).length || 1;

  var bar = document.createElement("div");
  bar.className = "breakdown-bar";
  bar.setAttribute("role", "img");
  bar.setAttribute(
    "aria-label",
    "9ダム内訳 " + order.map(function (k) { return labels[k] + counts[k]; }).join(" ")
  );
  order.forEach(function (k) {
    if (!counts[k]) return;
    var seg = document.createElement("span");
    seg.className = "breakdown-seg " + k;
    seg.style.width = (counts[k] / denom * 100) + "%";
    bar.appendChild(seg);
  });

  var cap = document.createElement("div");
  cap.className = "breakdown-cap";
  order.forEach(function (k) {
    var item = document.createElement("span");
    item.className = "breakdown-cap-item " + k;
    var dot = document.createElement("i");
    dot.className = "breakdown-dot";
    item.appendChild(dot);
    item.appendChild(document.createTextNode(labels[k] + " " + counts[k]));
    cap.appendChild(item);
  });

  host.appendChild(bar);
  host.appendChild(cap);
}

/*
 * 合計貯水率の直近30日スパークライン（SVG・依存追加なし）を描画する。
 *   history.series の rate.total を末尾から最大 30 日分（720 点）取り、正規化して折れ線に。
 */
function renderSparkline(history) {
  var host = document.getElementById("summary-sparkline");
  if (!host) return;
  host.innerHTML = "";

  var series = (history && history.series) || [];
  var pts = series.slice(-24 * 30)
    .map(function (s) { return s.rate && s.rate.total != null ? s.rate.total : null; })
    .filter(function (v) { return v != null; });
  if (pts.length < 2) { host.hidden = true; return; }
  host.hidden = false;

  var w = 200, h = 40, pad = 3;
  var min = Math.min.apply(null, pts);
  var max = Math.max.apply(null, pts);
  var span = (max - min) || 1;
  var coords = pts.map(function (v, i) {
    var x = pad + (i / (pts.length - 1)) * (w - pad * 2);
    var y = pad + (1 - (v - min) / span) * (h - pad * 2);
    return (Math.round(x * 10) / 10) + "," + (Math.round(y * 10) / 10);
  }).join(" ");

  var NS = "http://www.w3.org/2000/svg";
  var svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 " + w + " " + h);
  svg.setAttribute("width", String(w));
  svg.setAttribute("height", String(h));
  svg.setAttribute("class", "sparkline-svg");
  svg.setAttribute("role", "img");
  svg.setAttribute(
    "aria-label",
    "直近30日の合計貯水率の推移（" + fmtRate(pts[0]) + " → " + fmtRate(pts[pts.length - 1]) + "）"
  );
  var poly = document.createElementNS(NS, "polyline");
  poly.setAttribute("fill", "none");
  poly.setAttribute("stroke-width", "2");
  poly.setAttribute("stroke-linecap", "round");
  poly.setAttribute("stroke-linejoin", "round");
  poly.setAttribute("class", "sparkline-path");
  poly.setAttribute("points", coords);
  svg.appendChild(poly);

  var cap = document.createElement("span");
  cap.className = "sparkline-cap";
  cap.setAttribute("aria-hidden", "true");
  cap.textContent = "直近30日（" + fmtRate(pts[0]) + " → " + fmtRate(pts[pts.length - 1]) + "）";

  host.appendChild(svg);
  host.appendChild(cap);
}

function renderSummary(total, delta, dams, history) {
  if (!total) return;
  var card = document.getElementById("summary-card");

  var ringHost = document.getElementById("summary-ring");
  ringHost.innerHTML = "";
  ringHost.appendChild(makeRing(total.rate, "lg"));
  var status = document.createElement("span");
  status.className = "summary-status";
  status.textContent = rateLabel(total.rate);
  ringHost.appendChild(status);

  document.getElementById("summary-detail").textContent =
    "貯水量 " + fmtInt(total.storage) + " 千m³ ／ 総容量 " + fmtInt(total.capacity) + " 千m³";

  card.classList.remove("is-safe", "is-watch", "is-alert", "is-crit", "is-unknown");
  card.classList.add(rateClass(total.rate));

  var deltaEl = document.getElementById("summary-delta");
  deltaEl.textContent = "";
  deltaEl.appendChild(makeDeltaLine(delta ? delta.rate : null));

  renderBreakdown(dams);
  renderSparkline(history);
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
    var rate = d ? d.rate : null;

    var li = document.createElement("li");
    li.dataset.dam = def.key;
    li.classList.add(rateClass(rate));

    // ヘッダ: ダム名 ＋ ステータスバッジ
    var head = document.createElement("div");
    head.className = "dam-head";
    var name = document.createElement("span");
    name.className = "dam-name";
    name.textContent = def.label;
    var badge = document.createElement("span");
    badge.className = "dam-badge";
    badge.textContent = d ? rateLabel(rate) : "—";
    head.appendChild(name);
    head.appendChild(badge);

    // 本体: リング（左）＋ 詳細（右）
    var body = document.createElement("div");
    body.className = "dam-body";

    var ringWrap = document.createElement("span");
    ringWrap.className = "dam-ring";
    ringWrap.appendChild(makeRing(rate, "sm"));

    var meta = document.createElement("div");
    meta.className = "dam-meta";
    var dd = deltas[def.key];
    meta.appendChild(makeDeltaLine(d && dd ? dd.rate : null));
    var sub = document.createElement("span");
    sub.className = "dam-sub";
    sub.textContent = d
      ? "貯水量 " + fmtInt(d.storage) + " ／ 容量 " + fmtInt(d.capacity) + " 千m³"
      : "貯水量 —";
    meta.appendChild(sub);

    body.appendChild(ringWrap);
    body.appendChild(meta);

    li.appendChild(head);
    li.appendChild(body);
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
    renderSummary(latest.total, deltas.total, latest.dams, history);
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

// CSS カスタムプロパティを読む（テーマ差し替えに追従させるため描画時に都度取得）
function cssVar(name, fallback) {
  var v = getComputedStyle(document.documentElement).getPropertyValue(name);
  return (v && v.trim()) || fallback;
}

// ダムごとの線色（合計は描画時に --accent を読む）。9ダム＋合計。
var SERIES_COLORS = {
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

/*
 * しきい値ゾーン帯プラグイン（プラグイン“追加”ではなく自前の inline plugin）。
 *   貯水率表示のときだけ、プロット領域の背景に安全/注意/警戒/危険の帯を敷き、
 *   平常ライン（60%）を破線で引く。色は CSS 変数を都度読むのでダークモードにも追従。
 */
var thresholdZonesPlugin = {
  id: "thresholdZones",
  beforeDatasetsDraw: function (chart) {
    if (chartState.metric !== "rate") return;
    var y = chart.scales.y;
    var x = chart.scales.x;
    if (!y || !x) return;
    var ctx = chart.ctx;
    var left = x.left;
    var width = x.right - x.left;

    var zones = [
      [RATE_SAFE_MIN, 100, cssVar("--safe-bg", "#e7f5ec")],
      [RATE_WATCH_MIN, RATE_SAFE_MIN, cssVar("--watch-bg", "#fbf1dc")],
      [RATE_ALERT_MIN, RATE_WATCH_MIN, cssVar("--alert-bg", "#fbe9db")],
      [0, RATE_ALERT_MIN, cssVar("--crit-bg", "#f9e3e1")]
    ];

    ctx.save();
    zones.forEach(function (z) {
      var top = y.getPixelForValue(z[1]);
      var bottom = y.getPixelForValue(z[0]);
      ctx.fillStyle = z[2];
      ctx.fillRect(left, top, width, bottom - top);
    });
    // 平常ライン 60%
    var y60 = y.getPixelForValue(60);
    ctx.strokeStyle = cssVar("--text-muted", "#5c6b7a");
    ctx.globalAlpha = 0.55;
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(left, y60);
    ctx.lineTo(left + width, y60);
    ctx.stroke();
    ctx.restore();
  }
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
  var accent = cssVar("--accent", "#0b6e99");
  var surface = cssVar("--surface", "#ffffff");
  return SERIES_KEYS.filter(function (k) { return chartState.visible[k]; })
    .map(function (k) {
      var isTotal = k === "total";
      var color = isTotal ? accent : (SERIES_COLORS[k] || "#888");
      var lastIdx = rows.length - 1;
      return {
        label: SERIES_LABELS[k],
        data: rows.map(function (s) {
          return s[metric] && s[metric][k] != null ? s[metric][k] : null;
        }),
        borderColor: color,
        backgroundColor: color,
        borderWidth: isTotal ? 2.6 : 1.5,
        // 末尾に現在値マーカー（合計系列のみ最終点を大きく）
        pointRadius: rows.map(function (_v, i) {
          if (isTotal && i === lastIdx) return 5;
          return rows.length > 48 ? 0 : 2;
        }),
        pointBackgroundColor: color,
        pointBorderColor: surface,
        pointBorderWidth: isTotal ? 2 : 1,
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
  var gridColor = cssVar("--border", "#dde4ea");
  var tickColor = cssVar("--text-muted", "#5c6b7a");
  var textColor = cssVar("--text", "#1b2733");

  var data = { labels: labels, datasets: datasets };
  var options = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: { display: true, position: "bottom", labels: { color: textColor } },
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
          color: tickColor,
          autoSkip: true,
          maxRotation: 0,
          maxTicksLimit: chartState.range === "24h" ? 12 : 10
        },
        grid: { display: false }
      },
      y: {
        // 貯水率は 0–100 に固定してしきい値ゾーンと目盛りを安定させる
        min: isRate ? 0 : undefined,
        max: isRate ? 100 : undefined,
        beginAtZero: isRate,
        ticks: { color: tickColor },
        grid: { color: gridColor },
        title: { display: true, color: tickColor, text: isRate ? "貯水率 (%)" : "貯水量 (千m³)" }
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
      options: options,
      plugins: [thresholdZonesPlugin]
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
    sw.style.background = k === "total" ? cssVar("--accent", "#0b6e99") : (SERIES_COLORS[k] || "#888");

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
