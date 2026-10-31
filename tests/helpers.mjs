import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';

export function fixture(t, files = {}) {
  const root = mkdtempSync(join(tmpdir(), 'forge-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  git(root, ['init', '-q']);
  for (const [name, text] of Object.entries(files)) write(root, name, text);
  return root;
}
const scratch = new Set();
/** A temp directory for helpers that have no test context; removed when this test file's process exits. */
export function scratchDir(prefix) {
  if (!scratch.size)
    process.once('exit', () => {
      for (const path of scratch) rmSync(path, { recursive: true, force: true });
    });
  const path = mkdtempSync(join(tmpdir(), prefix));
  scratch.add(path);
  return path;
}
export function write(root, name, content) {
  const path = join(root, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}
export function git(root, args) {
  return execFileSync(
    'git',
    ['-C', root, '-c', 'user.name=Forge tests', '-c', 'user.email=tests@localhost', ...args],
    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
  );
}
export const code = expected => error => error.code === expected;

// A same-mode chmod is a metadata-only change, but coarse kernel timestamps (Linux CI runners) can leave
// ctime unchanged within one clock tick; repeat it until ctime actually moves.
export function touchCtime(path, mode = 0o600) {
  const before = statSync(path, { bigint: true }).ctimeNs,
    deadline = Date.now() + 1000;
  do chmodSync(path, mode);
  while (statSync(path, { bigint: true }).ctimeNs === before && Date.now() < deadline);
}
