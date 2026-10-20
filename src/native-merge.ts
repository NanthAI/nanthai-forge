// SPDX-License-Identifier: Apache-2.0
import type { NativeFile, NativeSource } from './native-source.js';
import { NativeAncestry } from './native-ancestry.js';
import { invariant } from './errors.js';
import { mergeNativeText } from './native-text-merge.js';

type Variant = NativeFile | undefined;
type Tree = Map<string, Variant[]>;
export type NativeMergeConflict = {
  path: string;
  base?: NativeFile;
  left?: NativeFile;
  right?: NativeFile;
};
const same = (x: Variant, y: Variant) => x === y || (!!x && !!y && x.blob === y.blob && x.mode === y.mode);
const unique = (items: Variant[]) => items.filter((item, i) => !items.slice(0, i).some(x => same(x, item)));

/** Virtual bases live only for this operation: no synthetic State or timestamp is persisted. */
export function mergeNativeFiles(
  source: NativeSource,
  left: string,
  right: string,
  a: Set<string>,
  b: Set<string>,
  verified: NativeAncestry,
) {
  const trees = new Map<string, Tree>(),
    virtual = new Map<string, string[]>(),
    ancestry = new NativeAncestry(id => virtual.get(id) ?? verified.parents(id));
  const tree = (id: string): Tree => {
    let result = trees.get(id);
    if (!result) {
      result = new Map(source.state(id).files.map(file => [file.path, [file]]));
      trees.set(id, result);
    }
    return result;
  };
  function entry(original: Variant, x: Variant, y: Variant): Variant | null {
    if (same(x, y)) return x;
    if (same(x, original)) return y;
    if (same(y, original)) return x;
    if (!original || !x || !y) return null;
    if (x.mode !== y.mode && x.mode !== original.mode && y.mode !== original.mode) return null;
    const mode = x.mode === original.mode ? y.mode : x.mode;
    let blob =
      x.blob === original.blob ? y.blob : y.blob === original.blob || x.blob === y.blob ? x.blob : undefined;
    if (!blob && ![original, x, y].some(file => file.mode === 'symlink')) {
      const bytes = mergeNativeText(
        source.object(original.blob),
        source.object(x.blob),
        source.object(y.blob),
        x.path,
      );
      if (bytes) blob = source.put(bytes);
    }
    return blob ? { path: x.path, mode, blob } : null;
  }
  function merge(base: Tree, l: Tree, r: Tree) {
    const result: Tree = new Map(),
      conflicts: NativeMergeConflict[] = [];
    for (const path of [...new Set([...base.keys(), ...l.keys(), ...r.keys()])].sort()) {
      const originals = base.get(path) ?? [undefined],
        xs = l.get(path) ?? [undefined],
        ys = r.get(path) ?? [undefined];
      const outcomes: Variant[] = [];
      let conflict = false;
      for (const x of xs)
        for (const y of ys)
          for (const original of originals) {
            const merged = entry(original, x, y);
            if (merged === null) conflict = true;
            else outcomes.push(merged);
          }
      const choices = unique(outcomes);
      if (conflict || choices.length !== 1) {
        // Preserve every alternative, including absence, for later recursive merges.
        result.set(path, unique([...xs, ...ys, ...outcomes]));
        conflicts.push({
          path,
          ...(originals[0] ? { base: originals[0] } : {}),
          ...(xs[0] ? { left: xs[0] } : {}),
          ...(ys[0] ? { right: ys[0] } : {}),
        });
      } else result.set(path, choices);
    }
    return { tree: result, conflicts };
  }
  function baseFor(
    x: string,
    y: string,
    first = ancestry.ancestors(x),
    second = ancestry.ancestors(y),
    allowUnrelated = true,
  ): string {
    const common = [...first].filter(id => second.has(id)),
      parents = new Set(common.flatMap(id => ancestry.parents(id))),
      bases = common.filter(id => !parents.has(id)).sort();
    if (!bases.length && allowUnrelated) {
      const empty = 'virtual:empty';
      trees.set(empty, new Map());
      virtual.set(empty, []);
      return empty;
    }
    invariant(
      bases.length > 0,
      'NATIVE_MERGE_BASE_UNKNOWN',
      'Native composition needs a shared ancestor; all source is retained.',
    );
    let base = bases[0]!;
    for (const next of bases.slice(1)) {
      const id = `virtual:${JSON.stringify([base, next])}`;
      if (!trees.has(id)) {
        const merged = merge(tree(baseFor(base, next)), tree(base), tree(next));
        // A virtual tree may contain a file and its subtree from different bases.
        // Neither presence is an agreed baseline: retain absence as an alternative
        // so opposing head resolutions cannot silently delete both sides.
        for (const [path, variants] of merged.tree) {
          if (!variants.some(Boolean)) continue;
          const parts = path.split('/');
          for (let i = 1; i < parts.length; i++) {
            const parent = parts.slice(0, i).join('/'),
              alternatives = merged.tree.get(parent);
            if (!alternatives?.some(Boolean)) continue;
            merged.tree.set(parent, unique([...alternatives, undefined]));
            merged.tree.set(path, unique([...variants, undefined]));
          }
        }
        trees.set(id, merged.tree);
        virtual.set(id, [base, next]);
      }
      base = id;
    }
    return base;
  }
  const base = baseFor(left, right, a, b, false);
  // Keep ordinary single-base composition on a direct path without variant allocation.
  if (!virtual.has(base)) {
    const original = new Map(source.state(base).files.map(file => [file.path, file])),
      l = new Map(source.state(left).files.map(file => [file.path, file])),
      r = new Map(source.state(right).files.map(file => [file.path, file]));
    const files: NativeFile[] = [],
      conflicts: NativeMergeConflict[] = [];
    for (const path of [...new Set([...original.keys(), ...l.keys(), ...r.keys()])].sort()) {
      const before = original.get(path),
        x = l.get(path),
        y = r.get(path);
      const selected = entry(before, x, y);
      if (selected === null)
        conflicts.push({
          path,
          ...(before ? { base: before } : {}),
          ...(x ? { left: x } : {}),
          ...(y ? { right: y } : {}),
        });
      else if (selected) files.push(selected);
    }
    return { files, conflicts };
  }
  const merged = merge(tree(base), tree(left), tree(right)),
    conflicts = new Set(merged.conflicts.map(item => item.path));
  const files: NativeFile[] = [];
  for (const [path, variants] of merged.tree)
    if (!conflicts.has(path) && variants[0]) files.push(variants[0]);
  return { files, conflicts: merged.conflicts };
}
