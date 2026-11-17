// SPDX-License-Identifier: Apache-2.0
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { invariant } from './errors.js';
import { readProcess } from './agent-client-process.js';

const within = (parent: string, child: string) => {
  const rel = relative(parent, child);
  return (
    rel === '' || (!rel.startsWith('..' + '/') && rel !== '..' && !isAbsolute(rel) && !rel.startsWith('..\\'))
  );
};
function privateDirectory(path: string) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  invariant(
    stat.isDirectory() && !stat.isSymbolicLink() && (!process.getuid || stat.uid === process.getuid()),
    'UNSAFE_PATH',
    'Secret temporary storage must be a private real directory.',
  );
  chmodSync(path, 0o700);
  return realpathSync(path);
}
function dead(pid: number) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

/** No timer: only the next run sweeps folders whose owning process has gone.
 * Inaccessible owners and malformed metadata are retained rather than guessed dead. */
export function sweepSecretFiles(base: string) {
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^run-/.test(entry.name)) continue;
    const path = join(base, entry.name);
    try {
      const stat = lstatSync(path);
      if (process.getuid && stat.uid !== process.getuid()) continue;
      const file = join(path, 'owner.json');
      if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) continue;
      const owner = JSON.parse(readFileSync(file, 'utf8')) as { pid: number; started?: string };
      if (!Number.isSafeInteger(owner.pid) || owner.pid <= 1) continue;
      const live = owner.started ? readProcess(owner.pid) : undefined;
      if (dead(owner.pid) || (owner.started && live && owner.started !== live.started))
        rmSync(path, { recursive: true, force: true });
    } catch {
      /* Unknown ownership never authorizes cleanup. */
    }
  }
}

export function prepareSecretFileStorage(input: {
  root: string;
  keptPaths?: readonly string[] | undefined;
  tempRoot?: string | undefined;
}) {
  const root = realpathSync(input.root);
  const parent = realpathSync(
    input.tempRoot ?? (process.platform === 'linux' && existsSync('/dev/shm') ? '/dev/shm' : tmpdir()),
  );
  const basePath = join(parent, `forge-run-secrets-${process.getuid?.() ?? 'user'}`);
  for (const kept of [root, ...(input.keptPaths ?? []).map(path => resolve(path))])
    invariant(
      !within(kept, basePath),
      'UNSAFE_PATH',
      'Secret files must stay outside the source tree and kept outputs.',
    );
  const base = privateDirectory(basePath);
  // Check the resolved directory too, before creating any value file.
  for (const kept of [
    root,
    ...(input.keptPaths ?? []).map(path => (existsSync(path) ? realpathSync(path) : resolve(path))),
  ])
    invariant(
      !within(kept, base),
      'UNSAFE_PATH',
      'Secret files must stay outside the source tree and kept outputs.',
    );
  sweepSecretFiles(base);
  return base;
}
export function secretFileFolder(input: {
  root: string;
  keptPaths?: readonly string[] | undefined;
  tempRoot?: string | undefined;
}) {
  const base = prepareSecretFileStorage(input);
  const path = mkdtempSync(join(base, 'run-'));
  chmodSync(path, 0o700);
  const started = readProcess(process.pid)?.started;
  writeFileSync(join(path, 'owner.json'), JSON.stringify({ pid: process.pid, started }), {
    mode: 0o600,
    flag: 'wx',
  });
  let removed = false;
  const cleanup = () => {
    if (removed) return;
    rmSync(path, { recursive: true, force: true });
    removed = true;
  };
  return {
    path,
    write(name: string, value: Buffer) {
      invariant(/^[A-Z][A-Z0-9_]{0,63}$/.test(name), 'BAD_ARGUMENT', 'Invalid secret file name.');
      const target = join(path, name);
      writeFileSync(target, value, { mode: 0o600, flag: 'wx' });
      return target;
    },
    cleanup,
  };
}
