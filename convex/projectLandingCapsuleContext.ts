// SPDX-License-Identifier: Apache-2.0
import type { QueryCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import type { LandingCapsulePointer } from '../src/hosted-landing';
import { canonicalPayload } from '../src/hosted-source-operation';
import { digest } from '../src/state/hash';
import { invariant } from '../src/errors';

/** Public metadata commits to server-only bytes; no object key, URL or transaction pins. */
export async function capsuleHistoryContext(
  ctx: QueryCtx,
  project: Doc<'hostedProjects'>,
  pointer: LandingCapsulePointer,
  protocol: 1 | undefined,
  submissionId: string,
  context: Record<string, unknown>,
) {
  invariant(
    protocol === 1,
    'CLI_UPGRADE_REQUIRED',
    'This landing history requires server-side capsule support. Run nforge update and retry.',
  );
  const viewVersion = await historyViewVersion(ctx, project);
  const { sha256, size, rawSize, version } = pointer;
  return canonicalPayload({
    ...context,
    landingCapsule: {
      protocol: 1,
      viewVersion,
      submissionId,
      pointer: {
        protocol: 1,
        sha256,
        size,
        rawSize,
        version,
        tables: '',
        tablesDigest: pointer.tablesDigest ?? digest(pointer.tables),
      },
    },
  });
}

const attemptCursorPrefix = 'landing-attempts-v1:';
export const isCapsuleAttemptCursor = (text: string | null) =>
  text === null || text.startsWith(attemptCursorPrefix);
export function capsuleAttemptCursor(submissionId: string, after: number) {
  return attemptCursorPrefix + JSON.stringify({ submissionId, after });
}
export function readCapsuleAttemptCursor(text: string | null, submissionId: string) {
  if (text === null) return -1;
  let value: { submissionId?: unknown; after?: unknown } = {};
  try {
    if (text.startsWith(attemptCursorPrefix)) value = JSON.parse(text.slice(attemptCursorPrefix.length));
  } catch {
    /* Refuse a cursor from another protocol. */
  }
  invariant(
    value.submissionId === submissionId &&
      typeof value.after === 'number' &&
      Number.isSafeInteger(value.after) &&
      value.after >= -1,
    'EVIDENCE_CHANGED',
    'Continue the original capsule-aware attempt page.',
  );
  return value.after;
}

/** Shared reactive viewer dependency for every server-only archive marker. */
export async function historyViewVersion(ctx: QueryCtx, project: Doc<'hostedProjects'>) {
  const viewer = await ctx.auth.getUserIdentity();
  invariant(viewer, 'PROJECT_UNAVAILABLE', 'Sign in to read hosted landing history.');
  // A public project's role can change without changing its source or current snapshot.
  // Retain that dependency even when only the viewer is named in the live context.
  const contributor =
    viewer.subject === project.owner
      ? null
      : await ctx.db
          .query('projectContributors')
          .withIndex('by_project_and_contributor', q =>
            q.eq('projectId', project._id).eq('contributor', viewer.subject),
          )
          .unique();
  return digest(
    canonicalPayload({
      viewer: viewer.subject,
      role: viewer.subject === project.owner ? 'owner' : contributor ? 'writer' : 'reader',
    }),
  );
}
