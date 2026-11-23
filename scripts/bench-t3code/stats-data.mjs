// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { describe, metrics } from './stats-math.mjs';

const read = path => JSON.parse(readFileSync(path, 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const finite = x => (Number.isFinite(x) ? x : null);
const sum = xs => (xs.length && xs.every(Number.isFinite) ? xs.reduce((a, b) => a + b, 0) : null);
const children = path =>
  existsSync(path)
    ? readdirSync(path, { withFileTypes: true })
        .filter(x => x.isDirectory())
        .map(x => join(path, x.name))
    : [];
const publicId = id => {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(id))
    throw Error('Invalid public cell/task identity');
  return id;
};

// Publish reason categories, never arbitrary error text containing paths, account IDs or logs.
function reasons(values) {
  return [
    ...new Set(
      values.map(value => {
        const text = String(value);
        const task = text.match(/harness error on ([a-z]\d+)\b/i)?.[1];
        if (task) return `Harness error on ${task}`;
        if (/version|deploy|drift/i.test(text)) return 'Version/deployment drift';
        if (/start barrier/i.test(text)) return 'Start barrier failure';
        if (/interrupt|SIGTERM/i.test(text)) return 'Interrupted attempt';
        return 'Harness failure (private details omitted)';
      }),
    ),
  ];
}

/** Only known retained layouts are traversed; no workspace, evidence tree or repository code. */
export function discover(roots) {
  const dirs = new Set(),
    batchFiles = new Set();
  for (const root of roots) {
    if (!existsSync(root)) throw Error('An input directory does not exist');
    const candidates = [root, ...children(root), ...children(join(root, 'runs'))];
    for (const dir of candidates) if (existsSync(join(dir, 'result.json'))) dirs.add(dir);
    for (const base of [root, dirname(root), dirname(dirname(root))])
      for (const dir of children(join(base, 'batches')))
        if (existsSync(join(dir, 'batch.json'))) batchFiles.add(join(dir, 'batch.json'));
  }
  const batches = new Map();
  for (const file of [...batchFiles].sort()) {
    const batch = read(file);
    for (const cell of batch.cells ?? []) {
      const old = batches.get(cell.cellId);
      if (old && JSON.stringify(old.voided ?? []) !== JSON.stringify(batch.voided ?? []))
        throw Error('Conflicting batch evidence for a cell identity');
      batches.set(cell.cellId, batch);
    }
  }
  return { dirs: [...dirs].sort(), batches };
}

function cellValues(result, rework, telemetry) {
  const records = result.records ?? [];
  const usable = records.filter(
    r => r.landing?.landed && !r.harnessError && !(result.taskVoids ?? []).includes(r.task),
  );
  const times = describe(usable.map(r => r.timeToMainSeconds));
  const observed = records.filter(r => r.landing?.landed && Number.isFinite(r.timeToMainSeconds));
  const observedTimes = describe(observed.map(r => r.timeToMainSeconds));
  const prep = records.map(r => finite(r.prepSeconds));
  // Missing transcripts are unknown, including older runs without phase coverage.
  const covered =
    rework?.lines?.length === records.length &&
    records.length > 0 &&
    rework.lines.every(l => l.source !== 'none');
  const recovery = field => (covered ? sum(rework.lines.map(l => finite(l.rework[field]))) : null);
  const t = result.tokens ?? {},
    totals = telemetry?.totals;
  const values = {
    wallSeconds: result.wallSecondsToAllLanded,
    timeToMainMedianSeconds: times.median,
    timeToMainMaxSeconds: times.max,
    observedTimeToMainMedianSeconds: observedTimes.median,
    observedTimeToMainMaxSeconds: observedTimes.max,
    prepSeconds: sum(prep),
    prepMedianSeconds: describe(prep).median,
    ciBilledMinutes: result.ci?.billedMinutes,
    ciJobs: result.ci?.jobs,
    cachedInputTokens: t.cacheReadInputTokens,
    uncachedInputTokens: t.inputTokens,
    cacheWriteTokens: t.cacheCreationInputTokens,
    outputTokens: t.outputTokens,
    reasoningOutputTokens: t.reasoningOutputTokens,
    turns: t.numTurns,
    reworkTurns: recovery('turns'),
    reworkCachedInputTokens: recovery('cachedInput'),
    reworkUncachedInputTokens: recovery('input'),
    reworkCacheWriteTokens: recovery('cacheWrite'),
    reworkOutputTokens: recovery('output'),
    reworkTokens: sum(['input', 'cachedInput', 'cacheWrite', 'output'].map(recovery)),
    landed: result.landed,
    strict: result.oracle?.grade?.strictSuccess,
    lenient: result.oracle?.grade?.lenientScore,
    convexUsd: result.convex?.valid === false ? null : result.convex?.costUsd,
    finishToMainP50Seconds:
      finite(totals?.finishToMain?.p50Minutes) == null ? null : 60 * totals.finishToMain.p50Minutes,
    finishToMainP90Seconds:
      finite(totals?.finishToMain?.p90Minutes) == null ? null : 60 * totals.finishToMain.p90Minutes,
    finishToMainMeanSeconds:
      finite(totals?.finishToMain?.meanMinutes) == null ? null : 60 * totals.finishToMain.meanMinutes,
    mainRaceRecheckRuns: totals?.waste?.mainRaceRecheckRuns,
    mainRaceRecheckRunnerMinutes: totals?.waste?.mainRaceRecheckRunnerMinutes,
    conflictElapsedMinutes: totals?.waste?.byCause?.find(c => c.cause === 'conflict')?.elapsedMinutes,
    reuseAcceptances: totals?.B?.reuseAcceptances,
    mainCheckFailures: totals?.B?.mainCheckFailures,
  };
  return {
    perCell: Object.fromEntries(Object.keys(metrics).map(m => [m, finite(values[m])])),
    taskTimes: usable
      .filter(r => Number.isFinite(r.timeToMainSeconds))
      .map(r => ({ task: publicId(r.task), seconds: r.timeToMainSeconds })),
    observedTaskTimes: observed.map(r => ({ task: publicId(r.task), seconds: r.timeToMainSeconds })),
    reworkCoverage: {
      tasks: records.length,
      covered: rework?.lines?.filter(l => l.source !== 'none').length ?? 0,
    },
  };
}

export function readSeries(roots, runRework) {
  const { dirs, batches } = discover(roots);
  const cells = [],
    voided = [],
    excluded = [],
    seen = new Map();
  for (const dir of dirs) {
    const bytes = readFileSync(join(dir, 'result.json'));
    const r = JSON.parse(bytes),
      cellId = publicId(r.cellId),
      digest = hash(bytes);
    if (seen.has(cellId)) {
      if (seen.get(cellId) !== digest) throw Error(`Conflicting result bytes for cell ${cellId}`);
      continue;
    }
    seen.set(cellId, digest);
    const batch = batches.get(cellId);
    const meta = {
      cellId,
      kind: r.diagnostic
        ? publicId(r.diagnostic.kind).startsWith('replay-')
          ? publicId(r.diagnostic.kind)
          : `replay-${publicId(r.diagnostic.kind)}`
        : publicId(r.coordinationCell?.kind ?? 'scored'),
      N: r.N,
      rep: r.rep,
      attempt: r.attempt,
      extra: Boolean(r.extra),
      arm: r.coordinationCell?.stack ? `${r.arm}-${publicId(r.coordinationCell.stack)}` : publicId(r.arm),
      resultSha256: digest,
      sourcePins: Object.fromEntries(
        [
          ['cliState', r.versions?.start?.cli?.commit],
          ['cliCommit', r.versions?.start?.cli?.git],
          ['harnessCommit', r.versions?.start?.harness?.commit],
          ['harnessFilesSha256', r.versions?.start?.harness?.filesSha256],
          ['deploymentCommit', r.versions?.start?.deploy?.headSha],
        ].filter(([, value]) => typeof value === 'string' && /^[a-f0-9]{40,64}$/.test(value)),
      ),
    };
    const why = [...(r.voided ?? []), ...(batch?.voided ?? [])];
    if (why.length) {
      voided.push({
        ...meta,
        reasons: reasons(why),
        failureCodes: [
          ...new Set(
            [...why, ...(r.records ?? []).map(record => record.harnessError ?? '')].flatMap(
              value => String(value).match(/\b(?:GH\d+|BENCH_[A-Z_]+)\b/g) ?? [],
            ),
          ),
        ].sort(),
        batchVoided: batch ? Boolean(batch.voided?.length) : null,
        dry: Boolean(r.dry),
      });
      continue;
    }
    const exclusion = r.dry
      ? 'Unscored dry'
      : r.modelCheck
        ? 'Model check'
        : r.refused
          ? 'Refused before run'
          : !batch
            ? 'No retained batch evidence'
            : !Array.isArray(r.records)
              ? 'No completed result'
              : null;
    if (exclusion) {
      excluded.push({ ...meta, reason: exclusion });
      continue;
    }
    const rw = runRework(dir);
    const file = join(dir, 'forge-metrics.json'),
      telemetryBytes = existsSync(file) ? readFileSync(file) : null;
    const rawTelemetry = telemetryBytes ? JSON.parse(telemetryBytes) : null;
    const telemetry = rawTelemetry?.result ?? rawTelemetry;
    const values = cellValues(r, rw, telemetry);
    cells.push({
      ...meta,
      ...values,
      replay: r.diagnostic
        ? {
            release: r.diagnostic.plan?.release ? publicId(r.diagnostic.plan.release) : null,
            modelTokens: finite(r.modelTokens),
            prepSeconds: Number.isFinite(r.replay?.prepMs) ? r.replay.prepMs / 1000 : null,
            protocolSeconds: Number.isFinite(r.replay?.elapsedMs) ? r.replay.elapsedMs / 1000 : null,
            lateTasks: (r.diagnostic.plan?.tasks ?? [])
              .filter(t => t.releaseAtMs > 0)
              .map(task => {
                const record = (r.records ?? []).find(record => record.task === task.id);
                return {
                  task: publicId(task.id),
                  releaseAtMs: task.releaseAtMs,
                  timeToMainSeconds: finite(record?.timeToMainSeconds),
                  recoveries: finite(record?.recoveries),
                };
              }),
          }
        : null,
      perLanding: Object.fromEntries(
        Object.entries(values.perCell).map(([m, v]) => [m, r.landed > 0 && v != null ? v / r.landed : null]),
      ),
      taskVoids: (r.taskVoids ?? []).map(publicId),
      quotaTasks: (r.quotaTasks ?? []).map(publicId),
      contaminationVoids: Object.entries(r.contamination ?? {})
        .filter(([, c]) => c.void)
        .map(([task]) => publicId(task)),
      forgeMetrics: telemetryBytes
        ? {
            sha256: hash(telemetryBytes),
            partial: Object.fromEntries(
              Object.entries(telemetry?.totals ?? {})
                .filter(([, v]) => typeof v?.partial === 'boolean')
                .map(([k, v]) => [k, v.partial]),
            ),
          }
        : null,
      convoy: rw?.convoy
        ? {
            pass: rw.convoy.pass,
            limitSeconds: rw.convoy.limitSeconds,
            lateTasks: rw.convoy.late.map(t => publicId(t.task)),
            orderWaitsAgainstIndependent: rw.convoy.orderWaitsAgainstIndependent,
            orderWaitsUnattributed: rw.convoy.orderWaitsUnattributed,
          }
        : null,
    });
  }
  return { cells, voided, excluded };
}

/** Fallback is explicitly a rounded, published projection, never reconstructed raw samples. */
export function readB15dReport(path) {
  const cells = [],
    voided = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const cols = line.split('|').map(x => x.trim());
    const match = cols[1]?.match(/^n(\d+)-r(\d+)(?: a(\d+))?( \(extra, see Deviation\))?$/);
    if (!match) continue;
    for (const [index, arm] of [
      [2, 'forge'],
      [3, 'github'],
    ]) {
      const meta = {
        cellId: `b15d-${arm}-n${match[1]}-r${match[2]}-a${match[3] ?? 1}`,
        kind: match[4] ? 'scored-owner-extra' : 'scored',
        extra: Boolean(match[4]),
        N: +match[1],
        rep: +match[2],
        attempt: +(match[3] ?? 1),
        arm,
        publishedRounded: true,
      };
      if (/void/i.test(cols[index])) {
        voided.push({
          ...meta,
          reasons: [
            /network/i.test(cols.slice(2).join(' '))
              ? 'Network loss during grading'
              : 'Start barrier failure',
          ],
        });
        continue;
      }
      const xs = cols[index].split('/').map(x => Number(x.trim().replace('$', '')));
      if (xs.length < 4 || !xs.slice(0, 4).every(Number.isFinite))
        throw Error('Unrecognized B1.5d published cell');
      const perCell = Object.fromEntries(Object.keys(metrics).map(m => [m, null]));
      Object.assign(perCell, {
        wallSeconds: xs[0],
        strict: xs[1],
        timeToMainMedianSeconds: xs[2],
        ciBilledMinutes: xs[3],
        landed: 10,
        convexUsd: xs[4] ?? null,
      });
      cells.push({
        ...meta,
        perCell,
        perLanding: Object.fromEntries(
          Object.entries(perCell).map(([m, v]) => [m, v == null ? null : v / 10]),
        ),
        taskTimes: [],
      });
    }
  }
  if (!cells.length) throw Error('No B1.5d published cells found');
  return {
    cells,
    voided,
    excluded: [],
    coverage:
      'Published rounded per-cell projection; raw B1.5d samples not supplied. Owner extra N=3 attempt retained in a separate deviation group, excluded from registered comparisons.',
  };
}
