// SPDX-License-Identifier: Apache-2.0
import { overlappingPaths, type NativeFile, type NativeSource } from './native-source.js';
import { markNativeTextConflicts, wholeFileConflict } from './native-text-merge.js';
import type { SyncTarget as Target } from './native-sync-workspace.js';
import type { Lane } from './work-types.js';
// Kept apart from agent-sync.ts: the hosted source worker imports this, and agent-sync's own
// imports (local workspace, records, GitHub, checks) must stay out of the worker bundle.
type Conflict = NonNullable<Lane['pendingMerge']>['conflicts'][number];
/** Working files for a conflicted merge of `right` into `left`: merged files, marker hunks for
 * text, the left version otherwise. `labels` name the side each hunk half holds, left first:
 * a Lane sync is ['lane', channel]; a landing resolution merges the Lane into main, ['main', 'lane']. */
export function conflictPlan(
  source: NativeSource,
  laneHead: string,
  target: string,
  labels: [left: string, right: string],
  base?: string,
) {
  const merged = source.mergeFiles(
      laneHead,
      target,
      base ? new Set([base]) : undefined,
      base ? new Set([base]) : undefined,
      undefined,
      {
        insertionOrder: 'right-first',
      },
    ),
    files: Target[] = [...merged.files],
    conflicts: Conflict[] = [];
  const empty = Buffer.alloc(0),
    read = (file?: NativeFile) => (file ? source.object(file.blob) : empty);
  for (const item of merged.conflicts) {
    if ([item.base, item.left, item.right].some(file => file?.mode === 'gitlink')) {
      if (item.left) files.push(item.left);
      conflicts.push({ path: item.path, kind: 'binary' });
      continue;
    }
    if (source.conflictContent) {
      const result = source.conflictContent(item, labels);
      if (result.file) files.push(result.file);
      conflicts.push({ path: item.path, kind: result.kind });
      continue;
    }
    const left = read(item.left),
      right = read(item.right),
      marked = markNativeTextConflicts(read(item.base), left, right, labels, 'right-first');
    if (!marked) {
      if (item.left) files.push(item.left);
      conflicts.push({ path: item.path, kind: 'binary' });
      continue;
    }
    // Markers keep the file's line ending (d36380ca); text input always yields bytes here.
    const bytes = marked.conflicted ? marked.bytes : wholeFileConflict(left, right, labels)!;
    files.push({ path: item.path, mode: item.left?.mode ?? item.right?.mode ?? 'file', bytes });
    conflicts.push({ path: item.path, kind: 'text' });
  }
  // A file/directory clash keeps the left side of that subtree (the Lane's, in a sync).
  const lane = source.state(laneHead).files;
  let result = files;
  for (const path of overlappingPaths(files as NativeFile[])) {
    const inside = (file: { path: string }) => file.path === path || file.path.startsWith(path + '/');
    result = [...result.filter(file => !inside(file)), ...lane.filter(inside)];
    conflicts.push({ path, kind: 'binary' });
  }
  return {
    files: result.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    conflicts: conflicts.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  };
}
