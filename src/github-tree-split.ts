// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { githubJson, type GithubFetch } from './github.js';
import { invariant } from './errors.js';
import { safeRelative } from './safe-relative.js';

export type GithubTreeEntry = { path: string; mode: string; type: string; sha: string; size?: number };

const modes = ['100644', '100755', '120000', '160000', '040000'],
  types = ['blob', 'tree', 'commit'];
const modeCode = new Map(modes.map((mode, code) => [mode, code])),
  typeCode = new Map(types.map((type, code) => [type, code]));
const directoryCode = modeCode.get('040000')! * 4 + typeCode.get('tree')!;
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
    const odd = this.odd.get(index);
    return odd ? odd.path : this.paths.slice(this.starts[index]!, this.starts[index + 1]!);
  }
  isDirectory(index: number) {
    const odd = this.odd.get(index);
    return odd ? isTree(odd) : this.codes[index] === directoryCode;
  }
  hasValidId(index: number) {
    const odd = this.odd.get(index);
    return !odd || (typeof odd.sha === 'string' && gitId.test(odd.sha));
  }
  get retainedBytes() {
    return this.odd.size
      ? Infinity
      : this.paths.length * 2 +
          this.starts.byteLength +
          this.shas.byteLength +
          this.sizes.byteLength +
          this.codes.byteLength;
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
      (entry.size === undefined || (Number.isSafeInteger(entry.size) && entry.size >= 0))
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
      (!sized || (typeof size === 'number' && Number.isSafeInteger(size) && size >= 0))
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

const treeSplitConcurrency = 8;
const treeSplitMaxRequests = 1_500;
const cacheBudget = 16 * 1024 * 1024;
// Flat ancestors and prefetched replies share the budget, with one slot for a current read.
const flatSlots = 4;

/** A tree GitHub cannot return in pieces. */
export class TreeSplitUnavailable extends Error {
  constructor(readonly reason: 'directory-truncated' | 'request-cap') {
    super(`GitHub tree split unavailable: ${reason}`);
  }
}

const isTree = (entry: GithubTreeEntry) => entry.type === 'tree' && entry.mode === '040000';
const validPaths = (ok: unknown) =>
  invariant(ok, 'GITHUB_RESPONSE', 'GitHub returned invalid or duplicate tree paths.');

function ordered(rows: TreeRows, recursive: boolean) {
  const directories = new Set(['']);
  for (let index = 0; index < rows.length; index++) {
    const path = rows.path(index);
    validPaths(typeof path === 'string' && safeRelative(path) && (recursive || !path.includes('/')));
    invariant(
      !/(?:^|\/)(?:\.git|\.forge)(?:\/|$)/i.test(path),
      'INVALID_NATIVE_SOURCE',
      'Imported paths cannot overlap native metadata.',
    );
    validPaths(rows.hasValidId(index));
    if (rows.isDirectory(index)) {
      validPaths(!directories.has(path));
      directories.add(path);
    }
  }
  let last = '';
  let needsSort = false;
  for (let index = 0; index < rows.length; index++) {
    const path = rows.path(index),
      directory = rows.isDirectory(index);
    const parent = path.slice(0, Math.max(0, path.lastIndexOf('/')));
    validPaths(directories.has(parent) && (directory || !directories.has(path)));
    const key = directory ? path + '/' : path;
    needsSort ||= key <= last;
    last = key;
  }
  const order = needsSort ? Uint32Array.from({ length: rows.length }, (_, index) => index) : null;
  if (order) {
    const key = (i: number) => (rows.isDirectory(i) ? rows.path(i) + '/' : rows.path(i));
    order.sort((a, b) => {
      const left = key(a),
        right = key(b);
      return left < right ? -1 : left > right ? 1 : 0;
    });
  }
  return {
    length: rows.length,
    bytes: rows.retainedBytes + (order?.byteLength ?? 0),
    entry: (index: number) => rows.entry(order?.[index] ?? index),
    isDirectory: (index: number) => rows.isDirectory(order?.[index] ?? index),
  };
}
type OrderedTree = ReturnType<typeof ordered>;
type TreeBatch = { prefix: string; entries: Iterable<GithubTreeEntry> };

function* entries(rows: OrderedTree, start = 0, end = rows.length) {
  for (let index = start; index < end; index++) yield rows.entry(index);
}

/** Walk in State order. Cache small identical subtrees and look ahead only as
 * far as the reply budget allows. A deeply nested split can evict a flat
 * ancestor, which is read again by its exact ID if it is still needed. */
export async function* streamGithubTree(
  repository: string,
  root: string,
  token: string | undefined,
  request: GithubFetch,
  stats: { requests: number; splits: number },
): AsyncGenerator<TreeBatch> {
  validPaths(gitId.test(root));
  const cache = new Map<string, OrderedTree | null>();
  let cachedBytes = 0;
  const cost = (rows: OrderedTree | null) => 128 + (rows?.bytes ?? 0);
  const read = async (tree: string, recursive: boolean) => {
    const key = recursive ? tree + '?' : tree;
    const hit = cache.get(key);
    if (hit !== undefined) {
      cache.delete(key);
      cache.set(key, hit);
      return hit;
    }
    if (stats.requests >= treeSplitMaxRequests) throw new TreeSplitUnavailable('request-cap');
    stats.requests++;
    const reply = await githubJson(
      `/repos/${repository}/git/trees/${tree}${recursive ? '?recursive=1' : ''}`,
      token,
      request,
      readTreeReply,
    );
    invariant(reply.sha === tree, 'GITHUB_RESPONSE', 'GitHub returned another tree.');
    const rows = reply.truncated ? null : ordered(reply.rows, recursive);
    const bytes = cost(rows);
    if (bytes <= cacheBudget) {
      while (cachedBytes + bytes > cacheBudget) {
        const oldest = cache.keys().next().value!;
        cachedBytes -= cost(cache.get(oldest)!);
        cache.delete(oldest);
      }
      cache.set(key, rows);
      cachedBytes += bytes;
    }
    return rows;
  };
  // Prefetched failures are observed in emission order. Drain speculative reads
  // if validation or the sink ends the walk early.
  const pending = new Map<string, Promise<OrderedTree | null>>();
  const flats = new Map<object, OrderedTree>();
  const take = (tree: string) => {
    const ready = pending.get(tree);
    pending.delete(tree);
    return ready ?? read(tree, true);
  };
  const whole = async function* (tree: string, prefix: string) {
    const rows = await take(tree);
    if (rows) yield { prefix, entries: entries(rows) };
    return rows !== null;
  };
  const walk = async function* (tree: string, prefix: string): AsyncGenerator<TreeBatch> {
    if (yield* whole(tree, prefix)) return;
    stats.splits++;
    const frame = {};
    let lookAheadAt = 0;
    const flat = async () => {
      const hit = flats.get(frame);
      flats.delete(frame);
      const available = Math.min(flatSlots, treeSplitConcurrency - pending.size - 1);
      if (!hit && flats.size >= available) flats.delete(flats.keys().next().value!);
      const rows = hit ?? (await read(tree, false));
      if (!rows) throw new TreeSplitUnavailable('directory-truncated');
      flats.set(frame, rows);
      return rows;
    };
    const segment = async (start: number) => {
      const rows = await flat();
      let end = start,
        child: GithubTreeEntry | undefined;
      while (end < rows.length) {
        if (rows.isDirectory(end++)) {
          child = rows.entry(end - 1);
          break;
        }
      }
      if (child) {
        const lookAhead = treeSplitConcurrency - flats.size - 1;
        // A wide fan-out can reuse one SHA, so pending.size alone cannot tell
        // us what we have already scanned. Never scan those siblings again.
        lookAheadAt = Math.max(lookAheadAt, end - 1);
        for (; lookAheadAt < rows.length && pending.size < lookAhead; lookAheadAt++) {
          if (!rows.isDirectory(lookAheadAt)) continue;
          const entry = rows.entry(lookAheadAt);
          if (pending.has(entry.sha)) continue;
          const reading = read(entry.sha, true);
          void reading.catch(() => {});
          pending.set(entry.sha, reading);
        }
      }
      return { batch: { prefix, entries: entries(rows, start, end) }, child, end, done: end === rows.length };
    };
    try {
      for (let start = 0; ;) {
        let part: Awaited<ReturnType<typeof segment>> | undefined = await segment(start);
        yield part.batch;
        const { child, done, end } = part;
        part = undefined;
        if (done) flats.delete(frame);
        if (child) yield* walk(child.sha, prefix ? `${prefix}/${child.path}` : child.path);
        if (done) break;
        start = end;
      }
    } finally {
      flats.delete(frame);
    }
  };
  try {
    yield* walk(root, '');
  } finally {
    await Promise.allSettled(pending.values());
  }
}
