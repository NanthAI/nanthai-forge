// SPDX-License-Identifier: Apache-2.0
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { invariant } from './errors.js';
import { gitlinkCommit } from './gitlink.js';
import { parseNativeState, type NativeFile } from './native-state-format.js';
import { digest } from './portable-hash.js';
import {
  fileMode,
  gitId,
  treeMode,
  type TreeEntry,
  type TreeFile,
  type TreeRef,
} from './state-tree-format.js';
import type { StateTreeRecord } from './state-tree-segment.js';
import type { StateTreePointer, TreeSession } from './state-tree-store.js';

/** Tree-native State operations. Each costs what changed, not what exists: a save rehashes only
 * the folders on its changed paths, and a walk opens only folders whose identities differ. */
export type TreeChange = { path: string; before?: TreeFile; after?: TreeFile };
export type TreeContest = { path: string; base?: TreeFile; left?: TreeFile; right?: TreeFile };

/** A file's tree entry values from its verified bytes: the Git id is derived here, once, and then
 * travels with the entry. A SHA-256 submodule commit has no place in a Git SHA-1 tree. */
export function treeFile(file: Pick<NativeFile, 'blob' | 'mode'>, bytes: Uint8Array): TreeFile {
  invariant(
    digest(bytes) === file.blob,
    'SOURCE_DIGEST_MISMATCH',
    'Source bytes do not match their identity.',
  );
  const oid = file.mode === 'gitlink' ? gitlinkCommit(bytes) : gitId('blob', bytes);
  invariant(oid.length === 40, 'GIT_OBJECT_INVALID', 'A Git tree cannot pin a SHA-256 submodule commit.');
  return { mode: file.mode, blob: file.blob, oid };
}
const asFile = (entry: TreeEntry): TreeFile => ({
  mode: fileMode(entry.mode)!,
  blob: entry.id,
  oid: entry.oid,
});
const asRef = (entry: TreeEntry | undefined): TreeRef | undefined =>
  entry?.mode === '40000' ? { id: entry.id, oid: entry.oid, at: entry.at! } : undefined;
const asEntry = (name: string, value: TreeFile | TreeRef): TreeEntry =>
  'at' in value
    ? { name, mode: '40000', oid: value.oid, id: value.id, at: value.at }
    : { name, mode: treeMode(value.mode), oid: value.oid, id: value.blob };
const overlap = (condition: unknown) =>
  invariant(condition, 'INVALID_NATIVE_SOURCE', 'Source file and directory paths overlap.');
const byName = (entries: readonly TreeEntry[]) => new Map(entries.map(entry => [entry.name, entry]));

/** Apply changed paths (a file, or null to remove) to a root and return the new root. Only folders
 * on a changed path are read and rewritten; an emptied folder disappears, as in Git. */
export async function applyTreeEdits(
  session: TreeSession,
  root: TreeRef | undefined,
  changes: Iterable<readonly [string, TreeFile | null]>,
): Promise<TreeRef> {
  const apply = async (
    ref: TreeRef | undefined,
    list: (readonly [string, TreeFile | null])[],
  ): Promise<TreeRef | undefined> => {
    const groups = new Map<
      string,
      { leaf?: TreeFile | null; below: (readonly [string, TreeFile | null])[] }
    >();
    for (const [path, value] of list) {
      const slash = path.indexOf('/'),
        name = slash < 0 ? path : path.slice(0, slash);
      invariant(name && name !== '.' && name !== '..', 'INVALID_NATIVE_SOURCE', 'A source path is invalid.');
      let group = groups.get(name);
      if (!group) groups.set(name, (group = { below: [] }));
      if (slash < 0) group.leaf = value;
      else group.below.push([path.slice(slash + 1), value]);
    }
    const tree = byName(ref ? await session.load(ref) : []);
    await Promise.all(
      [...groups].map(async ([name, group]) => {
        const current = tree.get(name);
        let file = current && current.mode !== '40000' ? asFile(current) : undefined;
        if (group.leaf !== undefined) file = group.leaf ?? undefined;
        const below = asRef(current),
          folder = group.below.length ? await apply(below, group.below) : below;
        overlap(!(file && folder));
        if (file) tree.set(name, asEntry(name, file));
        else if (folder) tree.set(name, asEntry(name, folder));
        else tree.delete(name);
      }),
    );
    return tree.size ? session.write(tree.values()) : undefined;
  };
  return (await apply(root, [...changes])) ?? session.write([]);
}

/** Every file under a folder, in Git order. Costs the whole subtree. */
export async function treeFiles(
  session: TreeSession,
  ref: TreeRef | undefined,
  prefix = '',
): Promise<(TreeFile & { path: string })[]> {
  if (!ref) return [];
  const lists = await Promise.all(
    (await session.load(ref)).map(async entry =>
      entry.mode === '40000'
        ? treeFiles(session, asRef(entry), `${prefix}${entry.name}/`)
        : [{ path: prefix + entry.name, ...asFile(entry) }],
    ),
  );
  return lists.flat();
}
const sameEntry = (x: TreeEntry | undefined, y: TreeEntry | undefined) =>
  x === y || (!!x && !!y && x.id === y.id && x.mode === y.mode);
const folderOrAbsent = (entry: TreeEntry | undefined) => !entry || entry.mode === '40000';
async function filesAt(session: TreeSession, entry: TreeEntry | undefined, path: string) {
  if (!entry) return new Map<string, TreeFile>();
  if (entry.mode !== '40000') return new Map([[path, asFile(entry)]]);
  return new Map(
    (await treeFiles(session, asRef(entry), `${path}/`)).map(({ path, ...file }) => [path, file]),
  );
}

/** Files that differ between two roots. Folders with equal identities are never opened. */
export async function treeChanges(
  session: TreeSession,
  before: TreeRef | undefined,
  after: TreeRef | undefined,
): Promise<TreeChange[]> {
  const out: TreeChange[] = [];
  const walk = async (a: TreeRef | undefined, b: TreeRef | undefined, prefix: string) => {
    if (a?.id === b?.id) return;
    const [x, y] = await Promise.all([a ? session.load(a) : [], b ? session.load(b) : []]),
      left = byName(x),
      right = byName(y);
    for (const name of [...new Set([...left.keys(), ...right.keys()])].sort()) {
      const p = left.get(name),
        q = right.get(name);
      if (sameEntry(p, q)) continue;
      if (folderOrAbsent(p) && folderOrAbsent(q)) {
        await walk(asRef(p), asRef(q), `${prefix}${name}/`);
        continue;
      }
      const [was, now] = await Promise.all([
        filesAt(session, p, prefix + name),
        filesAt(session, q, prefix + name),
      ]);
      for (const path of [...new Set([...was.keys(), ...now.keys()])].sort()) {
        const f = was.get(path),
          g = now.get(path);
        if (f && g && f.blob === g.blob && f.mode === g.mode) continue;
        out.push({ path, ...(f ? { before: f } : {}), ...(g ? { after: g } : {}) });
      }
    }
  };
  await walk(before, after, '');
  return out;
}

/** Three-way merge of roots that opens only folders changed on both sides. Paths only one side
 * changed are taken from it. A path both sides changed is returned in `contested` for the file
 * merge to decide; `root` holds the left side there until the caller applies its decisions with
 * `applyTreeEdits`. */
export async function mergeTrees(
  session: TreeSession,
  base: TreeRef | undefined,
  left: TreeRef | undefined,
  right: TreeRef | undefined,
): Promise<{ root: TreeRef; contested: TreeContest[] }> {
  const contested: TreeContest[] = [];
  const walk = async (
    b: TreeRef | undefined,
    l: TreeRef | undefined,
    r: TreeRef | undefined,
    prefix: string,
  ): Promise<TreeRef | undefined> => {
    if (l?.id === r?.id || b?.id === r?.id) return l;
    if (b?.id === l?.id) return r;
    const [B, L, R] = (await Promise.all([b, l, r].map(async ref => (ref ? session.load(ref) : [])))).map(
        byName,
      ) as [Map<string, TreeEntry>, Map<string, TreeEntry>, Map<string, TreeEntry>],
      out = new Map(L);
    for (const name of [...new Set([...B.keys(), ...L.keys(), ...R.keys()])].sort()) {
      const be = B.get(name),
        le = L.get(name),
        re = R.get(name);
      let pick = le;
      if (sameEntry(le, re) || sameEntry(be, re)) pick = le;
      else if (sameEntry(be, le)) pick = re;
      else if (folderOrAbsent(be) && folderOrAbsent(le) && folderOrAbsent(re)) {
        const folder = await walk(asRef(be), asRef(le), asRef(re), `${prefix}${name}/`);
        pick = folder && asEntry(name, folder);
      } else {
        const path = prefix + name,
          [was, ours, theirs] = await Promise.all([be, le, re].map(entry => filesAt(session, entry, path)));
        for (const p of [...new Set([...was!.keys(), ...ours!.keys(), ...theirs!.keys()])].sort()) {
          const f = was!.get(p),
            x = ours!.get(p),
            y = theirs!.get(p);
          contested.push({
            path: p,
            ...(f ? { base: f } : {}),
            ...(x ? { left: x } : {}),
            ...(y ? { right: y } : {}),
          });
        }
      }
      if (pick) out.set(name, pick);
      else out.delete(name);
    }
    return out.size ? session.write(out.values()) : undefined;
  };
  return { root: (await walk(base, left, right, '')) ?? session.write([]), contested };
}

/** Split exact manifest bytes into the State record and its files. */
export function stateTreeRecord(manifest: Uint8Array): { record: StateTreeRecord; files: NativeFile[] } {
  const parsed = parseNativeState(manifest),
    original = JSON.parse(new TextDecoder().decode(manifest)) as Record<string, unknown>,
    keys = Object.keys(original),
    fields: Record<string, unknown> = {};
  for (const key of keys) if (key !== 'files') fields[key] = original[key];
  return { record: { state: digest(manifest), fields, filesAt: keys.indexOf('files') }, files: parsed.files };
}
/** The manifest bytes a record and a file list stand for, in the native writer's order (UTF-16
 * code units of the whole path). */
export function stateTreeManifest(record: StateTreeRecord, files: readonly NativeFile[]): Uint8Array {
  const entries = Object.entries(record.fields),
    sorted = files
      .map(({ path, blob, mode }) => ({ path, blob, mode }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  entries.splice(record.filesAt, 0, ['files', sorted]);
  return utf8ToBytes(JSON.stringify(Object.fromEntries(entries)));
}
/** Whether a record and file list reproduce the manifest byte for byte. A manifest that does not
 * (unusual key order inside an entry, unsorted files, a name Git cannot hold) stays in flat form. */
export function reproducesManifest(
  record: StateTreeRecord,
  files: readonly NativeFile[],
  manifest: Uint8Array,
): boolean {
  const rebuilt = stateTreeManifest(record, files);
  return rebuilt.length === manifest.length && rebuilt.every((byte, i) => byte === manifest[i]);
}

/** Rebuild a State's exact manifest bytes from stored trees alone. Costs every folder. The result
 * hashes to the State identity or this throws. */
export async function readStateTree(session: TreeSession, pointer: StateTreePointer) {
  const { record, root } = await session.open(pointer),
    manifest = stateTreeManifest(record, await treeFiles(session, root));
  invariant(
    digest(manifest) === record.state,
    'SOURCE_DIGEST_MISMATCH',
    'The stored tree does not reproduce its State.',
  );
  parseNativeState(manifest);
  return { record, root, manifest };
}
