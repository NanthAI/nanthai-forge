// SPDX-License-Identifier: Apache-2.0
import { realpathSync, lstatSync } from 'node:fs';
import { resolve } from 'node:path';
import { analysisManifest, sourceLanguage } from './languages.js';
import { positionIn } from './structural-positions.js';
import { digest, identity } from './hash.js';
import { exclusion, readSource, safeRelative } from './files.js';
import { gitHead, ignoredPaths, sourcePaths, verifyRoot } from './git.js';
import { ForgeError, invariant } from './errors.js';
import type { Limits, Position, Snapshot, SourceIdentity } from './types.js';

export const DEFAULT_LIMITS: Readonly<Limits> = Object.freeze({
  maxPaths: 30_000,
  maxFiles: 5_000,
  maxFileBytes: 1024 * 1024,
  maxTotalBytes: 16 * 1024 * 1024,
});

/** Files that are never text; skipped before any read so a repository of images costs no I/O. */
const BINARY =
  /\.(png|jpe?g|gif|webp|avif|ico|bmp|tiff?|pdf|zip|gz|tgz|bz2|xz|7z|rar|jar|war|class|dll|exe|so|dylib|a|o|obj|wasm|woff2?|ttf|otf|eot|mp[34]|mov|avi|webm|ogg|wav|flac|bin|dat|pyc|sqlite3?|db)$/i;

export function normalizeRoot(rootInput: string): string {
  let root: string;
  try {
    const absolute = resolve(rootInput);
    invariant(
      !lstatSync(absolute).isSymbolicLink(),
      'UNSAFE_ROOT',
      'Pass a real worktree directory, not a symlink.',
    );
    root = realpathSync(absolute);
  } catch (error) {
    if (error instanceof ForgeError) throw error;
    throw new ForgeError('INVALID_ROOT', 'Worktree root does not exist or is inaccessible.');
  }
  verifyRoot(root);
  return root;
}

export function capture(rootInput: string, limits: Limits = { ...DEFAULT_LIMITS }): Snapshot {
  for (const value of Object.values(limits))
    invariant(Number.isSafeInteger(value) && value > 0, 'BAD_LIMIT', 'Limits must be positive integers.');
  const root = normalizeRoot(rootInput);
  const paths = sourcePaths(root);
  invariant(
    paths.length <= limits.maxPaths,
    'PATH_LIMIT',
    'Worktree path count exceeds the configured limit.',
  );
  const head = gitHead(root);
  const ignored = ignoredPaths(root, paths);
  const content = new Map<string, string>();
  const files: SourceIdentity['files'] = [];
  const excluded: Record<string, number> = {};
  const skip = (reason: string) => {
    excluded[reason] = (excluded[reason] ?? 0) + 1;
  };
  let bytes = 0;
  const inventory: string[] = [];
  // Text files in no analysed language get a file-level entry once all code is captured.
  const textOnly: string[] = [];
  const entries: { path: string; end: Position }[] = [];
  for (const path of paths) {
    if (!safeRelative(path)) {
      skip('unsafe-path');
      continue;
    }
    const reason = exclusion(path);
    if (reason) {
      skip(reason);
      continue;
    }
    if (ignored.has(path)) {
      skip('gitignored');
      continue;
    }
    const language = sourceLanguage(path);
    if (!language && !analysisManifest(path)) {
      if (BINARY.test(path)) skip('unsupported-language');
      else textOnly.push(path);
      continue;
    }
    inventory.push(path);
    const data = readSource(root, path, limits.maxFileBytes);
    if (!data) {
      skip('missing-symlink-or-special');
      continue;
    }
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data);
    } catch {
      throw new ForgeError('INVALID_ENCODING', 'Included source is not valid UTF-8.');
    }
    invariant(!text.includes('\0'), 'INVALID_ENCODING', 'Included source contains a NUL byte.');
    bytes += data.length;
    invariant(
      bytes <= limits.maxTotalBytes && files.length < limits.maxFiles,
      'SOURCE_LIMIT',
      'Included source exceeds the configured total limit.',
    );
    content.set(path, text);
    files.push({ path, digest: digest(data), bytes: data.length });
    if (!language) entries.push({ path, end: positionIn(text)(text.length) });
  }
  for (const path of textOnly) {
    // The code budget above is spent first: an inventory entry never takes a code file's place,
    // and never raises the file or byte limits.
    if (files.length >= limits.maxFiles || bytes >= limits.maxTotalBytes) {
      skip('inventory-limit');
      continue;
    }
    const data = readSource(root, path, limits.maxFileBytes);
    let text: string | undefined;
    try {
      text = data ? new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data) : undefined;
    } catch {
      text = undefined;
    }
    if (!data || text === undefined || text.includes('\0') || bytes + data.length > limits.maxTotalBytes) {
      skip('unsupported-language');
      continue;
    }
    bytes += data.length;
    inventory.push(path);
    files.push({ path, digest: digest(data), bytes: data.length });
    entries.push({ path, end: positionIn(text)(text.length) });
  }
  const state = {
    gitHead: head,
    scope: 'included-language-working-tree' as const,
    files,
    inventoryDigest: identity(inventory),
    policy: { version: 2 as const, limits },
  };
  return { root, source: { id: identity(state), ...state, excluded }, content, inventory: entries };
}
