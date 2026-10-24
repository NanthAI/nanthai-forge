// SPDX-License-Identifier: Apache-2.0
import { realpathSync, lstatSync } from 'node:fs';
import { resolve } from 'node:path';
import { sourceLanguage } from './languages.js';
import { digest, identity } from './hash.js';
import { exclusion, readSource, safeRelative } from './files.js';
import { gitHead, ignoredPaths, sourcePaths, verifyRoot } from './git.js';
import { ForgeError, invariant } from './errors.js';
import type { Limits, Snapshot, SourceIdentity } from './types.js';

export const DEFAULT_LIMITS: Readonly<Limits> = Object.freeze({
  maxPaths: 30_000,
  maxFiles: 5_000,
  maxFileBytes: 1024 * 1024,
  maxTotalBytes: 16 * 1024 * 1024,
});

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
    if (!sourceLanguage(path)) {
      skip('unsupported-language');
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
  }
  const state = {
    gitHead: head,
    scope: 'included-language-working-tree' as const,
    files,
    inventoryDigest: identity(inventory),
    policy: { version: 2 as const, limits },
  };
  return { root, source: { id: identity(state), ...state, excluded }, content };
}
