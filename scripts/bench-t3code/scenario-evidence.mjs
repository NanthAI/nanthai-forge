// SPDX-License-Identifier: Apache-2.0
// Mechanical proof that each scripted scenario role really happened (Item 5e3c3a3c). A cell
// whose role did not fire is not a test of its switch path: run-cell voids it, so no reading
// of the cell depends on judgment. Evidence comes only from what the cell recorded: the
// driver's scenario events, the CLI call log, the CI job records and the landed changes.
// Also records, per overlap group, the order in which its tasks first tried to land, so
// arrival-order effects between arms can be seen (a colliding pair that flips order decides
// which one re-composes).

const ms = at => Date.parse(at);

/** Per-task scenario events from the driver's stdout lines ({event:'scenario', step, ...}). */
export function scenarioEvents(lines) {
  return lines.flatMap(line => {
    try {
      const value = JSON.parse(line);
      return value?.event === 'scenario' ? [value] : [];
    } catch {
      return [];
    }
  });
}

const firstLand = (calls, task) =>
  calls
    .filter(
      c => c.task === task && /^agent land(\s|$)/.test(c.verb ?? '') && !/--withdraw|--help/.test(c.verb),
    )
    .map(c => c.startedAt ?? c.sentAt)
    .filter(Boolean)
    .sort()[0] ?? null;

/**
 * roles: [{ task, role, group }] in cell order; records: result records (task, dispatchedAt,
 * changes.files); calls: nforge call log; jobs: CI job records; events: { [task]: events[] }.
 * Returns { roles: [{task, kind, fired, evidence}], groupOrder: {group: [task]}, problems }.
 */
export function scenarioEvidence({ roles, records, calls, jobs = [], events = {} }) {
  const checks = [];
  const recordOf = task => records.find(r => r.task === task);
  const jobSeconds = jobs
    .filter(j => j.conclusion !== 'skipped' && j.startedAt && j.completedAt)
    .map(j => (ms(j.completedAt) - ms(j.startedAt)) / 1000);
  for (const { task, role } of roles) {
    const ev = events[task] ?? [];
    const step = name => ev.filter(e => e.step === name);
    if (role.withdrawOnce) {
      const w = step('withdrawn').at(-1);
      checks.push({
        task,
        kind: 'withdraw',
        fired: Boolean(w) && !w.error,
        evidence: w ? `withdraw reply ${w.error ?? 'accepted'}` : 'no withdraw step',
      });
    }
    if (role.failOnce) {
      // Only a CHECK_FAILED reply counts; the semantic role must also have passed its own
      // admission check (the failure is the queue check's).
      const fix = step('fix-after-failed-check').at(-1);
      const queue = role.failOnce !== 'semantic' || fix?.admission === false;
      checks.push({
        task,
        kind: 'fail-once',
        fired: fix?.code === 'CHECK_FAILED' && queue,
        evidence: !fix
          ? 'no failed landing check seen'
          : `fix after ${fix.code ?? 'a reply with no code'}${fix.admission ? ' (admission check)' : ''}`,
      });
    }
    if (role.slowSeconds) {
      const longest = jobSeconds.length ? Math.max(...jobSeconds) : 0;
      checks.push({
        task,
        kind: 'slow-check',
        fired: longest >= role.slowSeconds,
        evidence: `longest CI job ${Math.round(longest)} s, slow test ${role.slowSeconds} s`,
      });
    }
    if (role.releaseMs) {
      const record = recordOf(task);
      const land = firstLand(calls, task);
      const waited = record && land ? ms(land) - ms(record.dispatchedAt) : null;
      checks.push({
        task,
        kind: 'release',
        fired: waited !== null && waited >= role.releaseMs - 1000,
        evidence:
          waited === null
            ? 'no land call'
            : `first land ${Math.round(waited / 1000)} s after dispatch, release ${role.releaseMs / 1000} s`,
      });
    }
    if (role.doc) {
      const files = (recordOf(task)?.changes?.files ?? []).map(f => f.path);
      checks.push({
        task,
        kind: 'doc-edit',
        fired: files.includes(role.doc.path),
        evidence: files.includes(role.doc.path)
          ? `${role.doc.path} changed`
          : `${role.doc.path} not in changes`,
      });
    }
  }
  const groups = {};
  for (const { task, group } of roles) if (group) (groups[group] ??= []).push(task);
  const groupOrder = Object.fromEntries(
    Object.entries(groups)
      .filter(([, members]) => members.length > 1)
      .map(([group, members]) => [
        group,
        members
          .map(task => ({ task, at: firstLand(calls, task) }))
          .sort((a, b) => (a.at ?? '~').localeCompare(b.at ?? '~'))
          .map(m => m.task),
      ]),
  );
  const problems = checks
    .filter(c => !c.fired)
    .map(c => `scenario role did not fire: ${c.kind} on ${c.task} (${c.evidence})`);
  return { roles: checks, groupOrder, problems };
}
