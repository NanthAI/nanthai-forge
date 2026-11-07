// SPDX-License-Identifier: Apache-2.0
import { checkoutAhead, localApplyBlocked } from './hosted-apply-recovery-records.js';
import { checkoutHostedLane, type LaneTransport } from './hosted-lane-checkout.js';
import { ForgeError, invariant } from './errors.js';
import { applySchema } from './hosted-sync-contract.js';
export { applySchema } from './hosted-sync-contract.js';
/** An explicit, bounded apply. Original checkout receipt guards both the old
 * client marker and exact new server pins; later on-disk edits survive retries. */
export async function applyHostedSync(root: string, input: unknown, transport: LaneTransport) {
  const request = applySchema.parse(input),
    { from, lane } = request;
  invariant(
    from.laneId === lane.laneId,
    'WORK_OPERATION_CHANGED',
    'Apply sync to its original Lane checkout.',
  );
  try {
    return await checkoutHostedLane(
      root,
      {
        operationId: request.operationId,
        url: request.url,
        projectId: lane.projectId,
        laneId: lane.laneId,
        previous: { head: from.head, version: from.version, sourceVersion: from.sourceVersion },
        expected: { head: lane.head, version: lane.version, sourceVersion: lane.sourceVersion },
        // Preserve sparse scope. [] expands nothing and retains earlier scope roots.
        paths: [],
      },
      transport,
    );
  } catch (error) {
    // The checkout moved past `from` on its own (an `open` while the sync waited) and already holds
    // this result or a newer Lane version. Nothing is installed, moved or rolled back.
    const kind = (error as ForgeError | undefined)?.recovery?.obstruction as { kind?: string } | undefined;
    if (
      error instanceof ForgeError &&
      error.code === 'WORK_STALE' &&
      (kind?.kind === 'baseline-mismatch' || kind?.kind === 'superseded')
    ) {
      const ahead = checkoutAhead(root, request);
      if (ahead) return alreadyApplied(root, request, ahead);
    }
    if (
      error instanceof ForgeError &&
      (error.code === 'WORK_CONFLICT' || (error.code === 'WORK_STALE' && error.recovery?.obstruction))
    )
      throw localApplyBlocked(root, request, error);
    // Source already completed. A raw local filesystem refusal (a permission change, a full disk)
    // must still leave a typed, executable recovery instead of a generic hosted failure.
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (!(error instanceof ForgeError) && typeof code === 'string' && localFilesystemCodes.has(code))
      throw localApplyBlocked(
        root,
        request,
        new ForgeError(
          'LOCAL_APPLY_INTERRUPTED',
          `The local apply stopped on a filesystem error (${code}); nothing was discarded.`,
          undefined,
          { obstruction: { kind: 'local-filesystem', code, path: null } },
        ),
      );
    throw error;
  }
}
function alreadyApplied(root: string, request: { lane: { laneId: string } }, ahead: 'target' | 'newer') {
  return {
    ...request.lane,
    root,
    replayed: true,
    alreadyApplied: ahead,
    note:
      ahead === 'target'
        ? 'The checkout already holds this result; nothing was installed or moved.'
        : 'The checkout already holds a newer version of this Lane; nothing was installed or moved.',
  };
}
const localFilesystemCodes = new Set([
  'EACCES',
  'EPERM',
  'EBUSY',
  'EEXIST',
  'EISDIR',
  'ELOOP',
  'EMFILE',
  'ENFILE',
  'ENOENT',
  'ENOSPC',
  'ENOTDIR',
  'ENOTEMPTY',
  'EROFS',
  'EXDEV',
]);
