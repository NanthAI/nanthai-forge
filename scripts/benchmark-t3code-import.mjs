#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// B1.5c live big-repository import, run under the scheduled-import guard.
// Usage: node scripts/benchmark-t3code-import.mjs DIR '{"repository":"o/r","ref":"SHA","name":"..."}'
// DIR receives journal.json (resume pins), progress.jsonl and report.json. Run it again
// with the same DIR to resume the same import operation after a crash.
//
// Telemetry: `convex logs --jsonl` (user login, read-only, zero Convex functions) feeds
// the guard; raw log lines are never written. Owner calls use the saved nforge CLI
// credential in memory; internal guard calls use `convex run` (deployment login).
// The import itself never deletes: deletion happens on a guard breach, or after the run
// when FORGE_IMPORT_TEARDOWN=1 (guard cancellation, owner delete, then a finite wait for
// the purge; rerunning with the same DIR resumes a teardown that stopped part way).
// GitHub REST rate limits stop the job with GITHUB_RATE_LIMIT; the driver resumes the
// same operation after the limit window instead of starting a new import. Builds before
// the blob-endpoint classification fix report a rate-limited blob as GITHUB_UNAVAILABLE;
// the driver treats that as a rate limit only when `gh api rate_limit` (free, not counted)
// shows the shared core quota at 0, and waits for that reset.
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { createInterface } from 'node:readline';
import { deadlineConvexClient } from '../dist/network-convex-client.js';
import { makeFunctionReference as ref, getFunctionName } from 'convex/server';
import { importBenchmarkGuard } from './benchmark-import-guard.mjs';

const DEPLOYMENT = process.env.FORGE_BENCH_DEPLOYMENT || 'benevolent-wildebeest-974';
const URL = `https://${DEPLOYMENT}.convex.cloud`;
const STATUS_EVERY_MS = Number(process.env.FORGE_IMPORT_STATUS_MS || 180_000); // finite harness observation, counted in the report
if (!Number.isSafeInteger(STATUS_EVERY_MS) || STATUS_EVERY_MS < 1000)
  throw Error('Invalid status observation interval.');
const RATE_LIMIT_WAIT_MS = 15 * 60_000;
/** Shared REST quota of the local gh login: { remaining, resetMs } or null. */
function githubCore() {
  try {
    const core = JSON.parse(execFileSync('gh', ['api', 'rate_limit'], { encoding: 'utf8' })).resources.core;
    return { remaining: core.remaining, resetMs: core.reset * 1000 };
  } catch {
    return null;
  }
}
const QUIET_MS = 300_000;
const MAX_WALL_MS = 10 * 60 * 60_000;

const [dir, specJson] = process.argv.slice(2);
const spec = JSON.parse(specJson);
mkdirSync(dir, { recursive: true });
const journalPath = join(dir, 'journal.json');
const journal = existsSync(journalPath) ? JSON.parse(readFileSync(journalPath, 'utf8')) : {};
const saveJournal = async () => {
  writeFileSync(journalPath + '.tmp', JSON.stringify(journal, null, 1));
  renameSync(journalPath + '.tmp', journalPath);
};
const log = entry =>
  appendFileSync(
    join(dir, 'progress.jsonl'),
    JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n',
  );

const auth = JSON.parse(
  readFileSync(join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'forge', 'auth.json'), 'utf8'),
);
const credential = auth.deployments[URL];
if (!credential || credential.expiresAt < Date.now())
  throw Error('Forge CLI credential missing or expired for ' + URL);
const owner = deadlineConvexClient(URL, {});
owner.setAuth(credential.token);

const convexRun = (name, args) =>
  new Promise((resolve, reject) => {
    const child = spawn('npx', ['convex', 'run', '--deployment', DEPLOYMENT, name, JSON.stringify(args)], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let out = '';
    child.stdout.on('data', d => (out += d));
    child.on('close', code => {
      if (code !== 0) return reject(Error(`convex run ${name} exited ${code}`));
      try {
        resolve(JSON.parse(out));
      } catch {
        reject(Error(`convex run ${name} returned non-JSON`));
      }
    });
  });
const admin = {
  query: (fn, args) => convexRun(getFunctionName(fn), args),
  mutation: (fn, args) => convexRun(getFunctionName(fn), args),
};

journal.operationId ??= randomUUID();
journal.since ??= Date.now();
journal.spec ??= spec;
if (JSON.stringify(journal.spec) !== JSON.stringify(spec))
  throw Error('Journal belongs to a different import request.');
await saveJournal();

const guard = importBenchmarkGuard({
  projectId: journal.projectId,
  name: spec.name,
  creationOperationId: journal.operationId,
  journal,
  saveJournal,
  since: journal.since,
  admin,
  owner,
});
// Also total DB I/O and egress bytes for the cost model (the guard sums every usage key).
guard.monitor.usage = {
  databaseReadDocuments: 0,
  databaseWriteDocuments: 0,
  databaseIoReadBytes: 0,
  databaseIoWriteBytes: 0,
  storageReadBytes: 0,
  storageWriteBytes: 0,
  networkEgressBytes: 0,
};
const deployment = { completions: 0, failures: 0, ioReadBytes: 0, ioWriteBytes: 0, egressBytes: 0 };
let peakMemoryMb = 0;
const metrics = [];
const metricNumbers = [
  'at',
  'elapsedMillis',
  'files',
  'sourceBytes',
  'objects',
  'putAttempts',
  'putBytes',
  'uploadMillis',
  'peakBufferedBytes',
  'rssBytes',
];

let logs,
  streamFailed = false,
  stopping = false;
const logRestarts = { count: 0 };
/** The provider log stream. A dropped stream (a dev redeploy, a network blip) is reopened
 * with recent history up to 10 times: the guard drops events it already counted, and
 * the deployment totals below do the same. Past that, the run stops as telemetry-lost. */
function openLogs(history) {
  logs = spawn(
    'npx',
    [
      'convex',
      'logs',
      '--deployment',
      DEPLOYMENT,
      '--jsonl',
      '--success',
      ...(history ? ['--history', String(history)] : []),
    ],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );
  logs.on('close', () => {
    if (stopping) return;
    if (logRestarts.count >= 10) {
      streamFailed = true;
      return;
    }
    logRestarts.count++;
    log({ event: 'logs-reopened', restarts: logRestarts.count });
    openLogs(5000);
  });
  createInterface({ input: logs.stdout }).on('line', onLogLine);
}
const counted = new Set();
function onLogLine(line) {
  if (!line.startsWith('{')) return;
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return;
  }
  const key = `${event.requestId}:${event.executionId}:${event.executionTimestamp ?? event.timestamp}:${event.timestamp}`;
  if (event.kind === 'Completion' && !event.cachedResult && !counted.has(key)) {
    counted.add(key);
    deployment.completions++;
    deployment.failures += event.error ? 1 : 0;
    deployment.ioReadBytes += event.usageStats?.databaseIoReadBytes ?? 0;
    deployment.ioWriteBytes += event.usageStats?.databaseIoWriteBytes ?? 0;
    deployment.egressBytes += event.usageStats?.networkEgressBytes ?? 0;
  }
  const before = guard.monitor.total;
  guard.observe(event);
  // Fixed schema only: never persist provider log lines, URLs or credentials.
  for (const line of event.logLines ?? []) {
    const value = typeof line === 'string' ? line : (line.messages ?? []).join(' ');
    const match = value.match(/FORGE_IMPORT_METRIC (\{.*\})/);
    if (!match) continue;
    try {
      const data = JSON.parse(match[1]);
      if (
        data.projectId !== guard.monitor.target.projectId ||
        ![
          'upload',
          'listing-stored',
          'listing',
          'resume',
          'archive-open',
          'archive-complete',
          'metadata',
          'catalog',
          'projection',
          'ready',
        ].includes(data.phase)
      )
        continue;
      const metric = { phase: data.phase, executionId: event.executionId };
      for (const key of metricNumbers) if (Number.isFinite(data[key])) metric[key] = data[key];
      if (!metrics.some(prior => JSON.stringify(prior) === JSON.stringify(metric))) {
        metrics.push(metric);
        log({ event: 'metric', ...metric });
      }
    } catch {
      /* Ignore unrelated provider text. */
    }
  }
  if (guard.monitor.total > before)
    peakMemoryMb = Math.max(peakMemoryMb, event.usageStats?.memoryUsedMb ?? 0);
  if (!journal.projectId && guard.monitor.target.projectId) {
    journal.projectId = guard.monitor.target.projectId;
    saveJournal();
  }
}
openLogs();
await wait(5_000); // let the stream attach before the workload starts

const harness = { startCalls: 0, statusCalls: 0, resumes: 0, logRestarts };
const startImport = async () => {
  harness.startCalls++;
  return owner.action(ref('projectGithubImport:start'), {
    operationId: journal.operationId,
    url: `https://github.com/${spec.repository}`,
    ref: spec.ref,
    name: spec.name,
  });
};
const status = async () => {
  harness.statusCalls++;
  return owner.action(ref('projectGithubImport:status'), { id: journal.jobId });
};

const report = extra => {
  const out = {
    spec,
    operationId: journal.operationId,
    jobId: journal.jobId,
    projectId: journal.projectId ?? guard.monitor.target.projectId,
    startedAt: new Date(journal.since).toISOString(),
    ...extra,
    guard: guard.report(),
    peakActionMemoryMb: peakMemoryMb,
    harness,
    deploymentWindow: deployment,
    streamFailed,
    metrics,
    statusEveryMs: STATUS_EVERY_MS,
  };
  writeFileSync(join(dir, 'report.json'), JSON.stringify(out, null, 1));
  return out;
};

const ticker = setInterval(
  () => guard.tick().catch(error => log({ event: 'guard-error', error: String(error.message) })),
  1000,
);
let outcome = 'unknown',
  last;
try {
  // Always repeat start: the same operation resumes a stopped or errored worker and is a
  // no-op for a running or ready one. Earlier runs' reports stay as report-<ms>.json.
  if (existsSync(join(dir, 'report.json')))
    renameSync(join(dir, 'report.json'), join(dir, `report-${Date.now()}.json`));
  delete journal.finishedAt;
  journal.jobId = await startImport();
  await saveJournal();
  log({ event: 'started', jobId: journal.jobId });
  const deadline = journal.since + MAX_WALL_MS;
  while (true) {
    if (guard.monitor.reason) {
      outcome = `guard-stop:${guard.monitor.reason}`;
      log({ event: 'guard-breach', reason: guard.monitor.reason });
      await guard.stop();
      break;
    }
    if (streamFailed) {
      outcome = 'telemetry-lost';
      break;
    }
    if (Date.now() > deadline) {
      outcome = 'deadline';
      break;
    }
    last = await status();
    if (!guard.monitor.target.projectId && last.projectId) {
      // Fallback attribution if the creation marker was not observed.
      guard.monitor.target.projectId = journal.projectId = last.projectId;
      await saveJournal();
    }
    log({
      event: 'status',
      phase: last.phase,
      completed: last.completed,
      total: last.total,
      totalKnown: last.totalKnown,
      error: last.error?.code ?? null,
      executions: guard.monitor.total,
    });
    report({ outcome: 'running', last });
    if (last.phase === 'ready') {
      outcome = 'ready';
      break;
    }
    if (last.phase === 'error') {
      if (last.error?.code === 'GITHUB_IMPORT_INTERRUPTED' && harness.resumes < 20) {
        // A dev redeploy (other builders' landings) can stop the worker mid-step.
        log({ event: 'interrupted' });
        harness.resumes++;
        await startImport();
        continue;
      }
      const core = githubCore();
      const exhausted = core?.remaining === 0;
      if (
        last.error?.code !== 'GITHUB_RATE_LIMIT' &&
        !(last.error?.code === 'GITHUB_UNAVAILABLE' && exhausted)
      ) {
        outcome = `import-error:${last.error?.code}`;
        break;
      }
      const waitMs = exhausted
        ? Math.min(Math.max(core.resetMs - Date.now(), 0) + 60_000, 65 * 60_000)
        : RATE_LIMIT_WAIT_MS;
      log({ event: 'rate-limited', code: last.error?.code, coreRemaining: core?.remaining ?? null, waitMs });
      await wait(waitMs);
      harness.resumes++;
      await startImport(); // same operation: resumes the stopped worker
      continue;
    }
    await wait(STATUS_EVERY_MS);
  }
  journal.finishedAt ??= Date.now();
  await saveJournal();
  if (outcome === 'ready') {
    // Idle proof: provider logs only, no Convex calls. Any late attributed execution resets it.
    while (
      !(
        guard.monitor.running.size === 0 &&
        Date.now() - Math.max(guard.monitor.lastExecution, journal.finishedAt) >= QUIET_MS
      )
    ) {
      if (streamFailed) {
        outcome = 'ready-quiet-unproven';
        break;
      }
      await wait(5_000);
    }
  }
} catch (error) {
  outcome = `driver-error:${error.data?.code ?? error.message}`;
}
let teardown = null;
if (process.env.FORGE_IMPORT_TEARDOWN === '1')
  try {
    await guard.stop();
    // The purge settles 20 minutes after removal (purgeSettleMs: presigned PUT expiry + 5 min).
    const until = Date.now() + 25 * 60_000;
    while (!(await guard.confirmDeleted()) && Date.now() < until) await wait(10_000);
    teardown = guard.report().deleted ? 'deleted' : 'delete-pending';
  } catch (error) {
    teardown = `failed:${error.data?.code ?? error.message}`;
  }
if (teardown) log({ event: 'teardown', teardown });
clearInterval(ticker);
stopping = true;
logs.kill();
const final = report({
  outcome,
  last,
  finishedAt: new Date(journal.finishedAt ?? Date.now()).toISOString(),
  quietProvenAt: outcome === 'ready' ? new Date().toISOString() : null,
  teardown,
});
log({ event: 'done', outcome, executions: final.guard.total });
console.log(
  JSON.stringify({
    outcome,
    projectId: final.projectId,
    executions: final.guard.total,
    failures: final.guard.failures,
  }),
);
process.exit(outcome === 'ready' ? 0 : 1);
