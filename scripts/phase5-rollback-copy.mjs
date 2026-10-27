// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { childEnv } from './child-env.mjs';

export function vanishedCloneRuntimeOnly(error, source) {
  if (error?.status !== 1) return false;
  const prefix = `cp: ${source}/.forge/work/`,
    suffix = ': No such file or directory';
  const lines = error.stderr?.toString().trim().split('\n') ?? [];
  return (
    lines.length > 0 &&
    lines.every(line => {
      if (!line.startsWith(prefix) || !line.endsWith(suffix)) return false;
      const path = line.slice(prefix.length, -suffix.length);
      return (
        /^[^/]+\.(?:lock|tmp)$/.test(path) ||
        ['lock', 'lock-queue', 'lane-locks'].some(name => path === name || path.startsWith(`${name}/`))
      );
    })
  );
}

export function scrubRollbackCopy(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (
      entry.name.startsWith('.env') ||
      [
        'hosted-binding.json',
        'credentials.json',
        'credentials',
        'auth.json',
        '.ssh',
        '.aws',
        '.convex',
        '.config',
        'landing-workers',
      ].includes(entry.name)
    )
      rmSync(path, { recursive: true, force: true });
    else if (entry.isDirectory()) scrubRollbackCopy(path);
  }
}

export function cloneRollbackOwner(input, owner) {
  const source = realpathSync(input);
  // Pin before traversing immutable records; a newer copied pointer could name
  // records published after cp passed their directory.
  const pointer = readFileSync(join(source, '.forge/work/work.json'));
  try {
    execFileSync('cp', ['-c', '-R', source, owner], { stdio: 'pipe', env: childEnv() });
  } catch (error) {
    // Live lock/temp files are intentionally discarded below. Never suppress a
    // missing immutable record/object, a source-file error or a permission error.
    if (!vanishedCloneRuntimeOnly(error, source)) throw error;
    console.error(
      'rollback clone: temporary owner locks vanished during copy; durable inputs will be validated',
    );
  }
  writeFileSync(join(owner, '.forge/work/work.json'), pointer, { mode: 0o600 });
  scrubRollbackCopy(owner);
}
