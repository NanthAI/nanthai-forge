// SPDX-License-Identifier: Apache-2.0
import { packRecord, unpackRecord } from './work-record-codec.js';
import { preserveFields } from './work-normalization.js';
import { z } from 'zod';
import { digest } from './portable-hash.js';
import { invariant } from './errors.js';
import { checkRunSchema, type CheckRun, type WorkData } from './work-types.js';

export const workDetailPinSchema = z.object({
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  size: z.number().safe().nonnegative(),
});
export type WorkDetailPin = z.infer<typeof workDetailPinSchema>;
export type DetailWriter = (bytes: Uint8Array) => WorkDetailPin;
export type DetailReader = (pin: WorkDetailPin) => Uint8Array;
type Action = NonNullable<WorkData['automaticActions']>[number];
const encode = (value: unknown) => packRecord(Buffer.from(JSON.stringify(value)));
function readDetail(read: DetailReader, pin: WorkDetailPin) {
  const bytes = read(pin);
  invariant(
    bytes && bytes.length === pin.size && digest(bytes) === pin.sha256,
    'INVALID_WORK_STORE',
    'Retained Work detail is missing or changed. Existing Work is preserved.',
  );
  return JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(unpackRecord(Buffer.from(bytes))));
}
/** Exact selection and verdict evidence is retained separately; summary reads never open it. */
export function compactRun(run: CheckRun, put: DetailWriter, read?: DetailReader): CheckRun {
  if (!run.checkSelection?.tests.length && !run.checkSelection?.coverage && !run.backend?.testVerdicts)
    return run;
  if (run.detailRef) {
    invariant(read, 'INVALID_WORK_STORE', 'The retained evidence reader is unavailable.');
    const original = hydrateRun(run, read);
    const current = { ...run };
    delete current.detailRef;
    delete current.detailSummary;
    run = {
      ...original,
      ...current,
      ...(run.backend ? { backend: { ...original.backend, ...run.backend } } : {}),
      checkSelection:
        run.checkSelection?.tests.length || run.checkSelection?.coverage
          ? run.checkSelection
          : original.checkSelection,
    };
  }
  const detail = {
    kind: 'forge-run-detail-v1',
    ...(run.checkSelection ? { checkSelection: run.checkSelection } : {}),
    ...(run.backend?.testVerdicts ? { testVerdicts: run.backend.testVerdicts } : {}),
  };
  const verdicts = run.backend?.testVerdicts ?? [];
  const counts: Record<string, number> = {};
  for (const verdict of verdicts) counts[verdict.verdict] = (counts[verdict.verdict] ?? 0) + 1;
  const backend = run.backend ? { ...run.backend } : undefined;
  if (backend) delete backend.testVerdicts;
  const selection = run.checkSelection;
  return {
    ...run,
    ...(run.backend ? { backend: backend as CheckRun['backend'] } : {}),
    ...(selection
      ? {
          checkSelection: {
            scope: selection.scope,
            reason: selection.reason,
            ...(selection.partial === undefined ? {} : { partial: selection.partial }),
            tests: [],
          },
        }
      : {}),
    detailRef: put(encode(detail)),
    detailSummary: {
      tests: selection?.tests.length ?? 0,
      coverageTests: selection?.coverage?.tests.length ?? 0,
      verdicts: counts,
      failedTests: verdicts
        .filter(item => item.verdict === 'failed')
        .slice(0, 20)
        .map(item => item.test.slice(0, 512)),
    },
  };
}
export function hydrateRun(run: CheckRun, read: DetailReader): CheckRun {
  if (!run.detailRef) return run;
  const detail = readDetail(read, run.detailRef);
  invariant(detail.kind === 'forge-run-detail-v1', 'INVALID_WORK_STORE', 'Invalid retained run detail.');
  const rest = { ...run };
  delete rest.detailRef;
  delete rest.detailSummary;
  // Parse using the original schema ordering, preserving existing evidence fingerprints.
  const value = {
    ...rest,
    ...(detail.checkSelection ? { checkSelection: detail.checkSelection } : {}),
    ...(detail.testVerdicts ? { backend: { ...rest.backend, testVerdicts: detail.testVerdicts } } : {}),
  };
  return preserveFields(checkRunSchema.parse(value), value) as CheckRun;
}
export function compactAction(action: Action, put: DetailWriter): Action {
  if (
    action.result === undefined ||
    (action.resultRef && action.result === JSON.stringify({ deferred: true, bytes: action.resultRef.size }))
  )
    return action;
  const bytes = encode({ kind: 'forge-action-result-v1', result: action.result });
  return {
    ...action,
    result: JSON.stringify({ deferred: true, bytes: bytes.length }),
    resultRef: put(bytes),
  };
}
export function actionResult(action: Action | undefined, read: DetailReader): string | undefined {
  if (!action?.resultRef) return action?.result;
  const detail = readDetail(read, action.resultRef);
  invariant(
    detail.kind === 'forge-action-result-v1' && typeof detail.result === 'string',
    'INVALID_WORK_STORE',
    'Invalid retained automatic-action result.',
  );
  return detail.result;
}
export function workDetailPins(data: Pick<WorkData, 'runs' | 'automaticActions'>): WorkDetailPin[] {
  const pins = [
    ...data.runs.flatMap(run => (run.detailRef ? [run.detailRef] : [])),
    ...(data.automaticActions ?? []).flatMap(action => (action.resultRef ? [action.resultRef] : [])),
  ];
  return [...new Map(pins.map(pin => [pin.sha256, pin])).values()];
}
/** The same deterministic record-page conversion is usable by native and hosted writers.
 * Publication of a page and its cursor must follow durable object storage. */
export function compactDetailPage(
  collection: string,
  records: unknown[],
  put: DetailWriter,
  read?: DetailReader,
) {
  return records.map(record =>
    collection === 'runs'
      ? compactRun(record as CheckRun, put, read)
      : collection === 'automaticActions'
        ? compactAction(record as Action, put)
        : record,
  );
}
export function slimWorkFormat(schema: number) {
  return [16, 18, 20, 22, 24].includes(schema) ? 24 : 23;
}
