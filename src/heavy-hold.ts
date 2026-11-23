// SPDX-License-Identifier: Apache-2.0
// What one `nforge heavy` hold may use and what it leaves behind (Item 7008ff18): the slot's core
// share for every runner started inside it, and a dated, attributed, bounded record of the hold.
// Local files only; no server calls.
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { loadavg, tmpdir } from 'node:os';
import { join } from 'node:path';
import { ownerOnly } from './file-mode.js';
import type { HeavyHold, HeavyKind } from './heavy-queue.js';

/** Cores one slot may use: the cores shared by the slots, at least one. A slot limits jobs, not
 * CPU; without this each job ran up to cores - 1 test files (load 165 on 10 cores with 3 slots). */
export const testWorkersPerSlot = (cores: number, slots: number) =>
  Math.max(1, Math.floor(cores / Math.max(1, slots)));

const PRELOAD_PREFIX = 'forge-heavy-cap-';
/** Only a preload heavy itself wrote: `<tmp>/forge-heavy-cap-<id>/preload-<12 hex>.cjs`, so a caller's own `--require` that merely sits under a folder of that name stays. */
const HEAVY_PRELOAD_OPTION =
  /(?:^|\s+)--require="(?:[^"\\]|\\.)*[\/\\]forge-heavy-cap-[^"\\\/]*(?:\\\\|\/)preload-[0-9a-f]{12}\.cjs"/g;
/** Loaded with --require by every Node process in the slot (a `--import` never runs in the test
 * runner's own process). An uncapped `node --test` restarts in place with the slot's cap; its own
 * --test-concurrency wins; the runner's per-file children (NODE_TEST_CONTEXT) and Node before
 * 20.10 (no --test-concurrency) are left alone. Where process.execve is missing or refused
 * (Windows, Node before 22.15, a worker), the capped runner runs as a blocking child instead: a
 * signal sent to this process alone, not its group, then does not reach that runner. When
 * `--test-name-pattern` is passed and matches no top-level test across the run, the runner warns
 * on stderr before exiting (friction 24456142). */
const PRELOAD = `'use strict';
const n = process.env.FORGE_HEAVY_TEST_CONCURRENCY, a = process.execArgv, isTest = a.includes('--test');
const [major, minor] = process.versions.node.split('.').map(Number);
if (/^[1-9][0-9]*$/.test(n || '') && !process.env.NODE_TEST_CONTEXT && isTest &&
  (major > 20 || (major === 20 && minor >= 10)) &&
  !a.some(x => x === '--test-concurrency' || x.startsWith('--test-concurrency='))) {
  // Paths after --, so a file named like an option stays a path.
  const files = process.argv.slice(1), args = ['--test-concurrency=' + n, ...a, ...(files.length ? ['--', ...files] : [])];
  if (process.platform !== 'win32' && typeof process.execve === 'function' && require('node:worker_threads').isMainThread)
    try { process.execve(process.execPath, [process.execPath, ...args]); } catch {}
  const run = require('node:child_process').spawnSync(process.execPath, args, { stdio: 'inherit' });
  if (run.signal) process.kill(process.pid, run.signal);
  process.exit(run.status === null ? 1 : run.status);
}
if (!process.env.NODE_TEST_CONTEXT && isTest) {
  const words = a.concat((process.env.NODE_OPTIONS || '').split(/\\s+/).filter(Boolean)), patterns = [];
  for (let i = 0; i < words.length; i++) {
    if (words[i] === '--test-name-pattern' && words[i + 1] !== undefined) patterns.push(words[++i]);
    else if (words[i].startsWith('--test-name-pattern=')) patterns.push(words[i].slice(20));
  }
  // Without per-file children (--test-isolation=none) no frame says what matched: stay silent
  // rather than guess.
  const inProcess = words.includes('--test-isolation=none') || words.some((x, i) => x === '--test-isolation' && words[i + 1] === 'none');
  if (patterns.length && !inProcess) {
    const fs = require('node:fs'), marker = require('node:path').join(__dirname, 'pat-' + process.pid);
    try { fs.rmSync(marker, { force: true }); } catch {}
    process.env.FORGE_HEAVY_PATTERN_MATCH = marker;
    process.once('exit', () => {
      const matched = fs.existsSync(marker);
      try { fs.rmSync(marker, { force: true }); } catch {}
      if (!matched)
        process.stderr.write(
          'heavy: warning: --test-name-pattern (' + patterns.join(', ') + ') matched no top-level test; node --test filters top-level test names first and still reports 1 pass per file when none match.\\n'
        );
    });
  }
} else if (process.env.NODE_TEST_CONTEXT && process.env.FORGE_HEAVY_PATTERN_MATCH) {
  const marker = process.env.FORGE_HEAVY_PATTERN_MATCH;
  delete process.env.FORGE_HEAVY_PATTERN_MATCH;
  let hit = false;
  // The runner's per-file child writes one V8-serialized frame per event (a 4-byte size, then
  // ff 0f 6f ...). A top-level test that was selected enqueues (runnable, skipped or todo);
  // setup output, nested tests and diagnostics do not count. Frames before the first match are
  // few (plan, diagnostics), so decoding stops at the first hit.
  const write = process.stdout.write, mark = Buffer.from([0xff, 0x0f, 0x6f]);
  process.stdout.write = function(chunk, ...rest) {
    if (!hit && chunk instanceof Uint8Array) {
      try {
        const at = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).indexOf(mark);
        const event = at < 0 ? null : require('node:v8').deserialize(Buffer.from(chunk.buffer, chunk.byteOffset + at, chunk.byteLength - at));
        if (event && event.type === 'test:enqueue' && event.data && event.data.nesting === 0) {
          hit = true;
          require('node:fs').writeFileSync(marker, '');
        }
      } catch {}
    }
    return write.call(this, chunk, ...rest);
  };
}
`;
const PRELOAD_NAME = `preload-${createHash('sha256').update(PRELOAD).digest('hex').slice(0, 12)}.cjs`;

/** The preload's file: in this user's own cache folder (created 0700 and checked to be a real,
 * private folder this user owns, so no other account can plant code every Node process would
 * load), written once by name hash and reused, so a killed heavy leaves nothing. A folder that
 * fails the check falls back to a fresh private one per command, removed afterwards. */
function preloadFile(): { file: string; owned: string | null } | null {
  const name = PRELOAD_NAME;
  const uid = process.getuid?.();
  const shared = join(tmpdir(), `${PRELOAD_PREFIX}${uid ?? 'user'}`);
  try {
    mkdirSync(shared, { mode: 0o700 });
  } catch {}
  try {
    const folder = lstatSync(shared);
    const ours =
      folder.isDirectory() && (uid === undefined || (folder.uid === uid && ownerOnly(folder.mode)));
    if (ours) {
      const file = join(shared, name);
      if (!existsSync(file)) {
        const temporary = join(shared, `t-${process.pid}-${randomUUID().slice(0, 8)}.tmp`);
        writeFileSync(temporary, PRELOAD, { mode: 0o600 });
        renameSync(temporary, file);
      }
      return { file, owned: null };
    }
  } catch {}
  try {
    const owned = mkdtempSync(join(tmpdir(), PRELOAD_PREFIX));
    writeFileSync(join(owned, name), PRELOAD, { mode: 0o600 });
    return { file: join(owned, name), owned };
  } catch {
    return null; // A full or read-only temp folder costs the test cap, never the held slot.
  }
}

/**
 * Variables that bound every runner a slot starts, however deep (npm script, sh -c, npx, a script
 * spawning process.execPath, nested `nforge heavy`), to the slot's core share: `node --test`
 * through a preload, Go tools such as the native TypeScript checker through GOMAXPROCS, Rust rayon
 * tools through RAYON_NUM_THREADS. A value already set (by the command or an outer slot) wins.
 */
export function slotCapEnv(env: NodeJS.ProcessEnv, cores: number, slots: number, alwaysPreload = false) {
  if (slots <= 0 && !alwaysPreload) return { env: {} as Record<string, string>, dispose() {} };
  const share =
    slots <= 0
      ? null
      : /^[1-9][0-9]*$/.test(env.FORGE_HEAVY_TEST_CONCURRENCY ?? '')
        ? env.FORGE_HEAVY_TEST_CONCURRENCY!
        : String(testWorkersPerSlot(cores, slots));
  const options = (env.NODE_OPTIONS ?? '').replace(HEAVY_PRELOAD_OPTION, '').trim();
  let owned: string | null = null;
  let nodeOptions = env.NODE_OPTIONS ?? '';
  const preload = nodeOptions.includes(PRELOAD_NAME) ? null : preloadFile();
  if (preload) {
    owned = preload.owned;
    nodeOptions = `${options ? `${options} ` : ''}--require="${preload.file.replace(/["\\]/g, '\\$&')}"`;
  }
  return {
    env: {
      NODE_OPTIONS: nodeOptions,
      ...(share
        ? {
            FORGE_HEAVY_TEST_CONCURRENCY: share,
            GOMAXPROCS: env.GOMAXPROCS || share,
            RAYON_NUM_THREADS: env.RAYON_NUM_THREADS || share,
          }
        : {}),
    },
    dispose: () => owned && rmSync(owned, { recursive: true, force: true }),
  };
}

/** The kind of a heavy command from its words, for the history only (the words are never stored). */
export function commandKind(args: string[]): HeavyKind {
  const text = ` ${args.join(' ')} `;
  if (
    /\s--test(?=[\s=])/.test(text) ||
    /\b(?:npm|pnpm|yarn|bun)(?:\.cmd)?\s+(?:run\s+(?:(?:-s|--silent)\s+)?)?test\b/.test(text) ||
    /\b(?:vitest|jest|mocha|preflight)\b/.test(text)
  )
    return 'test';
  if (/\b(?:tsc|tsgo|vue-tsc|typecheck)\b/.test(text)) return 'typecheck';
  if (/\b(?:build|esbuild|webpack|rollup|vite)\b/.test(text)) return 'build';
  return 'other';
}

const minutes = (ms: number) => Math.round(ms / 6000) / 10;
/** p50/p90 queue wait in seconds over the holds that recorded one; null before any did. */
function waitSummary(holds: HeavyHold[]) {
  const waits = holds
    .flatMap(hold => (typeof hold.wait === 'number' ? [hold.wait] : []))
    .sort((a, b) => a - b);
  if (!waits.length) return null;
  const at = (share: number) => {
    const ms = waits[Math.min(waits.length - 1, Math.floor(share * waits.length))] ?? 0;
    return Math.round(ms / 100) / 10;
  };
  return { holds: waits.length, p50Seconds: at(0.5), p90Seconds: at(0.9) };
}
/** The last day of holds in a few lines: time per kind, the busiest Lanes and the peaks with who
 * held the slot then, so a load spike can be explained afterwards. */
export function holdSummary(holds: HeavyHold[], now = Date.now(), windowMs = 86_400_000) {
  const day = holds.filter(hold => hold.at + hold.ms >= now - windowMs);
  const byKind: Record<string, { holds: number; minutes: number }> = {};
  const byLane = new Map<string, number>();
  for (const hold of day) {
    const kind = (byKind[hold.kind] ??= { holds: 0, minutes: 0 });
    kind.holds++;
    kind.minutes += hold.ms;
    const lane = hold.lane?.slice(0, 8) ?? 'none';
    byLane.set(lane, (byLane.get(lane) ?? 0) + hold.ms);
  }
  for (const kind of Object.values(byKind)) kind.minutes = minutes(kind.minutes);
  const peak = (key: 'cpu' | 'load') => {
    const top = day.reduce<HeavyHold | null>(
      (best, hold) => (hold[key] !== null && (best === null || hold[key]! > best[key]!) ? hold : best),
      null,
    );
    return (
      top && {
        [key]: top[key],
        at: new Date(top.at).toISOString(),
        lane: top.lane?.slice(0, 8) ?? null,
        kind: top.kind,
      }
    );
  };
  return {
    since: new Date(now - windowMs).toISOString(),
    holds: day.length,
    byKind,
    lanes: [...byLane]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([lane, ms]) => ({ lane, minutes: minutes(ms) })),
    peakCpu: peak('cpu'),
    peakLoad: peak('load'),
    // Queue wait before each hold (ff33e9a6), for the measured before/after of the admission rule.
    wait: waitSummary(day),
  };
}

/** Cores used by `root` and its descendants, from `ps -o pid=,ppid=,pcpu=` lines. */
export function treeCpu(psOutput: string, root: number): number | null {
  const children = new Map<number, number[]>(),
    cpu = new Map<number, number>();
  for (const line of psOutput.split('\n')) {
    const [pid, ppid, pcpu] = line.trim().split(/\s+/).map(Number);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid) || !Number.isFinite(pcpu)) continue;
    cpu.set(pid!, pcpu!);
    children.set(ppid!, [...(children.get(ppid!) ?? []), pid!]);
  }
  if (!cpu.has(root)) return null;
  let total = 0;
  for (const queue = [root], seen = new Set<number>(); queue.length;) {
    const pid = queue.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    total += cpu.get(pid) ?? 0;
    queue.push(...(children.get(pid) ?? []));
  }
  return Math.round(total) / 100;
}
/** Peak CPU of a running command tree and peak load while it runs: one `ps` (pids and CPU only,
 * never arguments or environment) per `everyMs`, unref'd so it never keeps the process alive. */
export function sampleHold(pid: number, everyMs = 10_000, firstMs = 2000) {
  const unix = process.platform !== 'win32';
  let cpu: number | null = null,
    load: number | null = unix ? loadavg()[0]! : null,
    interval: NodeJS.Timeout | undefined;
  const take = () => {
    if (!unix) return;
    load = Math.max(load ?? 0, loadavg()[0]!);
    execFile('ps', ['-A', '-o', 'pid=,ppid=,pcpu='], { timeout: 5000, maxBuffer: 1 << 22 }, (error, out) => {
      const cores = error ? null : treeCpu(out, pid);
      if (cores !== null) cpu = Math.max(cpu ?? 0, cores);
    }).unref();
  };
  const first = setTimeout(() => {
    take();
    interval = setInterval(take, everyMs).unref();
  }, firstMs).unref();
  return {
    stop() {
      clearTimeout(first);
      clearInterval(interval);
      if (unix) load = Math.max(load ?? 0, loadavg()[0]!);
      const round = (value: number | null) => (value === null ? null : Math.round(value * 10) / 10);
      return { cpu: round(cpu), load: round(load) };
    },
  };
}
