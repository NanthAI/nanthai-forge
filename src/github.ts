// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { networkFetch, networkTimeout } from './network-fetch.js';
import { analysisManifest, sourceLanguage } from './languages.js';
import { binaryInventoryPath, inventoryEntry, inventoryFull, inventoryText } from './analysis-inventory.js';
import { ignoreLayer, ignoredBy, ignoreNames } from './source-ignore.js';
import { posix } from 'node:path';
import { createHash } from 'node:crypto';
import { analyze, analysisProvider } from './analyze.js';
import { DEFAULT_LIMITS } from './snapshot.js';
import { exclusion, safeRelative } from './files.js';
import { isRepositoryDocument } from './document-paths.js';
import { digest, identity } from './hash.js';
import { ForgeError, invariant } from './errors.js';
import type { GraphPack, Snapshot, SourceIdentity } from './types.js';

export const githubAnalysisVersion = (): string => {
  const provider = analysisProvider();
  return `${provider.version}:${provider.configVersion}:github-6`;
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
const analysisSource = (path: string) => !!sourceLanguage(path) || analysisManifest(path);

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

/** GitHub's primary and secondary limits: a retryable error with the provider's reset. */
export function assertGithubRateLimit(response: Response): void {
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
    const retryAt = deadlines.length ? Math.max(...deadlines) : now + 60_000;
    throw new ForgeError(
      'GITHUB_RATE_LIMIT',
      `GitHub has reached its API rate limit. Retry after ${new Date(retryAt).toISOString()}.`,
      retryAt,
    );
  }
}

export async function githubJson<T>(
  path: string,
  token?: string,
  request: GithubFetch = networkFetch,
  /** Reads the reply bytes; the default parses them as JSON. */
  parse: (bytes: Buffer) => T = bytes => JSON.parse(bytes.toString('utf8')) as T,
): Promise<T> {
  invariant(
    path.startsWith('/') && !path.split(/[/?]/).includes('..'),
    'BAD_GITHUB_PATH',
    'Invalid GitHub API path.',
  );
  const response = await request(`https://api.github.com${path}`, {
    signal: networkTimeout(30_000),
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'NanthAi-Forge',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  assertGithubRateLimit(response);
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
    return parse(Buffer.concat(chunks));
  } catch {
    throw new ForgeError('GITHUB_RESPONSE', 'GitHub returned invalid JSON.');
  }
}

export async function githubRepository(
  repository: string,
  token?: string,
  request: GithubFetch = networkFetch,
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
  request: GithubFetch = networkFetch,
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
      analysisSource(e.path) ||
      ignoreNames.some(name => posix.basename(e.path) === name) ||
      isRepositoryDocument(e.path),
  );
  let totalBytes = 0,
    done = 0;
  const downloaded = new Map<string, { text: string; bytes: number }>();
  const unavailable = new Map<string, string>();
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
  const download = async (entry: TreeEntry, required: boolean) => {
    if (
      !required &&
      Number.isSafeInteger(entry.size) &&
      inventoryFull(DEFAULT_LIMITS, 0, totalBytes, entry.size)
    ) {
      unavailable.set(
        entry.path,
        binaryInventoryPath(entry.path) ? 'unsupported-language' : 'inventory-limit',
      );
      return;
    }
    invariant(
      Number.isSafeInteger(entry.size) && entry.size! >= 0 && entry.size! <= DEFAULT_LIMITS.maxFileBytes,
      'FILE_LIMIT',
      'Source file exceeds the existing byte budget.',
    );
    // Reserve listed bytes in page order, before the concurrent blob reads.
    totalBytes += entry.size!;
    invariant(
      totalBytes <= DEFAULT_LIMITS.maxTotalBytes,
      'SOURCE_LIMIT',
      'Repository exceeds the existing source byte budget.',
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
    const text = inventoryText(bytes);
    invariant(text !== undefined || !required, 'INVALID_ENCODING', 'Included source is not UTF-8 text.');
    if (text === undefined) unavailable.set(entry.path, 'unsupported-language');
    else downloaded.set(entry.path, { text, bytes: bytes.length });
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
      if (entry) {
        await download(entry, true);
        done++;
      }
    }
    rules.push(
      ...ignoreLayer(
        directory === '.' ? '' : directory,
        name => downloaded.get(directory === '.' ? name : `${directory}/${name}`)?.text,
      ),
    );
  }
  for (const [path, file] of downloaded) {
    if (!ignored(path)) continue;
    totalBytes -= file.bytes;
    downloaded.delete(path);
  }
  const code: TreeEntry[] = [],
    textOnly: TreeEntry[] = [];
  for (const entry of selected) {
    if (ignoreEntries.has(entry.path) || ignored(entry.path)) continue;
    (analysisSource(entry.path) ? code : textOnly).push(entry);
  }
  invariant(
    code.filter(entry => sourceLanguage(entry.path)).length <= DEFAULT_LIMITS.maxFiles,
    'SOURCE_LIMIT',
    'Repository exceeds the existing source file budget.',
  );
  const included = [...code, ...textOnly];
  const total = included.length + done;
  for (let i = 0; i < included.length; i += 5) {
    const page = included.slice(i, i + 5);
    await Promise.all(page.map((entry, offset) => download(entry, i + offset < code.length)));
    done += page.length;
    await progress(done, total);
  }
  const content = new Map<string, string>(),
    documents: Record<string, string> = {},
    files: SourceIdentity['files'] = [],
    inventory: NonNullable<Snapshot['inventory']> = [];
  let bytes = 0;
  const add = (path: string, file: { text: string; bytes: number }) => {
    files.push({ path, digest: digest(file.text), bytes: file.bytes });
    bytes += file.bytes;
    if (!sourceLanguage(path)) inventory.push(inventoryEntry(path, file.text));
  };
  const ordered = [...downloaded].sort(([a], [b]) => a.localeCompare(b, 'en'));
  // Reserve the capture budget for analyzed languages and their manifests first.
  for (const [path, file] of ordered) {
    if (!analysisSource(path)) continue;
    content.set(path, file.text);
    add(path, file);
  }
  for (const [path, file] of ordered) {
    if (analysisSource(path)) continue;
    if (!ignoreEntries.has(path)) documents[path] = file.text;
    if (binaryInventoryPath(path)) unavailable.set(path, 'unsupported-language');
    else if (inventoryFull(DEFAULT_LIMITS, files.length, bytes, file.bytes))
      unavailable.set(path, 'inventory-limit');
    else add(path, file);
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
            : (unavailable.get(entry.path) ?? (downloaded.has(entry.path) ? null : 'unsupported-language'))));
    if (reason) excluded[reason] = (excluded[reason] ?? 0) + 1;
  }
  const state = {
    gitHead: commit.sha,
    scope: 'included-language-git-revision' as const,
    files,
    inventoryDigest: identity(files.map(file => file.path)),
    policy: { version: 2 as const, limits: { ...DEFAULT_LIMITS } },
  };
  const snapshot: Snapshot = {
    root: '',
    source: { id: identity(state), ...state, excluded },
    content,
    inventory,
  };
  return { pack: analyze(snapshot), content: Object.fromEntries(content), documents, repository };
}
