/*
 * history-retention.mjs — history.json の保持ポリシー（間引きロジック）
 *
 * 直近 hourlyDays 日は 1 時間粒度のまま、それより古く retainDays 日以内は
 * 「各日 1 点（12:00 JST の観測。無ければその日で最も 12:00 に近い観測）」へ間引き、
 * retainDays より古いものは捨てる。
 *
 * ■ 冪等性
 *   間引きは JST の暦日単位で行い、時間粒度ゾーンの開始も JST 日の 0:00 に揃える。
 *   そのため間引き済み history に、間引き対象期間を含む CSV 再取得データを
 *   マージして再度 applyRetention しても、1 日 1 点の形が保たれる
 *   （同じ epoch は CSV 値で上書き、12:00 が新たに得られた日だけ代表点が 12:00 へ寄る）。
 *
 * 入力レコードは { epoch, ... } を持つオブジェクト（epoch 昇順でなくてよい）。
 */

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const JST = 9 * HOUR;

export const DEFAULT_HOURLY_DAYS = 35;
export const DEFAULT_RETAIN_DAYS = 400;

/** epoch の JST 暦日番号（1970-01-01 JST = 0）。 */
const jstDay = (epoch) => Math.floor((epoch + JST) / DAY);

/** JST 暦日番号 → その日の 12:00 JST の epoch。 */
const noonOf = (day) => day * DAY - JST + 12 * HOUR;

/**
 * @param {Array<{epoch:number}>} records
 * @param {{hourlyDays?:number, retainDays?:number}} [opts]
 * @returns {Array<{epoch:number}>} epoch 昇順
 */
export function applyRetention(records, opts = {}) {
  const hourlyDays = opts.hourlyDays ?? DEFAULT_HOURLY_DAYS;
  const retainDays = opts.retainDays ?? DEFAULT_RETAIN_DAYS;
  if (records.length === 0) return [];
  const sorted = [...records].sort((a, b) => a.epoch - b.epoch);
  const latest = sorted[sorted.length - 1].epoch;

  const retainCutoff = latest - retainDays * DAY;
  // 時間粒度ゾーン開始 = (最新 - hourlyDays 日) を含む JST 日の 0:00
  const hourlyStart = jstDay(latest - hourlyDays * DAY) * DAY - JST;

  const out = [];
  const best = new Map(); // JST 日 → 12:00 に最も近い代表点
  for (const r of sorted) {
    if (r.epoch < retainCutoff) continue;
    if (r.epoch >= hourlyStart) {
      out.push(r);
      continue;
    }
    const day = jstDay(r.epoch);
    const cur = best.get(day);
    const dist = Math.abs(r.epoch - noonOf(day));
    // 同距離なら先（早い時刻）を優先するため厳密な < で比較
    if (!cur || dist < cur.dist) best.set(day, { dist, r });
  }
  const daily = [...best.values()].map((v) => v.r);
  return [...daily, ...out].sort((a, b) => a.epoch - b.epoch);
}
