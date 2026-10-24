// SPDX-License-Identifier: Apache-2.0
import { execFile } from 'node:child_process';
import { ForgeError } from './errors.js';

/** Private bare repository; no inherited Git configuration, hooks, credential
 * helper, checkout, filter or project process. Token exists only for remote I/O. */
export function hostedActionsGit(root: string, args: string[], input?: string, token?: string) {
  return new Promise<string>((resolve, reject) => {
    const child = execFile(
      'git',
      [
        '--no-replace-objects',
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'core.fsmonitor=false',
        '-c',
        'commit.gpgSign=false',
        '-C',
        root,
        ...args,
      ],
      {
        encoding: 'utf8',
        timeout: 90_000,
        maxBuffer: 4 * 1024 * 1024,
        env: {
          PATH: process.env.PATH,
          HOME: root,
          XDG_CONFIG_HOME: root,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_TERMINAL_PROMPT: '0',
          GIT_AUTHOR_NAME: 'NanthAi Forge',
          GIT_AUTHOR_EMAIL: 'forge@localhost',
          GIT_COMMITTER_NAME: 'NanthAi Forge',
          GIT_COMMITTER_EMAIL: 'forge@localhost',
          GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
          GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
          ...(token
            ? {
                GIT_CONFIG_COUNT: '1',
                GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
                GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
              }
            : {}),
        },
      },
      (error, stdout) => {
        // Never expose child stderr, argv, environment or a transport's raw error.
        if (error)
          reject(
            new ForgeError(
              'GITHUB_ACTIONS_GIT',
              'Actions Git operation was not acknowledged; reconcile its exact retained ref.',
            ),
          );
        else resolve(stdout.trim());
      },
    );
    child.stdin?.on('error', () => {});
    child.stdin?.end(input);
  });
}
