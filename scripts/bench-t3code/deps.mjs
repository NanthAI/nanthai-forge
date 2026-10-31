// B1.5d shared dependency reuse: one filtered install per lockfile under BENCH_ROOT/deps,
// reused by every agent checkout without a per-task `vp install`.
// Per checkout: root node_modules/.pnpm (the immutable package store) is a symlink to the
// shared install; every other node_modules entry is an APFS clone (`cp -cRP`, symlinks
// copied as symlinks). pnpm links workspace packages relatively, so
// packages/x/node_modules/@t3tools/y resolves to the agent's own packages/y, not the
// shared install's copy: cross-package tests see the agent's edits.
// The agent sandbox may read deps/ but never write it (agent.mjs), so one agent cannot
// change another agent's dependencies. No task changes package.json or the lockfile.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Packages the check (`.bench/ci.sh`) tests; the install uses the same filters. */
export const PACKAGES = ['shared', 'provider-pi', 'client-runtime', 'source-control-forgejo'];
export const NODE_VERSION = '26.12.1';
export const VP_VERSION = '1.4.0';

export function lockHash(checkout) {
  return createHash('sha256')
    .update(readFileSync(join(checkout, 'pnpm-lock.yaml')))
    .digest('hex')
    .slice(0, 12);
}

/** The toolchain (vp + Node) and the install for this lockfile; null if not built yet. */
export function sharedDeps(benchRoot, checkout) {
  const deps = join(benchRoot, 'deps');
  const install = join(deps, lockHash(checkout));
  const vpHome = join(deps, 'vp');
  if (!existsSync(join(install, 'node_modules', '.pnpm')) || !existsSync(join(vpHome, 'bin', 'vp')))
    return null;
  return { deps, install, vpHome, home: join(deps, 'home') };
}

/** node_modules directories of the install, outside other node_modules. */
function moduleDirs(install) {
  const out = execFileSync(
    'find',
    ['.', '-name', '.git', '-prune', '-o', '-name', 'node_modules', '-type', 'd', '-print', '-prune'],
    { cwd: install, encoding: 'utf8' },
  );
  return out
    .split('\n')
    .filter(Boolean)
    .map(p => p.replace(/^\.\//, ''));
}

/** Link the shared install into a checkout. Returns counts; seconds-cheap on APFS. */
export function linkDeps(shared, checkout) {
  const started = Date.now();
  let clonedEntries = 0;
  const dirs = moduleDirs(shared.install);
  for (const dir of dirs) {
    const src = join(shared.install, dir),
      dest = join(checkout, dir);
    mkdirSync(dest, { recursive: true });
    const entries = readdirSync(src).filter(name => !(dir === 'node_modules' && name === '.pnpm'));
    if (dir === 'node_modules') symlinkSync(join(src, '.pnpm'), join(dest, '.pnpm'));
    if (entries.length) {
      execFileSync('cp', ['-cRP', ...entries.map(name => join(src, name)), dest + '/']);
      clonedEntries += entries.length;
    }
  }
  return { moduleDirs: dirs.length, clonedEntries, seconds: (Date.now() - started) / 1000 };
}

/** Build the toolchain and the install once (outside any cell). The vp installer runs
 * with HOME pointed into deps/ so it cannot edit the owner's shell profile; read the
 * installer before running it (it is fetched from viteplus.dev).
 * Usage: node scripts/bench-t3code/deps.mjs build INSTALLER_SH */
export function buildSharedDeps(benchRoot, checkout, installer) {
  const deps = join(benchRoot, 'deps'),
    home = join(deps, 'home'),
    vpHome = join(deps, 'vp'),
    install = join(deps, lockHash(checkout));
  mkdirSync(home, { recursive: true });
  const env = {
    ...process.env,
    HOME: home,
    VP_HOME: vpHome,
    VP_VERSION,
    VITE_PLUS_VERSION: VP_VERSION,
    VP_NODE_MANAGER: 'yes',
    CI: 'true',
    PATH: `${join(vpHome, 'bin')}:/usr/local/bin:/usr/bin:/bin`,
  };
  const run = (cmd, args, cwd = deps) => execFileSync(cmd, args, { cwd, env, stdio: 'inherit' });
  if (!existsSync(join(vpHome, 'bin', 'vp'))) run('bash', [installer]);
  run('rsync', ['-a', '--exclude', '.git', checkout + '/', install + '/']);
  run('vp', ['env', 'use', NODE_VERSION], install);
  run('vp', ['install', ...PACKAGES.flatMap(p => ['--filter', `@t3tools/${p}...`])], install);
  return sharedDeps(benchRoot, checkout);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href && process.argv[2] === 'build') {
  const benchRoot = process.env.BENCH_ROOT || join(homedir(), 'NanthAI/forge-bench/b15d');
  const config = JSON.parse(readFileSync(join(benchRoot, 'config.json'), 'utf8'));
  console.log(buildSharedDeps(benchRoot, config.baseCheckout, process.argv[3]));
}
