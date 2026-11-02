// SPDX-License-Identifier: Apache-2.0
import type { Doc } from './_generated/dataModel';
import type { HostedRecord } from '../src/hosted-records';

/** Ownership is evidence about the exact original inputs, never the requester.
 * Compose staged/authenticated every selected page before retaining this aggregate.
 * Conflict path summaries are incomplete, so they cannot supply clean governance.
 * Legacy clean Candidates retain their existing governance proof; legacy conflicts
 * without an authenticated aggregate remain unknown (false). No history scan. */
export function candidateOwnerInputs(
  project: { owner: string },
  row: Pick<Doc<'projectHostedRecords'>, 'creatorAccountId' | 'ownerOnly' | 'provenanceEpoch'>,
  candidate: Extract<HostedRecord, { kind: 'candidate' }>,
  authorityEpoch: number,
) {
  if (row.creatorAccountId !== project.owner) return false;
  if (row.provenanceEpoch !== undefined && row.provenanceEpoch !== authorityEpoch) return false;
  if (row.ownerOnly !== undefined) return row.ownerOnly === true && row.provenanceEpoch === authorityEpoch;
  return candidate.result.status === 'clean' && candidate.governance?.ownerInputs === true;
}
