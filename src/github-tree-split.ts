// SPDX-License-Identifier: Apache-2.0
import { githubJson, type GithubFetch } from './github.js';
import { invariant } from './errors.js';

export type GithubTreeEntry = { path: string; mode: string; type: string; sha: string; size?: number };
type TreeReply = { sha: string; truncated: boolean; tree: GithubTreeEntry[] };
/** A listing as GitHub returned it: each reply's entries, relative to their directory, with
 * the replies of split child directories beside them (identical subtrees shared, never copied).
 * walkSplitTree visits every entry with its full path. */
export type SplitTree = { rows: TreeRows; nested: { prefix: string; tree: SplitTree }[] };

const modes = ['100644', '100755', '120000', '160000', '040000'],
  types = ['blob', 'tree', 'commit'];
const modeCode = new Map(modes.map((mode, code) => [mode, code])),
  typeCode = new Map(types.map((type, code) => [type, code]));
const gitId = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/** One tree reply's entries in columns: the paths in one string, binary object ids, sizes and
 * codes, about 100 bytes an entry less than GitHub's objects. An entry that does not fit the
 * columns (an unknown mode, a malformed id or size) is kept as it came, for the caller to
 * reject with its own message. */
export class TreeRows {
  readonly length: number;
  private paths: string;
  private starts: Uint32Array;
  private shas: Buffer;
  private shaBytes: number;
  private sizes: Float64Array;
  private codes: Uint8Array;
  private odd = new Map<number, GithubTreeEntry>();
  constructor(entries: GithubTreeEntry[]) {
    const n = entries.length;
    this.length = n;
    this.shaBytes = (entries.find(e => typeof e.sha === 'string' && gitId.test(e.sha))?.sha.length ?? 40) / 2;
    this.starts = new Uint32Array(n + 1);
    this.shas = Buffer.alloc(n * this.shaBytes);
    this.sizes = new Float64Array(n);
    this.codes = new Uint8Array(n);
    const paths: string[] = new Array(n);
    let at = 0;
    for (let i = 0; i < n; i++) {
      const entry = entries[i]!,
        mode = modeCode.get(entry.mode),
        type = typeCode.get(entry.type),
        path = typeof entry.path === 'string' ? entry.path : '';
      paths[i] = path;
      at += path.length;
      this.starts[i + 1] = at;
      if (
        path !== entry.path ||
        mode === undefined ||
        type === undefined ||
        typeof entry.sha !== 'string' ||
        !gitId.test(entry.sha) ||
        entry.sha.length !== this.shaBytes * 2 ||
        (entry.size !== undefined && !Number.isSafeInteger(entry.size))
      ) {
        this.odd.set(i, { ...entry });
        continue;
      }
      this.shas.write(entry.sha, i * this.shaBytes, 'hex');
      this.sizes[i] = entry.size === undefined ? -1 : entry.size;
      this.codes[i] = mode * 4 + type;
    }
    this.paths = paths.join('');
  }
  path(index: number) {
    return this.odd.get(index)?.path ?? this.paths.slice(this.starts[index]!, this.starts[index + 1]!);
  }
  /** One entry as an object, made on demand. */
  entry(index: number): GithubTreeEntry {
    const odd = this.odd.get(index);
    if (odd) return odd;
    const code = this.codes[index]!,
      size = this.sizes[index]!;
    const entry: GithubTreeEntry = {
      path: this.path(index),
      mode: modes[code >> 2]!,
      type: types[code & 3]!,
      sha: this.shas.toString('hex', index * this.shaBytes, (index + 1) * this.shaBytes),
    };
    if (size >= 0) entry.size = size;
    return entry;
  }
}

/** Calls `visit` for every entry of `tree` with its path from the listed root. */
export function walkSplitTree(
  tree: SplitTree,
  visit: (path: string, entry: GithubTreeEntry) => void,
  prefix = '',
) {
  for (let i = 0; i < tree.rows.length; i++) {
    const entry = tree.rows.entry(i);
    visit(prefix ? `${prefix}/${entry.path}` : entry.path, entry);
  }
  for (const child of tree.nested)
    walkSplitTree(child.tree, visit, prefix ? `${prefix}/${child.prefix}` : child.prefix);
}

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
): Promise<SplitTree> {
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
      return reply;
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
  const done = new Map<string, Promise<SplitTree>>();
  const collect = (sha: string, truncated = false): Promise<SplitTree> => {
    let pending = done.get(sha);
    if (!pending) done.set(sha, (pending = collectUncached(sha, truncated)));
    return pending;
  };
  const collectUncached = async (sha: string, truncated: boolean): Promise<SplitTree> => {
    if (!truncated) {
      const whole = await read(sha, true);
      if (whole.truncated === false) return { rows: new TreeRows(whole.tree), nested: [] };
    }
    stats.splits++;
    const flat = await read(sha, false);
    // One directory above the limit has no smaller reply to ask for.
    if (flat.truncated !== false) throw new TreeSplitUnavailable('directory-truncated');
    const nested = await Promise.all(
      flat.tree
        .filter(entry => entry.type === 'tree' && entry.mode === '040000')
        .map(async entry => ({ prefix: entry.path, tree: await collect(entry.sha) })),
    );
    return { rows: new TreeRows(flat.tree), nested };
  };
  return collect(tree, true);
}
