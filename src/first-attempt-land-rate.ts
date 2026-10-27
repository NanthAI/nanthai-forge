// SPDX-License-Identifier: Apache-2.0
export type LandRateEntry = {
  id: string;
  at: string;
  laneIds: string[];
  accepted: boolean;
  pending: boolean;
  cause: 'conflict' | 'check-failure-or-flake' | 'stall' | 'cancelled' | 'other';
};
/** Select first-ever entries before applying the half-open submission window.
 * Pending first entries remain in the denominator and are reported separately. */
export function firstAttemptLandRate(entries: LandRateEntry[], from: string, to: string) {
  const lanes = new Map<string, LandRateEntry[]>();
  for (const entry of entries.slice().sort((a, b) => Date.parse(a.at) - Date.parse(b.at)))
    for (const laneId of new Set(entry.laneIds)) {
      const history = lanes.get(laneId) ?? [];
      if (!history.some(item => item.id === entry.id)) history.push(entry);
      lanes.set(laneId, history);
    }
  const selected = [...lanes.values()].filter(
    history => Date.parse(history[0]!.at) >= Date.parse(from) && Date.parse(history[0]!.at) < Date.parse(to),
  );
  const accepted = selected.filter(history => history[0]!.accepted).length;
  const retryCauses = { conflict: 0, 'check-failure-or-flake': 0, stall: 0, cancelled: 0, other: 0 };
  let retriedLanes = 0;
  for (const history of selected) {
    let retried = false;
    for (let index = 1; index < history.length; index++) {
      if (Date.parse(history[index]!.at) >= Date.parse(to)) break;
      const previous = history[index - 1]!;
      if (previous.accepted || previous.pending) continue;
      retried = true;
      retryCauses[previous.cause]++;
    }
    if (retried) retriedLanes++;
  }
  return {
    from,
    to,
    lanes: selected.length,
    accepted,
    pending: selected.filter(h => h[0]!.pending).length,
    rate: selected.length ? accepted / selected.length : null,
    retriedLanes,
    retryCauses,
  };
}
