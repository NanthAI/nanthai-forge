// SPDX-License-Identifier: Apache-2.0
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ForgeError } from './errors.js';
import { gitlinkCommit, gitmoduleUrls } from './gitlink.js';
import type { NativeFile } from './state/format.js';
import { safeRelative } from './safe-relative.js';
import { inTestProcess } from './test-isolation.js';
import { submoduleAllowCommand } from './submodule-allowlist.js';

/** Recursive checkouts stop here, like a bounded `submodules: recursive`. */
export const submoduleDepthLimit = 8;
export const submoduleCountLimit = 256;
const fetchTimeoutMs = 10 * 60_000;

export type SubmoduleRefusalReason =
  | 'url-unavailable'
  | 'relative-url-without-origin'
  | 'url-unsupported'
  | 'fetch-failed'
  | 'outside-installation'
  | 'not-allowed'
  | 'public-logs'
  | 'access-unavailable'
  | 'git-unavailable'
  | 'limit';
export type SubmoduleRefusal = {
  path: string;
  commit: string;
  url: string | null;
  reason: SubmoduleRefusalReason;
  /** `OWNER/NAME` for a private GitHub repository refusal that names an owner command. */
  repository?: string;
};
export type MaterializedSubmodule = { path: string; commit: string; url: string; fetched: boolean };

/** Which URL Forge fetches for a `.gitmodules` URL, or why it refuses. Only
 * credential-free HTTPS leaves the runner; GitHub SSH spellings become their
 * public HTTPS form. Relative URLs resolve against the superproject's URL. */
export function submoduleFetchUrl(
  url: string | null,
  origin?: string,
): { url: string } | { reason: SubmoduleRefusalReason } {
  if (!url) return { reason: 'url-unavailable' };
  if (url.startsWith('./') || url.startsWith('../')) {
    if (!origin) return { reason: 'relative-url-without-origin' };
    // Synthetic fixtures: a local HTTP server stands in for the project's GitHub repository.
    const base =
      fileUrlsForTests() && origin.startsWith('http://127.0.0.1:')
        ? { url: origin }
        : submoduleFetchUrl(origin);
    if (!('url' in base)) return base;
    const parts = new URL(base.url).pathname.replace(/\/+$/, '').split('/');
    for (const part of url.split('/')) {
      if (part === '..') {
        if (parts.length <= 1) return { reason: 'url-unsupported' };
        parts.pop();
      } else if (part && part !== '.') parts.push(part);
    }
    const resolved = new URL(base.url);
    resolved.pathname = parts.join('/');
    return { url: resolved.href };
  }
  const ssh = /^(?:ssh:\/\/)?git@github\.com[:/]([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)\/?$/.exec(url);
  if (ssh) return { url: `https://github.com/${ssh[1]}` };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { reason: 'url-unsupported' };
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !parsed.hostname)
    return { reason: 'url-unsupported' };
  return { url: parsed.href };
}

/** `OWNER/NAME` of a GitHub repository URL, the only kind a project's App token can serve. */
export function githubRepositoryOf(url: string): string | null {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i.exec(url);
  if (match) return `${match[1]}/${match[2]}`;
  // Synthetic fixtures: a local HTTP server stands in for GitHub.
  const local = fileUrlsForTests()
    ? /^http:\/\/127\.0\.0\.1:\d+\/([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(url)
    : null;
  return local ? `${local[1]}/${local[2]}` : null;
}

const reasonHints: Partial<Record<SubmoduleRefusalReason, (repository?: string) => string>> = {
  'relative-url-without-origin': () =>
    " (a relative URL resolves against the project's GitHub repository, and this runner has none, as on a connected machine; use an absolute https URL, or run the check on a GitHub Actions runner)",
  'fetch-failed': repository =>
    !repository
      ? ''
      : ` (${repository} could not be fetched; if it is private, only a GitHub Actions runner can read it, after the project owner allows it, and a connected-machine runner cannot; make it public or set "submodules": false on the check)`,
  'outside-installation': () =>
    " (not readable without credentials, and its repository is not in the project's GitHub App installation)",
  'access-unavailable': () =>
    ' (the repository was not readable without credentials and App access could not be obtained)',
  'not-allowed': (repository = 'OWNER/NAME') =>
    ` (not readable without credentials, and the project owner has not allowed checks to read ${repository}; ` +
    `to allow it, the project owner runs ${submoduleAllowCommand(repository)})`,
  'public-logs': (repository = 'OWNER/NAME') =>
    ` (${repository} is private and this runner's check logs are public, so anything a check prints from it ` +
    `would be public; use a runner with private logs, or, only if that is acceptable, the project owner runs ` +
    `${submoduleAllowCommand(repository, true)})`,
};

export function submoduleRefusal(refusals: SubmoduleRefusal[]) {
  const first = refusals[0]!;
  return new ForgeError(
    'SUBMODULE_NOT_MATERIALIZED',
    `Submodule ${first.path} @ ${first.commit.slice(0, 12)} (${first.url ?? 'no URL in .gitmodules'}) was not materialized: ${first.reason}${reasonHints[first.reason]?.(first.repository) ?? ''}` +
      (refusals.length > 1 ? `; ${refusals.length - 1} more` : '') +
      '. Public HTTPS URLs are fetched without credentials; private GitHub repositories only when the project owner allowed them and the project\'s GitHub App installation includes them. Set "submodules": false on the check to run without submodule content.',
    undefined,
    { refusals: refusals.slice(0, 20), more: Math.max(0, refusals.length - 20) },
  );
}

/** One read-only token per GitHub repository (`OWNER/NAME`), or why none was issued. */
export type SubmoduleAccess = (
  repositories: string[],
) => Promise<
  Record<
    string,
    { token: string } | { refused: 'outside-installation' | 'not-allowed' | 'public-logs' | 'unavailable' }
  >
>;
type Options = {
  /** Asked only after a credential-free fetch of a GitHub URL fails. */
  access?: SubmoduleAccess | undefined;
  /** Private per-run cache: one bare repository per URL, each commit fetched once. */
  cache: string;
  /** Superproject URL for relative `.gitmodules` URLs. */
  origin?: string | undefined;
  log?: (line: string) => void;
};
/** Synthetic fixtures only: a test process may also fetch local file URLs. */
const fileUrlsForTests = () => inTestProcess() && process.env.FORGE_TEST_SUBMODULE_FILE_URLS === '1';

/** Replace each gitlink's pointer file in a check workspace with the pinned
 * commit's tree, recursively. Git runs with no inherited config, hooks,
 * credential helper, filters or prompts; no repository code runs. Refuses as
 * a whole (SUBMODULE_NOT_MATERIALIZED) before writing when any URL is unusable.
 * A gitlink with no `.gitmodules` URL has nothing to fetch: it becomes an empty
 * directory with one notice line, as in GitHub's default checkout. */
export async function materializeSubmodules(
  directory: string,
  files: readonly NativeFile[],
  read: (blob: string) => Promise<Buffer>,
  options: Options,
): Promise<MaterializedSubmodule[]> {
  const links = files.filter(file => file.mode === 'gitlink');
  if (!links.length) return [];
  const started = performance.now();
  const modules = files.find(
    file => file.path === '.gitmodules' && file.mode !== 'symlink' && file.mode !== 'gitlink',
  );
  const urls = modules
    ? gitmoduleUrls((await read(modules.blob)).toString('utf8'))
    : new Map<string, string>();
  const pending: {
    path: string;
    commit: string;
    url: string | null;
    origin: string | undefined;
    depth: number;
  }[] = [];
  for (const link of links)
    pending.push({
      path: link.path,
      commit: gitlinkCommit(await read(link.blob)),
      url: urls.get(link.path) ?? null,
      origin: options.origin,
      depth: 0,
    });
  const fetcher = new SubmoduleFetcher(options);
  const done: MaterializedSubmodule[] = [];
  const unmapped: string[] = [];
  try {
    // Top level: vet every URL first, so an unusable one refuses before any fetch.
    const refusals = pending.flatMap(item => {
      if (item.url === null) return [];
      const target = vetted(item);
      return 'url' in target
        ? []
        : [{ path: item.path, commit: item.commit, url: item.url, reason: target.reason }];
    });
    if (refusals.length) throw submoduleRefusal(refusals);
    while (pending.length) {
      const item = pending.shift()!;
      if (item.url === null) {
        await workspaceTarget(directory, item.path);
        unmapped.push(item.path);
        continue;
      }
      if (done.length >= submoduleCountLimit || item.depth >= submoduleDepthLimit)
        throw submoduleRefusal([{ path: item.path, commit: item.commit, url: item.url, reason: 'limit' }]);
      const target = vetted(item);
      if (!('url' in target))
        throw submoduleRefusal([
          { path: item.path, commit: item.commit, url: item.url, reason: target.reason },
        ]);
      const fetched = await fetcher.pin(target.url, item.commit);
      if (typeof fetched === 'string') {
        const repository = githubRepositoryOf(target.url);
        throw submoduleRefusal([
          {
            path: item.path,
            commit: item.commit,
            url: item.url,
            reason: fetched,
            ...(repository ? { repository } : {}),
          },
        ]);
      }
      await fetcher.checkout(target.url, item.commit, await workspaceTarget(directory, item.path));
      done.push({ path: item.path, commit: item.commit, url: target.url, fetched });
      for (const nested of await fetcher.nested(target.url, item.commit))
        pending.push({
          path: `${item.path}/${nested.path}`,
          commit: nested.commit,
          url: nested.url,
          origin: target.url,
          depth: item.depth + 1,
        });
    }
  } finally {
    await fetcher.dispose();
  }
  if (unmapped.length) options.log?.(unmappedNotice(unmapped));
  options.log?.(
    `submodules: ${done.length} materialized (${done.filter(item => item.fetched).length} fetched, ${done.filter(item => !item.fetched).length} cached) in ${((performance.now() - started) / 1000).toFixed(1)}s`,
  );
  return done;
}

/** One line for every gitlink left empty because `.gitmodules` names no URL for it. */
export function unmappedNotice(paths: readonly string[]) {
  const shown = paths.slice(0, 5).join(', ');
  return `submodules: ${paths.length} without a URL in .gitmodules left as empty directories, as in GitHub's default checkout: ${shown}${paths.length > 5 ? ` and ${paths.length - 5} more` : ''}`;
}

export function vetted(item: { url: string | null; origin: string | undefined }) {
  if (fileUrlsForTests() && (item.url?.startsWith('file://') || item.url?.startsWith('http://127.0.0.1:')))
    return { url: item.url };
  return submoduleFetchUrl(item.url, item.origin);
}

/** The pointer file (or the empty directory a parent's checkout left) becomes a
 * fresh directory. Parents must be real directories inside the workspace. */
async function workspaceTarget(directory: string, path: string) {
  if (!safeRelative(path)) throw new ForgeError('UNSAFE_PATH', 'Submodule path is not a safe relative path.');
  const parts = path.split('/');
  for (let i = 1; i < parts.length; i++) {
    const parent = join(directory, ...parts.slice(0, i));
    const info = await lstat(parent).catch(() => null);
    if (!info) await mkdir(parent, { mode: 0o755 });
    else if (!info.isDirectory() || info.isSymbolicLink())
      throw new ForgeError('UNSAFE_PATH', 'A submodule parent is not a real directory.');
  }
  const target = join(directory, path),
    info = await lstat(target).catch(() => null);
  if (info?.isDirectory() && !info.isSymbolicLink()) {
    if ((await readdir(target)).length)
      throw new ForgeError('UNSAFE_PATH', 'A submodule directory already has content.');
  } else {
    if (info) await rm(target);
    await mkdir(target, { mode: 0o755 });
  }
  return target;
}

export class SubmoduleFetcher {
  private readonly fetched = new Set<string>();
  private readonly scratch: string;
  constructor(private readonly options: Options) {
    this.scratch = join(options.cache, `.scratch-${randomUUID()}`);
  }
  repository(url: string) {
    return join(this.options.cache, `${createHash('sha256').update(url).digest('hex').slice(0, 32)}.git`);
  }
  /** true: fetched now; false: already cached; otherwise why it is unavailable. */
  async pin(
    url: string,
    commit: string,
  ): Promise<
    | boolean
    | 'fetch-failed'
    | 'git-unavailable'
    | 'outside-installation'
    | 'not-allowed'
    | 'public-logs'
    | 'access-unavailable'
  > {
    const repository = this.repository(url),
      key = `${url}\0${commit}`;
    if (this.fetched.has(key)) return false;
    try {
      await mkdir(repository, { recursive: true, mode: 0o700 });
      if (!(await lstat(join(repository, 'HEAD')).catch(() => null)))
        await git(repository, ['init', '--bare', '--quiet'], this.options);
      if (await hasCommit(repository, commit, this.options)) {
        this.fetched.add(key);
        return false;
      }
      const gitFetch = (extra?: Record<string, string>) =>
        git(
          repository,
          ['fetch', '--quiet', '--depth=1', '--no-tags', '--no-recurse-submodules', '--', url, commit],
          this.options,
          fetchTimeoutMs,
          extra,
        );
      try {
        await gitFetch();
      } catch (error) {
        const name = githubRepositoryOf(url);
        if ((error as ForgeError).code === 'SUBMODULE_GIT_UNAVAILABLE' || !name || !this.options.access)
          throw error;
        // Not readable anonymously: a private repository of the project's installation.
        const access = await this.access(name);
        if ('reason' in access) return access.reason;
        await gitFetch(tokenHeader(url, access.token));
      }
      await git(repository, ['update-ref', `refs/forge/${commit}`, commit], this.options);
    } catch (error) {
      return (error as ForgeError).code === 'SUBMODULE_GIT_UNAVAILABLE' ? 'git-unavailable' : 'fetch-failed';
    }
    if (!(await hasCommit(repository, commit, this.options))) return 'fetch-failed';
    this.fetched.add(key);
    return true;
  }
  private readonly tokens = new Map<
    string,
    Promise<
      | { token: string }
      | { reason: 'outside-installation' | 'not-allowed' | 'public-logs' | 'access-unavailable' }
    >
  >();
  /** One request per repository per run; the token lives in memory and is passed only to the fetch. */
  private access(name: string) {
    const key = name.toLowerCase();
    let pending = this.tokens.get(key);
    if (!pending) {
      pending = this.options.access!([name]).then(
        reply => {
          const entry = reply[name];
          if (entry && 'token' in entry) return { token: entry.token };
          const refused = entry?.refused;
          return {
            reason:
              refused === 'outside-installation' || refused === 'not-allowed' || refused === 'public-logs'
                ? refused
                : ('access-unavailable' as const),
          };
        },
        () => ({ reason: 'access-unavailable' as const }),
      );
      this.tokens.set(key, pending);
    }
    return pending;
  }
  /** Writes the commit's tree with a private index; never touches the cache's HEAD. */
  async checkout(url: string, commit: string, target: string) {
    await mkdir(this.scratch, { recursive: true, mode: 0o700 });
    await git(
      this.repository(url),
      ['--work-tree', target, 'read-tree', '--reset', '-u', commit],
      this.options,
      fetchTimeoutMs,
      {
        GIT_INDEX_FILE: join(this.scratch, `${randomUUID()}.index`),
      },
    );
  }
  async nested(url: string, commit: string) {
    const repository = this.repository(url);
    const listing = await git(repository, ['ls-tree', '-r', '-z', '--full-tree', commit], this.options);
    const links: { path: string; commit: string }[] = [];
    let modules = false;
    for (const row of listing.split('\0')) {
      const match = /^(\d{6}) (\w+) ([0-9a-f]+)\t(.+)$/s.exec(row);
      if (!match) continue;
      if (match[1] === '160000' && match[2] === 'commit' && safeRelative(match[4]!))
        links.push({ path: match[4]!, commit: match[3]! });
      else if (match[4] === '.gitmodules' && match[1] !== '120000') modules = true;
    }
    if (!links.length) return [];
    const urls = modules
      ? gitmoduleUrls(await git(repository, ['cat-file', 'blob', `${commit}:.gitmodules`], this.options))
      : new Map<string, string>();
    return links.map(link => ({ ...link, url: urls.get(link.path) ?? null }));
  }
  async dispose() {
    await rm(this.scratch, { recursive: true, force: true });
  }
}

async function hasCommit(repository: string, commit: string, options: Options) {
  return git(repository, ['cat-file', '-e', `${commit}^{commit}`], options).then(
    () => true,
    () => false,
  );
}

/** Git config (through the environment, never argv) that sends the token to exactly this
 * repository's URL and nowhere else. */
export function tokenHeader(url: string, token: string): Record<string, string> {
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `http.${url.replace(/\/+$/, '')}.extraheader`,
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
  };
}

/** Hardened Git: no inherited config, hooks, credential helper, filters, prompts or LFS
 * smudge; only HTTPS leaves the machine. `config` adds per-call settings (Forge's own cache
 * is read over a local path). `repository` null runs without `--git-dir` (init). */
export function submoduleGit(
  repository: string | null,
  args: string[],
  options: Pick<Options, 'cache'>,
  timeout = 90_000,
  extra: Record<string, string> = {},
  config: string[] = [],
) {
  return git(repository, args, options, timeout, extra, config);
}
function git(
  repository: string | null,
  args: string[],
  options: Pick<Options, 'cache'>,
  timeout = 90_000,
  extra: Record<string, string> = {},
  config: string[] = [],
) {
  const file = fileUrlsForTests();
  return new Promise<string>((resolve, reject) => {
    execFile(
      'git',
      [
        '--no-replace-objects',
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'core.fsmonitor=false',
        '-c',
        'core.bare=false',
        '-c',
        'core.autocrlf=false',
        '-c',
        'core.symlinks=true',
        '-c',
        'credential.helper=',
        '-c',
        'protocol.allow=never',
        '-c',
        'protocol.https.allow=always',
        ...(file ? ['-c', 'protocol.file.allow=always', '-c', 'protocol.http.allow=always'] : []),
        ...config.flatMap(item => ['-c', item]),
        '-c',
        'http.followRedirects=initial',
        '-c',
        'transfer.fsckObjects=true',
        ...(repository === null ? [] : ['--git-dir', repository]),
        ...args,
      ],
      {
        encoding: 'utf8',
        timeout,
        maxBuffer: 64 * 1024 * 1024,
        env: {
          PATH: process.env.PATH,
          HOME: options.cache,
          XDG_CONFIG_HOME: options.cache,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_TERMINAL_PROMPT: '0',
          GIT_ASKPASS: '',
          SSH_ASKPASS: '',
          GIT_LFS_SKIP_SMUDGE: '1',
          ...extra,
        },
      },
      (error, stdout) => {
        // Never expose child stderr or argv: a remote's message is untrusted text.
        if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT')
          reject(new ForgeError('SUBMODULE_GIT_UNAVAILABLE', 'Git is not installed on this runner.'));
        else if (error) reject(new ForgeError('SUBMODULE_GIT', 'A submodule Git operation failed.'));
        else resolve(stdout);
      },
    );
  });
}

/** Check runners: a refusal becomes a failing command, never a silent pointer file. */
export async function checkSubmodules(...args: Parameters<typeof materializeSubmodules>) {
  try {
    return { materialized: await materializeSubmodules(...args), refusal: null };
  } catch (error) {
    if ((error as ForgeError).code !== 'SUBMODULE_NOT_MATERIALIZED') throw error;
    return { materialized: [], refusal: (error as ForgeError).message };
  }
}
export function submoduleFailureCommand(executable: string, message: string) {
  return [
    executable,
    '--eval',
    `console.error(${JSON.stringify(`SUBMODULE_NOT_MATERIALIZED: ${message}`)}); process.exitCode = 1;`,
  ];
}
