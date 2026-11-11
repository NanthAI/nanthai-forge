// SPDX-License-Identifier: Apache-2.0
import { canonicalPayload, hostedOperationSchema, type HostedOperation } from './hosted-source-operation.js';
import { invariant } from './errors.js';
/** A self-contained retry receipt. The terminal result is retained verbatim; only repeated
 * transport envelope fields are removed. No R2 read or current resource lookup answers a retry. */
export function compactOperationReceipt(input: unknown) {
  const value = hostedOperationSchema.parse(input);
  invariant(value.terminal, 'WORK_STALE', 'Only terminal operations have compact receipts.');
  return canonicalPayload([
    1,
    value.payloadHash,
    value.expected,
    [value.firstAttempt.id, value.firstAttempt.at, value.firstAttempt.ids],
    value.terminal,
  ]);
}
export function expandOperationReceipt(row: {
  projectId: string;
  actor: string;
  operationId: string;
  value: string;
  journalSegment?: string;
}): HostedOperation {
  const value = JSON.parse(row.value);
  if (!row.journalSegment) return hostedOperationSchema.parse(value);
  invariant(
    Array.isArray(value) && value[0] === 1,
    'EVIDENCE_CHANGED',
    'Compact operation receipt protocol differs.',
  );
  const [, payloadHash, expected, [id, at, ids], terminal] = value;
  return hostedOperationSchema.parse({
    schema: 1,
    projectId: row.projectId,
    actor: row.actor,
    operationId: row.operationId,
    payloadHash,
    expected,
    firstAttempt: {
      projectId: row.projectId,
      operationId: row.operationId,
      id,
      parentAttemptId: null,
      at,
      expected,
      ids,
    },
    terminal,
  });
}
