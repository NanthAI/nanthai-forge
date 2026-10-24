// SPDX-License-Identifier: Apache-2.0
import { execFile } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ForgeError, invariant } from './errors.js';
import { digest } from './hash.js';
import { workGit } from './work-git.js';
import { treeForGit } from './native-git.js';
import { NativeSource } from './native-source.js';
import type { GitProjection } from './work-types.js';
import type { WorkStore } from './work-store.js';

function run(file: string, args: string[], cwd: string, input?: unknown): Promise<string> {
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GH_PROMPT_DISABLED: '1',
  };
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      { cwd, env, encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) =>
        error
          ? reject(
              new ForgeError(
                'PUBLISH_GITHUB_FAILED',
                'GitHub could not finish with the current local Git/gh access. Existing work is preserved; retry to reconcile.',
              ),
            )
          : resolve(stdout),
    );
    child.stdin?.on('error', () => {
      /* The callback reports failure without logging credential-bearing output. */
    });
    child.stdin?.end(input === undefined ? undefined : JSON.stringify(input));
  });
}
export async function workGithubApi<T>(store: WorkStore, path: string, input?: unknown): Promise<T> {
  const result = await run(
    'gh',
    [
      'api',
      '--hostname',
      'github.com',
      '--method',
      input === undefined ? 'GET' : 'POST',
      path,
      ...(input === undefined ? [] : ['--input', '-']),
    ],
    store.directory,
    input,
  );
  try {
    return JSON.parse(result) as T;
  } catch {
    throw new ForgeError(
      'PUBLISH_GITHUB_FAILED',
      'GitHub returned an invalid response. Existing work is preserved.',
    );
  }
}

// A disposable bare transport reads no target checkout configuration, hooks or filters.
// It owns no work journal; retained objects and refs belong to the existing Git/WorkStore.
export async function withGithubTransport<T>(
  store: WorkStore,
  use: (
    path: string,
    git: (args: string[]) => Promise<string>,
    retain: (heads: string[]) => Buffer | void,
  ) => Promise<T>,
  retention: 'github' | 'contributions' = 'github',
  projection?: GitProjection,
  projectionBytes?: Buffer,
): Promise<T> {
  const path = mkdtempSync(join(store.directory, 'publish-'));
  try {
    invariant(
      !store.native || projection,
      'INVALID_NATIVE_GIT',
      'Native Git transport requires its original retained projection.',
    );
    const source = store.native ? new NativeSource(store.root) : undefined;
    const format = projection?.format ?? workGit(store.root, ['rev-parse', '--show-object-format']).trim();
    workGit(store.directory, [
      'init',
      '--bare',
      '--template=',
      `--object-format=${format}`,
      '--initial-branch=forge',
      path,
    ]);
    const objects = source
      ? undefined
      : realpathSync(resolve(store.root, workGit(store.root, ['rev-parse', '--git-path', 'objects']).trim()));
    if (source && projection) {
      invariant(
        !projectionBytes || digest(projectionBytes) === projection.bundle,
        'INVALID_NATIVE_GIT',
        'Staged projection bytes differ from the selected digest.',
      );
      const bundle = join(path, 'native.bundle');
      writeFileSync(bundle, projectionBytes ?? source.object(projection.bundle), { mode: 0o600 });
      workGit(path, ['bundle', 'verify', bundle]);
      workGit(path, ['bundle', 'unbundle', bundle]);
      workGit(path, ['rev-parse', '--verify', `${projection.head}^{commit}`]);
      invariant(
        workGit(path, ['rev-parse', `${projection.head}^{tree}`]).trim() ===
          treeForGit(path, source.state(projection.state).files, source),
        'INVALID_NATIVE_GIT',
        'The projected Git tree differs from its exact native State.',
      );
    } else
      writeFileSync(join(path, 'objects/info/alternates'), `${JSON.stringify(objects)}\n`, { mode: 0o600 });
    const git = (args: string[]) =>
      run(
        'git',
        [
          '-c',
          'core.hooksPath=/dev/null',
          '-c',
          'core.fsmonitor=false',
          '-c',
          'credential.helper=',
          '-c',
          'credential.helper=!gh auth git-credential',
          '-C',
          path,
          ...args,
        ],
        path,
      );
    const retain = (heads: string[]) => {
      if (source) {
        const refs = [...new Set(heads)].map(head => {
          workGit(path, ['rev-parse', '--verify', `${head}^{commit}`]);
          const ref = `refs/forge/${retention}/${head}`;
          workGit(path, ['update-ref', ref, head]);
          return ref;
        });
        const bundle = join(path, 'observed.bundle');
        workGit(path, ['bundle', 'create', bundle, ...refs]);
        // Do not publish unreferenced CAS objects before the caller registers its observation.
        return readFileSync(bundle);
      }
      for (const name of readdirSync(join(path, 'objects'))) {
        if (/^(?:[0-9a-f]{2}|pack)$/.test(name))
          cpSync(join(path, 'objects', name), join(objects!, name), { recursive: true, force: false });
      }
      for (const head of new Set(heads)) {
        workGit(store.root, ['rev-parse', '--verify', `${head}^{commit}`]);
        workGit(store.root, ['update-ref', `refs/forge/${retention}/${head}`, head]);
      }
    };
    return await use(path, git, retain);
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
}
