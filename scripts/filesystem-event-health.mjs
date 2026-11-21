// SPDX-License-Identifier: Apache-2.0
import { isMainModule } from './main-module.mjs';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, mkdir, lstat, realpath, stat as volumeStat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { childEnv } from './child-env.mjs';

const run = promisify(execFile);
/** Probe folders start with this name (src/forge-cache-paths.ts keeps the same constant). */
const EVENT_PROBE_PREFIX = '.forge-event-probe-';
// Healthy local delivery is normally milliseconds. One second allows stream arming/load
// headroom while detecting delays large enough to distort ordinary source operations.
export const FILESYSTEM_EVENT_DEADLINE_MS = 1000;
// Optional ordinary diagnostics use the shared watcher's existing close bound.
export const FILESYSTEM_EVENT_CLOSE_DEADLINE_MS = 250;

async function ensureDiagnosticDirectory(path) {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const stat = await lstat(path);
  if (!stat.isDirectory())
    throw Object.assign(new Error('Diagnostic metadata directory must be real'), { code: 'UNSAFE_PATH' });
  return stat;
}

/** The probe's private folder: in the target's client cache sibling (ROOT.forge-client), on the
 * target volume and outside the checkout, so a killed probe never leaves a file in it that a save,
 * clean or apply sees (Issue 48835eea). `id` names this run's own folder, which its caller removes. */
export async function filesystemDiagnosticDirectory(root, id = '') {
  if (id && !/^[0-9a-f-]{36}$/.test(id))
    throw Object.assign(new Error('Probe id must be a UUID'), { code: 'BAD_ARGUMENT' });
  const cache = `${await realpath(root)}.forge-client`;
  const probes = join(cache, 'event-probe');
  const directory = join(probes, id);
  await ensureDiagnosticDirectory(cache);
  const probeStat = await ensureDiagnosticDirectory(probes);
  const stat = id ? await ensureDiagnosticDirectory(directory) : probeStat;
  if (stat.dev !== (await volumeStat(root)).dev)
    throw Object.assign(new Error('Diagnostic metadata must stay on the target volume'), {
      code: 'DIAGNOSTIC_VOLUME_MISMATCH',
    });
  return directory;
}

/** No arguments or environments are inspected; ps failure leaves optional metrics unknown. */
export async function fseventsdStats({ platform = process.platform, execute = run } = {}) {
  if (platform !== 'darwin') return { fseventsdRssMb: null, fseventsdCpuPercent: null };
  try {
    const { stdout } = await execute('ps', ['-axo', 'rss=,pcpu=,comm='], {
      encoding: 'utf8',
      timeout: 500,
      maxBuffer: 1 << 20,
      env: childEnv(),
    });
    const rows = stdout.split('\n').flatMap(line => {
      const m = line.trim().match(/^(\d+)\s+([\d.]+)\s+(.+)$/);
      return m && basename(m[3]) === 'fseventsd' ? [[Number(m[1]), Number(m[2])]] : [];
    });
    if (rows.length)
      return {
        fseventsdRssMb: rows.reduce((n, row) => n + row[0], 0) / 1024,
        fseventsdCpuPercent: rows.reduce((n, row) => n + row[1], 0),
      };
  } catch {
    /* Event delivery, rather than optional process inspection, decides health. */
  }
  return { fseventsdRssMb: null, fseventsdCpuPercent: null };
}

/** Isolate native fs.watch open/close: either can wedge in FSEvents. The parent owns cleanup. */
export async function filesystemEventAttempt(
  targetDirectory,
  { execute = run, requireCloseAck = false } = {},
) {
  let directory;
  try {
    directory = await mkdtemp(join(targetDirectory, EVENT_PROBE_PREFIX));
    const { stdout } = await execute(
      process.execPath,
      [
        fileURLToPath(new URL('./filesystem-event-health-worker.mjs', import.meta.url)),
        directory,
        ...(requireCloseAck ? ['--watcher-close-health'] : []),
      ],
      {
        encoding: 'utf8',
        timeout: 2000,
        killSignal: 'SIGKILL',
        maxBuffer: 4096,
        env: childEnv(),
      },
    );
    return JSON.parse(stdout);
  } catch (error) {
    return {
      latencyMs: null,
      reason: error.killed
        ? 'watcher process timed out'
        : `watcher probe failed (${error.code ?? 'invalid response'})`,
    };
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}

/** Finite, local-only diagnostic on the caller's volume. No daemon, polling or network I/O. */
export async function probeFilesystemEvents(
  targetDirectory,
  { attempt = filesystemEventAttempt, stats = fseventsdStats, requireCloseAck = false } = {},
) {
  const attempts = [];
  for (let i = 0; i < 3; i++) {
    try {
      attempts.push(await attempt(targetDirectory, { requireCloseAck }));
    } catch (error) {
      attempts.push({ latencyMs: null, reason: `probe failed (${error.code ?? 'unknown'})` });
    }
  }
  const failed = attempts.filter(
    a =>
      a.reason ||
      !Number.isFinite(a.latencyMs) ||
      a.latencyMs > FILESYSTEM_EVENT_DEADLINE_MS ||
      a.latencyMs < 0,
  );
  const latencies = attempts
    .map(a => a.latencyMs)
    .filter(n => Number.isFinite(n) && n >= 0)
    .sort((a, b) => a - b);
  return {
    ok: failed.length < 2,
    latencyMs: latencies.length ? latencies[Math.floor(latencies.length / 2)] : null,
    ...(await stats()),
    reason:
      failed.length >= 2
        ? `${failed.length}/3 attempts failed filesystem event health (event deadline ${FILESYSTEM_EVENT_DEADLINE_MS} ms): ${failed.map(a => a.reason ?? `${a.latencyMs} ms`).join('; ')}`
        : null,
    attempts,
  };
}

/** The gate's refusal text. It says to wait: event delivery recovers by itself after a burst
 * (Item 368ac54f: a large deletion kept the gate refusing for ~20 min); restarting is never step one. */
export function filesystemEventRefusal(probe, platform = process.platform) {
  if (probe.ok) return null;
  return `ENVIRONMENT FILESYSTEM_EVENTS_UNHEALTHY: ${probe.reason}. ${
    platform === 'darwin'
      ? 'fseventsd is busy (a large deletion or copy keeps it busy for up to about 20 minutes): wait, then rerun the probe. The gate retries by itself; nothing needs restarting.'
      : 'Check local filesystem watcher resources and event delivery (on macOS, fseventsd); wait, then rerun the probe.'
  }`;
}

if (isMainModule(import.meta.url)) {
  let result;
  try {
    const root = process.argv[2] ?? process.cwd();
    const directory = process.argv.includes('--private-root')
      ? await filesystemDiagnosticDirectory(
          root,
          process.argv.find(value => value.startsWith('--probe-id='))?.slice('--probe-id='.length),
        )
      : root;
    result = await probeFilesystemEvents(directory, {
      requireCloseAck: process.argv.includes('--watcher-close-health'),
    });
  } catch (error) {
    result = {
      ok: false,
      latencyMs: null,
      ...(await fseventsdStats()),
      reason: `diagnostic setup failed (${error.code ?? 'unknown'})`,
      attempts: [],
    };
  }
  console.log(JSON.stringify(result));
  process.exitCode = result.ok ? 0 : 1;
}
