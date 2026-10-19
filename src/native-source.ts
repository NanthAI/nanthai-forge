// SPDX-License-Identifier: Apache-2.0
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import ignore from 'ignore';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { digest } from './hash.js';
import { exclusion, readSource, safeRelative, sourceRealpath as realpathSync } from './files.js';
import { sourceLanguage } from './languages.js';
import { invariant } from './errors.js';
import { mergeNativeFiles } from './native-merge.js';
import { diskGuard } from './disk-guard.js';
import { nativeFile } from './native-file.js';
import { NativeWorkspaceFiles } from './native-workspace-files.js';
import { syncDirectory, syncFile } from './native-durability.js';
import { NativeAncestry } from './native-ancestry.js';

const oid = z.string().regex(/^[0-9a-f]{64}$/);
const gitImport = z
  .object({
    bundle: oid,
    commit: z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/),
    format: z.enum(['sha1', 'sha256']),
  })
  .strict();
const entry = z
  .object({
    path: z.string().refine(safeRelative),
    blob: oid,
    mode: z.enum(['file', 'executable', 'symlink']),
  })
  .strict();
export const stateSchema = z
  .object({
    schema: z.literal(1),
    kind: z.literal('forge-source-state'),
    parents: z.array(oid),
    files: z.array(entry),
    message: z.string(),
    at: z.string(),
    git: gitImport.optional(),
  })
  .strict();
export type NativeFile = z.infer<typeof entry>;
export type NativeState = z.infer<typeof stateSchema>;
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
export function nativeMarker(root: string, owner = root) {
  root = realpathSync(root);
  owner = realpathSync(owner);
  const path = join(root, '.forge');
  mkdirSync(path, { recursive: true, mode: 0o700 });
  invariant(!lstatSync(path).isSymbolicLink(), 'UNSAFE_PATH', 'Native metadata directory must be real.');
  writeFileSync(
    join(path, 'native.json'),
    JSON.stringify({ schema: 1, kind: 'forge-native', owner: relative(root, owner) || '.' }),
    { flag: 'wx', mode: 0o600 },
  );
}
export type NativeCaptureCoverage = {
  included: number;
  excludedCount: number;
  excluded: { path: string; reason: string }[];
};
export function nativePaths(
  root: string,
  retained: string[] = [],
  excluded?: { path: string; reason: string }[],
  scope?: string[],
  visitDirectory?: (path: string) => void,
): string[] {
  const paths: string[] = [];
  const retainedFiles = new Set(retained),
    retainedDirectories = new Set<string>();
  for (const file of retainedFiles)
    for (let index = file.indexOf('/'); index !== -1; index = file.indexOf('/', index + 1))
      retainedDirectories.add(file.slice(0, index));
  function walk(dir: string, patterns: { rule: ReturnType<typeof ignore>; dir: string }[]) {
    visitDirectory?.(dir);
    const bytes = readSource(root, join(dir, '.gitignore'), 1024 * 1024);
    const next = bytes
      ? [
          ...patterns,
          ...bytes
            .toString('utf8')
            .split(/\r?\n/)
            .filter(Boolean)
            .map(line => ({ rule: ignore().add(line), dir })),
        ]
      : patterns;
    const rules = next;
    for (const name of readdirSync(join(root, dir)).sort()) {
      const path = dir ? `${dir}/${name}` : name;
      if (
        scope &&
        !scope.some(item => item === path || item.startsWith(path + '/') || path.startsWith(item + '/'))
      )
        continue;
      invariant(safeRelative(path), 'UNSAFE_PATH', 'Native source paths must be portable relative paths.');
      const selected = retainedFiles.has(path),
        descendant = retainedDirectories.has(path);
      const stat = lstatSync(join(root, path));
      // Analysis name heuristics must not drop source modules such as secrets.ts.
      // Keep credential/config exclusions and explicit ignore rules unchanged.
      const sourceName =
        !stat.isDirectory() && /^(credentials?|secrets?)[.-]/i.test(name) && sourceLanguage(path);
      const reason = sourceName && exclusion(path) === 'sensitive-name' ? null : exclusion(path);
      if (reason && !selected && !descendant) {
        excluded?.push({ path, reason });
        continue;
      }
      let ignored = false;
      for (const rule of rules) {
        const local = rule.dir ? path.slice(rule.dir.length + 1) : path;
        const result = rule.rule.test(local + (stat.isDirectory() ? '/' : ''));
        if (result.ignored) ignored = true;
        if (result.unignored) ignored = false;
      }
      if (ignored && !selected && !descendant) {
        excluded?.push({ path, reason: 'gitignored' });
        continue;
      }
      invariant(
        stat.isDirectory() || stat.isSymbolicLink() || (stat.isFile() && stat.nlink === 1),
        'UNSUPPORTED_NATIVE_FILE',
        `Native source cannot capture this special or linked path: ${path}. Original files are preserved.`,
      );
      if (stat.isDirectory()) walk(path, next);
      else paths.push(path);
    }
  }
  walk('', []);
  return paths.sort();
}
export function overlappingPaths(files: NativeFile[]): string[] {
  const paths = new Set(files.map(file => file.path)),
    conflicts = new Set<string>();
  for (const path of paths) {
    const parts = path.split('/');
    for (let index = 1; index < parts.length; index++) {
      const parent = parts.slice(0, index).join('/');
      if (paths.has(parent)) conflicts.add(parent);
    }
  }
  return [...conflicts].sort();
}
export function parseNativeState(bytes: Buffer): NativeState {
  const state = stateSchema.parse(JSON.parse(bytes.toString('utf8')));
  invariant(
    new Set(state.files.map(file => file.path)).size === state.files.length &&
      state.files.every(
        file =>
          !file.path.toLowerCase().split('/').includes('.forge') &&
          !file.path.toLowerCase().split('/').includes('.git'),
      ),
    'INVALID_NATIVE_SOURCE',
    'Native source manifest paths are invalid.',
  );
  invariant(
    overlappingPaths(state.files).length === 0,
    'INVALID_NATIVE_SOURCE',
    'Source file and directory paths overlap.',
  );
  return state;
}
export const nativeSourceTestHooks: {
  beforePublish?: (path: string) => void;
  afterPublish?: (path: string) => void;
  afterRename?: (path: string) => void;
} = {};
export class NativeSource {
  private batchingObjects = false;
  readonly directory: string;
  readonly owner: string;
  constructor(owner: string) {
    this.owner = realpathSync(owner);
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
    const excluded: { path: string; reason: string }[] = [];
    const files: NativeFile[] = nativePaths(
      root,
      base ? this.state(base).files.map(file => file.path) : [],
      excluded,
    ).map(path => {
      const { bytes, mode } = nativeFile(root, path);
      return {
        path,
        blob: retain ? this.put(bytes) : digest(bytes),
        mode,
      };
    });
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
    if (staged)
      destination = join(dirname(destination), `.lane-stage-${basename(destination)}-${randomUUID()}`);
    this.withMaterialization(files => {
      const state = this.state(id);
      for (const file of state.files) files.prepare(file.blob);
      mkdirSync(destination, { recursive: true, mode: 0o700 });
      for (const file of state.files) {
        const path = join(destination, file.path);
        mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
        files.write(file.blob, path, file.mode);
      }
      if (marker) nativeMarker(destination, this.owner);
      const flush = (directory: string) => {
        for (const name of readdirSync(directory)) {
          const path = join(directory, name);
          if (lstatSync(path).isDirectory()) flush(path);
          else if (!lstatSync(path).isSymbolicLink()) syncFile(path);
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
  compose(left: string, right: string, message: string, at: string) {
    const ancestry = this.ancestry();
    if (ancestry.contains(left, right)) return { head: left, conflicts: [] };
    if (ancestry.contains(right, left)) return { head: right, conflicts: [] };
    const a = ancestry.ancestors(left),
      b = ancestry.ancestors(right);
    const merged = this.mergeFiles(left, right, a, b, ancestry),
      conflicts = merged.conflicts.map(item => item.path);
    conflicts.push(...overlappingPaths(merged.files));
    return conflicts.length
      ? { conflicts }
      : { head: this.writeState(merged.files, [left, right], message, at), conflicts };
  }
  /** Recursive three-way file merge. Ambiguous virtual-base entries retain their
   * alternatives until the heads agree; unresolved entries are normal conflicts. */
  mergeFiles(left: string, right: string, a?: Set<string>, b?: Set<string>, ancestry = this.ancestry()) {
    return mergeNativeFiles(
      this,
      left,
      right,
      a ?? ancestry.ancestors(left),
      b ?? ancestry.ancestors(right),
      ancestry,
    );
  }
}
