// SPDX-License-Identifier: Apache-2.0
/** Source-free signatures from the existing presign counters, grouped by provider caller.
 * A signed capability may be unused/reused/retried: this never claims executed bucket counts. */
export function r2SignatureMeter(projectId) {
  const seen = new Set(),
    byCaller = {};
  let unattributed = 0,
    malformed = 0;
  return {
    observe(event) {
      for (const line of event.logLines ?? []) {
        const text = typeof line === 'string' ? line : (line.messages ?? []).join(' ');
        const match = text.match(/FORGE_R2_COUNT (\{.*\})/);
        if (!match) continue;
        let row;
        try {
          row = JSON.parse(match[1]);
        } catch {
          malformed++;
          continue;
        }
        if (row.projectId !== projectId) {
          if (!row.projectId) unattributed++;
          continue;
        }
        if (
          ![row.sequence, row.a, row.b, row.put, row.deletes].every(n => Number.isSafeInteger(n) && n >= 0)
        ) {
          malformed++;
          continue;
        }
        const key = `${event.requestId}/${event.executionId}/${row.sequence}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const caller = event.identifier ?? 'unknown';
        const total = (byCaller[caller] ??= { classA: 0, classB: 0, putBytes: 0, deletes: 0 });
        total.classA += row.a;
        total.classB += row.b;
        total.putBytes += row.put;
        total.deletes += row.deletes;
      }
    },
    report(landings = null) {
      const totals = Object.values(byCaller).reduce(
        (a, b) => ({
          classA: a.classA + b.classA,
          classB: a.classB + b.classB,
          putBytes: a.putBytes + b.putBytes,
          deletes: a.deletes + b.deletes,
        }),
        { classA: 0, classB: 0, putBytes: 0, deletes: 0 },
      );
      return {
        kind: 'signed-capabilities',
        observed: seen.size > 0,
        byCaller,
        totals: seen.size ? totals : null,
        perLanding:
          seen.size && landings > 0
            ? Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, v / landings]))
            : null,
        unattributed,
        malformed,
        coverage:
          'Includes maintenance callers observed in this stream; excludes client executions/retries, external backup/maintenance and missing log lines. Executed-request reconciliation and caller attribution remain separate from signatures.',
      };
    },
  };
}
