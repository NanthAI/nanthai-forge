// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { hostedAcceptanceSchema } from '../dist/hosted-acceptance.js';
export function acceptMirrorReceipt(f, state, previous, sequence) {
  const id = randomUUID(),
    hash = 'a'.repeat(64),
    object = { sha256: hash, size: 1 };
  const receipt = hostedAcceptanceSchema.parse({
    schema: 1,
    id,
    projectId: f.projectId,
    channel: 'main',
    submissionId: randomUUID(),
    operationId: randomUUID(),
    attemptId: randomUUID(),
    at: '2026-01-02T00:00:00.000Z',
    authorityEpoch: 1,
    previous: { head: previous, receiptId: randomUUID() },
    candidate: {
      id: randomUUID(),
      digest: hash,
      head: state,
      inputs: object,
      dependencies: object,
      algorithm: 'synthetic',
    },
    message: `Paused landing ${sequence}`,
    actor: { id: 'owner', kind: 'person' },
    policyDigest: hash,
    check: null,
    snapshot: { id: randomUUID(), previousId: 'synthetic', revision: sequence },
    completion: { root: hash, pages: 0, lanes: 0, enabled: false },
    automatic: false,
    undo: { kind: 'revert', receiptId: id },
  });
  f.insert('projectHostedAcceptances', {
    projectId: f.projectId,
    receiptId: id,
    submissionId: receipt.submissionId,
    attemptId: receipt.attemptId,
    sequence,
    value: JSON.stringify(receipt),
  });
  const selection = JSON.stringify({
    schema: 2,
    projectId: f.projectId,
    snapshotId: receipt.snapshot.id,
    sourceRevision: sequence,
    authority: { mode: 'server', epoch: 1 },
    channel: 'main',
    head: state,
    receipt: { id, kind: 'server', previousHead: previous, previousReceiptId: receipt.previous.receiptId },
  });
  const old = [...f.tables.projectHostedChannels.values()][0];
  if (old) f.patch('projectHostedChannels', old._id, { selection });
  else
    f.insert('projectHostedChannels', {
      projectId: f.projectId,
      operationId: receipt.operationId,
      name: 'main',
      selection,
    });
  return receipt;
}
