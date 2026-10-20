// SPDX-License-Identifier: Apache-2.0
import { NativeSource, type NativeFile } from './native-source.js';
import { workGit } from './work-git.js';

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
      `${file.mode === 'symlink' ? '120000' : file.mode === 'executable' ? '100755' : '100644'} blob ${blobs.get(file.blob)!}\t${name}\0`,
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
    if (!blobs.has(file.blob))
      blobs.set(file.blob, workGit(root, ['hash-object', '-w', '--stdin'], source.object(file.blob)).trim());
  for (const [path, node] of treeNodes(files, blobs))
    trees.set(path, workGit(root, ['mktree', '-z'], treeInput(path, node, trees)).trim());
  return trees.get('')!;
}

export function asyncGitTreeWriter(
  root: string,
  source: NativeSource,
  git: (root: string, args: string[], input?: string | Buffer) => Promise<string>,
) {
  // Only IDs live across States. Validate bytes before their first write in this repository.
  const blobs = new Map<string, string>();
  return async (files: NativeFile[]): Promise<string> => {
    for (const file of files)
      if (!blobs.has(file.blob))
        blobs.set(
          file.blob,
          (await git(root, ['hash-object', '-w', '--stdin'], source.object(file.blob))).trim(),
        );
    const trees = new Map<string, string>();
    for (const [path, node] of treeNodes(files, blobs))
      trees.set(path, (await git(root, ['mktree', '-z'], treeInput(path, node, trees))).trim());
    return trees.get('')!;
  };
}
