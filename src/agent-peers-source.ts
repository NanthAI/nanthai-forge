// SPDX-License-Identifier: Apache-2.0
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { NativeSource, nativeOwner, nativePaths, type NativeState } from './native-source.js';
import { nativeFile } from './native-file.js';
import { NativeAncestry } from './native-ancestry.js';
import { createHash } from 'node:crypto';
import { digest } from './hash.js';
import { pathsOverlap } from './coordination-paths.js';
import { workGit } from './work-git.js';
import { PeersCache, peersFileStamp } from './agent-peers-cache.js';
import { invariant } from './errors.js';
import type { WorkStore } from './work-store.js';
import type { Lane } from './work-types.js';

/** Per-read overlay: even text merge's put() stays in memory. Never publishes objects. */
export class PeersSource extends NativeSource {
  private readonly scopedFiles = new Map<string, NativeState['files']>();
  private readonly liveObjects = new Map<string, { root: string; path: string }>();
  private readonly cache: PeersCache;
  private readonly memory = new Map<string, Buffer>();
  private readonly states = new Map<string, NativeState>();
  constructor(
    private readonly store: WorkStore,
    private readonly boundary: string,
  ) {
    super(store.root);
    this.cache = new PeersCache(store.root);
    if (store.native)
      invariant(
        realpathSync(this.directory) === this.directory,
        'INVALID_NATIVE_SOURCE',
        'Native object storage is redirected.',
      );
  }
  override ancestry() {
    return new NativeAncestry(id => (id === this.boundary ? [] : this.state(id).parents));
  }
  override put(bytes: Buffer) {
    const id = digest(bytes);
    this.memory.set(id, bytes);
    return id;
  }
  override object(id: string): Buffer {
    const live = this.liveObjects.get(id);
    if (live) {
      const bytes = nativeFile(live.root, live.path).bytes;
      invariant(digest(bytes) === id, 'SOURCE_CHANGED', 'Peer source changed during observation.');
      return bytes;
    }
    return (
      this.memory.get(id) ??
      (this.store.native
        ? super.object(id)
        : workGit(this.store.root, ['cat-file', 'blob', id], undefined, false, true))
    );
  }
  override state(id: string): NativeState {
    let state = this.states.get(id);
    if (state) return state;
    if (this.memory.has(id) || this.store.native) {
      const key = `state-v1:${id}`;
      const stamp =
        this.store.native && !this.memory.has(id) ? peersFileStamp(join(this.directory, id)) : undefined;
      const prior = stamp ? this.cache.read<{ stamp: string; state: NativeState }>(key) : undefined;
      state = prior && prior.stamp === stamp ? prior.state : super.state(id);
      if (stamp && prior?.stamp !== stamp && stamp === peersFileStamp(join(this.directory, id)))
        this.cache.write(key, { stamp, state });
    } else {
      const parents = workGit(this.store.root, ['rev-list', '--parents', '-n', '1', id])
        .trim()
        .split(' ')
        .slice(1);
      const files = workGit(this.store.root, ['ls-tree', '-r', '-z', id])
        .split('\0')
        .filter(Boolean)
        .map(row => {
          const split = row.indexOf('\t'),
            [mode, kind, blob] = row.slice(0, split).split(' ');
          invariant(kind === 'blob', 'UNSUPPORTED', 'Peer source contains a Git submodule.');
          return {
            path: row.slice(split + 1),
            blob: blob!,
            mode:
              mode === '120000'
                ? ('symlink' as const)
                : mode === '100755'
                  ? ('executable' as const)
                  : ('file' as const),
          };
        });
      const metadata = workGit(this.store.root, ['show', '-s', '--format=%B%x00%aI', id]).split('\0');
      state = {
        schema: 1,
        kind: 'forge-source-state',
        parents,
        files,
        message: metadata[0]?.trimEnd() ?? '',
        at: metadata[1]?.trim() ?? '',
      };
    }
    this.states.set(id, state);
    return state;
  }
  override writeState(files: NativeState['files'], parents: string[], message: string, at: string) {
    const state: NativeState = { schema: 1, kind: 'forge-source-state', files, parents, message, at };
    const id = digest(JSON.stringify(state));
    this.states.set(id, state);
    return id;
  }
  files(id: string, scope?: string[]) {
    if (!scope || !this.store.native)
      return this.state(id).files.filter(file => !scope || scope.some(item => pathsOverlap(file.path, item)));
    const key = `scope-v1:${id}:${JSON.stringify(scope)}`;
    const known = this.scopedFiles.get(key);
    if (known) return known;
    const stamp = peersFileStamp(join(this.directory, id));
    const prior = this.cache.read<{ stamp: string; files: NativeState['files'] }>(key);
    if (prior?.stamp === stamp) {
      this.scopedFiles.set(key, prior.files);
      return prior.files;
    }
    const files = this.state(id).files.filter(file => scope.some(item => pathsOverlap(file.path, item)));
    if (stamp === peersFileStamp(join(this.directory, id))) this.cache.write(key, { stamp, files });
    this.scopedFiles.set(key, files);
    return files;
  }
  /** Capture all of my source, but only potentially overlapping live files in peers.
   * Other peer files cannot affect path relevance. Missing cleaned workspaces use saved source. */
  live(lane: Lane, scope?: string[]) {
    const path = this.store.path(lane.id),
      saved = this.files(lane.head, scope);
    if (!existsSync(path)) {
      invariant(
        lane.state === 'completed' || lane.state === 'abandoned',
        'LANE_UNAVAILABLE',
        'Open peer workspace is unavailable.',
      );
      return saved;
    }
    invariant(
      !lstatSync(path).isSymbolicLink() && realpathSync(path) === path,
      'LANE_UNAVAILABLE',
      'Peer Lane is redirected.',
    );
    if (this.store.native)
      invariant(nativeOwner(path) === this.store.root, 'LANE_UNAVAILABLE', 'Peer Lane owner differs.');
    const retained = new Set(saved.map(file => file.path));
    let paths: string[];
    if (!this.store.native) {
      paths = workGit(path, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])
        .split('\0')
        .filter(Boolean);
    } else if (
      !scope ||
      scope.some(item => {
        try {
          return lstatSync(join(path, item)).isDirectory() || !retained.has(item);
        } catch {
          return false;
        }
      })
    ) {
      const key = `paths-v2:${lane.id}:${lane.head}:${JSON.stringify(scope)}`;
      type Paths = { paths: string[]; stamps: [string, string][] };
      // A start/checkpoint observation may already have indexed this exact
      // retained path set without scope. Filtering that fresh inventory is safe
      // and avoids rebuilding every peer inventory on the first scoped read.
      const fullKey = `paths-v2:${lane.id}:${lane.head}:undefined`;
      const prior = this.cache.read<Paths>(key) ?? (scope ? this.cache.read<Paths>(fullKey) : undefined);
      const stamp = (file: string) => {
        try {
          return peersFileStamp(join(path, file));
        } catch {
          return 'absent';
        }
      };
      if (
        prior &&
        Array.isArray(prior.paths) &&
        Array.isArray(prior.stamps) &&
        prior.stamps.every(([file, value]) => stamp(file) === value)
      )
        paths = prior.paths;
      else {
        const stamps: [string, string][] = [];
        paths = nativePaths(
          path,
          saved.map(file => file.path),
          undefined,
          scope,
          dir => {
            stamps.push([dir, stamp(dir)], [join(dir, '.gitignore'), stamp(join(dir, '.gitignore'))]);
          },
        );
        this.cache.write(key, { paths, stamps });
      }
    } else paths = [...new Set([...saved.map(file => file.path), ...scope])];
    const cacheKey = `live-v2:${lane.id}`;
    type Entry = { stamp: string; file: NativeState['files'][number] };
    const cached = this.store.native ? this.cache.read<Record<string, Entry>>(cacheKey) : undefined;
    const updated: Record<string, Entry> = Object.create(null);
    let changed = false;
    const parents = new Set<string>();
    const checkParents = (file: string) => {
      let directory = path;
      for (const part of file.split('/').slice(0, -1)) {
        directory = join(directory, part);
        if (parents.has(directory)) continue;
        const stat = lstatSync(directory);
        invariant(
          stat.isDirectory() && !stat.isSymbolicLink(),
          'UNSAFE_PATH',
          'Source parent is redirected.',
        );
        parents.add(directory);
      }
    };
    const selected = (file: string) => !scope || scope.some(item => pathsOverlap(file, item));
    const files = saved.filter(file => !selected(file.path));
    for (const file of [...new Set(paths)].filter(selected).sort()) {
      try {
        if (this.store.native) checkParents(file);
        const stamp = this.store.native ? peersFileStamp(join(path, file)) : '';
        const prior = cached?.[file];
        if (
          prior?.stamp === stamp &&
          prior.file?.path === file &&
          /^[a-f0-9]{64}$/.test(prior.file.blob) &&
          ['file', 'symlink', 'executable'].includes(prior.file.mode)
        ) {
          files.push(prior.file);
          updated[file] = prior;
          this.liveObjects.set(prior.file.blob, { root: path, path: file });
          continue;
        }
        changed = true;
        const { bytes, mode } = nativeFile(path, file);
        const blob = this.store.native
          ? digest(bytes)
          : createHash(lane.head.length === 64 ? 'sha256' : 'sha1')
              .update(`blob ${bytes.length}\0`)
              .update(bytes)
              .digest('hex');
        this.memory.set(blob, bytes);
        files.push({ path: file, mode, blob });
        if (this.store.native && stamp === peersFileStamp(join(path, file)))
          updated[file] = { stamp, file: { path: file, mode, blob } };
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      }
    }
    if (this.store.native && changed) this.cache.write(cacheKey, { ...cached, ...updated });
    return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }
}
