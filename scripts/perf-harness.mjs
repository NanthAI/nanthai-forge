// SPDX-License-Identifier: Apache-2.0
import { parseArgs } from 'node:util';
import { homedir, cpus, totalmem, release } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdir, writeFile, rename, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { budgets, bundleSummary, landingTiming, measurement, runtimeBuildHash } from './perf/report.mjs';

export const usage = `Usage: node scripts/perf-harness.mjs [--out private-artifacts/perf/result.json]
  [--bundle hosted-web-dist] [--build-hash SOURCE_OR_DEPLOYED_HASH] [--samples 3]
  [--work-owner OWNER --landing-id ACCEPTANCE_ID] [--cli-cold-start] [--snapshot-lane LANE_CHECKOUT]
  [--live --base DEV_URL --project ID --lane RETAINED_LANE_ID]
  [--credentials ~/.config/forge-ui-bot/credentials.json] [--timeout 60000]

Build core first. For bundle bytes, build with npm run build:hosted -- --manifest.
--live opts into read-only authenticated browser navigation, never a hosted push.
Enable QA readiness markers with VITE_FORGE_PERF=1 in the measured frontend.
Without --live, browser numbers are unrun. --cli-cold-start runs the built CLI's
--version (node dist/cli-entry.js) --samples times and judges its CPU time (user+sys,
which a loaded machine barely moves) against the cliColdStartCpu budget; it needs
/usr/bin/time and is unrun otherwise. --snapshot-lane runs in a Lane checkout of a scratch project with
policy autoSnapshot on (never a real project's Lane) and judges what a snapshot adds to a command
against the snapshotAdded* budgets; it needs a network and is unrun otherwise. Budgets live in
src/speed-budgets.json.
Work timings read only existing records; this command never
starts a check, finish, landing or backfill.
JSON contains machine/build identities, timestamps, each sample and median budget
pass/fail. A failed or exceeded budget exits 1; unrun is never a pass.`;

export function options(args) {
  const { values } = parseArgs({
    args,
    options: {
      help: { type: 'boolean' },
      live: { type: 'boolean', default: false },
      'cli-cold-start': { type: 'boolean', default: false },
      'snapshot-lane': { type: 'string' },
      base: { type: 'string' },
      project: { type: 'string' },
      lane: { type: 'string' },
      out: { type: 'string', default: 'private-artifacts/perf/result.json' },
      bundle: { type: 'string' },
      'build-hash': { type: 'string' },
      'work-owner': { type: 'string' },
      'landing-id': { type: 'string' },
      samples: { type: 'string', default: '3' },
      timeout: { type: 'string', default: '60000' },
      credentials: { type: 'string', default: join(homedir(), '.config/forge-ui-bot/credentials.json') },
    },
  });
  if (values.help) return { help: true };
  for (const key of ['samples', 'timeout']) {
    values[key] = Number(values[key]);
    if (!Number.isSafeInteger(values[key]) || values[key] <= 0) throw new Error('PERF_OPTIONS');
  }
  if (values.live) {
    const url = new URL(values.base);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      throw new Error('PERF_OPTIONS');
  }
  if (values['landing-id'] && !values['work-owner']) throw new Error('PERF_OPTIONS');
  return values;
}

/** CPU milliseconds (user+sys) of `node dist/cli-entry.js --version`, one sample per run, from the
 * `time -p` the platform ships. Wall time is recorded too but not judged: it moves with machine load. */
export function cliColdStartSamples(
  count,
  command = ['/usr/bin/time', '-p', process.execPath, 'dist/cli-entry.js', '--version'],
) {
  const samples = [];
  for (let n = 0; n < count; n++) {
    const started = performance.now();
    const child = spawnSync(command[0], command.slice(1), { encoding: 'utf8', timeout: 60_000 });
    const wallMs = Math.round(performance.now() - started);
    const cpu = cpuMs(child.stderr ?? '');
    samples.push({ durationMs: child.status === 0 && cpu !== null ? cpu : NaN, wallMs });
  }
  return samples;
}
export function cpuMs(timeOutput) {
  const user = /^user\s+([\d.]+)/m.exec(timeOutput)?.[1],
    system = /^sys\s+([\d.]+)/m.exec(timeOutput)?.[1];
  return user === undefined || system === undefined
    ? null
    : Math.round((Number(user) + Number(system)) * 1000);
}

export async function main(args) {
  const config = options(args);
  if (config.help) {
    console.log(usage);
    return;
  }
  process.chdir(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
  const record = {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    machine: {
      platform: process.platform,
      release: release(),
      arch: process.arch,
      node: process.version,
      cpu: cpus()[0]?.model ?? null,
      cpuCount: cpus().length,
      memoryBytes: totalmem(),
    },
    buildHash: config['build-hash'] ?? (await runtimeBuildHash('dist')),
    buildHashSource: config['build-hash']
      ? 'caller-supplied source/deployment identity'
      : 'SHA-256 of sorted local dist/*.js names and bytes; not a deployed frontend identity',
    budgets,
    browser: {
      mode: config.live ? 'live read-only navigation' : 'unrun',
      cold: 'fresh context per sample; authenticated storage reused in memory; HTTP cache disabled; no service workers',
      buildHash: config.live ? (config['build-hash'] ?? null) : null,
    },
    measurements: {},
  };
  if (config.bundle) {
    try {
      record.bundle = await bundleSummary(resolve(config.bundle));
      const max = budgets.eagerJsGzipBytes;
      record.bundle.budget = {
        metric: 'eagerJsGzipBytes',
        max,
        status: record.bundle.eagerJsGzipBytes <= max ? 'pass' : 'fail',
      };
    } catch {
      record.bundle = {
        status: 'failed',
        reason: 'Build directory or Vite manifest unavailable; build with --manifest.',
      };
    }
  }
  for (const name of ['now', 'work', 'laneFirstDiff'])
    record.measurements[name] = measurement(
      name,
      [],
      'Live authenticated browser measurement unrun; use --live with a QA-instrumented frontend.',
    );
  if (config.live) {
    try {
      const { browserSamples } = await import('./perf/browser.mjs');
      const observed = await browserSamples(config);
      record.browser.version = observed.browserVersion;
      for (const name of ['now', 'work', 'laneFirstDiff'])
        record.measurements[name] = measurement(name, observed.samples[name], observed.reason);
    } catch (error) {
      // Only the typed bot-access error carries a message: it names a project id and a command, no secrets.
      const reason =
        error?.code === 'BOT_NO_READER_GRANT'
          ? error.message
          : 'Live browser setup failed; verify the private bot file, Chromium, dev origin and authenticated access. Details redacted.';
      for (const name of ['now', 'work', 'laneFirstDiff'])
        record.measurements[name] = measurement(name, [], reason);
      record.browser.status = 'failed';
    }
  }
  record.measurements.cliColdStartCpu = config['cli-cold-start']
    ? measurement('cliColdStartCpu', cliColdStartSamples(config.samples))
    : measurement(
        'cliColdStartCpu',
        [],
        'Pass --cli-cold-start to run the built CLI (needs npm run build:core).',
      );
  const snapshotReason = 'Pass --snapshot-lane LANE_CHECKOUT (a scratch project with autoSnapshot on).';
  record.measurements.snapshotAddedUnchangedMs = measurement('snapshotAddedUnchangedMs', [], snapshotReason);
  record.measurements.snapshotAddedChangedMs = measurement('snapshotAddedChangedMs', [], snapshotReason);
  if (config['snapshot-lane']) {
    try {
      const { snapshotLatencySamples } = await import('./perf/snapshot-latency.mjs');
      const observed = await snapshotLatencySamples(resolve(config['snapshot-lane']), config.samples);
      record.measurements.snapshotAddedUnchangedMs = measurement(
        'snapshotAddedUnchangedMs',
        observed.unchanged,
      );
      record.measurements.snapshotAddedChangedMs = measurement('snapshotAddedChangedMs', observed.changed);
    } catch {
      for (const name of ['snapshotAddedUnchangedMs', 'snapshotAddedChangedMs'])
        record.measurements[name] = measurement(name, [], 'Snapshot latency run failed; details redacted.');
    }
  }
  record.landing = {
    status: 'unrun',
    reason: 'Supply --work-owner to read retained acceptance and check records.',
  };
  if (config['work-owner']) {
    try {
      const { WorkStore } = await import('../dist/work-store.js');
      const { nativeOwner } = await import('../dist/native-source.js');
      const owner = nativeOwner(resolve(config['work-owner']));
      if (!owner || !(await stat(join(owner, '.forge/work/work.json'))).isFile())
        throw new Error('PERF_EXISTING_NATIVE_WORK_REQUIRED');
      record.landing = landingTiming(new WorkStore(owner).load(), config['landing-id']);
    } catch {
      record.landing = { status: 'failed', reason: 'Work records could not be read. No mutation performed.' };
    }
  }
  record.endedAt = new Date().toISOString();
  record.status =
    record.browser.status === 'failed' ||
    record.bundle?.status === 'failed' ||
    record.bundle?.budget?.status === 'fail' ||
    record.landing.status === 'failed' ||
    Object.values(record.measurements).some(m => ['fail', 'failed'].includes(m.status))
      ? 'fail'
      : record.landing.status === 'unrun' ||
          Object.values(record.measurements).some(m => m.status === 'unrun')
        ? 'partial'
        : 'pass';
  const output = resolve(config.out);
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  await writeFile(`${output}.tmp`, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  await rename(`${output}.tmp`, output);
  console.log(
    JSON.stringify({
      status: record.status,
      measurements: Object.fromEntries(
        Object.entries(record.measurements).map(([key, m]) => [
          key,
          { status: m.status, medianMs: m.medianMs },
        ]),
      ),
      landing: record.landing.status,
    }),
  );
  if (record.status === 'fail') process.exitCode = 1;
  return record;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  main(process.argv.slice(2)).catch(() => {
    console.error(
      'PERF_HARNESS_FAILED: invalid options or result write failed; details redacted. Use --help.',
    );
    process.exitCode = 1;
  });
