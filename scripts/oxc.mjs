// SPDX-License-Identifier: Apache-2.0
// Explicit files also work in native Lanes beneath an ignored .forge/ ancestor.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import ignore from 'ignore';

export function oxcFiles(root, lint) {
  const config = JSON.parse(readFileSync(join(root, lint ? '.oxlintrc.json' : '.oxfmtrc.json')));
  const ignored = ignore()
    .add(readFileSync(join(root, '.gitignore'), 'utf8'))
    .add(config.ignorePatterns);
  const files = [];
  function walk(directory) {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      const path = directory ? `${directory}/${entry.name}` : entry.name;
      if (entry.name === '.git' || ignored.ignores(path + (entry.isDirectory() ? '/' : ''))) continue;
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && /\.(?:[cm]?[jt]s|[jt]sx)$/.test(path)) files.push(path);
    }
  }
  for (const directory of lint ? ['src', 'web/src', 'convex', 'netlify/functions', 'tests'] : [''])
    if (existsSync(join(root, directory))) walk(directory);
  return files.sort();
}

// A change to the tools' own configuration, the ignore rules or the lint plugin can alter any file's result.
const EVERY_FILE =
  /^(?:\.oxfmtrc\.json|\.oxlintrc\.json|\.gitignore|package(?:-lock)?\.json|scripts\/oxc\.mjs|scripts\/lint\/|tests\/test-hygiene-allowlist\.json)/;

// The test-hygiene lint rules (scripts/lint/forge-plugin.mjs) run through the JS plugin, which costs far more
// per file than the built-in rules. Only a test file that names something the rules look for can have a hit,
// so the rest skip the plugin: about 320 of 1,470 files, a fraction of the lint time. The pattern is a superset
// of what the rules match; tests/lint-rules.test.mjs checks every planted example against it.
export const TEST_HYGIENE_CANDIDATE =
  /setTimeout|setInterval|scheduler|Atomics|\bsleep\b|\b(?:sleepMs|delay|pause|nap|snooze|waitForTimeout|poll|pollUntil|eventually|retryTimes)\s*\(|\b(?:retry|retries|timeout)\b\s*[:,}]|testTimeout|hookTimeout|timers\/promises/;

/** The lint files with the tests/ files that cannot trip a test-hygiene rule removed. A file with an entry in the
 * allowlist stays: it may have dropped below its allowance. */
export function withoutQuietTests(files, root = '.') {
  let allowed = {};
  try {
    allowed = JSON.parse(readFileSync(join(root, 'tests/test-hygiene-allowlist.json'), 'utf8')).files ?? {};
  } catch {}
  return files.filter(
    path =>
      !path.startsWith('tests/') ||
      path in allowed ||
      TEST_HYGIENE_CANDIDATE.test(readFileSync(join(root, path), 'utf8')),
  );
}

/** The saved changed paths local preflight names (FORGE_PREFLIGHT_CHANGED_FILE, NUL-terminated), or null
 * when unnamed, unreadable or when a change to tool configuration means every file may differ. Only the
 * read-only modes use it: both tools judge one file at a time, so the changed files give the same verdict
 * on them as the whole tree. The hosted check and a direct run name none and cover the whole tree. */
export function changedOxcPaths(env = process.env) {
  try {
    const changed = readFileSync(env.FORGE_PREFLIGHT_CHANGED_FILE, 'utf8').split('\0').filter(Boolean);
    return changed.some(path => EVERY_FILE.test(path)) ? null : new Set(changed);
  } catch {
    return null;
  }
}

export function runOxc(mode) {
  if (!['lint', 'format', 'format:check'].includes(mode))
    throw new Error('Expected lint, format or format:check.');
  const lint = mode === 'lint';
  let files = oxcFiles('.', lint);
  if (!files.length) throw new Error('No source files selected for Oxc.');
  const changed = mode === 'format' ? null : changedOxcPaths();
  if (changed) {
    files = files.filter(path => changed.has(path));
    if (!files.length) {
      console.log(`Oxc ${mode}: no changed file is in scope.`);
      return 0;
    }
  }
  if (lint) {
    files = withoutQuietTests(files);
    if (!files.length) {
      console.log('Oxc lint: no changed file is in scope.');
      return 0;
    }
  }
  const tool = lint ? 'oxlint' : 'oxfmt';
  const result = spawnSync(
    process.execPath,
    [
      `node_modules/${tool}/bin/${tool}`,
      '--threads',
      '4',
      ...(lint ? ['--deny-warnings'] : [mode === 'format' ? '--write' : '--check']),
      ...files,
    ],
    { stdio: 'inherit' },
  );
  if (result.error) throw result.error;
  return result.status ?? 1;
}

export const OXC_USAGE = `Usage: node scripts/oxc.mjs lint | format | format:check
  lint          oxlint over src, web/src, convex, netlify/functions and tests (--deny-warnings)
  format        rewrite every formatted source file in the tree with oxfmt (writes files)
  format:check  report files oxfmt would change; writes nothing
  --help, -h    print this help and exit 0
Any other argument prints this usage to stderr and exits 2 before reading or writing any file.
`;

/** Parses argv after the script name: never touches a file, so --help and bad flags are safe. */
export function parseOxcArgs(args) {
  if (args.includes('--help') || args.includes('-h')) return { help: true };
  if (args.length !== 1 || !['lint', 'format', 'format:check'].includes(args[0]))
    return { error: args.length ? `Unexpected argument: ${args.join(' ')}` : 'Missing subcommand.' };
  return { mode: args[0] };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const parsed = parseOxcArgs(process.argv.slice(2));
  if (parsed.help) process.stdout.write(OXC_USAGE);
  else if (parsed.error) {
    process.stderr.write(`${parsed.error}\n${OXC_USAGE}`);
    process.exitCode = 2;
  } else process.exitCode = runOxc(parsed.mode);
}
