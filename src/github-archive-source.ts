// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { assertGithubRateLimit, githubJson, type GithubFetch } from './github.js';
import { githubBlobEndpointBytes, type GithubSourceEntry } from './github-project-source.js';
import { tarEntries } from './github-tar.js';
import { invariant } from './errors.js';
import { safeRelative } from './files.js';

const gitId = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(value);
export type GithubListing = { files: GithubSourceEntry[]; totalBytes: number; submodules: number };

/** One request for the whole committed tree. A truncated reply returns null so
 * the caller uses directory-by-directory discovery; it never imports a partial tree. */
export async function listGithubTree(
  repository: string,
  tree: string,
  token?: string,
  request: GithubFetch = fetch,
): Promise<GithubListing | null> {
  invariant(gitId(tree), 'GITHUB_RESPONSE', 'GitHub returned an invalid object identity.');
  const reply = await githubJson<{
    sha: string;
    truncated: boolean;
    tree: { path: string; mode: string; type: string; sha: string; size?: number }[];
  }>(`/repos/${repository}/git/trees/${tree}?recursive=1`, token, request);
  invariant(
    reply.sha === tree && Array.isArray(reply.tree),
    'GITHUB_RESPONSE',
    'GitHub returned another tree.',
  );
  if (reply.truncated !== false) return null;
  const paths = new Set<string>(),
    directories = new Set<string>(['']);
  const files: GithubSourceEntry[] = [];
  let totalBytes = 0,
    submodules = 0;
  for (const entry of reply.tree) {
    const path = entry.path;
    invariant(
      typeof path === 'string' && safeRelative(path) && !paths.has(path) && gitId(entry.sha),
      'GITHUB_RESPONSE',
      'GitHub returned invalid or duplicate tree paths.',
    );
    invariant(
      !path
        .toLowerCase()
        .split('/')
        .some(part => ['.git', '.forge'].includes(part)),
      'INVALID_NATIVE_SOURCE',
      'Imported paths cannot overlap native metadata.',
    );
    paths.add(path);
    if (entry.type === 'tree' && entry.mode === '040000') {
      directories.add(path);
      continue;
    }
    if (entry.type === 'commit' && entry.mode === '160000') {
      files.push({ path, sha: entry.sha, mode: '160000', size: 0 });
      submodules++;
      continue;
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
    files.push({ path, sha: entry.sha, size: entry.size!, mode: entry.mode as GithubSourceEntry['mode'] });
    totalBytes += entry.size!;
  }
  // Recursive replies list parents first; a file under an undeclared or file
  // parent would be a tree GitHub never committed.
  for (const file of files)
    invariant(
      directories.has(file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : ''),
      'GITHUB_RESPONSE',
      'GitHub returned a file outside its listed directories.',
    );
  invariant(Number.isSafeInteger(totalBytes), 'GITHUB_RESPONSE', 'Repository size is invalid.');
  // Portable State order (JS code units), identical to the paged inventory keys.
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files, totalBytes, submodules };
}

/** The commit's tarball as one gzip stream. GitHub redirects to codeload with a
 * short-lived URL; the API credential is never sent to the redirect target. */
export async function openGithubArchive(
  repository: string,
  commit: string,
  token?: string,
  request: GithubFetch = fetch,
): Promise<AsyncIterable<Uint8Array>> {
  invariant(gitId(commit), 'GITHUB_RESPONSE', 'GitHub returned an invalid commit.');
  const headers = { 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'NanthAi-Forge' };
  let response = await request(`https://api.github.com/repos/${repository}/tarball/${commit}`, {
    redirect: 'manual',
    signal: AbortSignal.timeout(30_000),
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
      signal: AbortSignal.timeout(480_000),
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

export type ArchiveFile = { entry: GithubSourceEntry; bytes: Buffer | null; read: TarRead | null };
type TarRead = (consume: (bytes: Buffer) => Promise<void>) => Promise<void>;

/** Yields archive members that name a listed tree entry of the same kind and
 * size, exactly once. Small members carry their bytes; large ones stream. The
 * caller proves each member's Git object ID; anything the archive omits or
 * rewrites (export-ignore, export-subst, LFS smudging) is fetched by Git blob. */
export async function* githubArchiveFiles(
  archive: AsyncIterable<Uint8Array>,
  listed: Map<string, GithubSourceEntry>,
  smallBytes: number,
): AsyncGenerator<ArchiveFile> {
  const seen = new Set<string>();
  let prefix: string | null = null;
  for await (const member of tarEntries(archive)) {
    const slash = member.path.indexOf('/');
    // GitHub roots every member under one "owner-repo-sha/" directory.
    const root = slash < 0 ? member.path : member.path.slice(0, slash);
    prefix ??= root;
    invariant(root === prefix, 'GITHUB_RESPONSE', 'GitHub archive has more than one root.');
    const path = slash < 0 ? '' : member.path.slice(slash + 1).replace(/\/$/, '');
    const entry = path ? listed.get(path) : undefined;
    if (!entry || seen.has(path) || entry.mode === '160000') continue;
    if (member.type === 'symlink') {
      if (entry.mode !== '120000') continue;
      seen.add(path);
      yield { entry, bytes: Buffer.from(member.linkname), read: null };
    } else if (member.type === 'file' && entry.mode !== '120000' && member.size === entry.size) {
      seen.add(path);
      if (member.size > smallBytes) yield { entry, bytes: null, read: member.read };
      else {
        const parts: Buffer[] = [];
        await member.read(async part => {
          parts.push(Buffer.from(part));
        });
        yield { entry, bytes: Buffer.concat(parts), read: null };
      }
    }
  }
}
