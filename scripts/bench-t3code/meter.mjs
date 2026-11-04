// B1.5d Convex meter: project-attributed usage during a cell, from the provider log stream
// (`npx convex logs`). It must never under-report quietly (S3): it is proven live before the
// cell (one own execution seen), and any coverage gap, early stream close or schema problem
// makes `valid` false, which voids the cell's cost and the cell itself.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { setTimeout as wait } from 'node:timers/promises';
import { ImportBenchmarkMonitor, completionUsage } from '../benchmark-import-monitor.mjs';

// Convex list rates: calls $2.2/M, DB I/O $0.22/GB, egress $0.132/GB, action compute $0.30/GB-h.
export const RATES = { perMillionCalls: 2.2, ioPerGb: 0.22, egressPerGb: 0.132, actionPerGbHour: 0.3 };

export function costBreakdownUsd({ executions, ioBytes, egressBytes, actionGbHours }) {
  const price = (value, rate) =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value * rate : null;
  return {
    calls: price(executions, RATES.perMillionCalls / 1e6),
    databaseIo: price(ioBytes, RATES.ioPerGb / 1e9),
    egress: price(egressBytes, RATES.egressPerGb / 1e9),
    actionCompute: price(actionGbHours, RATES.actionPerGbHour),
  };
}

export function costUsd(input) {
  const parts = Object.values(costBreakdownUsd(input));
  return parts.includes(null) ? null : parts.reduce((sum, part) => sum + part, 0);
}

/** Live meter. `spawnLogs` is injectable for tests. */
export function convexMeter({ deployment, projectId, name, cwd, spawnLogs = defaultSpawn }) {
  const startedAt = Date.now();
  const monitor = new ImportBenchmarkMonitor({ projectId, name, since: startedAt, capacity: 200_000 });
  monitor.usage = {
    databaseReadDocuments: 0,
    databaseWriteDocuments: 0,
    databaseIoReadBytes: 0,
    databaseIoWriteBytes: 0,
    networkEgressBytes: 0,
  };
  const deploymentWide = {
    completions: 0,
    ioBytes: 0,
    egressBytes: 0,
    missingUsageFields: {},
    perMinute: {},
  };
  const child = spawnLogs({ deployment, cwd });
  let closed = null,
    lines = 0,
    watching = false,
    stderrTail = '';
  child.on('close', code => (closed = { code, at: new Date().toISOString() }));
  child.stderr?.on('data', d => {
    stderrTail = (stderrTail + d).slice(-500);
    if (/Watching logs/i.test(stderrTail)) watching = true;
  });
  createInterface({ input: child.stdout }).on('line', line => {
    if (!line.startsWith('{')) return;
    lines++;
    try {
      const event = JSON.parse(line);
      if (event.kind === 'Completion' && !event.cachedResult) {
        deploymentWide.completions++;
        const minute = new Date(event.timestamp * 1000).toISOString().slice(0, 16);
        deploymentWide.perMinute[minute] = (deploymentWide.perMinute[minute] ?? 0) + 1;
        const { usage, missingFields } = completionUsage(event, [
          'databaseIoReadBytes',
          'databaseIoWriteBytes',
          'networkEgressBytes',
        ]);
        for (const field of missingFields)
          deploymentWide.missingUsageFields[field] = (deploymentWide.missingUsageFields[field] ?? 0) + 1;
        const io =
          usage.databaseIoReadBytes === null || usage.databaseIoWriteBytes === null
            ? null
            : usage.databaseIoReadBytes + usage.databaseIoWriteBytes;
        deploymentWide.ioBytes =
          deploymentWide.ioBytes === null || io === null ? null : deploymentWide.ioBytes + io;
        deploymentWide.egressBytes =
          deploymentWide.egressBytes === null || usage.networkEgressBytes === null
            ? null
            : deploymentWide.egressBytes + usage.networkEgressBytes;
      }
      monitor.observe(event);
    } catch {
      monitor.fail('BENCHMARK_LOG_SCHEMA');
    }
  });
  return {
    /** Resolves once the stream has attributed one execution to the project (the caller
     * makes a project call meanwhile). Throws when it cannot within the deadline. */
    async ready(probe, deadlineMs = 120_000) {
      const until = Date.now() + deadlineMs;
      // The stream misses calls made before it is watching (~5 s after spawn); then the probe
      // repeats every 20 s until the project's executions show up.
      let probes = 0,
        lastProbe = 0;
      while (monitor.total === 0) {
        if (closed) throw Error(`BENCH_METER_CLOSED ${closed.code} ${stderrTail.trim().slice(-200)}`);
        if (Date.now() > until)
          throw Error(
            `BENCH_METER_NOT_LIVE no project execution seen (${probes} probes, watching ${watching})`,
          );
        if (watching && Date.now() - lastProbe > 20_000) {
          lastProbe = Date.now();
          probes++;
          await probe();
        }
        await wait(1000);
      }
      return { liveAfterSeconds: (Date.now() - startedAt) / 1000, lines, probes };
    },
    stop() {
      const streamClosedEarly = closed !== null;
      child.kill();
      const r = monitor.report();
      const ioBytes =
        r.usage.databaseIoReadBytes === null || r.usage.databaseIoWriteBytes === null
          ? null
          : r.usage.databaseIoReadBytes + r.usage.databaseIoWriteBytes;
      const costInput = {
        executions: r.total,
        ioBytes,
        egressBytes: r.usage.networkEgressBytes,
        actionGbHours: r.actionGbHours,
      };
      const breakdown = costBreakdownUsd(costInput);
      const perFunction = r.perFunction.map(fn => {
        const input = {
          executions: fn.executions,
          ioBytes:
            fn.usage.databaseIoReadBytes === null || fn.usage.databaseIoWriteBytes === null
              ? null
              : fn.usage.databaseIoReadBytes + fn.usage.databaseIoWriteBytes,
          egressBytes: fn.usage.networkEgressBytes,
          actionGbHours: fn.actionGbHours,
        };
        return {
          ...fn,
          actionGbSeconds: fn.actionGbHours === null ? null : fn.actionGbHours * 3600,
          costBreakdownUsd: costBreakdownUsd(input),
          costUsd: costUsd(input),
        };
      });
      const problems = [
        ...(r.reason && r.reason !== 'total' && r.reason !== 'rate' ? [r.reason] : []),
        ...(r.coverageFailure ? [r.coverageFailure] : []),
        ...(streamClosedEarly ? [`stream closed early (${closed.code})`] : []),
        ...(lines === 0 ? ['no log lines'] : []),
        ...Object.keys(r.missingUsageFields).map(field => `missing or invalid ${field}`),
      ];
      return {
        valid: problems.length === 0,
        problems,
        reason: r.reason,
        coverageFailure: r.coverageFailure,
        streamClosedEarly,
        logLines: lines,
        projectExecutions: r.total,
        failures: r.failures,
        retainedExecutions: r.retainedExecutions,
        usage: monitor.usage,
        actionGbHours: r.actionGbHours,
        missingUsageFields: r.missingUsageFields,
        actionComputeUsd: breakdown.actionCompute,
        costBreakdownUsd: breakdown,
        perFunction,
        deploymentWide,
        costUsd: costUsd(costInput),
        notMetered: ['R2 operations and bytes', 'Convex storage'],
      };
    },
  };
}

function defaultSpawn({ deployment, cwd }) {
  return spawn('npx', ['convex', 'logs', '--deployment', deployment, '--jsonl', '--success'], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
