// 実行: node --test scripts/history-retention.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyRetention } from "./history-retention.mjs";

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const at = (iso) => Date.parse(iso);
const hourly = (fromIso, hours) =>
  Array.from({ length: hours }, (_, i) => ({ epoch: at(fromIso) + i * HOUR }));
const jstDayOf = (e) => Math.floor((e + 9 * HOUR) / DAY);

// 2026-01-01 00:00 JST から 100 日分の毎正時。最新 = 2026-04-10 23:00 JST
const base = hourly("2026-01-01T00:00:00+09:00", 100 * 24);
const opts = { hourlyDays: 35, retainDays: 400 };

test("古い日は 1 日 1 点、直近は 1 時間粒度のまま", () => {
  const out = applyRetention(base, opts);
  const latest = base[base.length - 1].epoch;
  const hourlyStart = at("2026-03-06T00:00:00+09:00"); // 4/10-35日=3/6 の JST 0:00
  const old = out.filter((r) => r.epoch < hourlyStart);
  const recent = out.filter((r) => r.epoch >= hourlyStart);
  assert.equal(new Set(old.map((r) => jstDayOf(r.epoch))).size, old.length);
  assert.equal(old.length, 64); // 1/1〜3/5
  assert.ok(old.every((r) => r.epoch % DAY === at("1970-01-01T03:00:00Z") % DAY)); // 12:00 JST = 03:00Z
  assert.equal(recent.length, base.filter((r) => r.epoch >= hourlyStart).length);
  assert.equal(out[out.length - 1].epoch, latest);
});

test("12:00 が無い日は最も 12:00 に近い観測を採る", () => {
  const recs = [
    { epoch: at("2026-01-01T09:00:00+09:00") },
    { epoch: at("2026-01-01T14:00:00+09:00") },
    { epoch: at("2026-01-01T11:00:00+09:00") },
    { epoch: at("2026-06-01T12:00:00+09:00") },
  ];
  const out = applyRetention(recs, opts);
  assert.deepEqual(out.map((r) => r.epoch), [at("2026-01-01T11:00:00+09:00"), at("2026-06-01T12:00:00+09:00")]);
});

test("retainDays より古いものは削除", () => {
  const recs = [
    { epoch: at("2024-01-01T12:00:00+09:00") },
    { epoch: at("2026-01-01T12:00:00+09:00") },
    { epoch: at("2026-09-01T12:00:00+09:00") },
  ];
  const out = applyRetention(recs, opts);
  assert.deepEqual(out.map((r) => r.epoch), recs.slice(1).map((r) => r.epoch));
});

test("冪等: 適用結果に再適用しても同じ", () => {
  const once = applyRetention(base, opts);
  assert.deepEqual(applyRetention(once, opts), once);
});

test("間引き済み日次点 + 再取得した時間粒度データをマージしても 1 日 1 点に戻る", () => {
  const thinned = applyRetention(base, opts);
  // 間引き対象期間（1/1〜）を含む CSV 再取得を模擬（epoch 重複は上書き）
  const byEpoch = new Map();
  for (const r of thinned) byEpoch.set(r.epoch, r);
  for (const r of hourly("2026-02-01T00:00:00+09:00", 60 * 24)) byEpoch.set(r.epoch, { ...r, fresh: true });
  const out = applyRetention([...byEpoch.values()], opts);
  const hourlyStart = at("2026-03-06T00:00:00+09:00");
  const old = out.filter((r) => r.epoch < hourlyStart);
  assert.equal(new Set(old.map((r) => jstDayOf(r.epoch))).size, old.length);
  assert.equal(old.length, 64);
  // 再取得値が優先されている（2/1 12:00 は fresh）
  assert.ok(out.find((r) => r.epoch === at("2026-02-01T12:00:00+09:00")).fresh);
  assert.deepEqual(applyRetention(out, opts), out);
});

test("最新が進んでも（実行の繰り返し）日次点は 1 日 1 点のまま安定", () => {
  let recs = applyRetention(base, opts);
  for (let h = 1; h <= 24 * 5; h++) {
    recs = applyRetention([...recs, { epoch: base[base.length - 1].epoch + h * HOUR }], opts);
  }
  const latest = recs[recs.length - 1].epoch;
  const hourlyStart = jstDayOf(latest - 35 * DAY) * DAY - 9 * HOUR;
  const old = recs.filter((r) => r.epoch < hourlyStart);
  assert.equal(new Set(old.map((r) => jstDayOf(r.epoch))).size, old.length);
});

test("空入力", () => assert.deepEqual(applyRetention([], opts), []));
