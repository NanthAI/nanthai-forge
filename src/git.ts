// SPDX-License-Identifier: Apache-2.0
import { childEnv } from '../scripts/child-env.mjs';
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { isAbsolute, posix } from 'node:path';
import { scanSourcePaths } from './source-paths.js';
import { nativeOwner, nativePaths } from './native-source.js';
import { ForgeError, invariant } from './errors.js';

function run(root: string, args: string[], input?: string, acceptNoMatch = false): string {
  const env = childEnv();
  try {
    return execFileSync(
      'git',
      [
        '--no-optional-locks',
        '-c',
        'core.fsmonitor=false',
        '-c',
        'core.untrackedCache=false',
        '-C',
        root,
        ...args,
      ],
      {
        encoding: 'utf8',
        timeout: 15_000,
        maxBuffer: 8 * 1024 * 1024,
        env: {
          ...env,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        ...(input === undefined ? {} : { input }),
      },
    );
  } catch (error) {
    const failure = error as { status?: number; stdout?: string };
    if (acceptNoMatch && failure.status === 1 && typeof failure.stdout === 'string') return failure.stdout;
    throw new ForgeError(
      'GIT_FAILED',
      'Git metadata could not be read. Use a local Git worktree with Git installed.',
    );
  }
}
export function verifyRoot(root: string): void {
  if (nativeOwner(root)) return;
  const top = run(root, ['rev-parse', '--show-toplevel']).trim();
  invariant(
    realpathSync(top) === root,
    'NOT_REPOSITORY_ROOT',
    'Pass the Git worktree root, not a subdirectory.',
  );
}
export function gitHead(root: string): string | null {
  if (nativeOwner(root)) return null;
  try {
    return run(root, ['rev-parse', '--verify', 'HEAD']).trim();
  } catch {
    return null;
  } // Unborn Git worktrees have no HEAD.
}
export function sourcePaths(root: string): string[] {
  if (nativeOwner(root)) return nativePaths(root);
  const paths = run(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])
    .split('\0')
    .filter(path => Boolean(path) && path !== '.forge' && !path.startsWith('.forge/'));
  const known = new Set(paths);
  // Git's initial listing omits files restored by a Forge negation. Add the
  // shared local inventory, preserving Git's private info/exclude settings.
  const extra = scanSourcePaths(root, { validate: false }).filter(path => !known.has(path));
  const external = externalGitIgnores(root, extra);
  return [...new Set([...paths, ...extra.filter(path => !external.has(path))])].sort();
}
export function ignoredPaths(root: string, paths: string[]): Set<string> {
  if (!paths.length) return new Set();
  const native = nativeOwner(root);
  const included = new Set(native ? nativePaths(root) : scanSourcePaths(root, { validate: false }));
  const ignored = new Set(paths.filter(path => !included.has(path)));
  if (!native) for (const path of externalGitIgnores(root, paths)) ignored.add(path);
  return ignored;
}
/** Repository .gitignore rules use the shared matcher. Retain Git's other local
 * exclusions without allowing a Forge negation to override those settings. */
function externalGitIgnores(root: string, paths: string[]): Set<string> {
  if (!paths.length) return new Set();
  const output = run(
    root,
    ['check-ignore', '--no-index', '--stdin', '-z', '-v', '--non-matching'],
    `${paths.join('\0')}\0`,
    true,
  );
  const fields = output.split('\0');
  const ignored = new Set<string>();
  for (let i = 0; i + 3 < fields.length; i += 4) {
    const source = fields[i]!,
      pattern = fields[i + 2],
      path = fields[i + 3];
    const repositoryRule = !isAbsolute(source) && posix.basename(source) === '.gitignore';
    if (!repositoryRule && pattern && !pattern.startsWith('!') && path) ignored.add(path);
  }
  return ignored;
}
