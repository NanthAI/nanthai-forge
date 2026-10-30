// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseNativeState, type NativeState } from './native-state-format.js';
import { digest } from './hash.js';
import { canonicalPayload } from './hosted-source-operation.js';
import { crossHeadProofSchema, pathsOverlap, type CrossHeadProof } from './hosted-cross-head-proof.js';
import { selectImpactPair, selectionSourcePath } from '../scripts/test-impact.mjs';

type Basis = Pick<
  CrossHeadProof,
  'checked' | 'checkedBase' | 'main' | 'head' | 'runId' | 'terminalDigest' | 'planDigest' | 'audit'
>;
type Reader = (
  digests: string[],
  consume?: (hash: string, bytes: Uint8Array) => Promise<void>,
) => Promise<Uint8Array[]>;
class DiskFiles extends Map<string, string> {
  constructor(
    private blobs: Map<string, string>,
    private directory: string,
  ) {
    super([...blobs.keys()].map(path => [path, '']));
  }
  override get(path: string) {
    const blob = this.blobs.get(path);
    return blob ? readFileSync(join(this.directory, blob), 'utf8') : undefined;
  }
  override *entries(): MapIterator<[string, string]> {
    for (const path of this.keys()) yield [path, this.get(path)!];
  }
  override [Symbol.iterator]() {
    return this.entries();
  }
  override *values(): MapIterator<string> {
    for (const path of this.keys()) yield this.get(path)!;
  }
}
const entries = (state: NativeState) => new Map(state.files.map(file => [file.path, file]));
const changed = (before: NativeState, after: NativeState) => {
  const a = entries(before),
    b = entries(after);
  return [...new Set([...a.keys(), ...b.keys()])]
    .filter(path => canonicalPayload(a.get(path) ?? null) !== canonicalPayload(b.get(path) ?? null))
    .sort();
};
/** No repository code executes. Four complete inventories preserve removed edges;
 * source text lives on disk and only one import graph lives in memory at a time.
 * The reader batches authorization/transport, never one RPC per file. */
export async function analyzeCrossHeadReuse(
  basis: Basis,
  selectionPin: string,
  read: Reader,
): Promise<CrossHeadProof | null> {
  const heads = [basis.checkedBase.head, basis.checked.head, basis.main.head, basis.head];
  const manifestBytes = await read(heads);
  if (manifestBytes.length !== 4 || manifestBytes.some((bytes, i) => digest(bytes) !== heads[i])) return null;
  const states = manifestBytes.map(parseNativeState),
    [base, checked, main, merged] = states;
  const candidatePaths = changed(base!, checked!),
    mainPaths = changed(base!, main!);
  if (pathsOverlap(candidatePaths, mainPaths)) return null;
  // The recomposition must be precisely the union of both deltas, including modes/deletions.
  const expected = entries(main!),
    source = entries(checked!);
  for (const path of candidatePaths) {
    const file = source.get(path);
    if (file) expected.set(path, file);
    else expected.delete(path);
  }
  if (
    canonicalPayload([...expected.values()].sort((a, b) => a.path.localeCompare(b.path))) !==
    canonicalPayload([...merged!.files].sort((a, b) => a.path.localeCompare(b.path)))
  )
    return null;
  const directory = await mkdtemp(join(tmpdir(), 'forge-impact-'));
  try {
    const files = states.map(state => state.files);
    if (files.flat().some(file => !['file', 'executable'].includes(file.mode))) return null;
    const hashes = [
      ...new Set(
        files.flatMap(inventory =>
          inventory.filter(file => selectionSourcePath(file.path)).map(file => file.blob),
        ),
      ),
    ];
    for (let at = 0; at < hashes.length; at += 100) {
      const page = hashes.slice(at, at + 100),
        seen = new Set<string>();
      const consume = async (hash: string, bytes: Uint8Array) => {
        if (!page.includes(hash) || seen.has(hash) || digest(bytes) !== hash)
          throw new Error('Incomplete impact source window.');
        new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        await writeFile(join(directory, hash), bytes);
        seen.add(hash);
      };
      const bytes = await read(page, consume);
      // Array readers remain useful for in-memory synthetic fixtures. Hosted
      // transport consumes each byte window directly into the private disk cache.
      if (bytes.length) {
        if (bytes.length !== page.length) return null;
        for (let i = 0; i < page.length; i++) await consume(page[i]!, bytes[i]!);
      }
      if (seen.size !== page.length) return null;
    }
    const candidateSelections: CrossHeadProof['candidateSelections'] = [],
      mainSelections: CrossHeadProof['mainSelections'] = [];
    const known = new Set(files.flatMap(inventory => inventory.map(file => file.path)));
    for (let i = 0; i < files.length; i++) {
      const inventory = new DiskFiles(new Map(files[i]!.map(file => [file.path, file.blob])), directory);
      const comparisons = [candidatePaths, mainPaths].map(paths =>
        paths.filter(path => inventory.has(path) || !known.has(path)),
      );
      const selections = selectImpactPair(inventory, comparisons);
      for (const [index, results] of [candidateSelections, mainSelections].entries()) {
        // An added/deleted path has no edges in inventories where it is absent;
        // the inventories where it exists still contribute its entire closure.
        const selection = selections[index]!;
        if (
          !['scoped', 'docs'].includes(selection.scope) ||
          (selection.scope !== 'docs' && !selection.affectedTests)
        )
          return null;
        results.push({
          head: heads[i]!,
          scope: selection.scope as 'docs' | 'scoped',
          tests: selection.affectedTests ?? [],
        });
      }
    }
    const union = (items: CrossHeadProof['candidateSelections']) =>
      [...new Set(items.flatMap(item => item.tests))].sort();
    const candidateTests = union(candidateSelections),
      mainTests = union(mainSelections);
    if (candidateTests.some(test => mainTests.includes(test))) return null;
    const [selectionBytes, auditBytes] = await read([selectionPin, basis.audit.selection]);
    if (!selectionBytes || digest(selectionBytes) !== selectionPin) return null;
    if (
      !auditBytes ||
      digest(auditBytes) !== basis.audit.selection ||
      JSON.parse(Buffer.from(auditBytes).toString('utf8')).scope !== 'full'
    )
      return null;
    const selection: unknown = JSON.parse(Buffer.from(selectionBytes).toString('utf8'));
    if (
      !selection ||
      typeof selection !== 'object' ||
      !('tests' in selection) ||
      !Array.isArray(selection.tests)
    )
      return null;
    const covered = selection.tests;
    if (candidateTests.some(test => !covered.includes(test))) return null;
    const proof = crossHeadProofSchema.parse({
      ...basis,
      algorithm: 'conservative-impact-v1',
      candidatePaths,
      mainPaths,
      candidateSelections,
      mainSelections,
      candidateTests,
      mainTests,
      checkedSelection: selectionPin,
      cleanComposition: true,
    });
    return Buffer.byteLength(canonicalPayload(proof)) <= 128 * 1024 ? proof : null;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
