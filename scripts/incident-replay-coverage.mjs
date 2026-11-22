// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { coreQueuePath, REGISTRY } from './core-queue-paths.mjs';
import { fileTemp, temporaryDirectory } from './test-temp.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const repoPath = file => relative(root, file).replaceAll('\\', '/');

export function replayTitle(title) {
  // The registry records the test declaration. Loop-generated tests use template titles.
  const parts = title.split(/\$\{[^}]+\}/);
  return new RegExp(`^${parts.map(RegExp.escape).join('.+?')}$`);
}

export function executedCorePaths(scripts) {
  const paths = new Set();
  for (const { url, functions } of scripts) {
    if (!url.startsWith('file:')) continue;
    const path = repoPath(fileURLToPath(url)).replace(/^dist\/(.*)\.js$/, 'src/$1.ts');
    if (!coreQueuePath(path) || paths.has(path)) continue;
    if (
      functions.some(({ functionName, ranges }, index) => {
        const entry = ranges[0];
        // V8 puts the module body first, unnamed and starting at zero. Its execution
        // alone proves only that the file was imported. Anonymous functions still count.
        return entry.count > 0 && (index > 0 || functionName || entry.startOffset !== 0);
      }) &&
      existsSync(join(root, path))
    )
      paths.add(path);
  }
  return paths;
}

export function staleReplayPaths(paths, reached) {
  return (paths ?? []).filter(path => !reached.has(path));
}

/** Start offsets of executed functions other than the module body, per core module URL. The
 * queue proof scope (scripts/queue-proof-scope.mjs) maps them to the top-level units a replay ran. */
export function executedCoreOffsets(scripts, into = new Map()) {
  for (const { url, functions } of scripts) {
    if (!url.startsWith('file:')) continue;
    const path = repoPath(fileURLToPath(url)).replace(/^dist\/(.*)\.js$/, 'src/$1.ts');
    if (!coreQueuePath(path)) continue;
    for (const [index, { functionName, ranges }] of functions.entries()) {
      const entry = ranges[0];
      if (!(entry.count > 0) || (index === 0 && !functionName && entry.startOffset === 0)) continue;
      if (!into.has(url)) into.set(url, new Set());
      into.get(url).add(entry.startOffset);
    }
  }
  return into;
}

export function runReplayCoverage(entry, moduleCache = process.env.FORGE_TEST_MODULE_DIRECTORY) {
  return replayRun(entry, moduleCache, false).paths;
}

/** One isolated replay with its reached paths and executed function offsets (Item ec229a55). */
export function runReplayScope(entry, moduleCache) {
  return replayRun(entry, moduleCache, true);
}

function replayRun(entry, moduleCache, scope) {
  if (!/^tests\/[^/\\]+\.test\.mjs$/.test(entry.file))
    throw new Error(`${entry.incident}: replay file is outside the normal suite: ${entry.file}`);
  const temp = fileTemp();
  const report = join(temp.root, 'coverage.json');
  const offsets = scope ? join(temp.root, 'scope.json') : undefined;
  const childEnv = {
    ...process.env,
    ...temp.env,
    ...(moduleCache && { FORGE_TEST_MODULE_DIRECTORY: moduleCache }),
    FORGE_REPLAY_COVERAGE_OUTPUT: report,
    ...(offsets && { FORGE_REPLAY_SCOPE_OUTPUT: offsets }),
    FORGE_REPLAY_COVERAGE_TEST: entry.test,
    FORGE_TEST_NAME_PATTERN: replayTitle(entry.test).source,
    FORGE_TEST_MAX_RETRIES: '0',
    FORGE_TEST_WORKERS: '1',
  };
  delete childEnv.NODE_TEST_CONTEXT;
  delete childEnv.NODE_V8_COVERAGE;
  delete childEnv.FORGE_TEST_COVERAGE_HEAD;
  try {
    const result = spawnSync(process.execPath, ['scripts/test-files.mjs', entry.file], {
      cwd: root,
      env: childEnv,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    });
    if (
      result.status !== 0 ||
      !/^# pass [1-9]\d*$/m.test(result.stdout) ||
      !/^# skipped 0$/m.test(result.stdout) ||
      !/^# todo 0$/m.test(result.stdout) ||
      !existsSync(report) ||
      (offsets && !existsSync(offsets))
    )
      throw new Error(
        `${entry.file}: replay "${entry.test}" did not produce passing coverage.\n` +
          (result.error?.message ?? (result.stderr + result.stdout).slice(-12_000)),
      );
    const paths = JSON.parse(readFileSync(report, 'utf8'));
    return { paths, offsets: offsets ? JSON.parse(readFileSync(offsets, 'utf8')) : undefined };
  } finally {
    const leaks = temp.cleanup();
    if (leaks.length) throw new Error(`${entry.file}: leaked temporary entries: ${leaks.join('; ')}`);
  }
}

function main(mode) {
  const registryFile = join(root, REGISTRY);
  const original = readFileSync(registryFile, 'utf8');
  const registry = JSON.parse(original);
  const moduleCache =
    process.env.FORGE_TEST_MODULE_DIRECTORY ?? temporaryDirectory(null, 'forge-test-modules-');
  const covered = new Set();
  let lastFile;
  for (const [index, entry] of registry.replays.entries()) {
    const { test, paths: registeredPaths, ...details } = entry;
    if (process.stderr.isTTY && entry.file !== lastFile)
      process.stderr.write(`Replay ${index + 1}/${registry.replays.length}: ${entry.file}\n`);
    lastFile = entry.file;
    const paths = runReplayCoverage(entry, moduleCache);
    const stale = staleReplayPaths(registeredPaths, new Set(paths));
    if (mode === '--check' && stale.length)
      throw new Error(`${entry.file}: "${entry.test}" no longer reaches ${stale.join(', ')}`);
    for (const path of paths) covered.add(path);
    registry.replays[index] = { ...details, paths, test };
  }
  if (mode === '--write') {
    if (readFileSync(registryFile, 'utf8') !== original)
      throw new Error(`${REGISTRY} changed during replay coverage. Run again on the current registry.`);
    writeFileSync(registryFile, JSON.stringify(registry, null, 2) + '\n');
  }
  const core = ['convex', 'src'].flatMap(dir =>
    readdirSync(join(root, dir))
      .map(name => `${dir}/${name}`)
      .filter(coreQueuePath),
  );
  console.log(
    JSON.stringify(
      {
        replays: registry.replays.length,
        coreFiles: core.length,
        covered: covered.size,
        uncovered: core.filter(path => !covered.has(path)).sort(),
      },
      null,
      2,
    ),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, ...rest] = process.argv.slice(2);
  if (!['--check', '--write'].includes(mode) || rest.length)
    throw new Error('Usage: nforge heavy node scripts/incident-replay-coverage.mjs --check|--write');
  main(mode);
}
