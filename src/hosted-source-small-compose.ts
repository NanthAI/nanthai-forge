// SPDX-License-Identifier: Apache-2.0
import {
  candidateFileList,
  composeInputSchema,
  composeLaneSchema,
  composeDependencySchema,
  composeResultSchema,
  validateComposePage,
} from './hosted-compose.js';
import { readSourceExact } from './hosted-source-exact.js';
import { saveBytes, savePin } from './hosted-save.js';
import { canonicalPayload } from './hosted-source-operation.js';
import { parseNativeState, stateSchema, overlappingPaths, type NativeFile } from './state/format.js';
import { mergeFileMetadata } from './native-file-merge.js';
import { digest } from './state/hash.js';
import { invariant } from './errors.js';
import { sourceValidation } from './hosted-source-validation.js';
import type { WorkerPin, WorkerObject } from './hosted-source-worker-format.js';
import type { SourceWorkerTransport } from './hosted-source-worker-reader.js';

// Routing bounds, never source limits. Three 4k-file manifests fit; larger, recursive,
// stacked, batch and content merges retain the resumable Node implementation.
const stateBytes = 768 * 1024;
const same = (a: NativeFile | undefined, b: NativeFile | undefined) =>
  a?.blob === b?.blob && a?.mode === b?.mode;
export async function runSmallSourceCompose(
  input: WorkerPin,
  io: SourceWorkerTransport,
): Promise<WorkerPin | null> {
  io.setSourceSizePhase?.('compose');
  if (input.size > 128 * 1024) return null;
  const awaitedInput = await readSourceExact(io, input);
  const plan = sourceValidation('SOURCE_JOB_INVALID', () =>
    composeInputSchema.parse(JSON.parse(new TextDecoder().decode(awaitedInput))),
  );
  return compose(plan);

  async function loadState(ref: WorkerObject) {
    io.expectState?.(ref.object.sha256);
    const state = parseNativeState(await readSourceExact(io, ref.object));
    io.rememberLoadedState?.(ref.object, state.files.length);
    return state;
  }
  // Read the exact input once before interpreting any routing hint.
  async function compose(plan: ReturnType<typeof composeInputSchema.parse>): Promise<WorkerPin | null> {
    invariant(plan.main.object.sha256 === plan.base.head, 'SOURCE_JOB_INVALID', 'Compose main pins differ.');
    if (
      plan.batch ||
      plan.restoreBases ||
      plan.inputs.count + plan.dependencies.count !== 1 ||
      plan.inputs.pages !== 1 ||
      plan.dependencies.pages !== 1 ||
      plan.main.recipe ||
      plan.main.object.size > stateBytes
    )
      return null;
    const manifests = [plan.dependencies, plan.inputs];
    if (manifests.some(m => m.root.size > 128 * 1024)) return null;
    await io.prepareRead?.(manifests.map(m => m.root));
    const pages = await Promise.all(
      manifests.map(async (m, index) => {
        const bytes = await readSourceExact(io, m.root);
        const page = sourceValidation('SOURCE_JOB_INVALID', () =>
          validateComposePage(JSON.parse(new TextDecoder().decode(bytes))),
        );
        invariant(
          canonicalPayload(savePin(page)) === canonicalPayload(m.root),
          'SOURCE_HASH_MISMATCH',
          'Compose page changed.',
        );
        invariant(
          !page.next && page.entries.length === m.count,
          'SOURCE_CLOSURE_INVALID',
          'Compose selection is incomplete.',
        );
        return page.entries.map(entry =>
          sourceValidation('SOURCE_JOB_INVALID', () =>
            (index === 0 ? composeDependencySchema : composeLaneSchema).parse(entry),
          ),
        );
      }),
    );
    const entry = pages.flat()[0]!;
    invariant(
      entry.head === entry.state.object.sha256,
      'SOURCE_JOB_INVALID',
      'Compose State differs from head.',
    );
    if (entry.state.recipe || entry.state.object.size > stateBytes) return null;
    const tips = [...new Map([plan.main, entry.state].map(ref => [ref.object.sha256, ref])).values()];
    await io.prepareRead?.(tips.map(ref => ref.object));
    const states = new Map(
      await Promise.all(tips.map(async ref => [ref.object.sha256, await loadState(ref)] as const)),
    );
    const left = states.get(plan.base.head)!,
      right = states.get(entry.head)!;
    let state: WorkerPin,
      files: NativeFile[],
      generated: Uint8Array | null = null;
    if (entry.head === plan.base.head || left.parents.includes(entry.head)) {
      state = plan.main.object;
      files = left.files;
    } else if (right.parents.includes(plan.base.head)) {
      state = entry.state.object;
      files = right.files;
    } else {
      if (
        left.parents.length !== 1 ||
        right.parents.length !== 1 ||
        left.parents[0] !== right.parents[0] ||
        !io.describeBatch
      )
        return null;
      const refs = await io.describeBatch([left.parents[0]!]);
      invariant(
        refs.length === 1 && refs[0]!.object.sha256 === left.parents[0],
        'SOURCE_HASH_MISMATCH',
        'Merge base changed.',
      );
      const ref: WorkerObject = refs[0]!;
      if (
        ref.recipe ||
        ref.object.size > stateBytes ||
        tips.reduce((n, r) => n + r.object.size, ref.object.size) > 2 * 1024 * 1024
      )
        return null;
      const base = await loadState(ref);
      const a = new Map(base.files.map(f => [f.path, f])),
        b = new Map(left.files.map(f => [f.path, f])),
        c = new Map(right.files.map(f => [f.path, f]));
      files = [];
      for (const path of [...new Set([...a.keys(), ...b.keys(), ...c.keys()])].sort()) {
        const value = mergeFileMetadata(a.get(path), b.get(path), c.get(path));
        if (value === null) return null;
        if (value) files.push(value);
      }
      if (overlappingPaths(files).length) return null;
      generated = new TextEncoder().encode(
        JSON.stringify(
          stateSchema.parse({
            schema: 1,
            kind: 'forge-source-state',
            parents: [plan.base.head, entry.head],
            files,
            message: plan.message,
            at: plan.at,
          }),
        ),
      );
      state = { sha256: digest(generated), size: generated.length };
    }
    const before = new Map(left.files.map(f => [f.path, f])),
      after = new Map(files.map(f => [f.path, f]));
    const paths = [...new Set([...before.keys(), ...after.keys()])]
      .filter(path => !same(before.get(path), after.get(path)))
      .sort();
    const listing = saveBytes(
      candidateFileList(
        plan.base.head,
        state.sha256,
        new Map(paths.map(path => [path, before.get(path) ?? null])),
        files,
        pages.flat(),
      ),
    );
    const listingPin = { sha256: digest(listing), size: listing.length };
    const bytes = saveBytes(
      composeResultSchema.parse({
        schema: 1,
        kind: 'forge-hosted-compose-result',
        input,
        algorithm: plan.algorithm,
        result: { status: 'clean', state, paths, candidateFiles: listingPin },
      }),
    );
    const output = { sha256: digest(bytes), size: bytes.length };
    const upload = (pin: WorkerPin, bytes: Uint8Array) =>
      io.upload(
        pin,
        (async function* () {
          yield bytes;
        })(),
      );
    // No output before eligibility is proven, so fallback reuses the same input and descriptors.
    await io.seedPhysicalState?.(plan.main.object, left.files);
    if (generated) io.rememberOutputState?.(state, [plan.base.head, entry.head], files);
    else await io.writePhysicalState?.(state, files, [plan.base.head]);
    const results = await Promise.allSettled([
      ...(generated ? [upload(state, generated)] : []),
      upload(listingPin, listing),
      upload(output, bytes),
    ]);
    for (const result of results) if (result.status === 'rejected') throw result.reason;
    return output;
  }
}
