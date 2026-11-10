// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { z } from 'zod';
import { selectionSourcePath } from '../scripts/test-impact.mjs';
import { digest } from './state/hash.js';
import { clientCacheRoot } from './root-paths.js';
import { sourceTree } from './source-tree.js';
import { stateSchema, type NativeFile } from './state/format.js';

// Increment when execution or partition semantics change. Runtime/config changes
// cannot transfer a local pass; package/config deltas also select full coverage.
export const preflightDefinition = digest(
  `preflight-v2:${process.version}:${process.platform}:${process.arch}`,
);
const evidenceSchema = z.object({
  definition: z.string(),
  files: stateSchema.shape.files,
  inventory: z.array(z.tuple([z.string(), z.string()])),
  covered: z.array(z.string()),
});
export type PreflightEvidence = z.infer<typeof evidenceSchema>;
const directory = (root: string) => join(clientCacheRoot(root), 'agent', 'preflight', 'evidence');
export function writePreflightEvidence(root: string, evidence: PreflightEvidence) {
  const bytes = gzipSync(JSON.stringify(evidence));
  const hash = digest(bytes);
  const dir = directory(root);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${hash}.gz`);
  writeFileSync(`${path}.tmp`, bytes, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
  return hash;
}
export function readPreflightEvidence(root: string, hash: string, tree: string) {
  try {
    if (!/^[a-f0-9]{64}$/.test(hash)) return null;
    const bytes = readFileSync(join(directory(root), `${hash}.gz`));
    if (digest(bytes) !== hash) return null;
    const evidence = evidenceSchema.parse(JSON.parse(gunzipSync(bytes).toString('utf8')));
    return evidence.definition === preflightDefinition && sourceTree(evidence.files) === tree
      ? evidence
      : null;
  } catch {
    return null;
  }
}
export function deltaPaths(before: NativeFile[], after: NativeFile[]) {
  const key = (file: NativeFile) => `${file.mode}:${file.blob}`;
  const left = new Map(before.map(file => [file.path, key(file)]));
  const right = new Map(after.map(file => [file.path, key(file)]));
  return [...new Set([...left.keys(), ...right.keys()])]
    .filter(path => left.get(path) !== right.get(path))
    .sort();
}
/** Retain only snapshots whose inspected bytes match the saved manifest. */
export function savedInventory(files: NativeFile[], inventory: Map<string, string>) {
  const saved = new Map(files.map(file => [file.path, file]));
  return (
    files.filter(file => selectionSourcePath(file.path)).every(file => inventory.has(file.path)) &&
    [...inventory].every(([path, text]) => {
      const file = saved.get(path);
      return file && file.mode !== 'symlink' && digest(text) === file.blob;
    })
  );
}
