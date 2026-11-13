// SPDX-License-Identifier: Apache-2.0
import type { NativeFile } from './state/format.js';
import type { NativeMergeConflict, NativeMergeResolution } from './state/merge.js';
import { mergeNativeText, markNativeTextConflicts, wholeFileConflict } from './native-text-merge.js';
import type { NativeInsertionOrder } from './native-text-merge.js';
import type { SourceStepCursor, StepTransport } from './hosted-source-step.js';
import { MemoryMergeSource, MemorySourceReader } from './hosted-source-memory.js';
import type { WorkerObject } from './hosted-source-worker-format.js';
import { canonicalPayload } from './hosted-source-operation.js';
import { SourceIoError, sourceCall } from './hosted-source-io-error.js';
import { invariant } from './errors.js';
import { syntaxConflictReason } from './state/merge-syntax.js';
import { docsMainSide, resolveListText } from './native-docs-resolve.js';
import type { ListMergeRule } from './project-config.js';
/** Bounds for the native whole-file text/import parser. Its memory grows with
 * bytes and with line count, so a file over either bound that both sides changed
 * is reported as a conflict instead of merged line by line (Git hosts do the same). */
export const SOURCE_TEXT_MERGE_MAX_BYTES = 4 * 1024 * 1024;
export const SOURCE_TEXT_MERGE_MAX_LINES = 65_536;
export const SOURCE_TEXT_MERGE_TOO_LARGE = 'too large to merge automatically';
/** Counts lines as the native parser splits them, without decoding. */
export function sourceTextLines(bytes: Buffer) {
  let count = 0;
  for (let i = bytes.indexOf(10); i !== -1; i = bytes.indexOf(10, i + 1)) count++;
  return bytes.length && bytes.at(-1) !== 10 ? count + 1 : count;
}
export type SourceCalculation = {
  key: string;
  kind: 'merge' | 'conflict' | 'markers' | 'docs';
  item: NativeMergeConflict;
  order: NativeInsertionOrder;
  /** The right side's marker label. */
  channel: string;
  /** Both marker labels, left first, when the left side is not the Lane (a landing resolution). */
  labels?: [string, string];
  /** Compose only: a merged file the syntax gate covers that fails to parse although both sides do is a conflict. */
  syntax?: true;
  /** Docs only: the declared list rule (forge.json `merge`); absent is the Markdown docs rule. */
  rule?: ListMergeRule;
};
export type SourceCalculationResult = {
  key: string;
  blob: string | null;
  kind: 'text' | 'binary';
  resolutions: NativeMergeResolution[];
  markers?: boolean;
  reason?: string;
};
export class SourceCalculationsPending extends Error {}
const labelsOf = (request: SourceCalculation): [string, string] =>
  request.labels ?? ['lane', request.channel];
/** Replay the native algorithm on compact outcomes, including recursive virtual
 * bases. No body from an acknowledged calculation is read during assembly. */
export function journalSourceCalculations(
  c: SourceStepCursor,
  source: MemoryMergeSource,
  markers: (requests: SourceCalculation[]) => Promise<SourceCalculationResult[] | null>,
) {
  const pending = new Map<string, SourceCalculation>();
  const reasons = new Map<string, string>();
  const compose = (c.plan as { kind?: string }).kind === 'forge-hosted-compose-input';
  source.mergeConflictReason = path => reasons.get(path);
  const request = (
    kind: SourceCalculation['kind'],
    item: NativeMergeConflict,
    order: NativeInsertionOrder,
    channel = 'target',
    syntax = false,
    labels?: [string, string],
    rule?: ListMergeRule,
  ) => {
    // Sync keys keep their shape (no `labels`), so journaled sync calculations replay unchanged.
    // Docs keys gain `rule` only for a declared list, so Markdown docs keys replay unchanged too.
    const extra = {
        ...(labels ? { labels } : {}),
        ...(syntax ? { syntax: true as const } : {}),
        ...(rule ? { rule } : {}),
      },
      key = canonicalPayload({ kind, item, order, channel, ...extra }),
      prior = c.calculations?.[key];
    if (prior?.reason) reasons.set(item.path, prior.reason);
    if (prior) return prior;
    pending.set(key, { key, kind, item, order, channel, ...extra });
    if (pending.size >= 100) throw new SourceCalculationsPending();
    return null;
  };
  source.resolvedContent = async files => {
    for (const file of files) request('markers', { path: file.path, left: file }, 'right-first');
    // Marker validation does not change the tree. Finish a small page while its verified
    // draft and saved State are already resident, instead of reassembling both in another action.
    const work = [...pending.values()].filter(value => value.kind === 'markers');
    if (work.length) {
      const results = await markers(work);
      if (!results) throw new SourceCalculationsPending();
      for (const result of results) {
        (c.calculations ??= {})[result.key] = result;
        pending.delete(result.key);
      }
    }
    for (const file of files) {
      const result = request('markers', { path: file.path, left: file }, 'right-first');
      invariant(
        !result?.markers,
        'CONFLICT_MARKERS',
        `Resolve the conflict markers before completing resolution: ${file.path}.`,
      );
    }
  };
  source.mergeContent = (base, left, right, options, resolutions) => {
    const result = request(
      'merge',
      { path: left.path, base, left, right },
      options.insertionOrder ?? 'left-first',
      'target',
      compose,
    );
    if (result) resolutions.push(...result.resolutions);
    return result?.blob ?? null;
  };
  // The docs and declared list rules' bytes (native-docs-resolve) are a calculation like a text merge.
  source.docsContent = (item, order, rule) =>
    request('docs', item, order, 'target', false, undefined, rule === 'docs' ? undefined : rule)?.blob ??
    null;
  source.conflictContent = (item, [left, right]) => {
    const result = request(
      'conflict',
      item,
      'right-first',
      right,
      false,
      left === 'lane' ? undefined : [left, right],
    );
    return {
      kind: result?.kind ?? 'binary',
      ...(result?.blob
        ? {
            file: { path: item.path, mode: item.left?.mode ?? item.right?.mode ?? 'file', blob: result.blob },
          }
        : item.left
          ? { file: item.left }
          : {}),
    };
  };
  return pending;
}
export async function calculationWindows(requests: SourceCalculation[], io: StepTransport) {
  invariant(io.describeBatch, 'SOURCE_WORKER_UNAVAILABLE', 'Resolve merge calculation descriptors.');
  const ids = [
      ...new Set(
        requests.flatMap(r => [r.item.base, r.item.left, r.item.right].flatMap(f => (f ? [f.blob] : []))),
      ),
    ],
    refs = new Map<string, WorkerObject>();
  for (let i = 0; i < ids.length; i += 100)
    for (const ref of await io.describeBatch(ids.slice(i, i + 100))) refs.set(ref.object.sha256, ref);
  const groups: import('./hosted-source-fanout.js').SourceTaskInput[] = [];
  let group: SourceCalculation[] = [],
    bytes = 0,
    used = new Map<string, WorkerObject>();
  const flush = () => {
    if (group.length) groups.push({ kind: 'calculate', requests: group, refs: [...used.values()] });
    group = [];
    bytes = 0;
    used = new Map();
  };
  for (const request of requests) {
    if (request.kind === 'markers') {
      flush();
      groups.push({ kind: 'markers', request, refs: [refs.get(request.item.left!.blob)!] });
      continue;
    }
    const required = [request.item.base, request.item.left, request.item.right].flatMap(f =>
        f ? [refs.get(f.blob)!] : [],
      ),
      size = required.reduce((n, r) => n + r.object.size, 0);
    if (
      group.length &&
      (bytes + size > 8 * 1024 * 1024 ||
        group.length >= 100 ||
        Buffer.byteLength(JSON.stringify([...group, request])) > 120 * 1024)
    )
      flush();
    group.push(request);
    bytes += size;
    for (const ref of required) used.set(ref.object.sha256, ref);
  }
  flush();
  return groups;
}
export async function calculateSourceFiles(
  input: { requests: SourceCalculation[]; refs: WorkerObject[] },
  io: StepTransport,
  start = 0,
  shouldYield = () => false,
) {
  const results: SourceCalculationResult[] = [];
  for (const request of input.requests.slice(start)) {
    if (shouldYield()) break;
    const source = new MemoryMergeSource({}),
      reader = new MemorySourceReader(source, io),
      refs = new Map(input.refs.map(r => [r.object.sha256, r]));
    const required = [request.item.base, request.item.left, request.item.right].flatMap(file =>
      file ? [refs.get(file.blob)!] : [],
    );
    const tooLarge = {
      key: request.key,
      blob: null,
      kind: 'binary' as const,
      resolutions: [],
      reason: SOURCE_TEXT_MERGE_TOO_LARGE,
    };
    if (required.some(ref => ref.object.size > SOURCE_TEXT_MERGE_MAX_BYTES)) {
      results.push(tooLarge);
      continue;
    }
    await io.prepareRead?.(required.filter(ref => !ref.recipe).map(ref => ref.object));
    const read = async (file?: NativeFile) => {
      if (!file) return Buffer.alloc(0);
      const ref = refs.get(file.blob)!;
      try {
        return await reader.bytes(ref);
      } catch (error) {
        if (error instanceof Error && error.name === 'ForgeError') throw error;
        throw new SourceIoError(error, 'task', file.blob, null, {
          call: 'merge-read',
          size: ref.object.size,
        });
      }
    };
    const [base, left, right] = await Promise.all([
        read(request.item.base),
        read(request.item.left),
        read(request.item.right),
      ]),
      resolutions: NativeMergeResolution[] = [];
    if ([base, left, right].some(bytes => sourceTextLines(bytes) > SOURCE_TEXT_MERGE_MAX_LINES)) {
      results.push(tooLarge);
      continue;
    }
    let bytes: Buffer | null = null,
      kind: 'text' | 'binary' = 'binary';
    if (request.kind === 'merge') {
      const notes: import('./native-text-merge.js').NativeTextResolution[] = [];
      bytes = await sourceCall(
        'merge-text',
        async () =>
          mergeNativeText(base, left, right, request.item.path, {
            insertionOrder: request.order,
            resolutions: notes,
          }),
        { size: base.length + left.length + right.length, objects: required.length },
      );
      resolutions.push(...notes.map(item => ({ ...item, path: request.item.path })));
      // A line merge of two edits that each parse can still not parse. Compose
      // reports that before any check runs; a side that already fails is not blocked.
      const reason =
        bytes && request.syntax ? await syntaxConflictReason(request.item.path, bytes, left, right) : null;
      if (reason) {
        results.push({ key: request.key, blob: null, kind: 'binary', resolutions: [], reason });
        continue;
      }
    } else if (request.kind === 'docs') {
      const main = docsMainSide(request.order) === 'left' ? left : right,
        lane = main === left ? right : left;
      bytes = await sourceCall(
        'merge-text',
        async () => resolveListText(base, main, lane, request.rule ?? 'docs'),
        {
          size: base.length + left.length + right.length,
          objects: required.length,
        },
      );
      if (bytes) kind = 'text';
    } else {
      const marked = await sourceCall(
        'merge-markers',
        async () => markNativeTextConflicts(base, left, right, labelsOf(request), request.order),
        { size: base.length + left.length + right.length, objects: required.length },
      );
      if (marked) {
        kind = 'text';
        // Markers keep the file's line ending (d36380ca); text input always yields bytes here.
        bytes = marked.conflicted ? marked.bytes : wholeFileConflict(base, left, right, labelsOf(request));
      }
    }
    const pin = bytes
      ? await sourceCall('merge-publish', () => reader.publish(bytes!), { size: bytes.length })
      : null;
    results.push({ key: request.key, blob: pin?.sha256 ?? null, kind, resolutions });
  }
  return results;
}
