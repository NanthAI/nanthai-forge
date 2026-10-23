// SPDX-License-Identifier: Apache-2.0
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ForgeError, invariant } from './errors.js';
import { workGit } from './work-git.js';
import type { GithubSyncCommit } from './github-sync-types.js';
import { gitPushRejectionClass } from './github-sync-classification.js';
export { gitPushRejectionClass } from './github-sync-classification.js';

/** Git's stderr, kept for diagnosis: redacted (credentials, tokens, Authorization) and bounded. */
export function redactGitStderr(text: string, limit = 600) {
  const clean = text
    .replace(
      /(authorization|proxy-authorization|x-access-token|bearer|basic)\s*[:=]?\s*\S+(\s+\S+)?/gi,
      '$1 [redacted]',
    )
    .replace(/\b(https?|ssh|git):\/\/[^\s/@]+@/gi, '$1://[redacted]@')
    .replace(/\b(gh[pousr]_|github_pat_)[A-Za-z0-9_]{6,}/g, '[redacted]')
    .replace(/(token|password|secret|key)=\S+/gi, '$1=[redacted]')
    .replace(/[\u0000-\u0008\u000b-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > limit ? `${clean.slice(0, limit)}...` : clean;
}
/** `detail` is redacted git stderr; `transient` is false for failures a retry cannot fix. */
export class GitSyncError extends ForgeError {
  constructor(
    readonly detail: string,
    readonly transient: boolean,
    readonly rejectionClass = gitPushRejectionClass(detail),
  ) {
    super(
      'GITHUB_SYNC_GIT_FAILED',
      'GitHub sync could not finish with current git/gh access. Retry to reconcile the retained operation.',
    );
  }
}
const permanentGit =
  /authentication failed|could not read (username|password)|repository not found|permission[^\n]*denied|access denied|write access[^\n]*not granted|not authorized|invalid credentials|bad credentials|protected (branch|ref)|GH0(?:0[136]|13)|non-fast-forward|fetch first|stale info|HTTP(?:\/\S+)?[ :]+(401|404)\b|error: (401|404)\b/i;
const rateLimitedGit = /rate.?limit|HTTP 429\b|error: 429\b|too many requests|abuse detection/i;
const forbiddenGit = /HTTP(?:\/\S+)?[ :]+403\b|error: 403\b/i;
const transientGit =
  /\[remote rejected\][^\n]*\((failed|internal server error)\)|HTTP(?:\/\S+)?[ :]+5\d\d\b|error: 5\d\d\b|RPC failed|early EOF|connection[^\n]*(reset|timed? out|timeout)|operation timed out|could not resolve host|failed to connect|cannot lock ref/i;
/** Explicit permanent failures win over transport symptoms; unknown failures are not retried. */
export function transientGitFailure(detail: string) {
  return (
    !permanentGit.test(detail) &&
    !['workflow-scope', 'ref-policy', 'ref-name', 'access-rejected'].includes(
      gitPushRejectionClass(detail) ?? '',
    ) &&
    (!forbiddenGit.test(detail) || rateLimitedGit.test(detail)) &&
    (transientGit.test(detail) || rateLimitedGit.test(detail))
  );
}
export const syncGitSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
/** The caller must observe its exact ref and lease on every attempt before pushing. */
export async function retrySyncGit<T>(
  attempt: () => Promise<T>,
  sleep = syncGitSleep,
  progress?: (message: string) => void,
) {
  for (let tries = 1; ; tries++) {
    try {
      return await attempt();
    } catch (error) {
      if (tries >= 5 || !(error instanceof GitSyncError) || !error.transient) throw error;
      const ms = Math.min(16_000, 2_000 * 2 ** (tries - 1)) * (0.5 + Math.random());
      progress?.(
        `Git push transient failure; retry ${tries + 1}/5 in ${Math.ceil(ms / 1000)} s after checking the exact remote ref.`,
      );
      await sleep(ms);
    }
  }
}

// Read user credentials/identity, but no target checkout config, hooks, filters or source code.
export function syncGit(root: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [
        '--no-replace-objects',
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'core.fsmonitor=false',
        '-c',
        'submodule.recurse=false',
        '-c',
        'credential.helper=!gh auth git-credential',
        '-C',
        root,
        ...args,
      ],
      {
        env: {
          ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
          GIT_TERMINAL_PROMPT: '0',
          GH_PROMPT_DISABLED: '1',
        },
        encoding: 'utf8',
        timeout: 120_000,
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (!error) return resolve(stdout);
        const detail = String(stderr || (error as Error).message || '');
        reject(
          new GitSyncError(
            redactGitStderr(detail),
            transientGitFailure(
              detail + (error.killed && error.signal === 'SIGTERM' ? '\nOperation timed out' : ''),
            ),
            gitPushRejectionClass(detail),
          ),
        );
      },
    );
  });
}
export async function withSyncGit<T>(directory: string, use: (root: string) => Promise<T>) {
  const root = mkdtempSync(join(directory, 'github-sync-'));
  try {
    workGit(directory, ['init', '--bare', '--template=', '--initial-branch=main', root]);
    return await use(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
export async function syncIdentity(root: string) {
  const read = async (key: string) => {
    try {
      return (await syncGit(root, ['config', '--get', key])).trim();
    } catch {
      return '';
    }
  };
  // Sync-only identity wins over the user's Git identity, which may be a private address.
  const name =
      process.env.FORGE_GITHUB_SYNC_NAME?.trim() ||
      (await read('forge.githubSync.name')) ||
      (await read('user.name')),
    email =
      process.env.FORGE_GITHUB_SYNC_EMAIL?.trim() ||
      (await read('forge.githubSync.email')) ||
      (await read('user.email'));
  invariant(
    name && email && !/[<>\r\n\0]/.test(name + email),
    'GITHUB_SYNC_IDENTITY',
    'Configure git user.name and user.email (or forge.githubSync.name and forge.githubSync.email) for GitHub sync.',
  );
  return {
    identity: { name, email },
    coAuthor: process.env.FORGE_GITHUB_SYNC_COAUTHOR ?? (await read('forge.githubSync.coAuthor')),
  };
}
export function writeSyncCommit(root: string, entry: Omit<GithubSyncCommit, 'commit'>) {
  const person = (value: typeof entry.author) => {
    invariant(
      !/[<>\r\n\0]/.test(value.name + value.email),
      'GITHUB_SYNC_IDENTITY',
      'Git attribution is invalid.',
    );
    return `${value.name} <${value.email}> ${entry.seconds} +0000`;
  };
  const raw = `tree ${entry.tree}\n${entry.parent ? `parent ${entry.parent}\n` : ''}author ${person(entry.author)}\ncommitter ${person(entry.committer)}\n\n${entry.message}\n`;
  return workGit(root, ['hash-object', '-t', 'commit', '-w', '--stdin'], raw).trim();
}
/** Returns '' for a missing branch only when `allowMissing`; otherwise a missing branch is an error. */
export async function remoteSyncHead(root: string, remote: string, ref: string, allowMissing = false) {
  const output = (await syncGit(root, ['ls-remote', '--refs', remote, ref])).trim();
  if (allowMissing && !output) return '';
  const parts = output.split(/\s+/);
  invariant(
    parts.length === 2 && /^[0-9a-f]{40}$/.test(parts[0]!) && parts[1] === ref,
    'GITHUB_SYNC_REMOTE',
    'Select an existing GitHub branch (or an empty repository to create it).',
  );
  return parts[0]!;
}

export async function defaultSyncRepository(input: string): Promise<string> {
  try {
    const output = await new Promise<string>((resolve, reject) => {
      execFile(
        'gh',
        ['repo', 'view', '--json', 'nameWithOwner'],
        { cwd: input, encoding: 'utf8', timeout: 20_000 },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      );
    });
    const value = JSON.parse(output) as { nameWithOwner?: unknown };
    invariant(
      typeof value.nameWithOwner === 'string',
      'BAD_REPOSITORY',
      'GitHub repository identity is invalid.',
    );
    return value.nameWithOwner;
  } catch {
    throw new ForgeError('BAD_REPOSITORY', 'Pass --repo OWNER/NAME on the first sync.');
  }
}
