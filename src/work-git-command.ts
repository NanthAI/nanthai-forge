// SPDX-License-Identifier: Apache-2.0
import { ForgeError } from './errors.js';
import { scrubText } from './client-error-text.js';

// Keep the existing per-command budget; loaded machines can opt into a longer wait.
export const gitTimeout = () => {
  const value = Number(process.env.FORGE_GIT_TIMEOUT_MS);
  return Number.isInteger(value) && value >= 1000 && value <= 3_600_000 ? value : 20_000;
};

export function gitCommand(root: string, args: string[]) {
  return {
    args: [
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
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: 'NanthAi Forge',
      GIT_AUTHOR_EMAIL: 'forge@localhost',
      GIT_COMMITTER_NAME: 'NanthAi Forge',
      GIT_COMMITTER_EMAIL: 'forge@localhost',
    },
  };
}

// Never report arguments (which can contain source text, credentials or URLs).
export const gitPhase = (args: string[]) => args.find(arg => /^[a-z][a-z-]*$/.test(arg)) ?? 'operation';

export function gitFailure(error: unknown, args: string[], timedOut = false): ForgeError {
  const failure = error as {
    stderr?: string | Buffer;
    status?: number;
    code?: string | number;
    signal?: string;
  };
  const stderr =
    typeof failure.stderr === 'string' || Buffer.isBuffer(failure.stderr)
      ? scrubText(
          failure.stderr
            .toString()
            .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1[redacted]@')
            .replace(/\b(?:gh[pousr]_|github_pat_)[\w]+/g, '[redacted]')
            .replace(/\bBasic\s+[A-Za-z0-9+/]+=*/gi, 'Basic [redacted]')
            .replace(/[\x00-\x1f\x7f]+/g, ' '),
          4000,
        ).trim()
      : '';
  return new ForgeError(
    timedOut ? 'WORK_GIT_TIMEOUT' : 'WORK_GIT_FAILED',
    `Git ${gitPhase(args)} ${timedOut ? `exceeded its ${gitTimeout()}ms wait budget (FORGE_GIT_TIMEOUT_MS)` : 'failed'} (status=${failure.status ?? 'unknown'}, code=${failure.code ?? 'none'}, signal=${failure.signal ?? 'none'}).${stderr ? ` stderr: ${stderr}` : ''} Existing branches and workspaces are retained; inspect work status before retrying.`,
  );
}
