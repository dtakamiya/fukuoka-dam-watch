#!/usr/bin/env node
/*
 * make-sample-data.mjs — フロント開発用のダミー JSON を生成する。
 *
 *   node scripts/make-sample-data.mjs
 *
 * data/latest.sample.json と data/history.sample.json を上書きする。
 * スキーマは fetch-dams.mjs の本番出力と同一。値は実データではなく、
 * 実在しうる範囲（利水容量以内）で緩やかに増減する合成値。
 * 実データ（data/latest.json / data/history.json）が無い状態でも
 * グラフ描画・現在値表示を作り込めるようにするのが目的。
 */

import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "data");
const UNIT = "千m3";

const DAMS = [
  { key: "minamibata", name: "南畑ダム", capacity: 3650, start: 2600, drift: -6 },
  { key: "gokayama", name: "五ケ山ダム", capacity: 31700, start: 17200, drift: -20 },
  { key: "sefuri", name: "脊振ダム", capacity: 3979, start: 3530, drift: -2 },
  { key: "magaribuchi", name: "曲渕ダム", capacity: 2368, start: 2090, drift: -3 },
  { key: "egawa", name: "江川ダム", capacity: 24000, start: 8500, drift: -12 },
  { key: "kubara", name: "久原ダム", capacity: 1460, start: 1195, drift: -1 },
  { key: "hase", name: "長谷ダム", capacity: 4850, start: 3590, drift: -1 },
  { key: "ino", name: "猪野ダム", capacity: 3650, start: 2605, drift: -1 },
  { key: "zuibaiji", name: "瑞梅寺ダム", capacity: 1220, start: 615, drift: -2 },
];
const TOTAL = { key: "total", name: "9ダム合計" };
const TOTAL_CAP = DAMS.reduce((n, d) => n + d.capacity, 0); // 76877

const HOURS = 35 * 24; // 35 日分・毎正時
const rate = (s, c) => Math.round((s / c) * 1000) / 10;

// 決定論的な擬似乱数（seed 固定で再現可能）
let seed = 20260906;
function rand() {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}

// 起点の観測時刻（末尾＝直近の正時）から HOURS 分さかのぼる
const endHour = new Date("2026-09-06T14:00:00+09:00").getTime();
const series = [];
const level = Object.fromEntries(DAMS.map((d) => [d.key, d.start + d.drift * HOURS]));

for (let i = 0; i < HOURS; i++) {
  const t = new Date(endHour - (HOURS - 1 - i) * 3600 * 1000);
  // JST ISO 文字列を組み立て
  const jst = new Date(t.getTime() + 9 * 3600 * 1000);
  const p = (n, w = 2) => String(n).padStart(w, "0");
  const observedAt =
    `${jst.getUTCFullYear()}-${p(jst.getUTCMonth() + 1)}-${p(jst.getUTCDate())}` +
    `T${p(jst.getUTCHours())}:${p(jst.getUTCMinutes())}:00+09:00`;

  const storage = {};
  let total = 0;
  for (const d of DAMS) {
    level[d.key] += -d.drift + (rand() - 0.45) * Math.max(2, d.capacity * 0.0006);
    const v = Math.max(0, Math.min(d.capacity, Math.round(level[d.key])));
    storage[d.key] = v;
    total += v;
  }
  storage[TOTAL.key] = total;

  const rateObj = {};
  for (const d of DAMS) rateObj[d.key] = rate(storage[d.key], d.capacity);
  rateObj[TOTAL.key] = rate(total, TOTAL_CAP);

  series.push({ observedAt, storage, rate: rateObj });
}

const generatedAt = "2026-09-06T05:00:00.000Z";
const capacities = Object.fromEntries([...DAMS.map((d) => [d.key, d.capacity]), [TOTAL.key, TOTAL_CAP]]);

const historySample = {
  generatedAt,
  unit: UNIT,
  retainDays: 40,
  bootstrapping: false,
  spanDays: Math.round(((HOURS - 1) / 24) * 10) / 10,
  _note: "SAMPLE / DUMMY DATA — フロント開発用の合成値。実データではない。",
  dams: [...DAMS.map((d) => ({ key: d.key, name: d.name })), { key: TOTAL.key, name: TOTAL.name }],
  capacities,
  series,
};

const last = series[series.length - 1];
const latestSample = {
  generatedAt,
  observedAt: last.observedAt,
  unit: UNIT,
  bootstrapping: false,
  _note: "SAMPLE / DUMMY DATA — フロント開発用の合成値。実データではない。",
  source: {
    name: "福岡市オープンデータ / BODIK 福岡市関連9ダム貯水量",
    dataset: "https://data.bodik.jp/dataset/d54fb22e-5b64-485c-8816-69f27ed1aaf1",
    attribution: "https://www.city.fukuoka.lg.jp/mizu/mizukanri/machi/002.html",
  },
  dams: DAMS.map((d) => ({
    key: d.key,
    name: d.name,
    storage: last.storage[d.key],
    capacity: d.capacity,
    rate: last.rate[d.key],
  })),
  total: {
    key: TOTAL.key,
    name: TOTAL.name,
    storage: last.storage[TOTAL.key],
    capacity: TOTAL_CAP,
    rate: last.rate[TOTAL.key],
  },
};

await mkdir(DATA_DIR, { recursive: true });
await writeFile(join(DATA_DIR, "history.sample.json"), JSON.stringify(historySample, null, 2) + "\n");
await writeFile(join(DATA_DIR, "latest.sample.json"), JSON.stringify(latestSample, null, 2) + "\n");
process.stderr.write(
  `[make-sample-data] history.sample.json (${series.length} 点 / ${historySample.spanDays} 日), latest.sample.json 生成\n`,
);
