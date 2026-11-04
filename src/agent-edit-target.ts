// SPDX-License-Identifier: Apache-2.0
import { existsSync, openSync, readSync, closeSync, realpathSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

export type EditTarget = { root: string; laneId: string; path: string; project: string; url?: string };
export function canonicalEditPath(path: string): string {
  try {
    return realpathSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(path) === path) throw error;
    return join(canonicalEditPath(dirname(path)), basename(path));
  }
}
/** Resolve from the edited file, including new files and symlinked checkout parents. */
export function editTarget(path: string): EditTarget | null {
  const absolute = canonicalEditPath(resolve(path));
  for (let root = dirname(absolute); ; root = dirname(root)) {
    const marker = join(root, '.forge', 'hosted-lane.json');
    if (existsSync(marker)) {
      const value = readEditMarkerIdentity(marker);
      const { laneId, projectId } = value.selection ?? {};
      if (
        value.kind !== 'forge-hosted-lane-checkout' ||
        typeof laneId !== 'string' ||
        typeof projectId !== 'string' ||
        typeof value.url !== 'string'
      )
        throw new Error('Invalid Lane');
      return {
        root,
        laneId,
        project: projectId,
        url: value.url,
        path: relative(root, absolute).split(sep).join('/'),
      };
    }
    if (
      /^lane-[a-f0-9-]{36}$/.test(basename(root)) &&
      basename(dirname(root)) === 'work' &&
      basename(dirname(dirname(root))) === '.forge'
    ) {
      const owner = dirname(dirname(dirname(root)));
      return {
        root: owner,
        laneId: basename(root).slice(5),
        project: owner,
        path: relative(root, absolute).split(sep).join('/'),
      };
    }
    if (dirname(root) === root) return null;
  }
}

export function readEditMarkerIdentity(marker: string) {
  // The generated marker puts selection before state. Read only its identity prefix,
  // never the embedded repository manifest (29k+ files on large projects).
  const fd = openSync(marker, 'r');
  let text: string;
  try {
    const bytes = Buffer.alloc(64 * 1024);
    text = bytes.subarray(0, readSync(fd, bytes)).toString('utf8');
  } finally {
    closeSync(fd);
  }
  let depth = 0,
    quoted = false,
    escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') depth--;
    else if (ch === ',' && depth === 1 && /^,\s*"state"\s*:/.test(text.slice(i, i + 32)))
      return JSON.parse(text.slice(0, i) + '}');
  }
  return JSON.parse(text);
}
