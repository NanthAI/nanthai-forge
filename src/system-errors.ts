// SPDX-License-Identifier: Apache-2.0
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ForgeError } from './errors.js';
import { refuseRealUserState } from './test-isolation.js';

const NO_RESULT = 'No successful result is claimed.';
export const DIAGNOSTICS_MAX_BYTES = 256 * 1024;
export const DIAGNOSTICS_FILES = 3;
const reasons: Record<string, string> = {
  EPERM: 'operation not permitted',
  EACCES: 'permission denied',
  ENOSPC: 'no space left on device',
  EMFILE: 'too many open files in this process',
  ENFILE: 'too many open files on this machine',
  EROFS: 'read-only file system',
  ENOENT: 'no such file or directory',
};
export type Failure = { code: string; message: string; hint?: string; diagnostics?: string };

const underForge = (path: string) => {
  const queue = process.env.FORGE_CHECK_QUEUE_DIR;
  return [join(homedir(), '.forge'), ...(queue ? [resolve(queue)] : [])].some(
    root => path === root || path.startsWith(root + '/') || path.startsWith(root + '\\'),
  );
};
function hint(code: string, path: string | undefined) {
  if (code === 'EPERM' || code === 'EACCES' || code === 'EROFS')
    return path && underForge(path)
      ? 'Forge needs write access to ~/.forge (the machine-wide check queue). In a sandbox or container, allow writes there, or set FORGE_CHECK_QUEUE_DIR to a writable directory shared by every Forge runner on this machine. Retrying will not help until that changes.'
      : 'Forge cannot write that path with the current OS permissions. Allow write access to it (sandboxes and containers often block this) and retry; retrying unchanged will fail the same way.';
  if (code === 'ENOSPC')
    return 'Free disk space on the volume holding that path, then retry the same command.';
  if (code === 'EMFILE' || code === 'ENFILE')
    return 'Close other processes or raise the open-file limit (ulimit -n), then retry the same command.';
  return 'Check that the path exists and was not removed or moved, then retry.';
}

/** Describe any thrown value without exposing environment or file contents. */
export function describeFailure(error: unknown): Failure {
  if (error instanceof ForgeError) return { code: error.code, message: error.message };
  const raw = error as { code?: unknown; syscall?: unknown; path?: unknown } | null;
  const code = typeof raw?.code === 'string' ? raw.code : undefined;
  if (code && code in reasons) {
    const path = typeof raw?.path === 'string' ? raw.path : undefined;
    const syscall = typeof raw?.syscall === 'string' ? raw.syscall : 'system call';
    return {
      code: `SYSTEM_${code}`,
      message: `${syscall}${path ? ` ${path}` : ''}: ${reasons[code]}. ${NO_RESULT}`,
      hint: hint(code, path),
    };
  }
  return { code: 'INTERNAL_ERROR', message: `Unexpected failure; ${NO_RESULT.toLowerCase()}` };
}

/** Bounded, rotating log: `diagnostics.log` is renamed to `.1`, `.2` and the oldest dropped. */
export function writeDiagnostics(
  directory: string,
  entry: string,
  /** Owner logs: create only the leaf, never its missing parents (a deleted owner stays deleted). */
  existingParentOnly = false,
): string | undefined {
  try {
    refuseRealUserState(directory, 'diagnostics');
    if (existingParentOnly) {
      try {
        mkdirSync(directory, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    } else mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = join(directory, 'diagnostics.log');
    if (existsSync(file) && statSync(file).size >= DIAGNOSTICS_MAX_BYTES) {
      rmSync(`${file}.${DIAGNOSTICS_FILES - 1}`, { force: true });
      for (let index = DIAGNOSTICS_FILES - 2; index >= 1; index--)
        if (existsSync(`${file}.${index}`)) renameSync(`${file}.${index}`, `${file}.${index + 1}`);
      renameSync(file, `${file}.1`);
    }
    appendFileSync(file, entry.slice(0, DIAGNOSTICS_MAX_BYTES / 4) + '\n', { mode: 0o600 });
    return file;
  } catch {
    return undefined;
  }
}

/** Log the full stack and command words (never arguments: they can carry payloads). Prefer the owner's `.forge/logs`, then `~/.forge/logs`, then the temp directory. */
export function recordFailure(error: unknown, root?: string): Failure {
  const failure = describeFailure(error);
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  const entry = `${new Date().toISOString()} ${failure.code} pid=${process.pid} command=${process.argv
    .slice(2, 4)
    .filter(arg => /^[a-z][a-z-]*$/.test(arg))
    .join(' ')}\n${detail}\n`;
  const ownerForge = root && existsSync(join(root, '.forge')) ? join(root, '.forge', 'logs') : undefined;
  for (const directory of [ownerForge, join(homedir(), '.forge', 'logs'), join(tmpdir(), 'forge-logs')]) {
    const diagnostics = directory && writeDiagnostics(directory, entry, directory === ownerForge);
    if (diagnostics) return { ...failure, diagnostics };
  }
  return failure;
}
