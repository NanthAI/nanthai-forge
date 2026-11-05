// SPDX-License-Identifier: Apache-2.0
import type { NativeFile } from './native-state-format.js';
import { mergeNativeText, type NativeTextResolution } from './native-text-merge.js';
import { syntaxCheckedPath, syntaxConflictReason } from './native-merge-syntax.js';
import type { LazyMergeSource } from './hosted-merge-reader.js';

type Merged = { path: string; key: string; left: NativeFile; right: NativeFile; blob: string };

/** Fixed-worker composition. Native text merging is synchronous, so each text
 * merge is recorded, the merged JS/TS files are parsed afterwards, and a merge
 * whose result fails to parse although both sides parse is run again with that
 * file reported as a conflict. The journaled hosted path decides the same thing
 * inside its byte calculation (hosted-source-merge-journal), so both paths
 * retain the same conflicts and reasons. A source that journals its own merges
 * is left untouched. */
export async function syntaxGatedMerge<T>(
  source: LazyMergeSource,
  calculate: <R>(action: () => R) => Promise<R>,
  action: () => T,
): Promise<T> {
  if (source.mergeContent) return calculate(action);
  const merges = new Map<string, Merged>(),
    blocked = new Set<string>(),
    reasons = new Map<string, string>();
  const install = () => {
    source.mergeConflictReason = path => reasons.get(path);
    source.mergeContent = (base, left, right, options, resolved) => {
      const key = `${left.blob}:${right.blob}:${base.blob}`;
      if (blocked.has(key)) return null;
      const notes: NativeTextResolution[] = [];
      const bytes = mergeNativeText(
        source.object(base.blob),
        source.object(left.blob),
        source.object(right.blob),
        left.path,
        { ...options, resolutions: notes },
      );
      if (!bytes) return null;
      const blob = source.put(bytes);
      resolved.push(...notes.map(item => ({ ...item, path: left.path })));
      if (syntaxCheckedPath(left.path)) merges.set(key, { path: left.path, key, left, right, blob });
      return blob;
    };
  };
  const uninstall = () => {
    delete source.mergeContent;
    delete source.mergeConflictReason;
  };
  const before = new Set(source.generated);
  install();
  let result: T;
  try {
    result = await calculate(action);
  } finally {
    uninstall();
  }
  const checked: { key: string; path: string; reason: string }[] = [];
  for (const merge of merges.values()) {
    const [merged, left, right] = await Promise.all(
      [merge.blob, merge.left.blob, merge.right.blob].map(id => calculate(() => source.object(id))),
    );
    const reason = await syntaxConflictReason(merge.path, merged!, left!, right!);
    if (reason) checked.push({ key: merge.key, path: merge.path, reason });
  }
  if (!checked.length) return result;
  for (const item of checked) {
    blocked.add(item.key);
    reasons.set(item.path, item.reason);
  }
  // Drop what the discarded run generated; the second run regenerates what it needs.
  for (const id of [...source.generated]) if (!before.has(id)) source.generated.delete(id);
  install();
  try {
    return await calculate(action);
  } finally {
    uninstall();
  }
}
