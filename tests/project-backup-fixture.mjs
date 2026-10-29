// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';

export const backupPreview = (fields = {}) => ({
  manifestDigest: 'a'.repeat(64),
  head: 'b'.repeat(64),
  format: 'native',
  revision: 0,
  intents: 0,
  lanes: 0,
  views: 0,
  runs: 0,
  files: 0,
  unavailable: 0,
  channels: [],
  ...fields,
});

const archiveFields = () => ({
  projectId: 'project',
  operationId: randomUUID(),
  request: 'synthetic',
  nonce: randomUUID(),
  digest: 'a'.repeat(64),
  size: 0,
  preview: backupPreview(),
  status: 'stored',
});
export const backupFields = () => ({ ...archiveFields(), previous: null });
export const proposalFields = () => ({
  ...archiveFields(),
  actor: 'owner',
  intentId: 'synthetic',
  baseBackupId: 'backup',
  baseArchiveSha256: 'a'.repeat(64),
  baseState: 'b'.repeat(64),
  head: 'c'.repeat(64),
  viewId: 'synthetic',
});
