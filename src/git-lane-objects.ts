// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import type { NativeFile } from './native-state-format.js';
import { gitHash, gitMode } from './hosted-github-git.js';
import { invariant } from './errors.js';

/** Git objects for a Lane's saved head (Issue 09367fb2): every tree of a file list, the
 * deterministic commit, and a plain (non-thin, undeltified) pack of chosen objects. */
export type GitEntry = { path: string; mode: NativeFile['mode']; sha: string };
type Tree = Map<string, { mode: string; sha: string } | Tree>;

/** Every tree object of `files`, keyed by id; `root` equals hosted-github-git gitTree(files). */
export function treeObjects(files: readonly GitEntry[]) {
  const root: Tree = new Map();
  for (const file of files) {
    const parts = file.path.split('/');
    let tree = root;
    for (const part of parts.slice(0, -1)) {
      if (!tree.has(part)) tree.set(part, new Map());
      const child = tree.get(part);
      invariant(child instanceof Map, 'GIT_LANE_TREE', 'Source paths overlap.');
      tree = child;
    }
    tree.set(parts.at(-1)!, { mode: gitMode(file.mode), sha: file.sha });
  }
  const trees = new Map<string, Buffer>();
  const write = (tree: Tree): string => {
    const entries = [...tree].sort(([a, av], [b, bv]) =>
      Buffer.compare(
        Buffer.from(a + (av instanceof Map ? '/' : '')),
        Buffer.from(b + (bv instanceof Map ? '/' : '')),
      ),
    );
    const bytes = Buffer.concat(
      entries.map(([name, value]) => {
        const mode = value instanceof Map ? '40000' : value.mode;
        const sha = value instanceof Map ? write(value) : value.sha;
        return Buffer.concat([Buffer.from(`${mode} ${name}\0`), Buffer.from(sha, 'hex')]);
      }),
    );
    const id = gitHash('tree', bytes);
    trees.set(id, bytes);
    return id;
  };
  return { root: write(root), trees };
}

/** The commit is a pure function of its inputs, so the same saved head always gets the
 * same id. Trailers name the Lane and State it came from. */
export function laneCommitBytes(input: {
  tree: string;
  parent: string;
  author: { name: string; email: string };
  at: string;
  message: string;
  laneId: string;
  state: string;
}) {
  const seconds = Math.floor(Date.parse(input.at) / 1000);
  invariant(Number.isSafeInteger(seconds), 'GIT_LANE_TREE', 'The saved head has an invalid time.');
  const person = `${input.author.name} <${input.author.email}> ${seconds} +0000`;
  const message = input.message.trimEnd() || 'Lane save';
  return Buffer.from(
    `tree ${input.tree}\nparent ${input.parent}\nauthor ${person}\ncommitter ${person}\n\n${message}\n\nForge-Lane: ${input.laneId}\nForge-State: ${input.state}\n`,
  );
}

const typeCode = { commit: 1, tree: 2, blob: 3 } as const;
export type PackObject = { type: keyof typeof typeCode; bytes: Uint8Array };
/** A version 2 pack of whole objects: header, zlib bodies, SHA-1 trailer. */
export function writePack(objects: readonly PackObject[]) {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'latin1');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    let size = object.bytes.length;
    const head = [(typeCode[object.type] << 4) | (size & 0x0f)];
    size = Math.floor(size / 16);
    while (size > 0) {
      head[head.length - 1]! |= 0x80;
      head.push(size & 0x7f);
      size = Math.floor(size / 128);
    }
    parts.push(Buffer.from(head), deflateSync(object.bytes));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}
