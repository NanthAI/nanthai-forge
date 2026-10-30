// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { githubJson, type GithubFetch } from './github.js';
import { invariant } from './errors.js';
import { safeRelative } from './files.js';
import { digest } from './hash.js';

export type GithubSourceEntry = {
  path: string;
  sha: string;
  size: number;
  mode: '100644' | '100755' | '120000' | '160000';
};
export type GithubSourceCursor = {
  schema: 1;
  repository: string;
  commit: string;
  pending: { path: string; sha: string }[];
  files: GithubSourceEntry[];
  completed: number;
  bytes: number;
  totalBytes: number;
  submodules?: number;
};
const gitId = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(value);
// Provider constraint, not a Forge quota. GitHub's Git blobs endpoint supports
// blobs up to 100 MB. File storage and aggregate repository size are separate.
export const githubBlobEndpointBytes = 100 * 1024 * 1024;

export async function beginGithubSource(
  repository: string,
  ref: string,
  token?: string,
  request: GithubFetch = fetch,
): Promise<GithubSourceCursor> {
  invariant(/^[\w.-]+\/[\w.-]+$/.test(repository), 'BAD_REPOSITORY', 'Select a GitHub repository.');
  const commit = await githubJson<{ sha: string; commit: { tree: { sha: string } } }>(
    `/repos/${repository}/commits/${encodeURIComponent(ref)}`,
    token,
    request,
  );
  invariant(
    gitId(commit.sha) && gitId(commit.commit?.tree?.sha),
    'GITHUB_RESPONSE',
    'GitHub returned an invalid commit.',
  );
  return {
    schema: 1,
    repository,
    commit: commit.sha,
    pending: [{ path: '', sha: commit.commit.tree.sha }],
    files: [],
    completed: 0,
    bytes: 0,
    totalBytes: 0,
  };
}

/** One directory per durable step. Never use the recursive API's potentially
 * truncated response; ignore rules and language selection never filter source. */
export async function discoverGithubSource(
  cursor: GithubSourceCursor,
  token?: string,
  request: GithubFetch = fetch,
): Promise<GithubSourceCursor> {
  const directory = cursor.pending[0];
  if (!directory) return cursor;
  const tree = await githubJson<{
    sha: string;
    truncated: boolean;
    tree: { path: string; mode: string; type: string; sha: string; size?: number }[];
  }>(`/repos/${cursor.repository}/git/trees/${directory.sha}`, token, request);
  invariant(
    tree.sha === directory.sha && Array.isArray(tree.tree) && tree.truncated === false,
    'GITHUB_RESPONSE',
    'GitHub returned an incomplete directory; main was not published.',
  );
  const next = structuredClone(cursor);
  next.pending.shift();
  const paths = new Set([...next.files, ...next.pending].map(entry => entry.path));
  for (const entry of tree.tree) {
    const path = directory.path ? `${directory.path}/${entry.path}` : entry.path;
    invariant(
      typeof entry.path === 'string' && !entry.path.includes('/') && safeRelative(path) && !paths.has(path),
      'GITHUB_RESPONSE',
      'GitHub returned invalid or duplicate tree paths.',
    );
    paths.add(path);
    invariant(gitId(entry.sha), 'GITHUB_RESPONSE', 'GitHub returned an invalid object identity.');
    if (entry.type === 'tree' && entry.mode === '040000') next.pending.push({ path, sha: entry.sha });
    else if (entry.type === 'commit' && entry.mode === '160000') {
      next.files.push({ path, sha: entry.sha, mode: '160000', size: 0 });
      next.submodules = (next.submodules ?? 0) + 1;
    } else {
      invariant(
        entry.type === 'blob' && ['100644', '100755', '120000'].includes(entry.mode),
        'GITHUB_SOURCE_UNSUPPORTED',
        `Git object at ${path} cannot be represented as file bytes (mode ${entry.mode}); main was not published.`,
      );
      invariant(
        Number.isSafeInteger(entry.size) && entry.size! >= 0,
        'GITHUB_RESPONSE',
        'GitHub returned an invalid file size.',
      );
      invariant(
        entry.size! <= githubBlobEndpointBytes,
        'GITHUB_BLOB_LIMIT',
        `GitHub's blob endpoint cannot return ${path} (${entry.size} bytes); it supports files up to 100 MB. Main was not published.`,
      );
      next.files.push({
        path,
        sha: entry.sha,
        size: entry.size!,
        mode: entry.mode as GithubSourceEntry['mode'],
      });
      next.totalBytes += entry.size!;
      invariant(Number.isSafeInteger(next.totalBytes), 'GITHUB_RESPONSE', 'Repository size is invalid.');
    }
  }
  if (!next.pending.length)
    next.files.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  return next;
}

/** Raw media avoids base64/JSON expansion at the provider's largest file size.
 * Every response is bound to the chosen Git object, including symlink targets. */
export async function streamGithubSourceBlob(
  repository: string,
  entry: GithubSourceEntry,
  consume: (bytes: Buffer) => Promise<void>,
  token?: string,
  request: GithubFetch = fetch,
): Promise<{ blob: string; size: number }> {
  if (entry.mode === '160000') {
    // Feed only pointer metadata through the existing sink, never a provider request.
    invariant(gitId(entry.sha), 'GITHUB_RESPONSE', 'GitHub returned an invalid object identity.');
    const bytes = Buffer.from(entry.sha);
    await consume(bytes);
    return { blob: digest(bytes), size: bytes.length };
  }
  const response = await request(`https://api.github.com/repos/${repository}/git/blobs/${entry.sha}`, {
    redirect: 'error',
    signal: AbortSignal.timeout(120_000),
    headers: {
      Accept: 'application/vnd.github.raw+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'NanthAi-Forge',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  invariant(
    response.ok && response.body,
    'GITHUB_UNAVAILABLE',
    'GitHub could not provide this source blob with current access.',
  );
  const reader = response.body.getReader();
  const git = createHash(entry.sha.length === 40 ? 'sha1' : 'sha256').update(`blob ${entry.size}\0`);
  const logical = createHash('sha256');
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      invariant(size <= entry.size, 'ARTIFACT_INTEGRITY', 'GitHub blob exceeds its pinned size.');
      git.update(part.value);
      logical.update(part.value);
      await consume(Buffer.from(part.value.buffer, part.value.byteOffset, part.value.byteLength));
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  invariant(
    size === entry.size && git.digest('hex') === entry.sha,
    'ARTIFACT_INTEGRITY',
    'GitHub blob differs from the selected commit.',
  );
  return { blob: logical.digest('hex'), size };
}

/** Compatibility reader; the hosted page worker consumes the stream directly. */
export async function readGithubSourceBlob(
  repository: string,
  entry: GithubSourceEntry,
  token?: string,
  request: GithubFetch = fetch,
): Promise<Buffer> {
  invariant(entry.mode !== '160000', 'INVALID_GITLINK', 'A gitlink is a commit pointer, not a GitHub blob.');
  const parts: Buffer[] = [];
  await streamGithubSourceBlob(
    repository,
    entry,
    async bytes => {
      parts.push(bytes);
    },
    token,
    request,
  );
  return Buffer.concat(parts);
}

export type ImportedSourceFile = {
  path: string;
  blob: string;
  mode: GithubSourceEntry['mode'];
  size: number;
};
/** The caller commits the returned cursor and file binding atomically. Retrying
 * after a crash reuses the immutable sink; no progress is inferred from a fetch. */
export async function importGithubSourceFile(
  cursor: GithubSourceCursor,
  put: (bytes: Buffer) => Promise<void>,
  token?: string,
  request: GithubFetch = fetch,
) {
  invariant(!cursor.pending.length, 'IMPORT_DISCOVERING', 'Complete tree discovery before importing bytes.');
  const entry = cursor.files[cursor.completed];
  invariant(entry, 'IMPORT_COMPLETE', 'All source files have been imported.');
  const bytes =
    entry.mode === '160000'
      ? Buffer.from(entry.sha)
      : await readGithubSourceBlob(cursor.repository, entry, token, request);
  await put(bytes);
  return {
    cursor: {
      ...cursor,
      completed: cursor.completed + 1,
      bytes: cursor.bytes + (entry.mode === '160000' ? 0 : bytes.length),
    },
    file: {
      path: entry.path,
      blob: digest(bytes),
      mode: entry.mode,
      size: bytes.length,
    } satisfies ImportedSourceFile,
  };
}

export const githubSourceMode = (mode: GithubSourceEntry['mode']) =>
  ({ '100644': 'file', '100755': 'executable', '120000': 'symlink', '160000': 'gitlink' } as const)[mode];
