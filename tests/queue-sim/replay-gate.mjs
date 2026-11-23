// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
/** Missing and non-finite values block qualification. No tolerance applies to
 * old/new rules; the 10% band is exclusively observed/old calibration. */
export function regressions(before, after) {
  const failures = [];
  for (const row of before) {
    const next = after.find(value => value.N === row.N);
    for (const [metric, value] of Object.entries(row)) {
      if (metric === 'N') continue;
      if (!Number.isFinite(value) || !Number.isFinite(next?.[metric]) || next[metric] > value)
        failures.push({
          N: row.N,
          metric,
          before: value,
          after: next?.[metric] ?? null,
          delta: Number.isFinite(next?.[metric]) ? next[metric] - value : null,
        });
    }
  }
  return failures;
}
export function calibration(observed, replay) {
  return Object.entries(observed)
    .filter(([metric, value]) => {
      if (!Number.isFinite(value) || !Number.isFinite(replay[metric])) return true;
      return Math.abs(replay[metric] - value) > (metric === 'recomposes' ? 1 : Math.abs(value) * 0.1);
    })
    .map(([metric, value]) => ({ metric, observed: value, replay: replay[metric] ?? null }));
}
