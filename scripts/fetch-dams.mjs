#!/usr/bin/env node
/*
 * fetch-dams.mjs — 福岡市関連9ダム 貯水量CSV → 正規化JSON
 *
 * BODIK 配信の当月＋前月 CSV（Shift_JIS / 毎正時1時間粒度 / 当月ローリング）を
 * 取得・デコードし、既存の data/history.json に累積マージして
 * data/latest.json（最新1時点）と data/history.json（直近 RETAIN_DAYS 日の時系列）を生成する。
 *
 * ■ データ源の制約（重要）
 *   BODIK の CSV リソースはファイル名の YYYYMM 接頭辞を無視し、常に「当月分の
 *   ローリングファイル」（月初〜現在時刻、毎正時）だけを返す。過去月のアーカイブは無い。
 *   そのため 35 日分の時系列は 1 回の取得では得られない。本スクリプトは毎正時実行で
 *   取得した最新時間を既存 history.json に追記し、時系列を自前で累積させる設計。
 *   初回〜数日は 35 日に満たない（bootstrapping フラグで示す）。
 *
 * 依存ゼロ（Node 標準モジュールのみ / Node 18+ の TextDecoder shift_jis を使用）。
 *
 * 使い方:
 *   node scripts/fetch-dams.mjs
 *
 * 環境変数（主に CI・デバッグ用）:
 *   FETCH_DAMS_LOCAL_DIR=<dir>   HTTP 取得の代わりに <dir>/YYYYMMdata.csv を読む（オフライン擬似実行）
 *   FETCH_DAMS_BASE_URL=<url>    CSV ダウンロード URL のベースを差し替える（失敗系テスト用）
 *   FETCH_DAMS_RETAIN_DAYS=<n>   history.json に残す日数（既定 40。最低 35 を確保する要件）
 *
 * 失敗時の挙動:
 *   当月 CSV の取得・デコード・パースで失敗したら、既存の data/*.json を一切書き換えず
 *   理由を stderr に出して exit 1。成功時のみ tmp ファイル経由で原子的に差し替える。
 *   前月 CSV の欠落や既存 history.json の破損は警告のみで続行する。
 */

import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const DATA_DIR = join(REPO_ROOT, "data");

const BASE_URL =
  process.env.FETCH_DAMS_BASE_URL ||
  "https://data.bodik.jp/dataset/d54fb22e-5b64-485c-8816-69f27ed1aaf1/resource/a5b26052-26d1-4c7a-b63f-5736de453bc1/download";
const LOCAL_DIR = process.env.FETCH_DAMS_LOCAL_DIR || null;
const RETAIN_DAYS = Number(process.env.FETCH_DAMS_RETAIN_DAYS || 40);

const UNIT = "千m3"; // BODIK 原資料の単位（千立方メートル）

/*
 * ダム定義。CSV の列順どおり。capacity は「利水容量」（単位: 千m3）。
 * 出典: BODIK 同データセットの HTML リソース realtime-list.html
 *   https://data.bodik.jp/dataset/d54fb22e-5b64-485c-8816-69f27ed1aaf1/resource/68982ce3-1c11-49df-b084-3a1049673bdf/download/realtime-list.html
 * この利水容量を分母にすると、福岡市水道局が公表する「9ダム合計貯水率」と一致する
 * （2026-09-06 14:00 時点: 合計 39,268 / 76,877 = 51.1% ← 公表値 51.1% と一致）。
 */
const DAMS = [
  { key: "minamibata", name: "南畑ダム", csvHeader: "南畑ダム", capacity: 3650 },
  { key: "gokayama", name: "五ケ山ダム", csvHeader: "五ケ山ダム", capacity: 31700 },
  { key: "sefuri", name: "脊振ダム", csvHeader: "脊振ダム", capacity: 3979 },
  { key: "magaribuchi", name: "曲渕ダム", csvHeader: "曲渕ダム", capacity: 2368 },
  { key: "egawa", name: "江川ダム", csvHeader: "江川ダム", capacity: 24000 },
  { key: "kubara", name: "久原ダム", csvHeader: "久原ダム", capacity: 1460 },
  { key: "hase", name: "長谷ダム", csvHeader: "長谷ダム", capacity: 4850 },
  { key: "ino", name: "猪野ダム", csvHeader: "猪野ダム", capacity: 3650 },
  { key: "zuibaiji", name: "瑞梅寺ダム", csvHeader: "瑞梅寺ダム", capacity: 1220 },
];
const TOTAL = { key: "total", name: "9ダム合計", csvHeader: "合計", capacity: 76877 };
const ALL = [...DAMS, TOTAL];

class FetchDamsError extends Error {}

function log(msg) {
  process.stderr.write(`[fetch-dams] ${msg}\n`);
}

/** 当月・前月の "YYYYMM" を返す（JST 基準）。 */
function targetMonths(now = new Date()) {
  // JST に寄せる（実行環境の TZ に依存しないよう UTC+9 で計算）
  const jst = new Date(now.getTime() + 9 * 3600 * 1000);
  const cur = new Date(Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), 1));
  const prev = new Date(Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth() - 1, 1));
  return [prev, cur].map((d) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
}

async function loadCsvBytes(month) {
  const filename = `${month}data.csv`;
  if (LOCAL_DIR) {
    const path = join(LOCAL_DIR, filename);
    if (!existsSync(path)) throw new FetchDamsError(`ローカルCSVが見つかりません: ${path}`);
    log(`ローカル読み込み: ${path}`);
    return new Uint8Array(await readFile(path));
  }
  const url = `${BASE_URL}/${filename}`;
  log(`取得: ${url}`);
  let res;
  try {
    res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(30000) });
  } catch (e) {
    throw new FetchDamsError(`取得失敗 (${url}): ${e.message}`);
  }
  if (!res.ok) throw new FetchDamsError(`取得失敗 (${url}): HTTP ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.length === 0) throw new FetchDamsError(`取得失敗 (${url}): 空レスポンス`);
  return buf;
}

function decodeShiftJis(bytes, label) {
  let text;
  try {
    text = new TextDecoder("shift_jis", { fatal: false }).decode(bytes);
  } catch (e) {
    throw new FetchDamsError(`Shift_JIS デコード不可 (${label}): ${e.message}`);
  }
  if (text.includes("�") && text.replace(/[^�]/g, "").length > text.length * 0.05) {
    throw new FetchDamsError(`Shift_JIS デコード結果が壊れています (${label})`);
  }
  return text;
}

/** "2026/09/06 14:00" (JST) → ISO 8601 "2026-09-06T14:00:00+09:00" と数値キー。 */
function parseObservedAt(raw) {
  const m = raw.trim().match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  const pad = (s, n = 2) => String(s).padStart(n, "0");
  const iso = `${y}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:00+09:00`;
  const epoch = Date.parse(iso);
  if (Number.isNaN(epoch)) return null;
  return { iso, epoch };
}

/**
 * CSV テキストをパースして観測レコード配列にする。
 * 返り値: [{ epoch, observedAt, storage: {key:number} }]
 */
function parseCsv(text, label) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length < 2) throw new FetchDamsError(`CSV が空です (${label})`);

  const header = lines[0].split(",").map((s) => s.trim());
  // 観測時刻列 + 各ダム列のインデックスを解決
  const timeIdx = header.findIndex((h) => h === "観測時刻" || h === "観測日時");
  if (timeIdx === -1) throw new FetchDamsError(`観測時刻列が見つかりません (${label}): ${lines[0]}`);
  const colIdx = {};
  for (const dam of ALL) {
    const idx = header.findIndex((h) => h === dam.csvHeader);
    if (idx === -1) throw new FetchDamsError(`列「${dam.csvHeader}」が見つかりません (${label}): ${lines[0]}`);
    colIdx[dam.key] = idx;
  }

  const records = [];
  let skipped = 0;
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(",");
    const ts = parseObservedAt(cells[timeIdx] ?? "");
    if (!ts) {
      skipped++;
      continue;
    }
    const storage = {};
    let bad = false;
    for (const dam of ALL) {
      const rawVal = (cells[colIdx[dam.key]] ?? "").trim().replace(/,/g, "");
      if (rawVal === "" || !/^-?\d+(\.\d+)?$/.test(rawVal)) {
        bad = true;
        break;
      }
      storage[dam.key] = Number(rawVal);
    }
    if (bad) {
      skipped++;
      continue;
    }
    records.push({ epoch: ts.epoch, observedAt: ts.iso, storage });
  }
  if (records.length === 0) throw new FetchDamsError(`有効な観測行がありません (${label})`);
  if (skipped > 0) log(`${label}: ${skipped} 行をスキップ（日時・数値が不正）`);
  return records;
}

/**
 * 既存 data/history.json を読み、CSV パースと同じレコード形へ変換する。
 * 無ければ []、壊れていれば警告して [] を返す（累積を CSV から作り直す）。
 */
async function readExistingHistory() {
  const path = join(DATA_DIR, "history.json");
  if (!existsSync(path)) {
    log("既存 history.json なし（初回）。CSV から時系列を開始する。");
    return [];
  }
  let json;
  try {
    json = JSON.parse(await readFile(path, "utf-8"));
  } catch (e) {
    log(`WARN: 既存 history.json を読めません（${e.message}）。CSV から作り直す。`);
    return [];
  }
  if (!json || !Array.isArray(json.series)) {
    log("WARN: 既存 history.json の形式が不正。CSV から作り直す。");
    return [];
  }
  const records = [];
  for (const entry of json.series) {
    const parsed = parseIsoObservedAt(entry.observedAt);
    if (!parsed) continue;
    const storage = {};
    let ok = true;
    for (const dam of ALL) {
      const v = entry.storage?.[dam.key];
      if (typeof v !== "number" || !Number.isFinite(v)) {
        ok = false;
        break;
      }
      storage[dam.key] = v;
    }
    if (!ok) continue;
    records.push({ epoch: parsed.epoch, observedAt: parsed.iso, storage });
  }
  log(`既存 history.json: ${records.length} 点を読み込み`);
  return records;
}

/** ISO 8601 ("2026-09-06T14:00:00+09:00") を直接パース。 */
function parseIsoObservedAt(raw) {
  if (typeof raw !== "string") return null;
  const epoch = Date.parse(raw);
  if (Number.isNaN(epoch)) return null;
  return { iso: raw, epoch };
}

function rate(storage, capacity) {
  if (!capacity) return null;
  return Math.round((storage / capacity) * 1000) / 10; // 小数第1位
}

async function main() {
  const [prevMonth, curMonth] = targetMonths();
  log(`対象月: ${prevMonth}, ${curMonth} / retain ${RETAIN_DAYS} 日`);

  // --- 取得 & パース（1つでも致命的失敗なら throw → 既存JSONは保持） ---
  const monthResults = [];
  for (const [month, required] of [
    [curMonth, true],
    [prevMonth, false],
  ]) {
    try {
      const bytes = await loadCsvBytes(month);
      const text = decodeShiftJis(bytes, `${month}data.csv`);
      const recs = parseCsv(text, `${month}data.csv`);
      log(`${month}: ${recs.length} 観測行`);
      monthResults.push(recs);
    } catch (e) {
      if (required) throw e;
      // 前月分は月初以外では欠けていることがある。警告のみで続行。
      log(`前月分をスキップ: ${e.message}`);
    }
  }

  // --- 既存 history.json（自前累積分）＋ 今回の CSV をマージ ---
  const existing = await readExistingHistory();
  const csvCount = monthResults.reduce((n, r) => n + r.length, 0);

  const byEpoch = new Map();
  for (const r of existing) byEpoch.set(r.epoch, r); // 既存を先に置く
  for (const recs of monthResults) {
    for (const r of recs) byEpoch.set(r.epoch, r); // 新しい CSV 値で上書き
  }
  let merged = [...byEpoch.values()].sort((a, b) => a.epoch - b.epoch);
  if (merged.length === 0) throw new FetchDamsError("マージ結果が空です");

  // --- 直近 RETAIN_DAYS 日に絞る（最新観測を基準） ---
  const latestEpoch = merged[merged.length - 1].epoch;
  const cutoff = latestEpoch - RETAIN_DAYS * 24 * 3600 * 1000;
  merged = merged.filter((r) => r.epoch >= cutoff);
  const spanDays = (latestEpoch - merged[0].epoch) / (24 * 3600 * 1000);
  const bootstrapping = spanDays < 35;
  log(
    `マージ後: ${merged.length} 点 / 期間 ${spanDays.toFixed(1)} 日 ` +
      `(既存 ${existing.length} + CSV ${csvCount} → ユニーク ${byEpoch.size})` +
      (bootstrapping ? " ※bootstrapping: まだ35日未満。毎正時実行で累積される。" : ""),
  );

  const generatedAt = new Date().toISOString();

  // --- latest.json ---
  const last = merged[merged.length - 1];
  const latestJson = {
    generatedAt,
    observedAt: last.observedAt,
    unit: UNIT,
    bootstrapping,
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
      rate: rate(last.storage[d.key], d.capacity),
    })),
    total: {
      key: TOTAL.key,
      name: TOTAL.name,
      storage: last.storage[TOTAL.key],
      capacity: TOTAL.capacity,
      rate: rate(last.storage[TOTAL.key], TOTAL.capacity),
    },
  };

  // --- history.json ---
  const historyJson = {
    generatedAt,
    unit: UNIT,
    retainDays: RETAIN_DAYS,
    bootstrapping,
    spanDays: Math.round(spanDays * 10) / 10,
    dams: [...DAMS.map((d) => ({ key: d.key, name: d.name })), { key: TOTAL.key, name: TOTAL.name }],
    capacities: Object.fromEntries(ALL.map((d) => [d.key, d.capacity])),
    series: merged.map((r) => ({
      observedAt: r.observedAt,
      storage: Object.fromEntries(ALL.map((d) => [d.key, r.storage[d.key]])),
      rate: Object.fromEntries(ALL.map((d) => [d.key, rate(r.storage[d.key], d.capacity)])),
    })),
  };

  // --- 原子的に書き出し（成功時のみ本ファイルを置換） ---
  await mkdir(DATA_DIR, { recursive: true });
  await writeAtomic(join(DATA_DIR, "latest.json"), latestJson);
  await writeAtomic(join(DATA_DIR, "history.json"), historyJson);
  log(`書き出し完了: data/latest.json (observedAt ${last.observedAt}), data/history.json (${merged.length} 点)`);
}

async function writeAtomic(path, obj) {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(obj, null, 2) + "\n", "utf-8");
  await rename(tmp, path);
}

main().catch((e) => {
  log(`ERROR: ${e.message}`);
  log("既存の data/*.json は変更していません。");
  process.exit(1);
});
