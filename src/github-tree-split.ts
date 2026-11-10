// SPDX-License-Identifier: Apache-2.0
import { githubJson, type GithubFetch } from './github.js';
import { invariant } from './errors.js';

export type GithubTreeEntry = { path: string; mode: string; type: string; sha: string; size?: number };
type TreeReply = { sha: string; truncated: boolean; tree: GithubTreeEntry[] };

/** Reads in flight at once; a split listing of a 150k-file tree needs a few hundred. */
export const treeSplitConcurrency = 8;
/** Past this many tree reads the split is abandoned for paged acquisition, so one
 * listing can never spend a token's hourly budget (5,000) on a pathological tree. */
export const treeSplitMaxRequests = 1_500;

/** A tree GitHub cannot return in pieces: one directory above its own reply limit. */
export class TreeSplitUnavailable extends Error {
  constructor(readonly reason: 'directory-truncated' | 'request-cap') {
    super(`GitHub tree split unavailable: ${reason}`);
  }
}

/** GitHub truncates a recursive tree reply at 100,000 entries or about 7 MB. This
 * builds the same complete entry list from smaller replies: it reads a truncated
 * tree without recursion, then each child tree recursively, and splits again only
 * the children whose recursive reply is still truncated. Identical subtrees (same
 * object id) are read once. Paths in the result are relative to `tree`, whose
 * recursive reply the caller already found truncated. */
export async function splitGithubTree(
  repository: string,
  tree: string,
  token: string | undefined,
  request: GithubFetch,
  stats: { requests: number; splits: number } = { requests: 0, splits: 0 },
): Promise<GithubTreeEntry[]> {
  let active = 0;
  const waiting: (() => void)[] = [];
  const read = async (sha: string, recursive: boolean): Promise<TreeReply> => {
    while (active >= treeSplitConcurrency) await new Promise<void>(resume => waiting.push(resume));
    if (stats.requests >= treeSplitMaxRequests) throw new TreeSplitUnavailable('request-cap');
    active++;
    stats.requests++;
    try {
      const reply = await githubJson<TreeReply>(
        `/repos/${repository}/git/trees/${sha}${recursive ? '?recursive=1' : ''}`,
        token,
        request,
      );
      invariant(
        reply.sha === sha && Array.isArray(reply.tree),
        'GITHUB_RESPONSE',
        'GitHub returned another tree.',
      );
      // Only the listed fields stay: each reply entry also carries a ~95-character API URL.
      return {
        ...reply,
        tree: reply.tree.map(({ path, mode, type, sha, size }) =>
          size === undefined ? { path, mode, type, sha } : { path, mode, type, sha, size },
        ),
      };
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
  const done = new Map<string, Promise<GithubTreeEntry[]>>();
  const collect = (sha: string, truncated = false): Promise<GithubTreeEntry[]> => {
    let pending = done.get(sha);
    if (!pending) done.set(sha, (pending = collectUncached(sha, truncated)));
    return pending;
  };
  const collectUncached = async (sha: string, truncated: boolean): Promise<GithubTreeEntry[]> => {
    if (!truncated) {
      const whole = await read(sha, true);
      if (whole.truncated === false) return whole.tree;
    }
    stats.splits++;
    const flat = await read(sha, false);
    // One directory above the limit has no smaller reply to ask for.
    if (flat.truncated !== false) throw new TreeSplitUnavailable('directory-truncated');
    const parts = await Promise.all(
      flat.tree.map(async entry => {
        if (entry.type !== 'tree' || entry.mode !== '040000') return [entry];
        const children = await collect(entry.sha);
        return [entry, ...children.map(child => ({ ...child, path: `${entry.path}/${child.path}` }))];
      }),
    );
    return parts.flat();
  };
  return collect(tree, true);
}
