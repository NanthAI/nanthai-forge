// B1.5d shared dependency reuse: one filtered install per lockfile under BENCH_ROOT/deps,
// reused by every agent checkout without a per-task `vp install`.
// Per checkout: root node_modules/.pnpm (the immutable package store) is a symlink to the
// shared install; every other node_modules entry is an APFS clone (`cp -cRP`, symlinks
// copied as symlinks). pnpm links workspace packages relatively, so
// packages/x/node_modules/@t3tools/y resolves to the agent's own packages/y, not the
// shared install's copy: cross-package tests see the agent's edits.
// The agent sandbox may read deps/ but never write it (agent.mjs), so one agent cannot
// change another agent's dependencies. No task changes package.json or the lockfile.
// The install is keyed by lockfile AND filter set: the part 3 scope added packages without
// changing the lockfile, and a lock-only key silently reused the smaller install.
// deps/browsers holds playwright-core's Chromium headless shell for the server preview
// tests (PLAYWRIGHT_BROWSERS_PATH, the same for both arms).
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Workspace packages the check (`.bench/ci.sh`) installs (`--filter <name>...`), by
 * package name: two are not `@t3tools/<dir>` (packages/effect-codex-app-server, apps/server
 * = `t3`). The check tests the first five in full and t3's src/preview. */
export const PACKAGES = [
  '@t3tools/shared',
  '@t3tools/provider-pi',
  '@t3tools/client-runtime',
  '@t3tools/source-control-forgejo',
  'effect-codex-app-server',
  't3',
];
export const installFilters = (packages = PACKAGES) => packages.flatMap(p => ['--filter', `${p}...`]);
export const NODE_VERSION = '26.12.1';
export const VP_VERSION = '1.4.0';

export function lockHash(checkout) {
  return createHash('sha256')
    .update(readFileSync(join(checkout, 'pnpm-lock.yaml')))
    .digest('hex')
    .slice(0, 12);
}

/** Install directory name: lockfile hash plus a hash of the filter set. */
export function installKey(checkout, packages = PACKAGES) {
  const filters = createHash('sha256').update(installFilters(packages).join(' ')).digest('hex').slice(0, 8);
  return `${lockHash(checkout)}-${filters}`;
}

/** The toolchain (vp + Node), the install for this lockfile and filter set, and the browser;
 * null if any is not built yet. */
export function sharedDeps(benchRoot, checkout, packages = PACKAGES) {
  const deps = join(benchRoot, 'deps');
  const install = join(deps, installKey(checkout, packages));
  const vpHome = join(deps, 'vp');
  const browsers = join(deps, 'browsers');
  if (
    !existsSync(join(install, 'node_modules', '.pnpm')) ||
    !existsSync(join(vpHome, 'bin', 'vp')) ||
    !existsSync(browsers)
  )
    return null;
  return { deps, install, vpHome, browsers, home: join(deps, 'home') };
}

/** node_modules directories of the install, outside other node_modules (read once). */
const moduleDirCache = new Map();
function moduleDirs(install) {
  if (!moduleDirCache.has(install)) moduleDirCache.set(install, findModuleDirs(install));
  return moduleDirCache.get(install);
}
function findModuleDirs(install) {
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

/** linkDeps without blocking the harness's event loop (other workers keep running). */
export async function linkDepsAsync(shared, checkout) {
  const run = promisify(execFile);
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
      await run('cp', ['-cRP', ...entries.map(name => join(src, name)), dest + '/']);
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
    install = join(deps, installKey(checkout)),
    browsers = join(deps, 'browsers');
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
  run('vp', ['install', ...installFilters()], install);
  // Same browser as the check: playwright-core's pinned Chromium headless shell.
  execFileSync(
    join(vpHome, 'bin', 'node'),
    ['apps/server/node_modules/playwright-core/cli.js', 'install', '--only-shell', 'chromium'],
    { cwd: install, env: { ...env, PLAYWRIGHT_BROWSERS_PATH: browsers }, stdio: 'inherit' },
  );
  return sharedDeps(benchRoot, checkout);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href && process.argv[2] === 'build') {
  const benchRoot = process.env.BENCH_ROOT || join(homedir(), 'NanthAI/forge-bench/b15d');
  const config = JSON.parse(readFileSync(join(benchRoot, 'config.json'), 'utf8'));
  console.log(buildSharedDeps(benchRoot, config.baseCheckout, process.argv[3]));
}
