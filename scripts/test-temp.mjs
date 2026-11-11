// SPDX-License-Identifier: Apache-2.0
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const owned = new Set();
// A fixture may use its temp directory as a Forge checkout, whose caches live beside it.
const remove = path => {
  for (const entry of [path, `${path}.forge-client`, `${path}.forge-metrics.jsonl`])
    rmSync(entry, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
};
const leaksIn = root =>
  existsSync(root)
    ? readdirSync(root).filter(name => {
        if (!/^(?:forge-|scale-)/.test(name)) return false;
        // Worker termination skips exit hooks; the enclosing private runtime owns
        // nested runtime roots and reclaims them after their worker has stopped.
        if (name.startsWith('forge-test-runtime-')) return false;
        // forgeTempDir leaves its shared container and sweep/index stamps after each owned
        // child is removed. The empty container is runtime bookkeeping, not a leaked fixture.
        if (name === 'forge-tmp')
          return readdirSync(join(root, name)).some(
            entry => entry !== '.metadata_never_index' && entry !== '.swept',
          );
        return true;
      })
    : [];

const cleanups = new Set();
const cleanup = (guard = true) => {
  for (const path of owned) remove(path);
  for (const fn of cleanups) fn(guard);
};
process.once('exit', () => cleanup());
for (const signal of ['SIGTERM', 'SIGINT'])
  process.once(signal, () => {
    queueMicrotask(() => {
      cleanup(false);
      process.kill(process.pid, signal);
    });
  });
let installed = false;
/** Register before fixture setup, so failures during setup have the same teardown as success. */
export function temporaryDirectory(t, prefix = 'forge-test-') {
  const path = mkdtempSync(join(tmpdir(), prefix));
  owned.add(path);
  if (t)
    t.after(() => {
      remove(path);
      // Keep ownership until file exit: deferred metric writers can recreate companions.
    });
  return path;
}
/** Only inspect this process's private temp root, never another builder's OS temp files. */
export function installTestTemp() {
  if (installed) return;
  installed = true;
  const root = mkdtempSync(join(tmpdir(), 'forge-test-runtime-'));
  for (const name of ['TMPDIR', 'TMP', 'TEMP']) process.env[name] = root;
  // Product caches/logs intentionally outlive an operation. Inside this private
  // temp root their owner is the test runtime, so reclaim them before checking
  // for unregistered operation/fixture directories.
  for (const name of [
    `forge-peers-${process.getuid?.() ?? 'user'}`,
    'forge-mac-check-logs',
    'forge-logs',
    ...(process.platform === 'win32' ? ['forge-heavy-slots'] : []),
  ])
    owned.add(join(root, name));
  const runtime = join(root, '.runtime');
  mkdirSync(runtime);
  const paths = {};
  for (const name of ['queue', 'config', 'home', 'state']) {
    paths[name] = join(runtime, name);
    mkdirSync(paths[name]);
  }
  let cleaned = false;
  const cleanup = (guard = true) => {
    if (cleaned) return;
    cleaned = true;
    for (const path of owned) remove(path);
    const leaked = leaksIn(root);
    if (guard && leaked.length) {
      process.stderr.write(
        `FORGE_TEMP_LEAK: ${leaked.length} Forge temporary entries left by this test file: ${leaked.join(', ')}\n`,
      );
      process.exitCode = 1;
    }
    remove(root);
  };
  cleanups.add(cleanup);
  return paths;
}
/** The supervisor owns this root even when a file is stopped with SIGKILL. */
export function fileTemp() {
  const root = temporaryDirectory(null, 'forge-test-file-');
  return {
    root,
    env: { TMPDIR: root, TMP: root, TEMP: root },
    cleanup() {
      const leaked = leaksIn(root);
      remove(root);
      owned.delete(root);
      return leaked;
    },
  };
}
