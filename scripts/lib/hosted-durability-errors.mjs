// SPDX-License-Identifier: Apache-2.0
const actions = {
  ARGUMENT_INVALID: 'Run hosted-durability.mjs --help and correct the selected command inputs.',
  R2_NOT_CONFIGURED: 'Have the owner check the four R2 secrets in the hosted-backup environment.',
  BACKUP_BUSY: 'Let the active backup finish, then replay the original operation with its state directory.',
  BACKUP_PENDING: 'Replay the pending operation with its original operation ID and state directory.',
  BACKUP_TARGET_MISMATCH: 'Replay with the original deployment, bucket, prefix and storage mode.',
  BACKUP_STATE_INVALID:
    'Inspect the private backup state and completed R2 manifest before replaying the original operation.',
  BACKUP_R2_FAILED:
    'Check R2 availability and backup credential permissions, then replay the original operation.',
  BACKUP_CHECKSUM_MISMATCH:
    'Inspect the saved snapshot and R2 checksum before replaying the original operation.',
  DEPLOYMENT_CREDENTIAL_MISMATCH:
    'Have the owner supply a credential for the explicitly selected deployment.',
  CONVEX_EXPORT_FAILED:
    'Check the selected deployment export status in Convex, then replay the original operation.',
  EXPORT_MISSING:
    'Check the selected deployment export status in Convex, then replay the original operation.',
  SNAPSHOT_READ_FAILED: 'Check that the snapshot is a complete Convex ZIP and Python 3 is available.',
  WORK_INDEX_UNAVAILABLE:
    'Inspect the selected Work generation in Convex using the diagnostic references before requesting an authorized repair.',
  WORK_INDEX_INVALID: 'Inspect the selected Work partition in Convex before requesting an authorized repair.',
  STORAGE_INCOMPLETE: 'Export again with file storage included before qualifying this backup.',
  DATABASE_ONLY_STORAGE_REMAINS:
    'Repeat with file storage included until the deployment-wide migration is complete.',
  BACKUP_FRESHNESS_FAILED:
    'Check the newest completed backup manifest and ZIP metadata in R2, then rerun the backup workflow.',
  DURABILITY_FAILED:
    'Inspect the named sub-step and its private local state before replaying the original command.',
};
const steps = new Set([
  'arguments',
  'backup',
  'backup-status',
  'export',
  'verify',
  'freshness',
  'backup.prepare',
  'backup.export',
  'backup.validate',
  'backup.hash',
  'backup.identity',
  'backup.upload-readback',
  'backup.manifest-readback',
  'backup.retention',
  'backup.record',
  'backup-status.read',
  'export.prepare',
  'export.snapshot',
  'export.publish',
  'verify.prepare',
  'verify.left.export',
  'verify.left.validate',
  'verify.right.export',
  'verify.right.validate',
  'verify.compare',
  'freshness.list',
  'freshness.manifest',
  'freshness.head',
]);
export const failure = code => Object.assign(new Error(code), { code });
export async function atStep(step, run) {
  try {
    return await run();
  } catch (caught) {
    const error = caught && typeof caught === 'object' ? caught : failure('DURABILITY_FAILED');
    // Never attach provider text, paths or request values to the public error.
    if (!steps.has(error.step)) error.step = step;
    throw error;
  }
}
export function durabilityError(error, fallback = 'arguments') {
  const code =
    typeof error?.code === 'string' && Object.hasOwn(actions, error.code) ? error.code : 'DURABILITY_FAILED';
  const step = steps.has(error?.step) ? error.step : steps.has(fallback) ? fallback : 'arguments';
  const result = {
    code,
    step,
    message: `Durability failed at ${step}; credentials and provider output are withheld.`,
    nextStep: actions[code],
  };
  // Diagnostics are constructed locally from enums and hashes, never raw rows.
  const d = error?.diagnostics;
  if (
    d &&
    [
      'generation-missing',
      'generation-building',
      'generation-failed',
      'project-mismatch',
      'backup-mismatch',
      'partition-missing',
      'no-work-projects',
    ].includes(d.reason)
  ) {
    result.diagnostics = { reason: d.reason };
    for (const key of ['projectRef', 'generationRef'])
      if (typeof d[key] === 'string' && /^[a-f0-9]{12}$/.test(d[key])) result.diagnostics[key] = d[key];
  }
  if (Number.isInteger(error?.attempts) && error.attempts >= 1 && error.attempts <= 3)
    result.attempts = error.attempts;
  return result;
}
