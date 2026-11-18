// SPDX-License-Identifier: Apache-2.0
// Setup hygiene (Item 5e3c3a3c, 2026-11-17): every arm starts from a base that passes the
// repository's own conventional format check, the static check `land --save` runs inline.
// Only bench-owned files (the bench's check script and workflow) may be rewritten, and only by
// the repository's own fixer script; an upstream file that fails is refused, never edited.
// The fix becomes a derived base commit on the base (deterministic: fixed identity and dates).
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/** Paths the bench adds to the upstream tree; nothing else is ever rewritten. */
export const BENCH_OWNED = [/^\.bench\//, /^\.github\/workflows\/bench-[^/]+$/];
const CHECKS = [
  ['format:check', 'format'],
  ['check:format', 'format'],
  ['fmt:check', 'fmt'],
];

/** The repository's conventional format check and its fixer, or null when it names none. */
export function formatScripts(packageJson) {
  let scripts = {};
  try {
    scripts = JSON.parse(packageJson).scripts ?? {};
  } catch {
    return null;
  }
  const pair = CHECKS.find(([check]) => typeof scripts[check] === 'string');
  if (!pair) return null;
  if (typeof scripts[pair[1]] !== 'string')
    throw Error(`BENCH_SETUP_BASE_STATIC: ${pair[0]} has no fixer script ${pair[1]}`);
  return { check: pair[0], fix: pair[1] };
}

const passes = (cmd, args, options) => {
  try {
    execFileSync(cmd, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    return true;
  } catch {
    return false;
  }
};

/**
 * Check the base tree; when only bench-owned files fail, format them with the repo's fixer and
 * write a derived base commit in the meta repo. Returns { sha, from, check, fixed[] }.
 * `prepare(root)` links the toolchain's install into the scratch root; `env` carries the toolchain.
 */
export async function baseStatic({ meta, baseCheckout, baseSha, work, env, prepare = async () => {} }) {
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env }).trim();
  if (git(baseCheckout, 'rev-parse', 'HEAD') !== baseSha)
    throw Error(`BENCH_SETUP_BASE_STATIC: ${baseCheckout} is not at the base ${baseSha.slice(0, 12)}`);
  const scripts = formatScripts(readFileSync(join(baseCheckout, 'package.json'), 'utf8'));
  if (!scripts) return { sha: baseSha, from: baseSha, check: null, fixed: [] };
  const scratch = mkdtempSync(join(work, 'base-static-'));
  const root = join(scratch, 'root');
  try {
    // On macOS an APFS clone (the harness's own copy): no second 0.5 GB tree on disk.
    if (process.platform === 'darwin') execFileSync('cp', ['-cR', baseCheckout, root]);
    else cpSync(baseCheckout, root, { recursive: true, verbatimSymlinks: true });
    await prepare(root);
    const at = { cwd: root, env };
    if (passes('npm', ['run', '-s', scripts.check], at))
      return { sha: baseSha, from: baseSha, check: scripts.check, fixed: [] };
    execFileSync('npm', ['run', '-s', scripts.fix], { ...at, stdio: ['ignore', 'pipe', 'pipe'] });
    const changed = git(root, 'diff', '--name-only').split('\n').filter(Boolean);
    const added = git(root, 'ls-files', '--others', '--exclude-standard').split('\n').filter(Boolean);
    const foreign = [...changed, ...added].filter(path => !BENCH_OWNED.some(re => re.test(path)));
    if (foreign.length || added.length)
      throw Error(
        `BENCH_SETUP_BASE_STATIC: ${scripts.check} fails outside bench-owned files (${[...foreign, ...added].slice(0, 5).join(', ')}); the base is not repaired`,
      );
    if (!passes('npm', ['run', '-s', scripts.check], at))
      throw Error(`BENCH_SETUP_BASE_STATIC: ${scripts.check} still fails after ${scripts.fix}`);
    if (!changed.length)
      throw Error(`BENCH_SETUP_BASE_STATIC: ${scripts.check} failed with nothing to format`);
    // Derived commit: the base tree with the formatted bench-owned blobs, parent = base.
    const index = join(scratch, 'index');
    const genv = { ...env, GIT_INDEX_FILE: index };
    const g = (...args) => execFileSync('git', ['-C', meta, ...args], { encoding: 'utf8', env: genv }).trim();
    g('read-tree', baseSha);
    for (const path of changed) {
      const mode = g('ls-tree', baseSha, '--', path).split(/\s+/)[0];
      const blob = g('hash-object', '-w', '--', join(root, path));
      g('update-index', '--cacheinfo', `${mode},${blob},${path}`);
    }
    const tree = g('write-tree');
    const date = g('show', '-s', '--format=%cI', baseSha);
    const identity = {
      GIT_AUTHOR_NAME: 'Forge bench',
      GIT_AUTHOR_EMAIL: 'bench@forge.invalid',
      GIT_COMMITTER_NAME: 'Forge bench',
      GIT_COMMITTER_EMAIL: 'bench@forge.invalid',
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    };
    const sha = execFileSync(
      'git',
      [
        '-C',
        meta,
        'commit-tree',
        tree,
        '-p',
        baseSha,
        '-m',
        `bench: base passes its own ${scripts.check} (${scripts.fix} on bench-owned files)`,
      ],
      { encoding: 'utf8', env: { ...genv, ...identity } },
    ).trim();
    return { sha, from: baseSha, check: scripts.check, fixed: changed };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
