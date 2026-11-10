// SPDX-License-Identifier: Apache-2.0
import { githubJson, type GithubFetch } from './github.js';
import { invariant } from './errors.js';

export type GithubTreeEntry = { path: string; mode: string; type: string; sha: string; size?: number };
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
  private constructor(
    private paths: string,
    private starts: Uint32Array,
    private shas: Buffer,
    private shaBytes: number,
    private sizes: Float64Array,
    private codes: Uint8Array,
    private odd: Map<number, GithubTreeEntry>,
  ) {
    this.length = codes.length;
  }
  static from(entries: GithubTreeEntry[]) {
    const rows = new RowsBuilder();
    for (const entry of entries) rows.entry(entry);
    return rows.finish();
  }
  /** @internal */
  static assemble(rows: RowsBuilder) {
    const n = rows.paths.length,
      starts = new Uint32Array(n + 1);
    for (let i = 0, at = 0; i < n; i++) starts[i + 1] = at += rows.paths[i]!.length;
    return new TreeRows(
      rows.paths.join(''),
      starts,
      Buffer.from(rows.shas.subarray(0, n * rows.shaBytes)),
      rows.shaBytes,
      Float64Array.from(rows.sizes),
      Uint8Array.from(rows.codes),
      rows.odd,
    );
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

class RowsBuilder {
  paths: string[] = [];
  shas = Buffer.alloc(0);
  shaBytes = 0;
  sizes: number[] = [];
  codes: number[] = [];
  odd = new Map<number, GithubTreeEntry>();
  private reserve(index: number) {
    if ((index + 1) * (this.shaBytes || 32) <= this.shas.length) return;
    const grown = Buffer.alloc(Math.max(4096, this.shas.length * 2));
    this.shas.copy(grown);
    this.shas = grown;
  }
  /** A row whose Git id the caller writes at the returned offset; -1 when the id length differs
   * from the reply's (the entry is then kept as it came). */
  row(path: string, code: number, size: number, shaHexLength: number) {
    if (!this.shaBytes) this.shaBytes = shaHexLength / 2;
    if (shaHexLength !== this.shaBytes * 2) return -1;
    const index = this.paths.length;
    this.reserve(index);
    this.paths.push(path);
    this.sizes.push(size);
    this.codes.push(code);
    return index * this.shaBytes;
  }
  /** An entry kept as it came (as JSON.parse reads it). */
  oddEntry(entry: GithubTreeEntry) {
    const index = this.paths.length;
    this.reserve(index);
    this.paths.push('');
    this.sizes.push(-1);
    this.codes.push(0);
    this.odd.set(index, entry);
  }
  entry(entry: GithubTreeEntry) {
    const mode = modeCode.get(entry.mode),
      type = typeCode.get(entry.type);
    if (
      typeof entry.path === 'string' &&
      mode !== undefined &&
      type !== undefined &&
      typeof entry.sha === 'string' &&
      gitId.test(entry.sha) &&
      (entry.size === undefined || Number.isSafeInteger(entry.size))
    ) {
      const at = this.row(entry.path, mode * 4 + type, entry.size ?? -1, entry.sha.length);
      if (at >= 0) {
        this.shas.write(entry.sha, at, 'hex');
        return;
      }
    }
    this.oddEntry({ ...entry });
  }
  finish() {
    if (!this.shaBytes) this.shaBytes = 20;
    return TreeRows.assemble(this);
  }
}

/** A tree reply: its own id, whether GitHub cut it short, and its entries in columns. */
export type TreeReply = { sha: unknown; truncated: boolean; rows: TreeRows };

/** Reads a tree reply from its bytes. A truncated recursive reply is only read again in pieces,
 * so its entries are not read at all (GitHub writes `sha` first and `truncated` last). Any
 * other reply is scanned straight into columns, with no object per entry: JSON.parse of a
 * 100,000-entry reply makes about 30 MB of short-lived objects (each with its API URL), and a
 * large listing made them faster than the action's collector freed them (a 487,756-file tree
 * ran out of its 512 MB). A reply the scanner does not recognise is parsed as JSON instead. */
export function readTreeReply(bytes: Buffer): TreeReply {
  const head = /^\{\s*"sha"\s*:\s*"([0-9a-f]{40}(?:[0-9a-f]{24})?)"/.exec(bytes.toString('latin1', 0, 96));
  if (
    head &&
    /"truncated"\s*:\s*true\s*\}\s*$/.test(bytes.toString('latin1', Math.max(0, bytes.length - 64)))
  )
    return { sha: head[1]!, truncated: true, rows: new RowsBuilder().finish() };
  const scanned = scanTreeReply(bytes);
  if (scanned) return scanned;
  const reply: { sha?: unknown; truncated?: unknown; tree?: unknown } | null = JSON.parse(
    bytes.toString('utf8'),
  );
  invariant(
    reply !== null && typeof reply === 'object' && Array.isArray(reply.tree),
    'GITHUB_RESPONSE',
    'GitHub returned another tree.',
  );
  return {
    sha: reply.sha,
    truncated: reply.truncated !== false,
    rows: TreeRows.from(reply.tree as GithubTreeEntry[]),
  };
}

type Span = [start: number, end: number, escaped: boolean];
const isSpace = (byte: number | undefined) =>
  byte === 0x20 || byte === 0x0a || byte === 0x0d || byte === 0x09;
const numberText = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const numberByte = (byte: number | undefined) =>
  byte !== undefined &&
  ((byte >= 0x30 && byte <= 0x39) ||
    byte === 0x2d ||
    byte === 0x2b ||
    byte === 0x2e ||
    byte === 0x45 ||
    byte === 0x65);
const hexValue = (byte: number) =>
  byte >= 0x30 && byte <= 0x39 ? byte - 0x30 : byte >= 0x61 && byte <= 0x66 ? byte - 0x57 : -1;
const words = [
  [Buffer.from('true'), true],
  [Buffer.from('false'), false],
  [Buffer.from('null'), null],
] as const;
const modeBytes = modes.map(mode => Buffer.from(mode)),
  typeBytes = types.map(type => Buffer.from(type));

/** The scanner behind readTreeReply: null for anything but one object whose `tree` is an
 * array of flat objects (string, number, true, false or null values) and whose other
 * values are scalars. */
function scanTreeReply(b: Buffer): TreeReply | null {
  let at = 0;
  const space = () => {
    while (isSpace(b[at])) at++;
  };
  /** The string at `at` (quotes excluded); null when there is none. */
  const string = (): Span | null => {
    if (b[at] !== 0x22) return null;
    const start = ++at;
    let escaped = false;
    for (; at < b.length; at++) {
      const byte = b[at]!;
      if (byte === 0x22) return [start, at++, escaped];
      if (byte < 0x20) return null;
      if (byte === 0x5c) {
        escaped = true;
        at++;
      }
    }
    return null;
  };
  const text = ([start, end, escaped]: Span): string =>
    escaped ? JSON.parse(b.toString('utf8', start - 1, end + 1)) : b.toString('utf8', start, end);
  /** A scalar: a string span, or a number, boolean or null; undefined when not a scalar. */
  const scalar = (): { span: Span } | { value: number | boolean | null } | undefined => {
    if (b[at] === 0x22) {
      const span = string();
      return span ? { span } : undefined;
    }
    for (const [word, value] of words)
      if (b[at] === word[0] && b.compare(word, 0, word.length, at, at + word.length) === 0) {
        at += word.length;
        return { value };
      }
    const start = at;
    while (numberByte(b[at])) at++;
    const number = b.toString('latin1', start, at);
    return numberText.test(number) ? { value: Number(number) } : undefined;
  };
  /** An unescaped key and its colon, as the known key it is ('' for any other); null when
   * there is none. */
  const keyNames = ['path', 'mode', 'type', 'sha', 'size', 'tree', 'truncated'].map(name =>
    Buffer.from(name),
  );
  const key = () => {
    const span = string();
    if (!span || span[2]) return null;
    space();
    if (b[at++] !== 0x3a) return null;
    space();
    const length = span[1] - span[0];
    for (const name of keyNames)
      if (name.length === length && b.compare(name, 0, length, span[0], span[1]) === 0)
        return name.toString('latin1');
    return '';
  };
  /** The code of a known mode or type string, without making the string; undefined if unknown. */
  const codeOf = (span: Span, known: Buffer[]) => {
    if (span[2]) {
      const value = text(span);
      const code = known.findIndex(word => word.toString('latin1') === value);
      return code < 0 ? undefined : code;
    }
    const length = span[1] - span[0];
    for (let code = 0; code < known.length; code++)
      if (known[code]!.length === length && b.compare(known[code]!, 0, length, span[0], span[1]) === 0)
        return code;
    return undefined;
  };
  /** `{ key: value, ... }` with `each` reading every value; false when malformed. */
  const members = (each: (name: string) => boolean) => {
    if (b[at++] !== 0x7b) return false;
    space();
    if (b[at] === 0x7d) {
      at++;
      return true;
    }
    for (;;) {
      const name = key();
      if (name === null || !each(name)) return false;
      space();
      if (b[at] === 0x2c) {
        at++;
        space();
        continue;
      }
      return b[at++] === 0x7d;
    }
  };
  const rows = new RowsBuilder();
  /** One entry of `tree`; false when it is not a flat object. */
  const entry = () => {
    const objectStart = at;
    let path: Span | null = null,
      mode: Span | null = null,
      type: Span | null = null,
      sha: Span | null = null,
      size: number | boolean | null | undefined,
      sized = false,
      plain = true;
    const flat = members(name => {
      const value = scalar();
      if (!value) return false;
      const span = 'span' in value ? value.span : null;
      if (name === 'path') path = span;
      else if (name === 'mode') mode = span;
      else if (name === 'type') type = span;
      else if (name === 'sha') sha = span;
      else if (name === 'size') {
        sized = true;
        size = 'value' in value ? value.value : undefined;
      }
      if (name === 'path' || name === 'mode' || name === 'type' || name === 'sha') plain &&= span !== null;
      return true;
    });
    if (!flat) return false;
    const fields = [path, mode, type, sha] as (Span | null)[];
    const code = fields[1] ? codeOf(fields[1], modeBytes) : undefined,
      kind = fields[2] ? codeOf(fields[2], typeBytes) : undefined,
      id = fields[3],
      length = id ? id[1] - id[0] : 0;
    if (
      plain &&
      fields[0] &&
      id &&
      !id[2] &&
      code !== undefined &&
      kind !== undefined &&
      (length === 40 || length === 64) &&
      (!sized || (typeof size === 'number' && Number.isSafeInteger(size)))
    ) {
      let valid = true;
      for (let i = id[0]; i < id[1] && valid; i++) valid = hexValue(b[i]!) >= 0;
      const shaAt = valid
        ? rows.row(text(fields[0]), code * 4 + kind, sized ? (size as number) : -1, length)
        : -1;
      if (shaAt >= 0) {
        for (let i = 0; i < length / 2; i++)
          rows.shas[shaAt + i] = hexValue(b[id[0] + 2 * i]!) * 16 + hexValue(b[id[0] + 2 * i + 1]!);
        return true;
      }
    }
    // Anything else is read exactly as JSON.parse reads it, for the caller's own message.
    const parsed = JSON.parse(b.toString('utf8', objectStart, at));
    const kept: GithubTreeEntry = {
      path: parsed.path,
      mode: parsed.mode,
      type: parsed.type,
      sha: parsed.sha,
    };
    if ('size' in parsed) kept.size = parsed.size;
    rows.oddEntry(kept);
    return true;
  };
  let sha: unknown,
    truncated = true,
    tree = false;
  space();
  const whole = members(name => {
    if (name !== 'tree') {
      const value = scalar();
      if (!value) return false;
      if (name === 'sha') sha = 'span' in value ? text(value.span) : value.value;
      if (name === 'truncated') truncated = !('value' in value && value.value === false);
      return true;
    }
    if (tree || b[at++] !== 0x5b) return false;
    tree = true;
    space();
    if (b[at] === 0x5d) {
      at++;
      return true;
    }
    for (;;) {
      if (!entry()) return false;
      space();
      if (b[at] === 0x2c) {
        at++;
        space();
        continue;
      }
      return b[at++] === 0x5d;
    }
  });
  space();
  return whole && tree && at === b.length ? { sha, truncated, rows: rows.finish() } : null;
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
      const reply = await githubJson(
        `/repos/${repository}/git/trees/${sha}${recursive ? '?recursive=1' : ''}`,
        token,
        request,
        readTreeReply,
      );
      invariant(reply.sha === sha, 'GITHUB_RESPONSE', 'GitHub returned another tree.');
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
      if (!whole.truncated) return { rows: whole.rows, nested: [] };
    }
    stats.splits++;
    const flat = await read(sha, false);
    // One directory above the limit has no smaller reply to ask for.
    if (flat.truncated) throw new TreeSplitUnavailable('directory-truncated');
    const children: GithubTreeEntry[] = [];
    for (let i = 0; i < flat.rows.length; i++) {
      const entry = flat.rows.entry(i);
      if (entry.type === 'tree' && entry.mode === '040000') children.push(entry);
    }
    const nested = await Promise.all(
      children.map(async entry => ({ prefix: entry.path, tree: await collect(entry.sha) })),
    );
    return { rows: flat.rows, nested };
  };
  return collect(tree, true);
}
