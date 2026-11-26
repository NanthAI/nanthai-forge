// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { ForgeError, invariant } from './errors.js';
import { ZodError } from 'zod';
import { assertBatchAccounted } from './hosted-batch-coverage.js';
import {
  candidateFileList,
  candidateFileListSchema,
  composeDependencySchema,
  composeInputSchema,
  composeResultSchema,
  type ComposeDeltaPins,
} from './hosted-compose.js';
import { changedPaths } from './hosted-compose-worker.js';
import { saveBytes, savePin } from './hosted-save.js';
import { canonicalPayload } from './hosted-source-operation.js';
import { MemoryMergeSource, MemorySourceReader } from './hosted-source-memory.js';
import type { SourceStepCursor, StepTransport } from './hosted-source-step.js';
import { overlappingPaths, parseNativeState, type NativeFile } from './state/format.js';
import { digest } from './hash.js';
import { SourceIoError } from './hosted-source-io-error.js';

type ComposePlan = typeof composeInputSchema._output;
type CandidateFiles = typeof candidateFileListSchema._output;
const same = (left: NativeFile | undefined | null, right: typeof left) =>
  left?.blob === right?.blob && left?.mode === right?.mode;

async function readDelta(reader: MemorySourceReader, head: string, pin: ComposeDeltaPins[string]) {
  try {
    const listing = candidateFileListSchema.parse(await reader.json(pin.files));
    invariant(
      listing.head === head && listing.base === pin.base && savePin(listing).sha256 === pin.files.sha256,
      'SOURCE_RECOMPOSE_INVARIANT',
      'The recompose Candidate delta does not match its pinned base or head.',
    );
    const paths = new Set<string>();
    for (const { path, before, after, status } of listing.files) {
      invariant(
        !paths.has(path) &&
          (before?.path ?? path) === path &&
          (after?.path ?? path) === path &&
          !same(before, after) &&
          status === (before ? (after ? 'modified' : 'deleted') : 'added'),
        'SOURCE_RECOMPOSE_INVARIANT',
        'The recompose Candidate delta contains an invalid file change.',
      );
      paths.add(path);
    }
    return listing;
  } catch (error) {
    if (error instanceof ForgeError && error.code === 'SOURCE_UNAVAILABLE')
      throw new SourceIoError(error, 'source-headers', pin.files.sha256);
    if (
      !(error instanceof ZodError) &&
      !(error instanceof SyntaxError) &&
      !(error instanceof ForgeError && error.code === 'SOURCE_HASH_MISMATCH')
    )
      throw error;
    throw new ForgeError('SOURCE_RECOMPOSE_INVARIANT', 'The recompose Candidate delta failed verification.');
  }
}

/** A complete trusted delta identifies every path on which right differs from
 * base. Along that delta left must still equal base. Everywhere else, the
 * ordinary three-way merge keeps left. Verify the whole cohort before the
 * first publication so a legitimate overlap can select general composition. */
export async function composeDisjoint(
  c: SourceStepCursor,
  io: StepTransport,
  source: MemoryMergeSource,
  plan: ComposePlan,
) {
  if (!io.composeDeltas || c.index) return false;
  const main = plan.main.object.sha256;
  const heads = c.selections.map(selection => (selection as { head: string }).head);
  const pins = heads.map(head => io.composeDeltas![head]);
  invariant(
    !plan.restoreBases &&
      heads.length > 0 &&
      !c.generationFallback &&
      !!c.generations?.[main] &&
      pins.every((pin, i) => pin && c.generations?.[heads[i]!]),
    'SOURCE_RECOMPOSE_INVARIANT',
    'The recompose proof is missing a verified Candidate pin or State generation.',
  );
  if (!hasExactBase(source, main, heads[0]!, pins[0]!.base)) return false;
  const reader = new MemorySourceReader(source, io);
  const mainParents = source.parents[main];
  const mainState = await reader.state(plan.main);
  invariant(
    canonicalPayload(mainState.parents) === canonicalPayload(mainParents),
    'SOURCE_RECOMPOSE_INVARIANT',
    'The recompose main State differs from its verified ancestry.',
  );
  const before = mainState.files;
  const files = new Map(before.map(file => [file.path, file]));
  // Tentative prefixes share the already validated file objects. Keep them isolated
  // from the durable cursor, whose graph the general merge may still need.
  const proof = new MemoryMergeSource({ ...source.parents }, source.ancestryBoundary, source.ancestryCuts);
  const outputs: Buffer[] = [];
  const changes = new Map();
  let head = main;
  let prior = before;
  for (const [i, member] of heads.entries()) {
    const pin = pins[i]!;
    if (!hasExactBase(proof, head, member, pin.base)) return false;
    const listing = await readDelta(reader, member, pin);
    if (listing.files.some(change => !same(files.get(change.path), change.before))) return false;
    applyDelta(files, listing);
    const next = [...files.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    if (overlappingPaths(next).length) return false;
    const left = head;
    head = proof.writeVerifiedComposeState(next, [left, member], plan.message, plan.at);
    const output = proof.object(head);
    const written = readWrittenState(output, head);
    const memberChanges = new Map();
    changedPaths(memberChanges, prior, written.files);
    const observed = candidateFileList(left, head, memberChanges, written.files, []);
    invariant(
      written.parents[0] === left &&
        written.parents[1] === member &&
        written.parents.length === 2 &&
        written.message === plan.message &&
        written.at === plan.at &&
        !written.git &&
        !written.conversation &&
        canonicalPayload(observed.files) === canonicalPayload(listing.files),
      'SOURCE_RECOMPOSE_INVARIANT',
      'The recompose State changed paths or parents outside the verified Candidate delta.',
    );
    for (const [path, original] of memberChanges) if (!changes.has(path)) changes.set(path, original);
    prior = written.files;
    outputs.push(output);
  }
  if (plan.batch)
    assertBatchAccounted(
      plan.batch.members,
      c.selections.flatMap(selection => {
        const entry = composeDependencySchema.safeParse(selection);
        return entry.success && plan.batch!.members.includes(entry.data.candidateId)
          ? [entry.data.candidateId]
          : [];
      }),
      [],
    );
  const listing = candidateFileList(main, head, changes, prior, c.selections);
  // The ordinary batch cursor retains the union for governance, while the
  // Candidate listing is the net diff. A later member can undo an earlier path.
  const paths = plan.batch ? [...changes.keys()].sort() : listing.files.map(file => file.path);
  const result = composeResultSchema.parse({
    schema: 1,
    kind: 'forge-hosted-compose-result',
    input: c.input,
    algorithm: plan.algorithm,
    ...(plan.batch ? { dropped: [] } : {}),
    result: {
      status: 'clean',
      state: { sha256: head, size: outputs.at(-1)!.length },
      candidateFiles: savePin(listing),
      paths,
    },
  });
  io.selectPhysicalComposeMain?.(main);
  if (io.seedPhysicalState && !io.hasPhysicalState?.(main))
    await io.seedPhysicalState(plan.main.object, before);
  const writer = new MemorySourceReader(proof, io);
  // Publish in parent order so chunk reuse and physical bindings see the
  // same ancestry as an ordinary compose. The action commits all outputs once.
  for (const bytes of outputs) {
    await writer.publish(bytes);
    await io.flushWrites?.();
  }
  const published = await writer.publishMany([
    Buffer.from(saveBytes(listing)),
    Buffer.from(saveBytes(result)),
  ]);
  c.index = heads.length;
  c.head = head;
  c.output = published[1]!;
  c.fastDisjoint = true;
  c.phase = 'done';
  return true;
}

function readWrittenState(output: Buffer, head: string) {
  invariant(digest(output) === head, 'SOURCE_RECOMPOSE_INVARIANT', 'The recompose State digest changed.');
  try {
    return parseNativeState(output);
  } catch (error) {
    if (!(error instanceof ForgeError) || error.code !== 'INVALID_NATIVE_SOURCE') throw error;
    throw new ForgeError('SOURCE_RECOMPOSE_INVARIANT', 'The serialized recompose State is invalid.');
  }
}

function applyDelta(files: Map<string, NativeFile>, listing: CandidateFiles) {
  for (const change of listing.files)
    if (change.after) files.set(change.path, change.after);
    else files.delete(change.path);
}

function hasExactBase(source: MemoryMergeSource, left: string, right: string, base: string) {
  const bases = source.mergeBases(left, right);
  return bases.length === 1 && bases[0] === base;
}
