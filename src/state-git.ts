// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { digest } from './hash.js';
import { invariant } from './errors.js';
import { gitlinkCommit } from './gitlink.js';
import { gitMode } from './hosted-github-git.js';
import { parseNativeState, type NativeFile } from './native-state-format.js';

/** P5-SG source layer: a Forge State keeps its SHA-256 identity (the hash of its
 * exact manifest bytes) while its file list is stored as Git trees and blobs.
 * Everything here is in-process; no Git binary or repository is involved. */
export type GitObjectType = 'blob' | 'tree' | 'commit';
export type GitObject = { type: GitObjectType; bytes: Buffer };
export type StateGitRecord = {
  schema: 1;
  kind: 'forge-git-state';
  /** Forge State identity: SHA-256 of the exact original manifest bytes. */
  state: string;
  /** Git (SHA-1) root tree holding the State's files. */
  tree: string;
  /** Every other manifest field, in its original key order. */
  fields: Record<string, unknown>;
  /** Position of `files` among the original keys. */
  filesAt: number;
  /** Gitlink pointer object IDs; Git trees hold only the pinned commit. */
  gitlinks?: Record<string, string>;
};
/** Known blob identities and already-stored objects shared across conversions.
 * A blob in `blobs` was emitted or stored before; discard the cache with any
 * objects the caller fails to store. */
export type StateGitCache = {
  /** SHA-256 file blob → Git blob oid. */
  blobs: Map<string, string>;
  /** Git blob oid → SHA-256 file blob (the reverse alias). */
  aliases: Map<string, string>;
  /** Git object IDs the destination already holds; never emitted again. */
  stored: Set<string>;
};
export type StateGitConversion =
  | { exact: true; record: StateGitRecord; objects: Map<string, GitObject> }
  | { exact: false; state: string; reason: 'NON_CANONICAL_MANIFEST' };

const modes = { '100644': 'file', '100755': 'executable', '120000': 'symlink', '160000': 'gitlink' } as const;
export const emptyStateGitCache = (): StateGitCache => ({
  blobs: new Map(),
  aliases: new Map(),
  stored: new Set(),
});
export function gitObjectId(type: GitObjectType, bytes: Uint8Array): string {
  return createHash('sha1').update(`${type} ${bytes.length}\0`).update(bytes).digest('hex');
}

type Dir = Map<string, { mode: string; oid: string } | Dir>;
/** Git orders entries by name bytes, with a directory compared as `name/`. */
function writeTree(dir: Dir, emit: (type: GitObjectType, bytes: Buffer) => string): string {
  const entries = [...dir].map(([name, value]) => {
    const tree = value instanceof Map;
    return {
      key: Buffer.from(tree ? `${name}/` : name),
      bytes: Buffer.concat([
        Buffer.from(`${tree ? '40000' : value.mode} ${name}\0`),
        Buffer.from(tree ? writeTree(value, emit) : value.oid, 'hex'),
      ]),
    };
  });
  entries.sort((a, b) => Buffer.compare(a.key, b.key));
  return emit('tree', Buffer.concat(entries.map(entry => entry.bytes)));
}

/** Convert exact manifest bytes into a State record plus the Git objects the
 * destination lacks. Each unknown blob is read once; a non-canonical manifest
 * (one this record cannot reproduce byte-for-byte) is reported, not converted. */
export function stateToGit(
  manifest: Uint8Array,
  readBlob: (blob: string) => Uint8Array,
  cache: StateGitCache,
): StateGitConversion {
  const state = digest(manifest),
    parsed = parseNativeState(manifest),
    original = JSON.parse(Buffer.from(manifest).toString('utf8')) as Record<string, unknown>,
    keys = Object.keys(original),
    fields: Record<string, unknown> = {};
  for (const key of keys) if (key !== 'files') fields[key] = original[key];
  const objects = new Map<string, GitObject>(),
    gitlinks: Record<string, string> = {};
  const emit = (type: GitObjectType, bytes: Buffer) => {
    const oid = gitObjectId(type, bytes);
    if (!cache.stored.has(oid) && !objects.has(oid)) objects.set(oid, { type, bytes });
    return oid;
  };
  const root: Dir = new Map();
  for (const file of parsed.files) {
    const parts = file.path.split('/'),
      name = parts.pop()!;
    let dir = root;
    for (const part of parts) {
      if (!dir.has(part)) dir.set(part, new Map());
      dir = dir.get(part) as Dir;
    }
    dir.set(name, { mode: gitMode(file.mode), oid: fileObject(file, readBlob, cache, emit, gitlinks) });
  }
  const record: StateGitRecord = {
    schema: 1,
    kind: 'forge-git-state',
    state,
    tree: writeTree(root, emit),
    fields,
    filesAt: keys.indexOf('files'),
    ...(Object.keys(gitlinks).length ? { gitlinks } : {}),
  };
  // Only a record that reproduces the original bytes may replace the manifest.
  const reproduced = Buffer.from(manifestJson(record, sortFiles([...parsed.files])));
  if (!reproduced.equals(Buffer.from(manifest)))
    return { exact: false, state, reason: 'NON_CANONICAL_MANIFEST' };
  return { exact: true, record, objects };
}
function fileObject(
  file: NativeFile,
  readBlob: (blob: string) => Uint8Array,
  cache: StateGitCache,
  emit: (type: GitObjectType, bytes: Buffer) => string,
  gitlinks: Record<string, string>,
): string {
  if (file.mode === 'gitlink') {
    gitlinks[file.path] = file.blob;
    return gitlinkCommit(verified(file.blob, readBlob(file.blob)));
  }
  const known = cache.blobs.get(file.blob);
  if (known) return known;
  const bytes = Buffer.from(verified(file.blob, readBlob(file.blob))),
    oid = emit('blob', bytes),
    alias = cache.aliases.get(oid);
  invariant(
    !alias || alias === file.blob,
    'GIT_OBJECT_COLLISION',
    'Two different files share one Git object ID. The State was not converted.',
  );
  cache.blobs.set(file.blob, oid);
  cache.aliases.set(oid, file.blob);
  return oid;
}
function verified(blob: string, bytes: Uint8Array): Uint8Array {
  invariant(digest(bytes) === blob, 'SOURCE_DIGEST_MISMATCH', 'Source bytes do not match their identity.');
  return bytes;
}
/** The native writer's order: UTF-16 code units of the whole path. */
const sortFiles = (files: NativeFile[]) =>
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
function manifestJson(record: StateGitRecord, files: NativeFile[]): string {
  const entries = Object.entries(record.fields);
  entries.splice(record.filesAt, 0, ['files', files]);
  return JSON.stringify(Object.fromEntries(entries));
}

/** Rebuild the exact manifest bytes from a record, verified Git trees and the
 * blob alias. The result hashes to the record's State identity or it throws. */
export function gitToState(
  record: StateGitRecord,
  readTree: (oid: string) => Uint8Array,
  alias: (oid: string) => string | undefined,
): Buffer {
  const files: NativeFile[] = [];
  const walk = (oid: string, prefix: string) => {
    const bytes = Buffer.from(readTree(oid));
    invariant(gitObjectId('tree', bytes) === oid, 'GIT_OBJECT_INVALID', 'A Git tree does not match its ID.');
    for (const entry of treeEntries(bytes)) {
      const path = prefix + entry.name;
      if (entry.mode === '40000') {
        walk(entry.oid, `${path}/`);
        continue;
      }
      const mode = modes[entry.mode as keyof typeof modes];
      invariant(mode, 'GIT_OBJECT_INVALID', 'A Git tree has an unsupported file mode.');
      const blob = mode === 'gitlink' ? record.gitlinks?.[path] : alias(entry.oid);
      invariant(blob, 'SOURCE_UNAVAILABLE', 'A Git object has no Forge source identity.');
      files.push({ path, blob, mode });
    }
  };
  walk(record.tree, '');
  const bytes = Buffer.from(manifestJson(record, sortFiles(files)));
  invariant(
    digest(bytes) === record.state,
    'SOURCE_DIGEST_MISMATCH',
    'The converted State does not reproduce its identity.',
  );
  parseNativeState(bytes);
  return bytes;
}
function* treeEntries(bytes: Buffer) {
  const text = new TextDecoder('utf-8', { fatal: true });
  for (let at = 0; at < bytes.length;) {
    const space = bytes.indexOf(0x20, at),
      nul = bytes.indexOf(0, space + 1);
    invariant(
      space > at && nul > space + 1 && nul + 21 <= bytes.length,
      'GIT_OBJECT_INVALID',
      'A Git tree is truncated.',
    );
    yield {
      mode: bytes.subarray(at, space).toString('latin1'),
      name: text.decode(bytes.subarray(space + 1, nul)),
      oid: bytes.subarray(nul + 1, nul + 21).toString('hex'),
    };
    at = nul + 21;
  }
}

/** The deterministic export commit for a State: its tree, the export commits of
 * its parents in order, its `at` time, and a Forge-State trailer. */
export function stateCommit(record: StateGitRecord, parentCommits: string[]) {
  const parents = record.fields.parents as string[];
  invariant(
    parentCommits.length === parents.length,
    'SOURCE_UNAVAILABLE',
    'Every parent State needs its export commit.',
  );
  const seconds = Math.floor(Date.parse(String(record.fields.at)) / 1000);
  invariant(Number.isSafeInteger(seconds), 'INVALID_NATIVE_SOURCE', 'The State time is invalid.');
  const person = `Forge <forge@forge.invalid> ${seconds} +0000`,
    message = String(record.fields.message).replace(/\n+$/, '');
  const bytes = Buffer.from(
    [
      `tree ${record.tree}\n`,
      ...parentCommits.map(parent => `parent ${parent}\n`),
      `author ${person}\ncommitter ${person}\n\n`,
      message ? `${message}\n\n` : '',
      `Forge-State: ${record.state}\n`,
    ].join(''),
  );
  return { oid: gitObjectId('commit', bytes), object: { type: 'commit', bytes } as GitObject };
}
