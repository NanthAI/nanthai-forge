// SPDX-License-Identifier: Apache-2.0
import { networkFetch, networkTimeout } from './network-fetch.js';
import { createHash } from 'node:crypto';
import { assertGithubRateLimit, type GithubFetch } from './github.js';
import { githubBlobEndpointBytes, type GithubSourceEntry } from './github-project-source.js';
import { tarEntries } from './github-tar.js';
import { invariant } from './errors.js';
import { refuseLossyGitPaths } from './git-path-bytes.js';
import type { ListingTable } from './github-listing-codec.js';
import { streamGithubTree, TreeSplitUnavailable } from './github-tree-split.js';

const gitId = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(value);

/** Validate and emit the committed files in State order. Null selects paged
 * acquisition when a split cannot finish; the caller discards any partial listing. */
export async function listGithubTree(
  repository: string,
  tree: string,
  token: string | undefined,
  request: GithubFetch,
  sink: { append: (entry: GithubSourceEntry) => Promise<void> | void },
) {
  const stats = { requests: 0, splits: 0 };
  let files = 0,
    totalBytes = 0,
    submodules = 0,
    entries = 0;
  let last = '';
  let idWidth = 0;
  let unordered = false;
  let lossyCount = 0;
  const lossy: string[] = [];
  try {
    for await (const batch of streamGithubTree(repository, tree, token, request, stats)) {
      for (const entry of batch.entries) {
        const path = batch.prefix ? `${batch.prefix}/${entry.path}` : entry.path;
        entries++;
        if (/[\uFFFD\uD800-\uDFFF]/u.test(path)) {
          lossyCount++;
          if (lossy.length < 100) lossy.push(path.replace(/[\uD800-\uDFFF]/gu, '\uFFFD'));
        }
        if (entry.type === 'tree' && entry.mode === '040000') continue;
        const submodule = entry.type === 'commit' && entry.mode === '160000';
        invariant(
          submodule || (entry.type === 'blob' && ['100644', '100755', '120000'].includes(entry.mode)),
          'GITHUB_SOURCE_UNSUPPORTED',
          `Git object at ${path} cannot be represented as file bytes (mode ${entry.mode}); main was not published.`,
        );
        const size = submodule ? 0 : entry.size!;
        invariant(
          Number.isSafeInteger(size) && size >= 0 && size <= githubBlobEndpointBytes,
          size > githubBlobEndpointBytes ? 'GITHUB_BLOB_LIMIT' : 'GITHUB_RESPONSE',
          `GitHub cannot return ${path} (${size} bytes); files up to 100 MB are supported. Main was not published.`,
        );
        idWidth ||= entry.sha.length;
        invariant(
          entry.sha.length === idWidth,
          'GITHUB_RESPONSE',
          'GitHub returned invalid or duplicate tree paths.',
        );
        unordered ||= path <= last;
        last = path;
        files++;
        totalBytes += size;
        submodules += Number(submodule);
        if (!lossyCount && !unordered) {
          const writing = sink.append({
            path,
            sha: entry.sha,
            size,
            mode: entry.mode as GithubSourceEntry['mode'],
          });
          if (writing) await writing;
        }
      }
    }
  } catch (error) {
    if (!(error instanceof TreeSplitUnavailable)) throw error;
    console.log(
      `FORGE_IMPORT_METRIC ${JSON.stringify({ phase: 'listing-split-unavailable', reason: error.reason, requests: stats.requests })}`,
    );
    return null;
  }
  if (lossyCount) refuseLossyGitPaths(lossy, 'This GitHub repository', lossyCount, 100);
  invariant(!unordered, 'GITHUB_RESPONSE', 'GitHub returned invalid or duplicate tree paths.');
  invariant(Number.isSafeInteger(totalBytes), 'GITHUB_RESPONSE', 'Repository size is invalid.');
  if (stats.splits)
    console.log(
      `FORGE_IMPORT_METRIC ${JSON.stringify({ phase: 'listing-split', ...stats, entries, rssBytes: process.memoryUsage().rss })}`,
    );
  return { files, totalBytes, submodules };
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
