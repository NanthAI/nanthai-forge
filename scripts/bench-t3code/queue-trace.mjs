// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const ms = value => (typeof value === 'number' ? value : Date.parse(value));
const delta = (end, start) =>
  Number.isFinite(ms(end)) && Number.isFinite(ms(start)) ? (ms(end) - ms(start)) / 1000 : null;
const median = values => {
  const sorted = [...values].sort((a, b) => a - b),
    n = sorted.length;
  return n ? (sorted[Math.floor((n - 1) / 2)] + sorted[Math.ceil((n - 1) / 2)]) / 2 : null;
};

/** Pure allowlist: no source text, messages, identities, addresses, grants or
 * session content can enter a normalized trace. Null means missing, not zero. */
export function normalizeCell(cell, result, history, resultSha256, calls = []) {
  const receipts = history.receipts,
    taskOf = new Map();
  for (const record of result.records) {
    const receipt = receipts.find(r => r.receiptId === record.landing?.receiptId);
    if (receipt) taskOf.set(receipt.submissionId, record.task);
  }
  const runs = new Map(history.runs.map(r => [r.runId, r.value]));
  const checkId = new Map([...runs.keys()].map((id, i) => [id, `check-${i + 1}`]));
  const start = result.startedAt,
    offset = at => delta(at, start);
  const missing = [],
    tasks = [];
  for (const record of result.records) {
    const receipt = receipts.find(r => r.receiptId === record.landing?.receiptId);
    const chain = history.histories.find(h => h.submissionId === receipt?.submissionId);
    const attempts = chain?.pages.flatMap(p => p.page ?? []) ?? [];
    const stamps = record.landing?.operations ?? [];
    const landCalls = calls.filter(
      call =>
        call.task === record.task && /^agent land(?:\s|$)/.test(call.verb) && !call.verb.includes('--help'),
    );
    const firstCall = [
      ...stamps.flatMap(op => op.commandTiming ?? []).map(c => c.startedAt),
      ...landCalls.map(call => call.startedAt ?? call.sentAt),
    ]
      .filter(Boolean)
      .sort()[0];
    if (!receipt || !attempts.length) missing.push(`${record.task}:attempt-chain`);
    if (!firstCall) missing.push(`${record.task}:land-call`);
    if (record.changes?.truncated || !record.changes?.files) missing.push(`${record.task}:paths`);
    const candidates = new Map();
    const generations = attempts.map(a => {
      const run = runs.get(a.check?.runId),
        timing = a.progress?.timing;
      if (!candidates.has(a.candidate?.id)) candidates.set(a.candidate?.id, candidates.size);
      if (a.check?.runId && !run) missing.push(`${record.task}:check-metadata`);
      return {
        number: a.number,
        candidate: candidates.get(a.candidate?.id),
        check: checkId.get(a.check?.runId) ?? null,
        mainFrom: taskOf.get(receipts.find(r => r.receiptId === a.main.receiptId)?.submissionId) ?? 'base',
        composeAt: offset(timing?.composeStartedAt),
        composeSeconds: delta(timing?.composedAt, timing?.composeStartedAt),
        settledAt: offset(timing?.settledAt),
        cause: a.recheckReason ?? null,
        outcome: a.progress?.error?.code ?? a.progress?.phase ?? null,
        proof: a.crossHeadProof?.kind ?? (a.crossHeadProof ? 'recorded' : null),
      };
    });
    const waits = (receipt?.orderWaits ?? []).map(w => ({
      task: taskOf.get(w.submissionId) ?? null,
      held: w.held,
      footprints: w.footprints,
    }));
    if (waits.some(w => w.task === null)) missing.push(`${record.task}:wait-holder`);
    tasks.push({
      task: record.task,
      worker: record.worker,
      dispatchedAt: offset(record.dispatchedAt),
      counted: !cell.taskTimes.length || cell.taskTimes.some(task => task.task === record.task),
      arriveAt: offset(firstCall),
      submittedAt: offset(receipt?.submittedAt),
      committedAt: offset(receipt?.committedAt),
      paths: record.changes?.files.map(f => f.path).sort() ?? null,
      observedTimeToMainSeconds: record.timeToMainSeconds ?? null,
      observedRecomposes: receipt?.recomposeCount ?? null,
      attempts: generations,
      waits,
      reactions: landCalls.length
        ? landCalls.map(call => ({
            start: offset(call.startedAt ?? call.sentAt),
            end: offset(call.endedAt ?? call.receivedAt),
            outcome: call.errorCodes?.[0] ?? (call.code === 0 ? 'completed' : 'unknown'),
          }))
        : stamps.map(op => ({
            start: offset(op.commandTiming?.[0]?.startedAt),
            end: offset(op.commandTiming?.at(-1)?.replyReceivedAt),
            outcome: op.error?.code ?? op.phase ?? null,
          })),
    });
  }
  const checks = [...runs].map(([id, run]) => {
    const jobs = result.ci?.jobRecords?.filter(job => String(job.runId) === String(run.executionId)) ?? [];
    const billed = jobs.length
      ? jobs.reduce(
          (sum, job) =>
            sum +
            (job.conclusion === 'skipped'
              ? 0
              : Math.ceil((delta(job.completedAt, job.startedAt) ?? NaN) / 60)),
          0,
        )
      : null;
    const wall = delta(run.endedAt, run.actions?.reservedAt ?? run.at);
    if (![wall, billed, run.execution?.seconds].every(value => Number.isFinite(value) && value >= 0))
      missing.push(`${checkId.get(id)}:timing-or-cost`);
    return {
      id: checkId.get(id),
      kind: run.gate?.effective ?? run.gate?.mode ?? 'full',
      members: tasks.filter(t => t.attempts.some(a => a.check === checkId.get(id))).map(t => t.task),
      at: offset(run.actions?.reservedAt ?? run.at),
      wallSeconds: wall,
      runnerSeconds: run.execution?.seconds ?? null,
      billedMinutes: billed,
      outcome: run.status,
    };
  });
  return {
    schema: 1,
    N: cell.N,
    rep: cell.rep,
    series: cell.series,
    resultSha256,
    sourcePins: Object.fromEntries(
      ['cliCommit', 'cliState', 'deploymentCommit', 'harnessCommit', 'harnessFilesSha256']
        .filter(key => cell.sourcePins?.[key] !== undefined)
        .map(key => [key, cell.sourcePins[key]]),
    ),
    coverage: {
      complete: missing.length === 0,
      missing: [...new Set(missing)],
      limitation:
        'Stored waits have no transition timestamps. Attempt progress is the retained terminal snapshot, not a transaction journal.',
    },
    tasks,
    checks,
    observed: {
      timeToMainMedianSeconds:
        cell.perCell.timeToMainMedianSeconds ?? cell.perCell.observedTimeToMainMedianSeconds,
      wallSeconds: cell.perCell.wallSeconds,
      ciBilledMinutes: cell.perCell.ciBilledMinutes,
      recomposes: receipts.reduce((sum, r) => sum + (r.recomposeCount ?? 0), 0),
      recomposesMax: Math.max(...receipts.map(r => r.recomposeCount ?? 0)),
      checkRuns: checks.length,
    },
    normalization: {
      taskMedianSeconds: median(tasks.map(t => t.observedTimeToMainSeconds).filter(Number.isFinite)),
    },
  };
}

// Inputs are private retained artifacts. Only the allowlisted normalized output
// is suitable for a fixture; callers review coverage and provenance first.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [manifest, retained, output] = process.argv.slice(2);
  if (!manifest || !retained || !output)
    throw new Error('Usage: queue-trace.mjs MANIFEST HISTORY OUTPUT_DIRECTORY');
  const cells = JSON.parse(readFileSync(manifest)),
    histories = JSON.parse(readFileSync(retained));
  mkdirSync(output, { recursive: true });
  for (const { cell, result: path } of cells) {
    const bytes = readFileSync(path),
      digest = hash(bytes);
    if (digest !== cell.resultSha256) throw new Error(`Result hash mismatch at N=${cell.N} rep=${cell.rep}`);
    const history = histories.find(h => h.cellId === cell.cellId);
    if (!history) throw new Error(`Missing history at N=${cell.N} rep=${cell.rep}`);
    const calls = readFileSync(join(dirname(path), 'nforge-calls.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line));
    const trace = normalizeCell(cell, JSON.parse(bytes), history, digest, calls);
    writeFileSync(join(output, `n${cell.N}-r${cell.rep}.json`), JSON.stringify(trace, null, 2) + '\n');
    console.log(
      JSON.stringify({
        N: cell.N,
        rep: cell.rep,
        tasks: trace.tasks.length,
        complete: trace.coverage.complete,
        missing: trace.coverage.missing,
      }),
    );
  }
}
