import { gitlinkCommit } from './gitlink.js';
import type { Conversation } from './agent-edit-context.js';
// SPDX-License-Identifier: Apache-2.0
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { nativePaths } from './source-paths.js';
import { forgeCachePath } from './forge-cache-paths.js';
export { nativePaths } from './source-paths.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { digest } from './hash.js';
import { readSource, sourceRealpath as realpathSync } from './files.js';
import { invariant } from './errors.js';
import {
  mergeNativeFiles,
  nativeMergeMessage,
  type NativeMergeOptions,
  type NativeMergeResolution,
  type NativeMergeConflict,
} from './native-merge.js';
import { diskGuard } from './disk-guard.js';
import { nativeFile } from './native-file.js';
import { NativeWorkspaceFiles } from './native-workspace-files.js';
import { cloneLaneTree } from './native-lane-cache.js';
import { writeRecoveryState } from './recovery-state.js';
import { syncDirectory, syncFile } from './native-durability.js';
import { NativeAncestry } from './native-ancestry.js';

import {
  stateSchema,
  oid,
  gitImport,
  overlappingPaths,
  parseNativeState,
  type NativeFile,
  type NativeState,
} from './native-state-format.js';
export {
  stateSchema,
  overlappingPaths,
  parseNativeState,
  type NativeFile,
  type NativeState,
} from './native-state-format.js';
const markerSchema = z
  .object({ schema: z.literal(1), kind: z.literal('forge-native'), owner: z.string() })
  .strict();
export function nativeOwner(root: string): string | null {
  const bytes = readSource(root, '.forge/native.json', 4096);
  if (!bytes) return null;
  const marker = markerSchema.parse(JSON.parse(bytes.toString('utf8')));
  const owner = realpathSync(resolve(root, marker.owner));
  invariant(
    owner === root || root.startsWith(join(owner, '.forge', 'work') + '/'),
    'INVALID_NATIVE_SOURCE',
    'Native workspace must belong to its retained Work owner.',
  );
  if (owner !== root)
    invariant(nativeOwner(owner) === owner, 'INVALID_NATIVE_SOURCE', 'Native owner is unavailable.');
  return owner;
}
export function nativeMarker(root: string, owner = root, publishedRoot?: string) {
  root = realpathSync(root);
  owner = realpathSync(owner);
  const path = join(root, '.forge');
  mkdirSync(path, { recursive: true, mode: 0o700 });
  invariant(!lstatSync(path).isSymbolicLink(), 'UNSAFE_PATH', 'Native metadata directory must be real.');
  writeFileSync(
    join(path, 'native.json'),
    JSON.stringify({
      schema: 1,
      kind: 'forge-native',
      owner: relative(publishedRoot ? resolve(publishedRoot) : root, owner) || '.',
    }),
    { flag: 'wx', mode: 0o600 },
  );
}
export type NativeCaptureCoverage = {
  included: number;
  excludedCount: number;
  excluded: { path: string; reason: string }[];
};
export const nativeSourceTestHooks: {
  beforePublish?: (path: string) => void;
  afterPublish?: (path: string) => void;
  afterRename?: (path: string) => void;
} = {};
export class NativeSource {
  /** Hosted execution journals these byte calculations between bounded actions. */
  mergeConflictReason?: (path: string) => string | undefined;
  resolvedContent?: (file: NativeFile) => void;
  mergeContent?: (
    base: NativeFile,
    left: NativeFile,
    right: NativeFile,
    options: NativeMergeOptions,
    resolutions: NativeMergeResolution[],
  ) => string | null;
  conflictContent?: (
    item: NativeMergeConflict,
    channel: string,
  ) => { file?: NativeFile; kind: 'text' | 'binary' };
  private batchingObjects = false;
  readonly directory: string;
  readonly owner: string;
  constructor(owner: string | null) {
    this.owner = owner === null ? '' : realpathSync(owner);
    this.directory = join(this.owner, '.forge', 'work', 'objects');
  }
  object(id: string): Buffer {
    invariant(oid.safeParse(id).success, 'INVALID_NATIVE_SOURCE', 'Select an exact native object identity.');
    invariant(
      existsSync(this.directory) && realpathSync(this.directory) === this.directory,
      'INVALID_NATIVE_SOURCE',
      'Native object storage is unavailable or redirected.',
    );
    const bytes = readSource(this.directory, id, Number.MAX_SAFE_INTEGER, id);
    invariant(
      bytes && digest(bytes) === id,
      'INVALID_NATIVE_SOURCE',
      'Native object is absent or changed; original work is retained.',
    );
    return bytes;
  }
  put(bytes: Buffer): string {
    for (const part of ['.forge', '.forge/work', '.forge/work/objects']) {
      const path = join(this.owner, part);
      if (existsSync(path))
        invariant(
          lstatSync(path).isDirectory() && !lstatSync(path).isSymbolicLink(),
          'UNSAFE_PATH',
          'Native metadata must use real directories.',
        );
      else {
        mkdirSync(path, { mode: 0o700 });
        syncDirectory(dirname(path));
      }
    }
    invariant(
      !lstatSync(this.directory).isSymbolicLink(),
      'UNSAFE_PATH',
      'Native objects must use a real directory.',
    );
    const id = digest(bytes),
      path = join(this.directory, id);
    if (existsSync(path)) {
      invariant(this.object(id).equals(bytes), 'INVALID_NATIVE_SOURCE', 'An original object changed.');
      if (!this.batchingObjects) syncDirectory(this.directory);
      return id;
    }
    const temp = join(this.directory, `${randomUUID()}.tmp`),
      fd = openSync(temp, 'wx', 0o600);
    try {
      writeFileSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      if (existsSync(path))
        invariant(
          this.object(id).equals(bytes),
          'INVALID_NATIVE_SOURCE',
          'Concurrent native object changed.',
        );
      else renameSync(temp, path);
      if (!this.batchingObjects) syncDirectory(this.directory);
    } finally {
      if (existsSync(temp)) unlinkSync(temp);
    }
    return id;
  }
  state(id: string): NativeState {
    return parseNativeState(this.object(id));
  }
  writeState(
    files: NativeFile[],
    parents: string[],
    message: string,
    at: string,
    git?: z.infer<typeof gitImport>,
    conversation?: Conversation,
  ): string {
    for (const parent of parents) this.state(parent);
    const bytes = Buffer.from(
      JSON.stringify(
        stateSchema.parse({
          schema: 1,
          kind: 'forge-source-state',
          parents,
          files: [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
          message,
          at,
          ...(git ? { git } : {}),
          ...(conversation ? { conversation } : {}),
        }),
      ),
    );
    const id = this.put(bytes);
    this.state(id);
    return id;
  }
  capture(root: string, retain = false, base?: string): NativeFile[] {
    return this.captureReport(root, retain, base).files;
  }
  captureReport(
    root: string,
    retain = false,
    base?: string,
  ): { files: NativeFile[]; coverage: NativeCaptureCoverage } {
    const previous = this.batchingObjects;
    this.batchingObjects = retain || previous;
    try {
      return this.captureFiles(root, retain, base);
    } finally {
      this.batchingObjects = previous;
      if (retain && !previous && existsSync(this.directory)) syncDirectory(this.directory);
    }
  }
  private captureFiles(
    root: string,
    retain: boolean,
    base?: string,
  ): { files: NativeFile[]; coverage: NativeCaptureCoverage } {
    root = realpathSync(root);
    const baseline = base ? this.state(base).files : [];
    const baselineModes = new Map(baseline.map(file => [file.path, file.mode]));
    const excluded: { path: string; reason: string }[] = [];
    const files: NativeFile[] = nativePaths(
      root,
      baseline.map(file => file.path),
      excluded,
    ).map(path => {
      const observed = nativeFile(root, path);
      const { bytes } = observed;
      const mode =
        baselineModes.get(path) === 'gitlink' && observed.mode === 'file' ? 'gitlink' : observed.mode;
      if (mode === 'gitlink') gitlinkCommit(bytes);
      return {
        path,
        blob: retain ? this.put(bytes) : digest(bytes),
        mode,
      };
    });
    // Ignore legacy cache bytes and their removal without turning migration
    // into a deletion on main. Retained historical source stays immutable.
    files.push(...baseline.filter(file => forgeCachePath(file.path)));
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return {
      files,
      coverage: { included: files.length, excludedCount: excluded.length, excluded: excluded.slice(0, 100) },
    };
  }
  tree(files: NativeFile[]): string {
    return digest(JSON.stringify(files));
  }
  protected withMaterialization<T>(action: (files: NativeWorkspaceFiles) => T): T {
    const files = new NativeWorkspaceFiles(this.directory, id => this.object(id));
    try {
      return action(files);
    } finally {
      files.dispose();
    }
  }
  materialize(id: string, destination: string, marker = true) {
    const present = (path: string) => {
      try {
        lstatSync(path);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
    };
    invariant(
      !present(destination),
      'RESTORE_TARGET_EXISTS',
      'Native materialization requires a new directory; existing files are retained.',
    );
    const kind = relative(join(this.owner, '.forge', 'work'), resolve(destination));
    const warnings = /^(?:lane-[0-9a-f-]{36}|check-[0-9a-f-]{36}[\/\\]workspace)$/.test(kind)
      ? diskGuard(this.owner)
      : [];
    const published = destination,
      staged = /^lane-[0-9a-f-]{36}$/.test(basename(destination));
    let stageRoot: string | undefined;
    if (staged) {
      stageRoot = join(dirname(destination), `.lane-stage-${basename(destination)}-${randomUUID()}`);
      mkdirSync(stageRoot, { mode: 0o700 });
      destination = join(stageRoot, 'workspace');
    }
    this.withMaterialization(files => {
      const clone = staged ? cloneLaneTree(this, id, destination) : undefined;
      if (!clone) {
        const state = this.state(id);
        for (const file of state.files) files.prepare(file.blob);
        mkdirSync(destination, { recursive: true, mode: 0o700 });
        for (const file of state.files) {
          const path = join(destination, file.path);
          mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
          files.write(file.blob, path, file.mode);
        }
      }
      if (marker) nativeMarker(destination, this.owner, staged ? published : undefined);
      if (clone && marker)
        writeRecoveryState(join(destination, '.forge/materialization.json'), {
          schema: 1,
          head: id,
          ...clone,
        });
      const flush = (directory: string) => {
        for (const name of readdirSync(directory)) {
          const path = join(directory, name);
          if (lstatSync(path).isDirectory()) flush(path);
          // A reflink's source bytes were flushed once in the verified cache.
          // Persist its new directory entries and marker; ordinary copy fallback
          // still flushes every newly written file. Work retains the exact head
          // for rematerialization even if a derived clone is lost on restart.
          else if (
            !lstatSync(path).isSymbolicLink() &&
            (clone?.method !== 'clone' || path.startsWith(join(destination, '.forge') + '/'))
          )
            syncFile(path);
        }
        syncDirectory(directory);
      };
      if (staged) {
        flush(destination);
        nativeSourceTestHooks.beforePublish?.(destination);
        invariant(!present(published), 'RESTORE_TARGET_EXISTS', 'Existing workspace is retained.');
        renameSync(destination, published);
        nativeSourceTestHooks.afterRename?.(published);
        syncDirectory(dirname(published));
        nativeSourceTestHooks.afterPublish?.(published);
        // A failed/interrupted stage remains inspectable. Remove only our empty
        // container after successful publication, never any possible edits.
        if (stageRoot && readdirSync(stageRoot).length === 0) rmdirSync(stageRoot);
      }
    });
    return warnings;
  }
  /** Fresh scope: verified parent information is reused only within this operation. */
  ancestry(): NativeAncestry {
    return new NativeAncestry(id => this.state(id).parents);
  }
  contains(head: string, ancestor: string): boolean {
    return this.ancestry().contains(head, ancestor);
  }
  ancestors(id: string): Set<string> {
    return this.ancestry().ancestors(id);
  }
  compose(
    left: string,
    right: string,
    message: string,
    at: string,
    options: NativeMergeOptions = {},
  ): { head?: string; conflicts: string[]; resolutions?: NativeMergeResolution[] } {
    const ancestry = this.ancestry();
    if (ancestry.contains(left, right)) return { head: left, conflicts: [] };
    if (ancestry.contains(right, left)) return { head: right, conflicts: [] };
    const a = ancestry.ancestors(left),
      b = ancestry.ancestors(right);
    const merged = this.mergeFiles(left, right, a, b, ancestry, options),
      conflicts = merged.conflicts.map(item => item.path);
    conflicts.push(...overlappingPaths(merged.files));
    if (conflicts.length) return { conflicts };
    const resolutions = merged.resolutions.length ? { resolutions: merged.resolutions } : {};
    return {
      head: this.writeState(merged.files, [left, right], nativeMergeMessage(message, merged.resolutions), at),
      conflicts,
      ...resolutions,
    };
  }
  /** Recursive three-way file merge. Ambiguous virtual-base entries retain their
   * alternatives until the heads agree; unresolved entries are normal conflicts. */
  mergeFiles(
    left: string,
    right: string,
    a?: Set<string>,
    b?: Set<string>,
    ancestry = this.ancestry(),
    options: NativeMergeOptions = {},
  ) {
    return mergeNativeFiles(
      this,
      left,
      right,
      a ?? ancestry.ancestors(left),
      b ?? ancestry.ancestors(right),
      ancestry,
      options,
    );
  }
}
