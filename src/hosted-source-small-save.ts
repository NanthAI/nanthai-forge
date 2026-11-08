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
/** The one delta page a V8 small save takes; `begin` hints only this shape (review 0f10873e G1). */
export const smallSavePageBytes = 128 * 1024;
const smallSaveInputBytes = 128 * 1024;
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
  /** Objects the plan is expected to name (the baseline and its delta page, from `begin`): read
   * beside the input instead of after it. Used only when the plan names exactly these pins. */
  hints: readonly WorkerPin[] = [],
  /** Changed objects the calling action itself just committed after a HEAD confirmed their exact
   * size and sha256 checksum (R2 also enforced that checksum on their create-only PUT). Staging
   * already bound them to this save, and the step does not use their bytes, so it does not
   * download them again only to re-hash them. Every other changed object is read and checked. */
  verified: readonly WorkerPin[] = [],
): Promise<WorkerPin | null> {
  if (input.size > smallSaveInputBytes) return null;
  const early = new Map(
    hints
      .filter(pin => pin.size <= smallSaveStateBytes)
      .map(pin => {
        const read = readExact(io, pin);
        read.catch(() => {});
        return [pin.sha256, { pin, read }] as const;
      }),
  );
  const inputBytes = await readExact(io, input);
  const plan = sourceValidation('SOURCE_JOB_INVALID', () =>
    saveInputSchema.parse(JSON.parse(new TextDecoder().decode(inputBytes))),
  );
  if (
    plan.pages.size > smallSavePageBytes ||
    plan.pageCount !== 1 ||
    plan.baseline.recipe ||
    plan.baseline.object.size > smallSaveStateBytes
  )
    return null;
  const started = (pin: WorkerPin) => {
    const hinted = early.get(pin.sha256);
    return hinted && hinted.pin.size === pin.size ? hinted.read : null;
  };
  const pending = [plan.pages, plan.baseline.object].filter(pin => !started(pin));
  // Both pins are known and prepared together: one round trip, not two (none when hinted).
  if (pending.length) await io.prepareRead?.(pending);
  const pageRead = started(plan.pages) ?? readExact(io, plan.pages),
    baselineRead = started(plan.baseline.object) ?? readExact(io, plan.baseline.object);
  baselineRead.catch(() => {});
  const pageBytes = await pageRead;
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
  // The changed objects' descriptors resolve while the (larger) baseline is still downloading; the
  // ones the baseline already holds are then not read.
  const committed = new Set(verified.map(pin => `${pin.sha256}:${pin.size}`)),
    unverified = after.filter(ref => !committed.has(`${ref.object.sha256}:${ref.object.size}`));
  const objects = [...new Map(unverified.map(ref => [ref.object.sha256, ref.object])).values()];
  const [baselineBytes] = await Promise.all([
    baselineRead,
    objects.length ? io.prepareRead?.(objects) : undefined,
  ]);
  const baseline = parseNativeState(baselineBytes!),
    files = new Map(baseline.files.map(file => [file.path, file])),
    seen = new Set(baseline.files.map(file => file.blob));
  const verify = [
    ...new Map(
      unverified.filter(ref => !seen.has(ref.object.sha256)).map(ref => [ref.object.sha256, ref.object]),
    ).values(),
  ];
  // Descriptors were prepared in one window above; changed bytes are streamed and
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
