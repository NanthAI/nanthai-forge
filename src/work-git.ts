// SPDX-License-Identifier: Apache-2.0
import { diskGuard } from './disk-guard.js';
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  openSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Lane } from './work-types.js';
import { execFileSync } from 'node:child_process';
import { ForgeError, invariant } from './errors.js';

// Per-command ceiling for local Git. FORGE_GIT_TIMEOUT_MS raises it for heavily loaded machines
// (the standard check sets it); invalid values fall back to the default.
const gitTimeout = () => {
  const value = Number(process.env.FORGE_GIT_TIMEOUT_MS);
  return Number.isInteger(value) && value >= 1000 && value <= 3_600_000 ? value : 20_000;
};

export function workGit(
  root: string,
  args: string[],
  input?: string | Buffer,
  acceptConflict?: boolean,
): string;
export function workGit(
  root: string,
  args: string[],
  input: string | Buffer | undefined,
  acceptConflict: boolean,
  raw: true,
): Buffer;
export function workGit(
  root: string,
  args: string[],
  input?: string | Buffer,
  acceptConflict = false,
  raw = false,
): string | Buffer {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  // Large stdin written through spawnSync's pipe intermittently stalls until the timeout (seen with
  // `hash-object --stdin` on a 1 MiB blob). Hand Git the same bytes as a private file descriptor instead.
  let spill: { directory: string; fd: number } | undefined;
  if (input !== undefined && Buffer.byteLength(input) > 32 * 1024) {
    const directory = mkdtempSync(join(tmpdir(), 'forge-git-input-')),
      file = join(directory, 'input');
    writeFileSync(file, input, { mode: 0o600 });
    spill = { directory, fd: openSync(file, 'r') };
  }
  try {
    return execFileSync(
      'git',
      [
        '--no-replace-objects',
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'core.fsmonitor=false',
        '-c',
        'commit.gpgSign=false',
        '-c',
        'submodule.recurse=false',
        '-c',
        'core.untrackedCache=false',
        '-C',
        root,
        ...args,
      ],
      {
        encoding: raw ? undefined : 'utf8',
        timeout: gitTimeout(),
        maxBuffer: 4 * 1024 * 1024,
        env: {
          ...env,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
          GIT_TERMINAL_PROMPT: '0',
          GIT_AUTHOR_NAME: 'NanthAi Forge',
          GIT_AUTHOR_EMAIL: 'forge@localhost',
          GIT_COMMITTER_NAME: 'NanthAi Forge',
          GIT_COMMITTER_EMAIL: 'forge@localhost',
        },
        stdio: [spill ? spill.fd : 'pipe', 'pipe', 'pipe'],
        ...(input === undefined || spill ? {} : { input }),
      },
    );
  } catch (error) {
    const failure = error as { status?: number; stdout?: string };
    if (acceptConflict && failure.status === 1 && typeof failure.stdout === 'string') return failure.stdout;
    throw new ForgeError(
      'WORK_GIT_FAILED',
      'Git operation failed or exceeded its limit. Existing branches and workspaces are retained; inspect work status before retrying.',
    );
  } finally {
    if (spill) {
      closeSync(spill.fd);
      rmSync(spill.directory, { recursive: true, force: true });
    }
  }
}
/** True when `ancestor` is reachable from `head` (or equal). */
export function gitIsAncestor(root: string, ancestor: string, head: string): boolean {
  return workGit(root, ['merge-base', ancestor, head], undefined, true).trim() === ancestor;
}
export function executionGuard(root: string): void {
  const config = workGit(
    root,
    ['config', '--get-regexp', String.raw`^(filter\..*\.(clean|smudge|process)|merge\..*\.driver)$`],
    undefined,
    true,
  );
  invariant(
    !config.trim(),
    'UNSAFE_GIT_CONFIG',
    'Local work operations do not run configured Git filters or merge drivers. Use a checkout without those commands.',
  );
}
export const branchFor = (id: string) => `refs/heads/forge/lane/${id}`;
export const headAt = (root: string) => workGit(root, ['rev-parse', '--verify', 'HEAD']).trim();
export function commitTree(root: string, tree: string, parents: string[], message: string): string {
  return workGit(root, ['commit-tree', tree, ...parents.flatMap(p => ['-p', p])], `${message}\n`).trim();
}

export function materializeLane(root: string, path: string, lane: Lane) {
  if (!existsSync(path)) {
    diskGuard(root);
    const refs = workGit(root, [
      'for-each-ref',
      '--format=%(refname) %(objectname)',
      branchFor(lane.id),
    ]).trim();
    if (refs) {
      invariant(
        refs === `${branchFor(lane.id)} ${lane.base}`,
        'LANE_DIVERGED',
        'Interrupted Lane branch moved; its work is preserved.',
      );
      workGit(root, ['worktree', 'add', path, `forge/lane/${lane.id}`]);
    } else workGit(root, ['worktree', 'add', '-b', `forge/lane/${lane.id}`, path, lane.base]);
  }
  invariant(
    !lstatSync(path).isSymbolicLink() && realpathSync(path) === path,
    'LANE_UNAVAILABLE',
    'Lane workspace is unavailable or unsafe. Existing work is preserved.',
  );
  executionGuard(path);
  invariant(
    workGit(path, ['symbolic-ref', 'HEAD']).trim() === branchFor(lane.id),
    'LANE_BRANCH_CHANGED',
    'The original Lane changed branches. Existing work is preserved.',
  );
  invariant(
    headAt(path) === lane.base,
    'LANE_DIVERGED',
    'The pending Lane has changed source. Existing work is retained.',
  );
}
