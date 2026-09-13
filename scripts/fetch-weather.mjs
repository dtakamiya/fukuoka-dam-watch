#!/usr/bin/env node
/*
 * fetch-weather.mjs — 福岡市関連9ダム地点の現在天気 → data/weather.json
 *
 * Open-Meteo（APIキー不要）に9ダム地点の緯度経度をまとめて1リクエストで問い合わせ、
 * 現在の気温・降水量・天気コードを取得して data/weather.json を生成する。
 *
 * ダムの緯度経度はダム便覧（https://dambinran.damnet.or.jp/）掲載値を10進化したもの。
 *
 * 依存ゼロ（Node 標準モジュールのみ）。
 *
 * 使い方:
 *   node scripts/fetch-weather.mjs
 *
 * 失敗時の挙動:
 *   取得・パースに失敗したら既存の data/weather.json を一切書き換えず、
 *   理由を stderr に出して exit 1（貯水量データの更新はブロックしない。
 *   ワークフロー側で独立したステップとして実行する）。
 */

import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const DATA_DIR = join(REPO_ROOT, "data");

const BASE_URL = process.env.FETCH_WEATHER_BASE_URL || "https://api.open-meteo.com/v1/forecast";

/**
 * ダムごとの緯度経度（10進度）。
 * 出典: ダム便覧の個別ダムページ「位置」欄（北緯・東経の度分秒）を10進化。
 *   南畑   https://dambinran.damnet.or.jp/dams/japan/2451/
 *   五ケ山 https://dambinran.damnet.or.jp/dams/japan/2452/
 *   脊振   https://dambinran.damnet.or.jp/dams/japan/2429/
 *   曲渕   https://dambinran.damnet.or.jp/dams/japan/3341/
 *   江川   https://dambinran.damnet.or.jp/dams/japan/2424/
 *   久原   https://dambinran.damnet.or.jp/dams/japan/2419/
 *   長谷   https://dambinran.damnet.or.jp/dams/japan/2446/
 *   猪野   https://dambinran.damnet.or.jp/dams/japan/2445/
 *   瑞梅寺 https://dambinran.damnet.or.jp/dams/japan/2444/
 */
const DAMS = [
  { key: "minamibata", name: "南畑ダム", lat: 33.4344, lon: 130.4247 },
  { key: "gokayama", name: "五ケ山ダム", lat: 33.4142, lon: 130.4189 },
  { key: "sefuri", name: "脊振ダム", lat: 33.4353, lon: 130.3961 },
  { key: "magaribuchi", name: "曲渕ダム", lat: 33.498, lon: 130.3078 },
  { key: "egawa", name: "江川ダム", lat: 33.46, lon: 130.7342 },
  { key: "kubara", name: "久原ダム", lat: 33.6442, lon: 130.525 },
  { key: "hase", name: "長谷ダム", lat: 33.6544, lon: 130.4758 },
  { key: "ino", name: "猪野ダム", lat: 33.6834, lon: 130.5203 },
  { key: "zuibaiji", name: "瑞梅寺ダム", lat: 33.5036, lon: 130.2475 },
];

class FetchWeatherError extends Error {}

function log(msg) {
  process.stderr.write(`[fetch-weather] ${msg}\n`);
}

function buildUrl() {
  const url = new URL(BASE_URL);
  url.searchParams.set("latitude", DAMS.map((d) => d.lat).join(","));
  url.searchParams.set("longitude", DAMS.map((d) => d.lon).join(","));
  url.searchParams.set("current", "temperature_2m,precipitation,weather_code");
  url.searchParams.set("timezone", "Asia/Tokyo");
  return url.toString();
}

async function fetchCurrentWeather() {
  const url = buildUrl();
  log(`取得: ${url}`);
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  } catch (e) {
    throw new FetchWeatherError(`取得失敗: ${e.message}`);
  }
  if (!res.ok) throw new FetchWeatherError(`取得失敗: HTTP ${res.status}`);
  let body;
  try {
    body = await res.json();
  } catch (e) {
    throw new FetchWeatherError(`レスポンスのJSON解析に失敗: ${e.message}`);
  }
  // 複数地点を渡すと配列で返る（地点数と同じ長さ・同じ順序）。
  const results = Array.isArray(body) ? body : [body];
  if (results.length !== DAMS.length) {
    throw new FetchWeatherError(`地点数が一致しません（要求 ${DAMS.length} / 応答 ${results.length}）`);
  }
  return results;
}

async function main() {
  const results = await fetchCurrentWeather();

  const dams = {};
  for (let i = 0; i < DAMS.length; i++) {
    const dam = DAMS[i];
    const current = results[i]?.current;
    if (
      !current ||
      typeof current.temperature_2m !== "number" ||
      typeof current.precipitation !== "number" ||
      typeof current.weather_code !== "number" ||
      typeof current.time !== "string"
    ) {
      throw new FetchWeatherError(`${dam.name}: current 天気データが不正です`);
    }
    dams[dam.key] = {
      temperature: current.temperature_2m,
      precipitation: current.precipitation,
      weatherCode: current.weather_code,
      observedAt: current.time,
    };
  }

  const weatherJson = {
    generatedAt: new Date().toISOString(),
    source: {
      name: "Open-Meteo",
      url: "https://open-meteo.com/",
    },
    dams,
  };

  await mkdir(DATA_DIR, { recursive: true });
  const changed = await writeIfChanged(join(DATA_DIR, "weather.json"), weatherJson);
  log(`weather.json: ${changed ? "更新" : "変更なし"}`);
}

const VOLATILE_KEYS = ["generatedAt"];
async function writeIfChanged(path, obj) {
  const stripVolatile = (o) => {
    const c = { ...o };
    for (const k of VOLATILE_KEYS) delete c[k];
    return JSON.stringify(c);
  };
  if (existsSync(path)) {
    try {
      const prev = JSON.parse(await readFile(path, "utf-8"));
      if (stripVolatile(prev) === stripVolatile(obj)) return false;
    } catch {
      /* 壊れている等 → そのまま上書き */
    }
  }
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(obj, null, 2) + "\n", "utf-8");
  await rename(tmp, path);
  return true;
}

main().catch((e) => {
  log(`ERROR: ${e.message}`);
  log("既存の data/weather.json は変更していません。");
  process.exit(1);
});
