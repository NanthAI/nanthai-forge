import { gitlinkCommit } from './gitlink.js';
import { gitMode } from './hosted-github-git.js';
// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { NativeSource, type NativeFile } from './native-source.js';
import { workGit } from './work-git.js';

const objectKey = (file: NativeFile) => (file.mode === 'gitlink' ? `gitlink:${file.blob}` : file.blob);
type Node = { files: string[]; dirs: Set<string> };
function treeNodes(files: NativeFile[], blobs: Map<string, string>) {
  const entries = new Map<string, Node>();
  const node = (path: string) => {
    if (!entries.has(path)) entries.set(path, { files: [], dirs: new Set() });
    return entries.get(path)!;
  };
  node('');
  for (const file of files) {
    const parts = file.path.split('/'),
      name = parts.pop()!;
    let dir = '';
    for (const part of parts) {
      node(dir).dirs.add(part);
      dir = dir ? `${dir}/${part}` : part;
      node(dir);
    }
    node(dir).files.push(
      `${gitMode(file.mode)} ${file.mode === 'gitlink' ? 'commit' : 'blob'} ${blobs.get(objectKey(file))!}\t${name}\0`,
    );
  }
  // Children are inserted after their parent: write bottom-up without recursion.
  return [...entries].reverse();
}
function treeInput(path: string, node: Node, trees: Map<string, string>) {
  return Buffer.from(
    [
      ...node.files,
      ...[...node.dirs].map(name => `040000 tree ${trees.get(path ? `${path}/${name}` : name)!}\t${name}\0`),
    ].join(''),
  );
}

export function treeForGit(root: string, files: NativeFile[], source: NativeSource): string {
  const blobs = new Map<string, string>(),
    trees = new Map<string, string>();
  for (const file of files)
    if (!blobs.has(objectKey(file)))
      blobs.set(
        objectKey(file),
        file.mode === 'gitlink'
          ? gitlinkCommit(source.object(file.blob))
          : workGit(root, ['hash-object', '-w', '--stdin'], source.object(file.blob)).trim(),
      );
  for (const [path, node] of treeNodes(files, blobs))
    trees.set(path, workGit(root, ['mktree', '-z'], treeInput(path, node, trees)).trim());
  return trees.get('')!;
}

export function asyncGitTreeWriter(
  source: NativeSource,
  writeBlob: (bytes: Buffer) => Promise<string>,
  writeTree: (bytes: Buffer) => Promise<string>,
  blobs = new Map<string, string>(),
) {
  // Only IDs live across States. Validate bytes before their first write in this repository.
  return async (files: NativeFile[]): Promise<string> => {
    for (const file of files)
      if (!blobs.has(objectKey(file)))
        blobs.set(
          objectKey(file),
          file.mode === 'gitlink'
            ? gitlinkCommit(source.object(file.blob))
            : await writeBlob(source.object(file.blob)),
        );
    const trees = new Map<string, string>();
    for (const [path, node] of treeNodes(files, blobs))
      trees.set(path, await writeTree(Buffer.concat([treeInput(path, node, trees), Buffer.from('\0')])));
    return trees.get('')!;
  };
}

/** Compute Git tree identities for validation without writing Git objects. */
export function gitTreeHasher(
  source: NativeSource,
  format: 'sha1' | 'sha256',
  blobs = new Map<string, string>(),
  objects = new Set<string>(),
) {
  const hash = (kind: string, bytes: Buffer) =>
    createHash(format).update(`${kind} ${bytes.length}\0`).update(bytes).digest('hex');
  return (files: NativeFile[]) => {
    for (const file of files)
      if (!blobs.has(objectKey(file)))
        blobs.set(
          objectKey(file),
          file.mode === 'gitlink'
            ? gitlinkCommit(source.object(file.blob))
            : hash('blob', source.object(file.blob)),
        );
    const trees = new Map<string, string>();
    for (const [path, node] of treeNodes(files, blobs)) {
      const records = treeInput(path, node, trees)
        .toString('utf8')
        .split('\0')
        .filter(Boolean)
        .map(record => {
          const split = record.indexOf('\t'),
            [mode, kind, oid] = record.slice(0, split).split(' '),
            name = record.slice(split + 1);
          return {
            key: Buffer.from(name + (kind === 'tree' ? '/' : '')),
            bytes: Buffer.concat([
              Buffer.from(`${mode === '040000' ? '40000' : mode} ${name}\0`),
              Buffer.from(oid!, 'hex'),
            ]),
          };
        })
        .sort((a, b) => Buffer.compare(a.key, b.key));
      const tree = hash('tree', Buffer.concat(records.map(record => record.bytes)));
      trees.set(path, tree);
      objects.add(tree);
    }
    return trees.get('')!;
  };
}
