// SPDX-License-Identifier: Apache-2.0
/**
 * Where a hosted project is in its removal lifecycle (SM-D, machine M1). One pure derive that the
 * web, the CLI and the server read models share, in the shape of `hostedMirrorStatusText`'s source
 * of truth: closed `state`, people's `label`, `tone`, and the one `nextStep`.
 *
 * It reads only fields the project list already returns, so it adds no Convex call or read. Elapsed
 * time is the caller's `now`; the derive itself is deterministic.
 */
export type ProjectPhaseState =
  | 'active'
  /** Deleted, inside the owner's restore window (or a legacy trash with no window). */
  | 'restorable'
  /** Deleted, but restore is not available now: access revocation is finishing or the window ended. */
  | 'trashed'
  | 'purging'
  | 'purge-blocked'
  /** Permanently deleted and the purge receipt confirms every inventoried row and object was removed. */
  | 'purged'
  /** A tombstone with no completed purge receipt: older purges left records and objects behind (Issue 4bf603cc). */
  | 'purged-with-leftovers'
  /** A removal value this client does not know: never treated as active, deleted or purged. */
  | 'unknown';

export type ProjectPhaseTone = 'passed' | 'waiting' | 'failed' | 'plain';

/** The recorded fields the derive reads; every field is optional because the server omits unset ones. */
export type ProjectPhaseRecord = {
  removal?: string | undefined;
  purgeBlocked?: string | undefined;
  retention?: { purgeAt: number; revoking?: boolean | undefined } | undefined;
  purge?: { completedAt?: number | undefined } | undefined;
};

export type ProjectPhase = {
  state: ProjectPhaseState;
  label: string;
  tone: ProjectPhaseTone;
  /** The one action for a person or an agent. */
  nextStep: string;
  /** Why it is stopped or not restorable; present for `purge-blocked`, `trashed` and `unknown`. */
  reason?: string;
  /** What the owner may do from here. */
  canRestore: boolean;
  canDeletePermanently: boolean;
  canRetryRemoval: boolean;
};

/** Reason sentences for every purge-blocked code. Typed so a new code cannot ship without one. */
export const purgeBlockedReasons = {
  R2_PURGE_RETRY_EXHAUSTED: 'R2 purge stopped after repeated storage errors.',
  R2_PURGE_UNAUTHORIZED: 'The R2 prefix purge has no confirmed permanent-delete grant; retrying confirms it.',
  /** Retired code kept for existing rows: the prefix purge no longer reads the global switch. */
  R2_MAINTENANCE_DISABLED: 'The R2 prefix purge was stopped by a retired maintenance switch.',
} as const satisfies Record<string, string>;
export type PurgeBlockedCode = keyof typeof purgeBlockedReasons;
const blockedNext = {
  R2_PURGE_RETRY_EXHAUSTED: 'Resolve the R2 storage failure, then retry removal.',
  R2_PURGE_UNAUTHORIZED: 'Retry removal to confirm the grant and resume.',
  R2_MAINTENANCE_DISABLED: 'Retry removal to resume.',
} as const satisfies Record<PurgeBlockedCode, string>;

const isBlockedCode = (code: string): code is PurgeBlockedCode =>
  Object.prototype.hasOwnProperty.call(purgeBlockedReasons, code);

const none = { canRestore: false, canDeletePermanently: false, canRetryRemoval: false };

export function deriveProjectPhase(project: ProjectPhaseRecord, now: number): ProjectPhase {
  switch (project.removal) {
    case undefined:
      return {
        state: 'active',
        label: 'Active',
        tone: 'plain',
        nextStep: 'No action needed.',
        ...none,
        canDeletePermanently: true,
      };
    case 'trash': {
      const { retention } = project;
      if (retention?.revoking)
        return {
          state: 'trashed',
          label: 'Deleted, finishing access revocation',
          tone: 'waiting',
          nextStep: 'Retry restore shortly.',
          reason: 'Access revocation for this deletion is still finishing.',
          ...none,
          canDeletePermanently: true,
        };
      if (retention && now >= retention.purgeAt)
        return {
          state: 'trashed',
          label: 'Deleted, restore window ended',
          tone: 'waiting',
          nextStep: 'Permanent removal starts on its own.',
          reason: 'The 90-day restore window for this project has ended.',
          ...none,
          canDeletePermanently: true,
        };
      return {
        state: 'restorable',
        label: 'Deleted, restorable',
        tone: 'waiting',
        nextStep: 'Restore it, or delete it permanently now.',
        ...none,
        canRestore: true,
        canDeletePermanently: true,
      };
    }
    case 'deleting': {
      const code = project.purgeBlocked;
      if (code)
        return {
          state: 'purge-blocked',
          label: 'Purge stopped',
          tone: 'failed',
          nextStep: isBlockedCode(code) ? blockedNext[code] : 'Retry removal to resume.',
          reason: isBlockedCode(code)
            ? purgeBlockedReasons[code]
            : `Permanent removal stopped (${code}); this client cannot say why.`,
          ...none,
          canRetryRemoval: true,
        };
      return {
        state: 'purging',
        label: 'Purging',
        tone: 'waiting',
        nextStep: 'Permanent removal is running; nothing to do.',
        ...none,
        // The retry resumes a purge that stopped without a recorded reason (suspected in M1); it is safe to repeat.
        canRetryRemoval: true,
      };
    }
    case 'deleted':
      return project.purge?.completedAt === undefined
        ? {
            state: 'purged-with-leftovers',
            label: 'Deleted, purge not confirmed',
            tone: 'waiting',
            nextStep: 'Ask the Forge operator to re-run the purge for this tombstone.',
            reason:
              'This project was deleted before purges recorded a completion receipt, so its records and stored objects may remain.',
            ...none,
          }
        : {
            state: 'purged',
            label: 'Permanently deleted',
            tone: 'plain',
            nextStep: 'Nothing remains to do.',
            ...none,
          };
    default:
      return {
        state: 'unknown',
        label: "Can't confirm project state",
        tone: 'waiting',
        nextStep: 'Update Forge and refresh; nothing was changed.',
        reason: `This client does not know the removal state "${project.removal}".`,
        ...none,
      };
  }
}
