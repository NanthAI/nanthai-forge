// SPDX-License-Identifier: Apache-2.0
import { networkFetch, networkTimeout } from './network-fetch.js';
import { createHash } from 'node:crypto';
import { assertGithubRateLimit, githubJson, type GithubFetch } from './github.js';
import { githubBlobEndpointBytes, type GithubSourceEntry } from './github-project-source.js';
import { tarEntries } from './github-tar.js';
import { invariant } from './errors.js';
import { safeRelative } from './files.js';
import { refuseLossyGitPaths } from './git-path-bytes.js';
import { ListingBuilder, type ListingTable } from './github-listing-codec.js';
import {
  splitGithubTree,
  TreeSplitUnavailable,
  readTreeReply,
  walkSplitTree,
  type SplitTree,
} from './github-tree-split.js';

const gitId = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(value);
export type GithubListing = { files: GithubSourceEntry[]; totalBytes: number; submodules: number };

/** One request for the whole committed tree. When GitHub truncates that reply
 * (100,000 entries or about 7 MB) the same listing is assembled from smaller tree
 * reads (see splitGithubTree). Only a tree that cannot be split (one directory above
 * the limit, or more than the request cap) returns null so the caller uses
 * directory-by-directory discovery; a partial tree is never imported. The rows go
 * straight into a column table: no object per file outlives GitHub's replies. */
export async function listGithubTree(
  repository: string,
  tree: string,
  token?: string,
  request: GithubFetch = networkFetch,
): Promise<ListingTable | null> {
  invariant(gitId(tree), 'GITHUB_RESPONSE', 'GitHub returned an invalid object identity.');
  const reply = await githubJson(
    `/repos/${repository}/git/trees/${tree}?recursive=1`,
    token,
    request,
    readTreeReply,
  );
  invariant(reply.sha === tree, 'GITHUB_RESPONSE', 'GitHub returned another tree.');
  let listed: SplitTree | null = null,
    stats: { requests: number; splits: number } | null = null;
  if (!reply.truncated) listed = { rows: reply.rows, nested: [] };
  else {
    stats = { requests: 1, splits: 0 };
    try {
      listed = await splitGithubTree(repository, tree, token, request, stats);
    } catch (error) {
      if (!(error instanceof TreeSplitUnavailable)) throw error;
      console.log(
        `FORGE_IMPORT_METRIC ${JSON.stringify({ phase: 'listing-split-unavailable', reason: error.reason, requests: stats.requests })}`,
      );
      return null;
    }
  }
  const invalid = () =>
    invariant(false, 'GITHUB_RESPONSE', 'GitHub returned invalid or duplicate tree paths.') as never;
  const directories = new Set<string>(['']),
    rows = new ListingBuilder();
  let totalBytes = 0,
    submodules = 0,
    entries = 0;
  const lossy: string[] = [];
  walkSplitTree(listed!, (path, entry) => {
    entries++;
    if (typeof path !== 'string' || !safeRelative(path) || !gitId(entry.sha)) invalid();
    if (path.includes('\uFFFD')) lossy.push(path);
    invariant(
      !path
        .toLowerCase()
        .split('/')
        .some(part => ['.git', '.forge'].includes(part)),
      'INVALID_NATIVE_SOURCE',
      'Imported paths cannot overlap native metadata.',
    );
    if (entry.type === 'tree' && entry.mode === '040000') {
      if (directories.has(path)) invalid();
      directories.add(path);
      return;
    }
    if (entry.type === 'commit' && entry.mode === '160000') {
      if (!rows.push(path, entry.sha, 0, '160000')) invalid();
      submodules++;
      return;
    }
    invariant(
      entry.type === 'blob' && ['100644', '100755', '120000'].includes(entry.mode),
      'GITHUB_SOURCE_UNSUPPORTED',
      `Git object at ${path} cannot be represented as file bytes (mode ${entry.mode}); main was not published.`,
    );
    invariant(
      Number.isSafeInteger(entry.size) && entry.size! >= 0 && entry.size! <= githubBlobEndpointBytes,
      entry.size! > githubBlobEndpointBytes ? 'GITHUB_BLOB_LIMIT' : 'GITHUB_RESPONSE',
      `GitHub cannot return ${path} (${entry.size} bytes); files up to 100 MB are supported. Main was not published.`,
    );
    if (!rows.push(path, entry.sha, entry.size!, entry.mode)) invalid();
    totalBytes += entry.size!;
  });
  listed = null;
  // One refusal names every path GitHub could not show as UTF-8 (Issue 6a0dd2e8).
  if (lossy.length) refuseLossyGitPaths(lossy, 'This GitHub repository');
  // Recursive replies list parents first; a file under an undeclared or file
  // parent would be a tree GitHub never committed, and a path is a file or a directory.
  for (let i = 0; i < rows.length; i++) {
    const path = rows.path(i);
    invariant(
      directories.has(path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '') &&
        !directories.has(path),
      'GITHUB_RESPONSE',
      'GitHub returned a file outside its listed directories.',
    );
  }
  invariant(Number.isSafeInteger(totalBytes), 'GITHUB_RESPONSE', 'Repository size is invalid.');
  // Portable State order (JS code units), identical to the paged inventory keys.
  const table = rows.finish(totalBytes, submodules) ?? invalid();
  if (stats)
    console.log(
      `FORGE_IMPORT_METRIC ${JSON.stringify({ phase: 'listing-split', requests: stats.requests, splits: stats.splits, entries, rssBytes: process.memoryUsage().rss })}`,
    );
  return table;
}

/** The commit's tarball as one gzip stream. GitHub redirects to codeload with a
 * short-lived URL; the API credential is never sent to the redirect target. */
export async function openGithubArchive(
  repository: string,
  commit: string,
  token?: string,
  request: GithubFetch = networkFetch,
): Promise<AsyncIterable<Uint8Array>> {
  invariant(gitId(commit), 'GITHUB_RESPONSE', 'GitHub returned an invalid commit.');
  const headers = { 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'NanthAi-Forge' };
  let response = await request(`https://api.github.com/repos/${repository}/tarball/${commit}`, {
    redirect: 'manual',
    signal: networkTimeout(30_000),
    headers: { ...headers, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  assertGithubRateLimit(response);
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const location = new URL(response.headers.get('location') ?? '', 'https://api.github.com');
    invariant(
      location.protocol === 'https:' && location.hostname === 'codeload.github.com' && !location.username,
      'GITHUB_RESPONSE',
      'GitHub redirected the archive to an unexpected host.',
    );
    await response.body?.cancel();
    response = await request(location.href, {
      redirect: 'error',
      signal: networkTimeout(480_000),
      headers,
    });
  }
  invariant(
    response.ok && response.body,
    'GITHUB_UNAVAILABLE',
    'GitHub could not provide this commit archive with current access.',
  );
  // Node's web streams are async iterable; the DOM lib types omit it.
  return response.body.pipeThrough(new DecompressionStream('gzip')) as unknown as AsyncIterable<Uint8Array>;
}

export const gitBlobId = (sha: string, bytes: Buffer) =>
  createHash(sha.length === 40 ? 'sha1' : 'sha256')
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest('hex');

export type ArchiveFile = {
  entry: GithubSourceEntry;
  /** The entry's row in the listing table. */
  index: number;
  bytes: Buffer | null;
  read: TarRead | null;
};
type TarRead = (consume: (bytes: Buffer) => Promise<void>) => Promise<void>;

/** Yields archive members that name a listed tree entry of the same kind and
 * size, exactly once. Small members carry their bytes; large ones stream. The
 * caller proves each member's Git object ID; anything the archive omits or
 * rewrites (export-ignore, export-subst, LFS smudging) is fetched by Git blob.
 * Members seen are marked by row, so no path string outlives its member. */
export async function* githubArchiveFiles(
  archive: AsyncIterable<Uint8Array>,
  listed: ListingTable,
  smallBytes: number,
): AsyncGenerator<ArchiveFile> {
  const seen = new Uint8Array(listed.length);
  let prefix: string | null = null;
  for await (const member of tarEntries(archive)) {
    const slash = member.path.indexOf('/');
    // GitHub roots every member under one "owner-repo-sha/" directory.
    const root = slash < 0 ? member.path : member.path.slice(0, slash);
    prefix ??= root;
    invariant(root === prefix, 'GITHUB_RESPONSE', 'GitHub archive has more than one root.');
    const path = slash < 0 ? '' : member.path.slice(slash + 1).replace(/\/$/, '');
    const index = path ? listed.index(path) : -1;
    if (index < 0 || seen[index] || listed.mode(index) === '160000') continue;
    const entry = listed.entry(index);
    if (member.type === 'symlink') {
      if (entry.mode !== '120000') continue;
      seen[index] = 1;
      yield { entry, index, bytes: Buffer.from(member.linkname), read: null };
    } else if (member.type === 'file' && entry.mode !== '120000' && member.size === entry.size) {
      seen[index] = 1;
      if (member.size > smallBytes) yield { entry, index, bytes: null, read: member.read };
      else {
        const parts: Buffer[] = [];
        await member.read(async part => {
          parts.push(Buffer.from(part));
        });
        yield { entry, index, bytes: Buffer.concat(parts), read: null };
      }
    }
  }
}
