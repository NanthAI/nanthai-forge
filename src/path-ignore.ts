// SPDX-License-Identifier: Apache-2.0
import { join } from 'node:path';
import { readSource, sourceRealpath } from './files.js';
import { ignoreLayer, ignoreNames, ignoredBy } from './source-ignore.js';

type Layers = ReturnType<typeof ignoreLayer>;

/** "Would capture's ignore rules drop this path?" for one path at a time (a watcher event),
 * with each directory's `.gitignore`/`.forgeignore` read once. Any ignored ancestor ignores the
 * path, as in the capture walk. Call `changed(path)` for every event: an edited ignore file
 * drops the cache. Advisory only; an unreadable ignore file ignores nothing. */
/** `readSource` wants the canonical root; a temp or symlinked path is resolved once. */
export function canonicalRoot(root: string) {
  try {
    return sourceRealpath(root);
  } catch {
    return root;
  }
}

export function pathIgnoreMatcher(rootPath: string) {
  const root = canonicalRoot(rootPath);
  const layers = new Map<string, Layers>();
  const layerAt = (directory: string): Layers => {
    let layer = layers.get(directory);
    if (!layer) {
      layer = ignoreLayer(directory, name => {
        try {
          return readSource(root, join(directory, name), 1024 * 1024)?.toString('utf8');
        } catch {
          return undefined;
        }
      });
      layers.set(directory, layer);
    }
    return layer;
  };
  return {
    ignored(path: string): boolean {
      const parts = path.split('/');
      let active = [...layerAt('')];
      for (let end = 1; end < parts.length; end++) {
        const directory = parts.slice(0, end).join('/');
        if (ignoredBy(active, directory, true)) return true;
        active = [...active, ...layerAt(directory)];
      }
      return !!ignoredBy(active, path);
    },
    changed(path: string) {
      if ((ignoreNames as readonly string[]).includes(path.split('/').at(-1) ?? '')) layers.clear();
    },
  };
}
