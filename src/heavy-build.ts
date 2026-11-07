// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Targeted tests import ../dist/*.js. A fresh Lane has no dist/ (friction 6288d0c2). */
export const CORE_BUILD_COMMAND = 'npm run build:core';
const BUILT_MARKER = join('dist', 'cli-entry.js');

/** The Forge checkout that holds cwd: the nearest package.json with a build:core script and a src/. */
export function coreBuildRoot(cwd: string): string | null {
  let folder = cwd;
  for (let depth = 0; depth < 8; depth++) {
    try {
      const scripts = (
        JSON.parse(readFileSync(join(folder, 'package.json'), 'utf8')) as {
          scripts?: Record<string, unknown>;
        }
      ).scripts;
      if (typeof scripts?.['build:core'] === 'string' && existsSync(join(folder, 'src'))) return folder;
    } catch {}
    const parent = dirname(folder);
    if (parent === folder) return null;
    folder = parent;
  }
  return null;
}

/**
 * 'missing' without dist/, 'stale' when a src/**.ts file or tsconfig.json is newer than the built
 * entry, otherwise 'fresh'. One stat per source file: no hashing, no reads, no network.
 */
export function coreBuildState(root: string): 'fresh' | 'missing' | 'stale' {
  let built: number;
  try {
    built = statSync(join(root, BUILT_MARKER)).mtimeMs;
  } catch {
    return 'missing';
  }
  const newer = (file: string) => {
    try {
      return statSync(file).mtimeMs > built;
    } catch {
      return false;
    }
  };
  if (newer(join(root, 'tsconfig.json'))) return 'stale';
  const source = join(root, 'src');
  let names: string[];
  try {
    names = readdirSync(source, { recursive: true }) as string[];
  } catch {
    return 'fresh';
  }
  return names.some(name => name.endsWith('.ts') && newer(join(source, name))) ? 'stale' : 'fresh';
}

const runBuild = (root: string) =>
  new Promise<number>(resolve => {
    // Build output goes to stderr so a test reporter's stdout stays clean.
    const child = spawn(CORE_BUILD_COMMAND.split(' ')[0]!, CORE_BUILD_COMMAND.split(' ').slice(1), {
      cwd: root,
      stdio: ['ignore', 2, 2],
      shell: process.platform === 'win32',
    });
    child.once('error', () => resolve(1));
    child.once('exit', code => resolve(code ?? 1));
  });

/**
 * Build core before a node --test batch when dist/ is missing or older than src/. Fresh dist/ costs
 * one stat pass. Returns a nonzero exit code (after printing the exact command) if the build fails.
 */
export async function ensureCoreBuild(
  cwd: string,
  build: (root: string) => Promise<number> = runBuild,
  write: (text: string) => void = text => void process.stderr.write(text),
): Promise<number> {
  const root = coreBuildRoot(cwd);
  if (!root) return 0;
  const state = coreBuildState(root);
  if (state === 'fresh') return 0;
  write(`heavy: dist/ is ${state}; running ${CORE_BUILD_COMMAND} before the tests.\n`);
  const code = await build(root);
  if (code !== 0)
    write(
      `heavy: ${CORE_BUILD_COMMAND} failed with exit ${code}; the tests were not run. Fix the build, then re-run ${CORE_BUILD_COMMAND} (or this command).\n`,
    );
  return code;
}
