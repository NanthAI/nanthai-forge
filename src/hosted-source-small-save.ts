// SPDX-License-Identifier: Apache-2.0
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { digest } from './portable-hash.js';
import { saveInputSchema, validateSavePage, savePin } from './hosted-save.js';
import { parseNativeState, overlappingPaths, type NativeState } from './native-state-format.js';
import { workerResultSchema, type WorkerPin } from './hosted-source-worker-format.js';
import type { SourceWorkerTransport } from './hosted-source-worker-reader.js';
import { canonicalPayload } from './hosted-source-operation.js';
import { invariant } from './errors.js';
import { sourceValidation } from './hosted-source-validation.js';
import { mapSourceOrdered } from './hosted-source-parallel.js';

// Runtime routing bounds, not source limits: larger/recipe saves use the Node worker.
export const smallSaveStateBytes = 4 * 1024 * 1024;
const windowBytes = 8 * 1024 * 1024;
async function readExact(io: SourceWorkerTransport, pin: WorkerPin) {
  const bytes = new Uint8Array(pin.size);
  let offset = 0;
  for await (const part of await io.read(pin)) {
    invariant(offset + part.length <= pin.size, 'SOURCE_HASH_MISMATCH', 'Source exceeds its exact size.');
    bytes.set(part, offset);
    offset += part.length;
  }
  invariant(
    offset === pin.size && digest(bytes) === pin.sha256,
    'SOURCE_HASH_MISMATCH',
    'Source bytes differ from their exact pin.',
  );
  return bytes;
}
/** The same native delta and State format, in one bounded V8 action. Null hands
 * the unchanged execution to the resumable worker, before any output is written. */
export async function runSmallSourceSave(
  input: WorkerPin,
  io: SourceWorkerTransport,
): Promise<WorkerPin | null> {
  if (input.size > 128 * 1024) return null;
  const inputBytes = await readExact(io, input);
  const plan = sourceValidation('SOURCE_JOB_INVALID', () =>
    saveInputSchema.parse(JSON.parse(new TextDecoder().decode(inputBytes))),
  );
  if (
    plan.pages.size > 128 * 1024 ||
    plan.pageCount !== 1 ||
    plan.baseline.recipe ||
    plan.baseline.object.size > smallSaveStateBytes
  )
    return null;
  await io.prepareRead?.([plan.baseline.object, plan.pages]);
  // Both pins are known and prepared together: one round trip, not two.
  const [pageBytes, baselineBytes] = await mapSourceOrdered([plan.pages, plan.baseline.object], pin =>
    readExact(io, pin),
  );
  const page = sourceValidation(
    'SOURCE_JOB_INVALID',
    () => validateSavePage(JSON.parse(new TextDecoder().decode(pageBytes)), null).page,
  );
  invariant(
    canonicalPayload(savePin(page)) === canonicalPayload(plan.pages),
    'SOURCE_HASH_MISMATCH',
    'Save page is not canonical.',
  );
  invariant(
    !page.next && page.changes.length === plan.changeCount,
    'SOURCE_CLOSURE_INVALID',
    'Save counts changed.',
  );
  const after = page.changes.flatMap(change => (change.after ? [change.after.content] : []));
  if (after.some(ref => ref.recipe) || after.reduce((n, ref) => n + ref.object.size, 0) > windowBytes)
    return null;
  const baseline = parseNativeState(baselineBytes!),
    files = new Map(baseline.files.map(file => [file.path, file])),
    seen = new Set(baseline.files.map(file => file.blob));
  const verify = [
    ...new Map(
      after.filter(ref => !seen.has(ref.object.sha256)).map(ref => [ref.object.sha256, ref.object]),
    ).values(),
  ];
  await io.prepareRead?.(verify);
  // Descriptors are prepared in one window; changed bytes are streamed and
  // discarded, several in flight (each read is a round trip, not CPU).
  await mapSourceOrdered(verify, async pin => {
    const hash = sha256.create();
    let size = 0;
    for await (const part of await io.read(pin)) {
      size += part.length;
      invariant(size <= pin.size, 'SOURCE_HASH_MISMATCH', 'Source exceeds its exact size.');
      hash.update(part);
    }
    invariant(
      size === pin.size && bytesToHex(hash.digest()) === pin.sha256,
      'SOURCE_HASH_MISMATCH',
      'Source bytes differ from their exact pin.',
    );
  });
  let changed = false;
  for (const change of page.changes) {
    const old = files.get(change.path);
    invariant(
      canonicalPayload(old ? { blob: old.blob, mode: old.mode } : null) === canonicalPayload(change.before),
      'WORK_STALE',
      'Delta does not match registered baseline.',
    );
    const value = change.after ? { blob: change.after.blob, mode: change.after.mode } : null;
    if (canonicalPayload(value) !== canonicalPayload(change.before)) changed = true;
    if (value) files.set(change.path, { path: change.path, ...value });
    else files.delete(change.path);
  }
  const uploads: Promise<void>[] = [];
  const publish = (bytes: Uint8Array) => {
    const pin = { sha256: digest(bytes), size: bytes.length };
    uploads.push(
      io.upload(
        pin,
        (async function* () {
          yield bytes;
        })(),
      ),
    );
    return pin;
  };
  let state = plan.baseline.object;
  if (changed) {
    const next: NativeState = {
      schema: 1,
      kind: 'forge-source-state',
      parents: [plan.baseline.object.sha256],
      files: [...files.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
      message: plan.message,
      at: plan.at,
    };
    invariant(
      overlappingPaths(next.files).length === 0,
      'INVALID_NATIVE_SOURCE',
      'Source file and directory paths overlap.',
    );
    state = publish(new TextEncoder().encode(JSON.stringify(next)));
  }
  const output = publish(
    new TextEncoder().encode(
      JSON.stringify(
        workerResultSchema.parse({
          schema: 1,
          kind: 'forge-source-worker-result',
          input,
          state,
        }),
      ),
    ),
  );
  // The manifest references the State pin, but their immutable R2 writes are independent.
  const settled = await Promise.allSettled(uploads);
  for (const result of settled) if (result.status === 'rejected') throw result.reason;
  return output;
}
