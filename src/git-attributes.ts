// SPDX-License-Identifier: Apache-2.0
/** `.gitattributes` patterns and the `text`/`eol` line-ending rules Git applies with its default
 * configuration (core.autocrlf false, core.eol native) (Issue 44ef42b9). Stored bytes stay exactly
 * what Git stores; only working-tree copies are converted: LF to CRLF where Git's checkout would
 * write CRLF, and CRLF back to LF on save for files Git's `add` normalises. Pure functions; no
 * filesystem or network access. Not applied: `ident`, `working-tree-encoding` and filter drivers
 * other than Git LFS (whose working copy is the object itself, so it is never converted). */

const gitattributes = (path: string) => path === '.gitattributes' || path.endsWith('/.gitattributes');
export const isGitattributesPath = gitattributes;

/** One attributes line: a pattern and the quoted-or-plain rest. */
export function splitAttributePattern(line: string): [string, string] {
  if (!line.startsWith('"')) {
    const space = line.search(/[ \t]/);
    return space < 0 ? [line, ''] : [line.slice(0, space), line.slice(space + 1)];
  }
  let pattern = '',
    index = 1;
  for (; index < line.length && line[index] !== '"'; index++)
    pattern += line[index] === '\\' && index + 1 < line.length ? line[++index] : line[index];
  return index < line.length ? [pattern, line.slice(index + 1).trim()] : ['', ''];
}

const compiled = new Map<string, RegExp>();
/** Git wildmatch for attributes: `*`, `?`, `[...]`, `**` and anchoring by slash. */
function wildmatch(pattern: string): RegExp {
  let cached = compiled.get(pattern);
  if (cached) return cached;
  const anchored = pattern.includes('/');
  const body = pattern.replace(/^\//, '');
  let source = '';
  for (let i = 0; i < body.length; i++) {
    const char = body[i]!;
    if (char === '*' && body[i + 1] === '*') {
      const atStart = i === 0 || body[i - 1] === '/';
      const atEnd = i + 2 === body.length || body[i + 2] === '/';
      if (atStart && atEnd) {
        if (i + 2 === body.length) source += '.*';
        else {
          source += '(?:.*/)?';
          i++;
        }
        i++;
        continue;
      }
      source += '[^/]*';
      i++;
    } else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else if (char === '[') {
      const end = body.indexOf(']', i + 2);
      if (end < 0) source += '\\[';
      else {
        let set = body.slice(i + 1, end);
        if (set.startsWith('!')) set = '^' + set.slice(1);
        source += `[${set.replace(/\\/g, '\\\\')}]`;
        i = end;
      }
    } else if (char === '\\' && i + 1 < body.length) source += escape(body[++i]!);
    else source += escape(char);
  }
  cached = new RegExp(anchored ? `^${source}$` : `(?:^|/)${source}$`);
  compiled.set(pattern, cached);
  return cached;
}
const escape = (char: string) => char.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** Whether `pattern` from the `.gitattributes` in folder `base` (`''` or `dir/`) matches file `path`. */
export function attributePatternMatches(base: string, pattern: string, path: string) {
  if (!path.startsWith(base)) return false;
  const relative = path.slice(base.length);
  const target = pattern.includes('/') ? relative : relative.slice(relative.lastIndexOf('/') + 1);
  return wildmatch(pattern).test(target);
}

/** Every `.gitattributes` file, shallow files first and lines in order, so a later match wins as in
 * Git (deeper files override shallower ones). Directory-only and negative patterns never match. */
export function attributeLines(files: readonly { path: string; text: string }[]) {
  const ordered = files
    .filter(file => gitattributes(file.path))
    .sort((a, b) => a.path.split('/').length - b.path.split('/').length || (a.path < b.path ? -1 : 1));
  const lines: { base: string; pattern: string; attributes: string[]; root: boolean }[] = [];
  for (const file of ordered) {
    const base = file.path.slice(0, file.path.length - '.gitattributes'.length);
    for (const raw of file.text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const [pattern, rest] = splitAttributePattern(line);
      const attributes = rest.split(/[ \t]+/).filter(Boolean);
      if (pattern.startsWith('[attr]')) {
        lines.push({ base, pattern, attributes, root: base === '' });
        continue;
      }
      if (!pattern || pattern.endsWith('/') || pattern.startsWith('!')) continue;
      lines.push({ base, pattern, attributes, root: base === '' });
    }
  }
  return lines;
}

/** Git's line-ending action for a path (convert.c `crlf_action`). */
export type TextAction = 'binary' | 'text-input' | 'text-crlf' | 'auto' | 'auto-input' | 'auto-crlf';
type Value = true | false | string;
const relevant = new Set(['text', 'eol', 'crlf', 'filter']);

/** One attribute setting: `name` set, `-name` unset, `!name` unspecified, `name=value`. */
function setting(attribute: string): [string, Value | null] {
  if (attribute.startsWith('-')) return [attribute.slice(1), false];
  if (attribute.startsWith('!')) return [attribute.slice(1), null];
  const equals = attribute.indexOf('=');
  return equals < 0 ? [attribute, true] : [attribute.slice(0, equals), attribute.slice(equals + 1)];
}

type Rule = { base: string; pattern: string; settings: [string, Value | null][]; at: number };
/** `*.bat`, `*.tar.gz`: a basename suffix with no other wildcard, looked up by its extension. */
const suffixPattern = /^\*([^*?[\\/]*\.[^*?[\\/.]*)$/;
const extension = (name: string) => name.slice(name.lastIndexOf('.'));

/** The rules matching a path in file order, testing only rules that can match: suffix rules are
 * found by the basename's extension, so a long list of `*.ext` lines costs one lookup per path. */
function ruleMatcher(rules: readonly Rule[]) {
  const general: Rule[] = [],
    bySuffix = new Map<string, { rule: Rule; suffix: string }[]>();
  for (const rule of rules) {
    const suffix = suffixPattern.exec(rule.pattern)?.[1];
    if (suffix === undefined) general.push(rule);
    else {
      const key = extension(suffix);
      bySuffix.set(key, [...(bySuffix.get(key) ?? []), { rule, suffix }]);
    }
  }
  return (path: string): Rule[] => {
    const name = path.slice(path.lastIndexOf('/') + 1),
      dot = name.lastIndexOf('.');
    const found: Rule[] = [];
    if (dot >= 0)
      for (const { rule, suffix } of bySuffix.get(name.slice(dot)) ?? [])
        if (path.startsWith(rule.base) && name.endsWith(suffix)) found.push(rule);
    const sorted = found.length > 0;
    for (const rule of general) if (attributePatternMatches(rule.base, rule.pattern, path)) found.push(rule);
    return sorted && found.length > 1 ? found.sort((a, b) => a.at - b.at) : found;
  };
}

/** Line-ending rules of a tree. */
export type TextAttributes = {
  action(path: string): TextAction;
  /** False when no path can be checked out with CRLF here (nothing to convert at checkout). */
  readonly convertsCheckout: boolean;
  /** Whether Git's checkout may write this path with CRLF (its bytes decide; no read here). */
  convertsAt(path: string): boolean;
  /** Working-tree bytes Git's checkout writes for this blob; null when they are the blob. */
  toWorktree(path: string, bytes: Uint8Array): Buffer | null;
  /** Bytes Git's `add` stores for these working bytes; null when they are stored as they are.
   * `indexHasCrlf` answers whether the path's current blob holds CRLF (asked only when needed). */
  toGit(path: string, bytes: Uint8Array, indexHasCrlf?: () => boolean): Buffer | null;
};

/** Rules from these `.gitattributes` files, or null when none sets text, eol or crlf (nothing is
 * ever converted). `crlfNative` is Git's core.eol default on this platform. */
export function textAttributes(
  files: readonly { path: string; text: string }[],
  crlfNative = process.platform === 'win32',
): TextAttributes | null {
  const lines = attributeLines(files);
  // Macros: built-in `binary`, plus `[attr]` definitions in the top-level file (as Git allows).
  const macros = new Map<string, string[]>([['binary', ['-diff', '-merge', '-text']]]);
  for (const line of lines)
    if (line.pattern.startsWith('[attr]') && line.root) macros.set(line.pattern.slice(6), line.attributes);
  const expand = (attributes: string[], depth = 0): [string, Value | null][] =>
    attributes.flatMap(attribute => {
      const [name, value] = setting(attribute);
      const macro = macros.get(name);
      return macro && value !== false && value !== null && depth < 8
        ? expand(macro, depth + 1)
        : relevant.has(name)
          ? [[name, value] as [string, Value | null]]
          : [];
    });
  const rules: Rule[] = [];
  for (const line of lines) {
    if (line.pattern.startsWith('[attr]')) continue;
    const settings = expand(line.attributes);
    if (settings.length) rules.push({ base: line.base, pattern: line.pattern, settings, at: rules.length });
  }
  if (!rules.some(rule => rule.settings.some(([name]) => name !== 'filter'))) return null;
  const matching = ruleMatcher(rules);
  const action = (path: string): TextAction => {
    const value = new Map<string, Value | null>();
    for (const rule of matching(path)) for (const [name, setTo] of rule.settings) value.set(name, setTo);
    // A Git LFS file's working copy is the object itself (Forge stores it), never converted.
    if (value.get('filter') === 'lfs') return 'binary';
    const crlfOf = (v: Value | null | undefined) =>
      v === true
        ? 'text'
        : v === false
          ? 'binary'
          : v === 'input'
            ? 'text-input'
            : v === 'auto'
              ? 'auto'
              : 'undefined';
    let crlf = crlfOf(value.get('text'));
    if (crlf === 'undefined') crlf = crlfOf(value.get('crlf'));
    if (crlf !== 'binary') {
      const eol = value.get('eol');
      if (eol === 'lf') crlf = crlf === 'auto' ? 'auto-input' : 'text-input';
      else if (eol === 'crlf') crlf = crlf === 'auto' ? 'auto-crlf' : 'text-crlf';
    }
    if (crlf === 'text') return crlfNative ? 'text-crlf' : 'text-input';
    if (crlf === 'undefined') return 'binary';
    return crlf as TextAction;
  };
  const convertsCheckout = rules.some(rule =>
    rule.settings.some(
      ([name, v]) => (name === 'eol' && v === 'crlf') || (crlfNative && (name === 'text' || name === 'crlf')),
    ),
  );
  const crlfOutput = (a: TextAction) =>
    a === 'text-crlf' || a === 'auto-crlf' || (a === 'auto' && crlfNative);
  const guessed = (a: TextAction) => a === 'auto' || a === 'auto-input' || a === 'auto-crlf';
  return {
    action,
    convertsCheckout,
    convertsAt: path => convertsCheckout && crlfOutput(action(path)),
    toWorktree(path, bytes) {
      if (!convertsCheckout || bytes.indexOf(10) < 0) return null;
      const a = action(path);
      if (!crlfOutput(a)) return null;
      const stats = textStats(bytes);
      if (!stats.lonelf) return null;
      // Git's safer autocrlf: a guessed text file that already has CR is left alone.
      if (guessed(a) && (stats.lonecr || stats.crlf || isBinary(stats))) return null;
      return lfToCrlf(bytes, stats.lonelf);
    },
    toGit(path, bytes, indexHasCrlf) {
      if (!bytes.length || bytes.indexOf(13) < 0) return null;
      const a = action(path);
      if (a === 'binary') return null;
      const stats = textStats(bytes);
      if (!stats.crlf) return null;
      // A guessed text file committed with CRLF keeps it (Git's has_crlf_in_index).
      if (guessed(a) && (isBinary(stats) || (indexHasCrlf?.() ?? true))) return null;
      return crlfToLf(bytes, stats.crlf);
    },
  };
}

type Stats = {
  lonecr: number;
  lonelf: number;
  crlf: number;
  nul: number;
  printable: number;
  nonprintable: number;
};
/** Git's gather_stats. */
export function textStats(bytes: Uint8Array): Stats {
  const s: Stats = { lonecr: 0, lonelf: 0, crlf: 0, nul: 0, printable: 0, nonprintable: 0 };
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i]!;
    if (c === 13) {
      if (bytes[i + 1] === 10) {
        s.crlf++;
        i++;
      } else s.lonecr++;
    } else if (c === 10) s.lonelf++;
    else if (c === 127) s.nonprintable++;
    else if (c < 32) {
      // BS, HT, ESC and FF count as printable.
      if (c === 8 || c === 9 || c === 27 || c === 12) s.printable++;
      else {
        if (c === 0) s.nul++;
        s.nonprintable++;
      }
    } else s.printable++;
  }
  // A trailing Ctrl-Z (DOS end of file) is not counted as non-printable.
  if (bytes.length && bytes[bytes.length - 1] === 26) s.nonprintable--;
  return s;
}
/** Git's convert_is_binary. */
export const isBinary = (s: Stats) => s.lonecr > 0 || s.nul > 0 || s.printable >> 7 < s.nonprintable;
/** Whether a blob holds CRLF as Git's has_crlf_in_index reads it (text with at least one CRLF). */
export function blobHasCrlf(bytes: Uint8Array) {
  if (bytes.indexOf(13) < 0) return false;
  const stats = textStats(bytes);
  return stats.crlf > 0 && !isBinary(stats);
}

function lfToCrlf(bytes: Uint8Array, lonelf: number) {
  const out = Buffer.allocUnsafe(bytes.length + lonelf);
  let o = 0;
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i]!;
    if (c === 10 && (i === 0 || bytes[i - 1] !== 13)) out[o++] = 13;
    out[o++] = c;
  }
  return out;
}
function crlfToLf(bytes: Uint8Array, crlf: number) {
  const out = Buffer.allocUnsafe(bytes.length - crlf);
  let o = 0;
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i]!;
    if (c !== 13 || bytes[i + 1] !== 10) out[o++] = c;
  }
  return out;
}
