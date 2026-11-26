// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
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
import { validStateGeneration } from './state/generation.js';
import { invariant } from './errors.js';
import { sourceValidation } from './hosted-source-validation.js';
import type { WorkerPin, WorkerObject } from './hosted-source-worker-format.js';
import type { SourceWorkerTransport } from './hosted-source-worker-reader.js';

// Routing bounds, never source limits. Three 4k-file manifests fit; larger, recursive,
// stacked, batch and content merges retain the resumable Node implementation.
export const smallComposeStateBytes = 768 * 1024;
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
    io.rememberLoadedState?.(ref.object, state.files.length, state.files);
    return state;
  }
  /** Main moved on from the Lane's base: true only when recorded parents and generations prove
   * `base` is an ancestor of main and `head` is not, so `base` is the one merge base. Every ancestor
   * above base's generation is visited (an ancestor's generation is lower), one descriptor call per
   * level (the first also returns the base's descriptor), at most 32 States; an unknown edge, the
   * head itself or a longer walk keeps the full step (null). */
  async function movedFrom(
    main: string,
    parents: readonly string[],
    base: string,
    head: string,
  ): Promise<WorkerObject | null> {
    const generation = (id: string) => io.stateGeneration?.(id),
      edges = (id: string) => io.stateParents?.(id);
    const unknown = (ids: string[]) => ids.filter(id => !validStateGeneration(generation(id)) || !edges(id));
    const describe = async (ids: string[]) => {
      for (const id of ids) io.expectState?.(id);
      return ids.length ? await io.describeBatch!(ids) : [];
    };
    // Free pre-check from the begin payload's descriptors: without recorded levels on main and the
    // head (older rows), or with main below the head's level (base + 1), no walk can prove the base.
    const top = generation(main),
      own = generation(head);
    if (!validStateGeneration(top) || !edges(main) || !validStateGeneration(own) || top < own) return null;
    let level = [...new Set(parents)];
    // The base's bytes are read next, so its descriptor is always part of the first call.
    const ref = (await describe([base, ...unknown(level.filter(id => id !== base))])).find(
      value => value.object.sha256 === base,
    );
    const floor = generation(base);
    if (!ref || !validStateGeneration(floor) || !edges(base)) return null;
    const seen = new Set([main]);
    let found = false,
      visited = 0,
      first = true;
    while (level.length) {
      // A wide merge frontier stops before its descriptors are read, not after.
      if (visited + level.length > 33) return null;
      if (!first) await describe(unknown(level));
      first = false;
      const next = new Set<string>();
      for (const id of level) {
        seen.add(id);
        const value = generation(id),
          up = edges(id);
        if (id === head || !validStateGeneration(value) || !up) return null;
        if (id === base) found = true;
        else if (value > floor) {
          if (++visited > 32) return null;
          for (const parent of up) if (!seen.has(parent)) next.add(parent);
        }
      }
      level = [...next];
    }
    return found ? ref : null;
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
      plan.main.object.size > smallComposeStateBytes
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
    if (entry.state.recipe || entry.state.object.size > smallComposeStateBytes) return null;
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
      // The Lane head's one parent is the merge base when main is its sibling, or when main moved on
      // from it (a recompose, Item 686ecdde Fix 3): proven from recorded edges, else the full step.
      const baseId = right.parents.length === 1 ? right.parents[0]! : undefined;
      if (!baseId || !io.describeBatch) return null;
      const ref =
        left.parents.length === 1 && left.parents[0] === baseId
          ? (await io.describeBatch([baseId]))[0]
          : await movedFrom(plan.base.head, left.parents, baseId, entry.head);
      if (ref === null) return null;
      invariant(ref?.object.sha256 === baseId, 'SOURCE_HASH_MISMATCH', 'Merge base changed.');
      if (
        ref.recipe ||
        ref.object.size > smallComposeStateBytes ||
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
    io.selectPhysicalComposeMain?.(plan.main.object.sha256);
    await io.seedPhysicalState?.(plan.main.object, left.files);
    if (generated) io.rememberOutputState?.(state, [plan.base.head, entry.head], files);
    else if (io.composePhysicalState) await io.composePhysicalState(state, files, plan.base.head);
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
