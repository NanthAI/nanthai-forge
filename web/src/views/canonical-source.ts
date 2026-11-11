// SPDX-License-Identifier: Apache-2.0
import { parseNativeState } from '../../../src/state/format';
import { reviewPaths } from '../../../src/source-review-format';
import {
  candidateFileListSchema,
  validateComposePage,
  composeLaneSchema,
  composeDependencySchema,
} from '../../../src/hosted-compose';
import { hostedRecordSchema } from '../../../src/hosted-records';
import { verifiedBytes } from '../verified-blob';
import { invariant } from '../../../src/errors';
import type { ViewModel } from './model';

type Pin = { sha256: string; size: number };
type Read = (pins: Pin[]) => Promise<Uint8Array[]>;
type Source = { protocol: number; candidate: unknown; pins: Pin[]; files?: Pin };
const cursorPrefix = 'candidate-files-v1:';

/** Only exact State manifests and composition pages are read. Neither legacy
 * projection rows nor a checkpoint's retained Work/archive are needed. */
export async function canonicalViewFiles(
  model: ViewModel & { canonicalSource: Source },
  request: { file?: string; paginationOpts: { cursor: string | null; numItems: number } },
  read: Read,
) {
  const { canonicalSource: source, ...metadata } = model;
  invariant(source.protocol === 1, 'CLI_UPGRADE_REQUIRED', 'Update Forge to read these Candidate files.');
  const candidate = hostedRecordSchema.options[3].parse(source.candidate);
  invariant(candidate.id === model.viewId, 'SOURCE_CHANGED', 'Candidate identity differs.');
  if (candidate.result.status !== 'clean') return metadata;
  const exact = async (pins: Pin[]) => {
    const bytes = await read(pins);
    invariant(bytes.length === pins.length, 'SOURCE_UNAVAILABLE', 'Pinned Candidate objects are incomplete.');
    for (let i = 0; i < pins.length; i++) {
      invariant(bytes[i]!.length === pins[i]!.size, 'SOURCE_HASH_MISMATCH', 'Candidate object size differs.');
      try {
        await verifiedBytes(bytes[i]!, pins[i]!.sha256);
      } catch {
        invariant(false, 'SOURCE_HASH_MISMATCH', 'Pinned Candidate bytes differ.');
      }
    }
    return bytes;
  };
  const pins = new Map(source.pins.map(pin => [pin.sha256, pin]));
  const pair = source.files
    ? []
    : [candidate.base.head, candidate.result.head].map(id => {
        const pin = pins.get(id);
        invariant(pin, 'SOURCE_UNAVAILABLE', 'Pinned Candidate State is unavailable.');
        return pin;
      });
  let changes;
  let listing: ReturnType<typeof candidateFileListSchema.parse> | null = null;
  if (source.files) {
    const [bytes] = await exact([source.files]);
    listing = candidateFileListSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
    invariant(
      listing.base === candidate.base.head && listing.head === candidate.result.head,
      'SOURCE_CHANGED',
      'Candidate file list selected different States.',
    );
    changes = listing.files;
  } else {
    const manifests = await exact(pair);
    changes = reviewPaths(
      parseNativeState(manifests[0]!).files,
      parseNativeState(manifests[1]!).files,
    ).filter(file => file.status !== 'unchanged');
  }
  let offset = 0;
  if (request.paginationOpts.cursor) {
    let cursor;
    try {
      cursor = JSON.parse(request.paginationOpts.cursor.slice(cursorPrefix.length));
    } catch {
      /* checked below */
    }
    invariant(
      request.paginationOpts.cursor.startsWith(cursorPrefix) &&
        cursor &&
        cursor.viewId === model.viewId &&
        cursor.base === candidate.base.head &&
        cursor.head === candidate.result.head &&
        Number.isSafeInteger(cursor.offset) &&
        cursor.offset >= 0 &&
        cursor.offset <= changes.length,
      'BAD_ARGUMENT',
      'Continue the original Candidate file page.',
    );
    offset = cursor.offset;
  }
  const selected =
    request.file === undefined
      ? changes.slice(offset, offset + request.paginationOpts.numItems)
      : changes.filter(file => file.path === request.file);
  const inputs: ViewModel['inputs'] = [];
  const dependencies: ViewModel['dependencies'] = [];
  if (listing?.inputs && listing.dependencies) {
    inputs.push(...listing.inputs.map(input => ({ ...input, saveIndex: -1 })));
    dependencies.push(
      ...listing.dependencies.map(input => ({
        kind: 'view' as const,
        viewId: input.candidateId,
        head: input.head,
      })),
    );
  } else
    for (const kind of ['inputs', 'dependencies'] as const) {
      let next: Pin | null = candidate[kind];
      const seen = new Set<string>();
      while (next) {
        invariant(!seen.has(next.sha256), 'SOURCE_UNAVAILABLE', 'Candidate selection pages repeat.');
        seen.add(next.sha256);
        const [bytes] = await exact([next]);
        const page = validateComposePage(JSON.parse(new TextDecoder().decode(bytes)));
        for (const value of page.entries) {
          if (kind === 'inputs') {
            const lane = composeLaneSchema.parse(value);
            inputs.push({ laneId: lane.laneId, head: lane.head, saveIndex: -1 });
          } else {
            const dependency = composeDependencySchema.parse(value);
            dependencies.push({ kind: 'view', viewId: dependency.candidateId, head: dependency.head });
          }
        }
        next = page.next;
      }
    }
  const end = offset + selected.length;
  return {
    ...metadata,
    inputs,
    dependencies,
    files: {
      total: changes.length,
      items: selected.map(file => ({
        ...file,
        historyComplete: false,
        contributors: [],
        why: [{ ...model.why, notes: [] }],
      })),
      nextCursor:
        request.file === undefined && end < changes.length
          ? cursorPrefix +
            JSON.stringify({
              viewId: model.viewId,
              base: candidate.base.head,
              head: candidate.result.head,
              offset: end,
            })
          : null,
    },
  };
}
