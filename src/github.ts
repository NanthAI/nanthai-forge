// SPDX-License-Identifier: Apache-2.0
import { sourceLanguage } from './languages.js';
import { ignoreLayer, ignoredBy, ignoreNames } from './source-ignore.js';
import { posix } from 'node:path';
import { createHash } from 'node:crypto';
import { analyze, analysisProvider } from './analyze.js';
import { DEFAULT_LIMITS } from './snapshot.js';
import { exclusion, safeRelative } from './files.js';
import { isRepositoryDocument } from './document-paths.js';
import { digest, identity } from './hash.js';
import { ForgeError, invariant } from './errors.js';
import type { GraphPack, Snapshot } from './types.js';

export const githubAnalysisVersion = (): string => {
  const provider = analysisProvider();
  return `${provider.version}:${provider.configVersion}:github-5`;
};

export type GithubFetch = typeof fetch;
export interface GithubRepository {
  full_name: string;
  private: boolean;
  default_branch: string;
  html_url: string;
  license: { spdx_id: string; name: string } | null;
}
export interface HostedArtifact {
  pack: GraphPack;
  content: Record<string, string>;
  documents: Record<string, string>;
  repository: GithubRepository;
}
type TreeEntry = { path: string; mode: string; type: string; sha: string; size?: number };

export function githubInput(input: string): { repository: string; ref: string | undefined } {
  let value = input.trim();
  if (value.startsWith('https://')) {
    const url = new URL(value);
    invariant(
      url.hostname === 'github.com' && !url.username && !url.password && !url.port,
      'BAD_REPOSITORY',
      'Enter a github.com repository URL.',
    );
    value = decodeURIComponent(url.pathname).replace(/^\/+|\/+$/g, '');
  }
  const [owner, name, kind, ...rest] = value.split('/');
  invariant(
    owner &&
      name &&
      /^[\w.-]+$/.test(owner) &&
      /^[\w.-]+$/.test(name) &&
      (!kind || kind === 'tree') &&
      (!kind || rest.length > 0),
    'BAD_REPOSITORY',
    'Use owner/repository or a GitHub repository URL.',
  );
  return { repository: `${owner}/${name.replace(/\.git$/, '')}`, ref: kind ? rest.join('/') : undefined };
}

export async function githubJson<T>(path: string, token?: string, request: GithubFetch = fetch): Promise<T> {
  invariant(
    path.startsWith('/') && !path.split(/[/?]/).includes('..'),
    'BAD_GITHUB_PATH',
    'Invalid GitHub API path.',
  );
  const response = await request(`https://api.github.com${path}`, {
    signal: AbortSignal.timeout(30_000),
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'NanthAi-Forge',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (
    response.status === 429 ||
    (response.status === 403 &&
      (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after')))
  ) {
    const now = Date.now(),
      after = Number(response.headers.get('retry-after')),
      reset = Number(response.headers.get('x-ratelimit-reset'));
    const deadlines = [
      response.headers.get('retry-after') && Number.isSafeInteger(after) && after >= 0
        ? now + after * 1000
        : NaN,
      response.headers.get('x-ratelimit-remaining') === '0' &&
      Number.isSafeInteger(reset) &&
      reset * 1000 > now
        ? reset * 1000
        : NaN,
    ].filter(value => Number.isSafeInteger(value) && value >= now);
    throw new ForgeError(
      'GITHUB_RATE_LIMIT',
      'GitHub has reached its API rate limit. Retry after its reset.',
      deadlines.length ? Math.max(...deadlines) : now + 60_000,
    );
  }
  invariant(
    response.ok,
    'GITHUB_UNAVAILABLE',
    'GitHub could not provide this repository with the current access.',
  );
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  invariant(response.body, 'GITHUB_RESPONSE', 'GitHub returned an empty response.');
  const reader = response.body.getReader();
  while (true) {
    const { value: chunk, done } = await reader.read();
    if (done) break;
    bytes += chunk.length;
    invariant(
      bytes <= 64 * 1024 * 1024,
      'SOURCE_LIMIT',
      'GitHub response exceeds the existing artifact budget.',
    );
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
  } catch {
    throw new ForgeError('GITHUB_RESPONSE', 'GitHub returned invalid JSON.');
  }
}

export async function githubRepository(
  repository: string,
  token?: string,
  request: GithubFetch = fetch,
): Promise<GithubRepository> {
  const repo = await githubJson<GithubRepository>(`/repos/${repository}`, token, request);
  invariant(
    typeof repo.private === 'boolean' &&
      typeof repo.full_name === 'string' &&
      typeof repo.default_branch === 'string' &&
      /^https:\/\/github\.com\//.test(repo.html_url),
    'GITHUB_RESPONSE',
    'GitHub repository metadata is incomplete.',
  );
  return repo;
}

export async function captureGithub(
  repository: GithubRepository,
  ref: string | undefined,
  token?: string,
  progress: (done: number, total: number) => Promise<void> = async () => {},
  request: GithubFetch = fetch,
): Promise<HostedArtifact> {
  const prefix = `/repos/${repository.full_name}`;
  const commit = await githubJson<{ sha: string; commit: { tree: { sha: string } } }>(
    `${prefix}/commits/${encodeURIComponent(ref || repository.default_branch)}`,
    token,
    request,
  );
  invariant(
    /^[a-f0-9]{40,64}$/.test(commit.sha) && /^[a-f0-9]{40,64}$/.test(commit.commit?.tree?.sha),
    'GITHUB_RESPONSE',
    'GitHub returned an invalid commit.',
  );
  const tree = await githubJson<{ tree: TreeEntry[]; truncated: boolean }>(
    `${prefix}/git/trees/${commit.commit.tree.sha}?recursive=1`,
    token,
    request,
  );
  invariant(
    Array.isArray(tree.tree) && !tree.truncated,
    'PATH_LIMIT',
    'GitHub returned a truncated tree; no incomplete index was published.',
  );
  invariant(
    tree.tree.filter(e => e.type === 'blob' || e.type === 'commit').length <= DEFAULT_LIMITS.maxPaths,
    'PATH_LIMIT',
    'Repository exceeds the existing source path budget.',
  );
  const entries = tree.tree
    .filter(e => e.type === 'blob' && e.mode !== '120000' && safeRelative(e.path) && !exclusion(e.path))
    .sort((a, b) => a.path.localeCompare(b.path, 'en'));
  const selected = entries.filter(
    e =>
      !!sourceLanguage(e.path) ||
      ignoreNames.some(name => posix.basename(e.path) === name) ||
      isRepositoryDocument(e.path),
  );
  let totalBytes = 0,
    done = 0;
  const downloaded = new Map<string, string>();
  const rules: ReturnType<typeof ignoreLayer> = [];
  const matches = (path: string) => {
    const directory = path.endsWith('/');
    const candidate = directory ? path.slice(0, -1) : path;
    return ignoredBy(
      rules.filter(rule => !rule.directory || candidate.startsWith(rule.directory + '/')),
      candidate,
      directory,
    );
  };
  const ignored = (path: string) =>
    !!(
      path
        .split('/')
        .slice(0, -1)
        .some((_, i, parts) => matches(`${parts.slice(0, i + 1).join('/')}/`)) || matches(path)
    );
  await progress(0, selected.length);
  const download = async (entry: TreeEntry) => {
    invariant(
      Number.isSafeInteger(entry.size) && entry.size! <= DEFAULT_LIMITS.maxFileBytes,
      'FILE_LIMIT',
      'Source file exceeds the existing byte budget.',
    );
    const blob = await githubJson<{ content: string; encoding: string; sha: string }>(
      `${prefix}/git/blobs/${entry.sha}`,
      token,
      request,
    );
    invariant(
      blob.encoding === 'base64' && blob.sha === entry.sha && typeof blob.content === 'string',
      'GITHUB_RESPONSE',
      'GitHub returned an invalid source blob.',
    );
    const bytes = Buffer.from(blob.content, 'base64');
    invariant(
      bytes.length === entry.size,
      'GITHUB_RESPONSE',
      'Source blob size differs from its tree entry.',
    );
    invariant(
      createHash(entry.sha.length === 40 ? 'sha1' : 'sha256')
        .update(`blob ${bytes.length}\0`)
        .update(bytes)
        .digest('hex') === entry.sha,
      'ARTIFACT_INTEGRITY',
      'Source blob does not match its Git object identity.',
    );
    totalBytes += bytes.length;
    invariant(
      totalBytes <= DEFAULT_LIMITS.maxTotalBytes,
      'SOURCE_LIMIT',
      'Repository exceeds the existing source byte budget.',
    );
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      throw new ForgeError('INVALID_ENCODING', 'Included source is not UTF-8.');
    }
    invariant(!text.includes('\0'), 'INVALID_ENCODING', 'Included source contains a NUL byte.');
    downloaded.set(entry.path, text);
    done++;
  };
  const ignoreEntries = new Map(
    selected
      .filter(e => ignoreNames.some(name => posix.basename(e.path) === name))
      .map(entry => [entry.path, entry]),
  );
  const directories = [...new Set([...ignoreEntries.keys()].map(path => posix.dirname(path)))].sort(
    (a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b, 'en'),
  );
  for (const directory of directories) {
    if (directory !== '.' && ignored(directory + '/')) continue;
    for (const name of ignoreNames) {
      const entry = ignoreEntries.get(directory === '.' ? name : `${directory}/${name}`);
      if (entry) await download(entry);
    }
    rules.push(
      ...ignoreLayer(directory === '.' ? '' : directory, name =>
        downloaded.get(directory === '.' ? name : `${directory}/${name}`),
      ),
    );
  }
  const included = selected.filter(
    e => !ignoreNames.some(name => posix.basename(e.path) === name) && !ignored(e.path),
  );
  invariant(
    included.filter(e => !!sourceLanguage(e.path)).length <= DEFAULT_LIMITS.maxFiles,
    'SOURCE_LIMIT',
    'Repository exceeds the existing source file budget.',
  );
  for (let i = 0; i < included.length; i += 5) {
    await Promise.all(included.slice(i, i + 5).map(download));
    await progress(done, included.length + rules.length);
  }
  const content = new Map<string, string>(),
    documents: Record<string, string> = {};
  for (const [path, text] of [...downloaded].sort(([a], [b]) => a.localeCompare(b, 'en'))) {
    if (ignored(path)) continue;
    if (!!sourceLanguage(path)) content.set(path, text);
    else if (!ignoreNames.some(name => posix.basename(path) === name)) documents[path] = text;
  }
  const excluded: Record<string, number> = {};
  for (const entry of tree.tree) {
    if (entry.type !== 'blob' && entry.type !== 'commit') continue;
    const reason = !safeRelative(entry.path)
      ? 'unsafe-path'
      : (exclusion(entry.path) ??
        (entry.mode === '120000' || entry.type === 'commit'
          ? 'missing-symlink-or-special'
          : ignored(entry.path)
            ? matches(entry.path)?.source === '.forgeignore'
              ? 'forgeignored'
              : 'gitignored'
            : !sourceLanguage(entry.path)
              ? 'unsupported-language'
              : null));
    if (reason) excluded[reason] = (excluded[reason] ?? 0) + 1;
  }
  const files = [...content].map(([path, text]) => ({
    path,
    digest: digest(text),
    bytes: Buffer.byteLength(text),
  }));
  const state = {
    gitHead: commit.sha,
    scope: 'included-language-git-revision' as const,
    files,
    inventoryDigest: identity([...content.keys()]),
    policy: { version: 2 as const, limits: { ...DEFAULT_LIMITS } },
  };
  const snapshot: Snapshot = { root: '', source: { id: identity(state), ...state, excluded }, content };
  return { pack: analyze(snapshot), content: Object.fromEntries(content), documents, repository };
}
