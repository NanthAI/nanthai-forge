// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// The .env side of `nforge secret import` (Item 41a0df87 slice 3): parse a dotenv file into names and values, keep the
// root .env.example listing the names (never a value), and write a removed file back for a person. Notices name a
// variable or a line number, never a value or the text of a line.
import { randomUUID, createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  linkSync,
  lstatSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { ForgeError, invariant } from './errors.js';
import { readSecretExampleFile, type SecretNameNotice } from './secret-env-example.js';
import { secretNameKind } from './secret-names.js';

/** A dotenv file is read whole, so it is bounded: far above 200 names of the format's value sizes in practice. */
const MAX_DOTENV_BYTES = 1024 * 1024;
export type DotenvEntry = { name: string; line: number; value: Buffer };
const DECLARATION = /^\s*(?:export\s+)?([^\s=#]+)\s*=[ \t]*(.*)$/;

/** The lines (1-based, split at LF as the parser splits) whose bytes are not valid UTF-8 (review M2): decoding them
 * would replace bytes, so they are never imported and the file is kept. One pass when the whole file is valid. */
export function invalidUtf8Lines(bytes: Buffer) {
  const bad = new Set<number>();
  if (Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes)) return bad;
  for (let start = 0, line = 1; ; line++) {
    const end = bytes.indexOf(0x0a, start),
      piece = bytes.subarray(start, end < 0 ? bytes.length : end);
    if (!Buffer.from(piece.toString('utf8'), 'utf8').equals(piece)) bad.add(line);
    if (end < 0) return bad;
    start = end + 1;
  }
}
/** The file's bytes parsed, with any line that is not valid UTF-8 named and left out. */
export const parseDotenvBytes = (bytes: Buffer) =>
  parseDotenv(bytes.toString('utf8'), invalidUtf8Lines(bytes));

/** dotenv's rules: `[export ]NAME=value`; single and backtick quotes are literal, double quotes turn `\n` and `\r`
 * into line breaks, and any quote may span lines. An unquoted value ends at `#` and is trimmed. No `${}` expansion.
 * A repeated name keeps its last value. Notices carry a line number, or a name only when it is a valid one: no text
 * of a malformed line reaches output (review L1). Linear in the text, which is at most 1 MiB (review L2). */
export function parseDotenv(text: string, invalid: ReadonlySet<number> = new Set()) {
  invariant(text.length <= MAX_DOTENV_BYTES, 'SECRETS_FORMAT_REFUSED', 'The file to import is over 1 MiB.');
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const found = new Map<string, { line: number; value: string }>();
  const notices: SecretNameNotice[] = [...invalid].map(at => ({
    name: `line ${at}`,
    reason: 'not valid UTF-8',
  }));
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!,
      at = i + 1;
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const declaration = DECLARATION.exec(line);
    if (!declaration) {
      if (!invalid.has(at)) notices.push({ name: `line ${at}`, reason: 'not a NAME=value line' });
      continue;
    }
    const name = declaration[1]!,
      rest = declaration[2]!;
    let value: string,
      last = i;
    const quote = rest[0];
    if (quote === '"' || quote === "'" || quote === '`') {
      // Each line is scanned once, carrying the escape state, and the pieces are joined once.
      const pieces: string[] = [];
      let piece = rest.slice(1),
        scanned = closing(piece, quote, false);
      while (scanned.end < 0 && last + 1 < lines.length) {
        pieces.push(piece);
        piece = lines[++last]!;
        // A backslash before the line break escaped the break itself.
        scanned = closing(piece, quote, false);
      }
      if (scanned.end < 0 || !/^\s*(?:#.*)?$/.test(piece.slice(scanned.end + 1))) {
        if (!spans(invalid, at, last))
          notices.push({ name: `line ${at}`, reason: 'unclosed or malformed quote' });
        continue;
      }
      pieces.push(piece.slice(0, scanned.end));
      i = last;
      value = pieces.join('\n');
      if (quote === '"') value = value.replace(/\\n/g, '\n').replace(/\\r/g, '\r');
    } else value = rest.split('#', 1)[0]!.trim();
    if (spans(invalid, at, last)) continue;
    if (found.has(name))
      notices.push({
        name: secretNameKind(name) === 'invalid' ? `line ${at}` : name,
        reason: 'repeated; the last value is used',
      });
    found.delete(name);
    found.set(name, { line: at, value });
  }
  return {
    entries: [...found].map(([name, { line, value }]): DotenvEntry => ({
      name,
      line,
      value: Buffer.from(value, 'utf8'),
    })),
    notices,
  };
}
const spans = (invalid: ReadonlySet<number>, from: number, last: number) => {
  if (!invalid.size) return false;
  for (let at = from; at <= last + 1; at++) if (invalid.has(at)) return true;
  return false;
};
function closing(piece: string, quote: string, escaped: boolean) {
  for (let i = 0; i < piece.length; i++) {
    if (escaped) escaped = false;
    else if (piece[i] === '\\' && quote === '"') escaped = true;
    else if (piece[i] === quote) return { end: i };
  }
  return { end: -1 };
}

type Opened = { bytes: Buffer; dev: number; ino: number; hash: Buffer };
/** A regular file, opened once without following a link; its type and size are checked on that handle, and the read
 * stops past 1 MiB even if the file grows after the check. */
export function readDotenvFile(path: string): Opened {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | constants.O_NONBLOCK);
    const opened = fstatSync(fd);
    invariant(opened.isFile(), 'UNSAFE_PATH', 'The file to import must be a regular file, never a link.');
    invariant(opened.size <= MAX_DOTENV_BYTES, 'SECRETS_FORMAT_REFUSED', 'The file to import is over 1 MiB.');
    const buffer = Buffer.alloc(MAX_DOTENV_BYTES + 1);
    let size = 0;
    try {
      for (let n = 1; n && size < buffer.length; size += n)
        n = readSync(fd, buffer, size, buffer.length - size, null);
      invariant(size <= MAX_DOTENV_BYTES, 'SECRETS_FORMAT_REFUSED', 'The file to import is over 1 MiB.');
      const bytes = Buffer.from(buffer.subarray(0, size));
      return { bytes, dev: opened.dev, ino: opened.ino, hash: createHash('sha256').update(bytes).digest() };
    } finally {
      buffer.fill(0);
    }
  } catch (error) {
    if (error instanceof ForgeError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    throw new ForgeError(
      code === 'ENOENT' ? 'NOT_FOUND' : 'UNSAFE_PATH',
      code === 'ENOENT'
        ? 'There is no file to import there.'
        : code === 'ELOOP'
          ? 'The file to import must be a regular file, never a link.'
          : 'The file to import could not be read.',
    );
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Removes the imported file only if it still holds the exact bytes that were imported. The entry is first moved
 * aside in one rename, so what is checked is what is deleted; anything else is put back where it was, never over a
 * file that appeared since. Returns 'removed', 'changed', or the aside path when it could not be put back. */
export function removeIfUnchanged(path: string, read: Opened): 'removed' | 'changed' | { aside: string } {
  const aside = join(dirname(path), `.${basename(path)}.${randomUUID()}.removing`);
  try {
    renameSync(path, aside);
  } catch {
    return 'changed';
  }
  let ours = false;
  try {
    const now = readDotenvFile(aside);
    now.bytes.fill(0);
    ours = now.dev === read.dev && now.ino === read.ino && now.hash.equals(read.hash);
  } catch {
    ours = false;
  }
  try {
    if (ours) unlinkSync(aside);
    else {
      // A hard link refuses to replace an entry that appeared at the path meanwhile; anything that is not a regular
      // file stays aside and is named.
      if (!lstatSync(aside).isFile()) return { aside };
      linkSync(aside, path);
      unlinkSync(aside);
    }
  } catch {
    return { aside };
  }
  return ours ? 'removed' : 'changed';
}

/** Appends the names the root .env.example does not list yet, as `NAME=` lines, in one atomic replace of the text it
 * read. Returns the names added. A case-variant spelling of the file is refused rather than overwritten on a
 * case-insensitive disk. */
export function addExampleNames(root: string, names: readonly string[]) {
  const current = readSecretExampleFile(root);
  invariant(
    !current.notices.some(n => /use the exact name/.test(n.reason)),
    'UNSAFE_PATH',
    'Rename the case-variant example file to .env.example, then import again.',
  );
  const missing = names.filter(name => !current.names.includes(name));
  if (!missing.length) return [];
  const text = current.text;
  const next = `${text}${text && !text.endsWith('\n') ? '\n' : ''}${missing.map(name => `${name}=\n`).join('')}`;
  const temporary = join(root, `.env.example.${randomUUID()}.tmp`);
  const fd = openSync(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
    0o644,
  );
  try {
    writeSync(fd, next);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temporary, join(root, '.env.example'));
  } catch (error) {
    unlinkSync(temporary);
    throw error;
  }
  return missing;
}

/** A value as a dotenv line that parseDotenv (and dotenv) read back to the same bytes: single quotes are literal,
 * then backticks. A value with a carriage return, or with both quote kinds, is double-quoted with `\r` and `\n`
 * escaped, when it has no `"` or backslash; a raw CR is never written, since a CR LF pair reads back as LF (review
 * L3). Null when no form fits. */
export function dotenvLine(name: string, value: string) {
  if (!value.includes('\r')) {
    if (!value.includes("'")) return `${name}='${value}'`;
    if (!value.includes('`')) return `${name}=\`${value}\``;
  }
  if (!/["\\]/.test(value)) return `${name}="${value.replace(/\r/g, '\\r').replace(/\n/g, '\\n')}"`;
  return null;
}

/** Writes a new private file (0600), refusing one that exists or a link in its place. */
export function writeNewPrivate(path: string, text: string) {
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
  } catch (error) {
    throw new ForgeError(
      'UNSAFE_PATH',
      (error as NodeJS.ErrnoException).code === 'EEXIST'
        ? 'That file exists; move it away first. Nothing was written.'
        : 'That file could not be created.',
    );
  }
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
}
