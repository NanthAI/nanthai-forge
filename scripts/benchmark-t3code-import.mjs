#!/usr/bin/env node
// B1.5c live big-repository import, run under the scheduled-import guard.
// Usage: node scripts/benchmark-t3code-import.mjs DIR '{"repository":"o/r","ref":"SHA","name":"..."}'
// DIR receives journal.json (resume pins), progress.jsonl and report.json. Run it again
// with the same DIR to resume the same import operation after a crash.
//
// Telemetry: `convex logs --jsonl` (user login, read-only, zero Convex functions) feeds
// the guard; raw log lines are never written. Owner calls use the saved nforge CLI
// credential in memory; internal guard calls use `convex run` (deployment login).
// The import itself never deletes: deletion happens only on a guard breach.
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
import { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference as ref, getFunctionName } from 'convex/server';
import { importBenchmarkGuard } from './benchmark-import-guard.mjs';

const DEPLOYMENT = process.env.FORGE_BENCH_DEPLOYMENT || 'benevolent-wildebeest-974';
const URL = `https://${DEPLOYMENT}.convex.cloud`;
const STATUS_EVERY_MS = 180_000; // finite harness observation, counted in the report
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
const owner = new ConvexHttpClient(URL);
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

const logs = spawn('npx', ['convex', 'logs', '--deployment', DEPLOYMENT, '--jsonl', '--success'], {
  stdio: ['ignore', 'pipe', 'ignore'],
});
let streamFailed = false;
logs.on('close', () => (streamFailed = !stopping));
let stopping = false;
createInterface({ input: logs.stdout }).on('line', line => {
  if (!line.startsWith('{')) return;
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return;
  }
  if (event.kind === 'Completion' && !event.cachedResult) {
    deployment.completions++;
    deployment.failures += event.error ? 1 : 0;
    deployment.ioReadBytes += event.usageStats?.databaseIoReadBytes ?? 0;
    deployment.ioWriteBytes += event.usageStats?.databaseIoWriteBytes ?? 0;
    deployment.egressBytes += event.usageStats?.networkEgressBytes ?? 0;
  }
  const before = guard.monitor.total;
  guard.observe(event);
  if (guard.monitor.total > before)
    peakMemoryMb = Math.max(peakMemoryMb, event.usageStats?.memoryUsedMb ?? 0);
  if (!journal.projectId && guard.monitor.target.projectId) {
    journal.projectId = guard.monitor.target.projectId;
    saveJournal();
  }
});
await wait(5_000); // let the stream attach before the workload starts

const harness = { startCalls: 0, statusCalls: 0, resumes: 0 };
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
clearInterval(ticker);
stopping = true;
logs.kill();
const final = report({
  outcome,
  last,
  finishedAt: new Date(journal.finishedAt ?? Date.now()).toISOString(),
  quietProvenAt: outcome === 'ready' ? new Date().toISOString() : null,
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
