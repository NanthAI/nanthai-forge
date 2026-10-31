// SPDX-License-Identifier: Apache-2.0
import { diskGuard } from './disk-guard.js';
import { closeSync, existsSync, lstatSync, openSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Lane } from './work-types.js';
import { execFileSync } from 'node:child_process';
import { invariant } from './errors.js';
import { gitCommand, gitFailure, gitTimeout } from './work-git-command.js';
import { forgeTempDir } from './forge-disk.js';

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
  const command = gitCommand(root, args);
  // Large stdin written through spawnSync's pipe intermittently stalls until the timeout (seen with
  // `hash-object --stdin` on a 1 MiB blob). Hand Git the same bytes as a private file descriptor instead.
  let spill: { directory: string; fd: number } | undefined;
  if (input !== undefined && Buffer.byteLength(input) > 32 * 1024) {
    const directory = forgeTempDir('git-input'),
      file = join(directory, 'input');
    writeFileSync(file, input, { mode: 0o600 });
    spill = { directory, fd: openSync(file, 'r') };
  }
  try {
    return execFileSync('git', command.args, {
      encoding: raw ? undefined : 'utf8',
      timeout: gitTimeout(),
      maxBuffer: 4 * 1024 * 1024,
      env: command.env,
      stdio: [spill ? spill.fd : 'pipe', 'pipe', 'pipe'],
      ...(input === undefined || spill ? {} : { input }),
    });
  } catch (error) {
    const failure = error as { status?: number; stdout?: string };
    if (acceptConflict && failure.status === 1 && typeof failure.stdout === 'string') return failure.stdout;
    throw gitFailure(error, args);
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
