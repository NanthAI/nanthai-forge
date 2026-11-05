#!/usr/bin/env node
// B1.5d pinned harness (B3): a clean checkout of one landed commit of nanthai-forge, outside
// every Lane root, that the driver and cells run from. The Convex meter needs the convex
// package, so node_modules links to the one CLI build's dependencies (read-only).
//   node scripts/bench-t3code/pin.mjs [STATE_HEAD | GIT_SHA]   -> prints the checkout path
// Forge main is the authority (its State heads are 64 hex; the CLI's `.commit` is one). The
// checkout itself is a Git commit of the GitHub mirror, so the pin maps the State head to
// its Git commit through the project's own mirror record (`capabilities.githubMirror`:
// `mirroredHead` -> `gitHead`). It never guesses: when the mirror has not reached the
// State head it exits with BENCH_PIN_WAITS_FOR_MIRROR and says exactly what it waits for.
// No argument pins the CLI build's own commit, which is what the version record compares.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

const MIRROR_REMOTE = 'https://github.com/NanthAI/nanthai-forge';
const STATE_HEAD = /^[0-9a-f]{64}$/;
const GIT_SHA = /^[0-9a-f]{40}$/;

/** The mirror record, or null when the response carries none. */
export function parseMirror(capabilities) {
  const m = capabilities?.result?.githubMirror ?? capabilities?.githubMirror;
  if (!m || typeof m !== 'object') return null;
  return {
    repository: m.repository ?? null,
    status: m.status ?? null,
    targetHead: m.targetHead ?? null,
    mirroredHead: m.mirroredHead ?? null,
    gitHead: m.gitHead ?? null,
    lagging: Boolean(m.lagging),
    pendingSince: m.pendingSince ?? null,
    nextAttemptAt: m.nextAttemptAt ?? null,
    failures: m.failures ?? 0,
    error: m.error ?? null,
  };
}

const short = h => (h ? String(h).slice(0, 12) : 'none');
const when = ms => (Number.isFinite(ms) ? new Date(ms).toISOString() : 'not scheduled');

/**
 * What to pin. `wanted` is a State head (64 hex) or a Git commit (40 hex).
 * Returns { ok: true, gitSha, via } or { ok: false, code, waitsFor, message }.
 */
export function resolvePin({ wanted, mirror }) {
  if (GIT_SHA.test(wanted ?? '')) return { ok: true, gitSha: wanted, via: 'git-sha' };
  if (!STATE_HEAD.test(wanted ?? ''))
    return {
      ok: false,
      code: 'BENCH_PIN_USAGE',
      waitsFor: null,
      message: 'usage: pin.mjs [STATE_HEAD(64 hex) | GIT_SHA(40 hex)]; no argument pins the CLI build commit',
    };
  if (!mirror)
    return {
      ok: false,
      code: 'BENCH_PIN_NO_MIRROR_RECORD',
      waitsFor:
        'the project capabilities to report githubMirror (is the GitHub mirror connected? nforge github status PROJECT)',
      message: 'no githubMirror record was returned, so the State head cannot be mapped to a Git commit',
    };
  if (mirror.mirroredHead === wanted && GIT_SHA.test(mirror.gitHead ?? ''))
    return { ok: true, gitSha: mirror.gitHead, via: 'mirror-record' };
  const behind = mirror.targetHead === wanted && mirror.mirroredHead !== wanted;
  const detail = [
    `wanted State ${short(wanted)}`,
    `mirror has mirrored ${short(mirror.mirroredHead)} (Git ${short(mirror.gitHead)})`,
    `mirror target ${short(mirror.targetHead)}`,
    `status ${mirror.status}${mirror.lagging ? ' (lagging)' : ''}`,
    mirror.pendingSince ? `pending since ${when(mirror.pendingSince)}` : null,
    `next attempt ${when(mirror.nextAttemptAt)}`,
    mirror.failures ? `${mirror.failures} failed attempt(s)` : null,
    mirror.error ? `error ${String(mirror.error).slice(0, 120)}` : null,
  ]
    .filter(Boolean)
    .join('; ');
  return {
    ok: false,
    code: 'BENCH_PIN_WAITS_FOR_MIRROR',
    waitsFor: `${mirror.repository ?? 'the GitHub mirror'} main to contain State ${short(wanted)}`,
    message: `${detail}. ${
      behind
        ? 'The mirror is on its way; re-run when it is synced, or push it now: nforge github-sync ROOT --push.'
        : 'This State is not the mirror target (main moved on, or it is not an accepted main State): pin a State the mirror reaches, or no argument for the CLI build commit.'
    }`,
  };
}

/** Where the dependency donor lives: explicit, else the CLI build next to config.forge.cli. */
export function cliDonor({ explicit, config, home = homedir() } = {}) {
  if (explicit) return explicit;
  if (config?.forge?.cli) return dirname(dirname(config.forge.cli));
  return join(home, 'NanthAI/forge-cli/current');
}

/** The CLI build's own commit (a State head), or null. */
export function cliCommit(donor) {
  try {
    return readFileSync(join(donor, '.commit'), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

/** Materialise the pin. `git`/`forgeCapabilities` are injectable for tests. */
export function pinHarness({
  benchRoot,
  wanted,
  donor,
  forgeRoot,
  forgeCapabilities = root =>
    JSON.parse(
      execFileSync(
        '/usr/local/bin/node',
        [join(donor, 'dist/cli-entry.js'), 'agent', root, 'capabilities', '{}'],
        {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      )
        .split('\n')
        .filter(l => l.startsWith('{'))
        .at(-1),
    ),
  git = (dir, ...args) =>
    execFileSync('git', ['-C', dir, ...args], {
      stdio: ['ignore', 'pipe', 'inherit'],
      encoding: 'utf8',
    }).trim(),
}) {
  const want = wanted ?? cliCommit(donor);
  if (!want)
    throw Object.assign(Error('BENCH_PIN_NO_CLI_COMMIT: no argument and the CLI build has no .commit'), {
      code: 'BENCH_PIN_NO_CLI_COMMIT',
    });
  const mirror = STATE_HEAD.test(want) ? parseMirror(forgeCapabilities(forgeRoot)) : null;
  const r = resolvePin({ wanted: want, mirror });
  if (!r.ok) throw Object.assign(Error(`${r.code}: ${r.message}`), { code: r.code, waitsFor: r.waitsFor });
  const dir = join(benchRoot, 'harness', r.gitSha.slice(0, 12));
  if (!existsSync(join(dir, '.git'))) {
    mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q');
    git(dir, 'remote', 'add', 'origin', MIRROR_REMOTE);
    git(dir, 'fetch', '-q', '--depth', '1', 'origin', r.gitSha);
    git(dir, 'checkout', '-q', 'FETCH_HEAD');
  }
  if (git(dir, 'rev-parse', 'HEAD') !== r.gitSha) throw Error('BENCH_PIN_MISMATCH');
  if (!existsSync(join(dir, 'node_modules')))
    symlinkSync(realpathSync(join(donor, 'node_modules')), join(dir, 'node_modules'));
  return { dir, gitSha: r.gitSha, stateHead: STATE_HEAD.test(want) ? want : null, via: r.via };
}

/** The pin's checkout path if it is already there (read-only; for status and dry runs). */
export function existingPin({ benchRoot, wanted, donor, mirror }) {
  const want = wanted ?? cliCommit(donor);
  if (!want) return { done: false, reason: 'the CLI build has no .commit' };
  const r = resolvePin({ wanted: want, mirror: STATE_HEAD.test(want) ? mirror : null });
  if (!r.ok) return { done: false, reason: r.message, waitsFor: r.waitsFor, code: r.code };
  const dir = join(benchRoot, 'harness', r.gitSha.slice(0, 12));
  return {
    done: existsSync(join(dir, '.git')) && existsSync(join(dir, 'node_modules')),
    dir,
    gitSha: r.gitSha,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const B = process.env.BENCH_ROOT || join(homedir(), 'NanthAI/forge-bench/b15d');
  let config = null;
  try {
    config = JSON.parse(readFileSync(join(B, 'config.json'), 'utf8'));
  } catch {}
  try {
    const out = pinHarness({
      benchRoot: B,
      wanted: process.argv[2],
      donor: cliDonor({ explicit: process.env.FORGE_CLI_HOME, config }),
      forgeRoot: process.env.FORGE_ROOT || dirname(dirname(import.meta.dirname)),
    });
    console.log(out.dir);
  } catch (error) {
    console.error(error.message);
    if (error.waitsFor) console.error(`waits for: ${error.waitsFor}`);
    process.exitCode = 1;
  }
}
