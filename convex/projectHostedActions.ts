// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { internalMutation, type MutationCtx } from './_generated/server';
import { query } from './cliServer';
import { accessibleProject } from './projectAuthority';
import { writableHostedCheck, type CheckIdentity } from './projectHostedCheckStore';
import { saveObject } from './projectHostedSaveStore';
import {
  hostedActionsMappingSchema,
  hostedActionsCommandSchema,
  actionsMappingMatches,
  actionsAccessMessage,
  type HostedActionsMapping,
} from '../src/hosted-actions';
import { hostedCheckTerminal, checkPin } from '../src/hosted-check';
import { canonicalPayload } from '../src/hosted-source-operation';
import { invariant } from '../src/errors';
import { armActionsWake, actionsFallbackMs } from './projectHostedActionsWake';
import { report } from './errors';

/** Only fixed worker control metadata enters this transaction. No source/Git,
 * network I/O, history scan or scheduled project scan. */
export async function controlHostedActions(
  ctx: MutationCtx,
  input: CheckIdentity & { command: unknown },
  now = Date.now(),
) {
  const command = hostedActionsCommandSchema.parse(input.command);
  const { run } = await writableHostedCheck(ctx, input);
  invariant(
    run.configuration.provider === 'github-actions' && run.plan && run.planDigest,
    'RUNNER_UNAVAILABLE',
    'Prepare the pinned GitHub Actions plan before exporting.',
  );
  const row = await ctx.db
    .query('projectHostedActionsExports')
    .withIndex('by_project_and_run', q => q.eq('projectId', input.projectId).eq('runId', input.runId))
    .unique();
  let m: HostedActionsMapping;
  if (row) m = hostedActionsMappingSchema.parse(JSON.parse(row.value));
  else {
    invariant(
      command.kind === 'claim' && !hostedCheckTerminal(run) && !run.cancelRequested,
      'WORK_STALE',
      'Only an active check can begin its original Actions export.',
    );
    m = {
      schema: 1,
      wakeGeneration: 0,
      wakeAt: 0,
      lastCallbackAt: 0,
      adoptedAt: 0,
      reconciliation: { settles: 0, cancelSent: false },
      runId: run.id,
      dispatchKey: run.dispatchKey,
      head: run.request.expectedHead,
      configuration: run.request.expectedConfiguration,
      planDigest: run.planDigest,
      repository: run.configuration.repository,
      branch: `forge-check/${run.id}`,
      export: null,
      published: false,
      dispatching: false,
      outcome: null,
      httpStatus: null,
      rejections: 0,
      emptyLookups: 0,
      recoveryUsed: false,
      run: null,
      deleted: false,
      nextAt: 0,
      error: null,
      lookupReceipt: null,
      dispatchReceipt: null,
      reservationToken: null,
      lease: { owner: command.owner, token: 0, until: 0 },
    };
  }
  actionsMappingMatches(m, run);
  let effect = false;
  if (command.kind === 'claim') {
    if (m.lease.until > now) return { mapping: m, acquired: false, effect: false };
    m.lease = { owner: command.owner, token: m.lease.token + 1, until: now + 180_000 };
  } else {
    invariant(
      m.lease.owner === command.owner && m.lease.token === command.token && m.lease.until > now,
      'WORK_STALE',
      'The Actions worker lease changed; reconcile the retained mapping.',
    );
    if (command.kind === 'export') {
      if (m.export)
        invariant(
          canonicalPayload(m.export) === canonicalPayload(command.export),
          'EVIDENCE_CHANGED',
          'Reuse the original Actions export commit and bundle.',
        );
      else {
        await saveObject(ctx, input.projectId, command.export.bundle);
        m.export = command.export;
      }
    } else if (command.kind === 'published') {
      invariant(m.export && !m.deleted, 'EVIDENCE_CHANGED', 'Retain the export before publishing its ref.');
      m.published = true;
      m.error = null;
    } else if (command.kind === 'reserve') {
      if (m.reservationToken === command.token) return { mapping: m, acquired: true, effect: false };
      invariant(
        m.export &&
          m.published &&
          !m.deleted &&
          !hostedCheckTerminal(run) &&
          !run.cancelRequested &&
          run.dispatchStarted,
        'WORK_STALE',
        'Reserve an active H10 dispatch before the Actions mutation.',
      );
      if (m.run || now < m.nextAt) return { mapping: m, acquired: true, effect: false };
      if (command.recovery) {
        invariant(
          m.dispatching && m.outcome === 'ambiguous' && !m.recoveryUsed && m.emptyLookups >= 13,
          'EVIDENCE_CHANGED',
          'Recovery needs exhausted lookups and a fresh empty branch lookup.',
        );
        m.recoveryUsed = true;
      } else if (m.dispatching || m.recoveryUsed || m.rejections >= 5)
        return { mapping: m, acquired: true, effect: false };
      m.dispatching = true;
      m.reservationToken = command.token;
      m.outcome = 'ambiguous';
      m.httpStatus = null;
      m.emptyLookups = 0;
      effect = true;
    } else if (command.kind === 'dispatch') {
      const digest = checkPin({ outcome: command.outcome, httpStatus: command.httpStatus });
      if (m.dispatchReceipt?.token === command.token) {
        invariant(
          m.dispatchReceipt.digest === digest,
          'WORK_OPERATION_CHANGED',
          'Replay the original Actions dispatch response.',
        );
        return { mapping: m, acquired: true, effect: false };
      }
      invariant(m.dispatching, 'EVIDENCE_CHANGED', 'Retain dispatch intent before its response.');
      m.dispatchReceipt = { token: command.token, digest };
      m.outcome = command.outcome;
      if (command.outcome === 'accepted') m.error = null;
      m.httpStatus = command.httpStatus;
      if (command.outcome === 'rejected') {
        // A rejected recovery cannot disprove the original ambiguous execution.
        m.dispatching = m.recoveryUsed;
        if (m.recoveryUsed) m.outcome = 'ambiguous';
        m.rejections++;
        m.nextAt = now + 5_000 * 2 ** (m.rejections - 1);
      }
    } else if (command.kind === 'lookup') {
      const digest = checkPin({ run: command.run, empty: command.empty });
      if (m.lookupReceipt?.token === command.token) {
        invariant(
          m.lookupReceipt.digest === digest,
          'WORK_OPERATION_CHANGED',
          'Replay the original Actions lookup response.',
        );
        return { mapping: m, acquired: true, effect: false };
      }
      m.lookupReceipt = { token: command.token, digest };
      invariant(m.export && m.published, 'EVIDENCE_CHANGED', 'Observe only the retained export.');
      if (command.run !== null) {
        invariant(!m.run || m.run === command.run, 'EVIDENCE_CHANGED', 'The retained Actions run changed.');
        const newlyAdopted = m.run === null;
        m.run = command.run;
        if (newlyAdopted) {
          m.adoptedAt = now;
          await armActionsWake(ctx, input, m, now + actionsFallbackMs);
        }
        m.error = null;
      } else if (m.dispatching && command.empty) {
        m.emptyLookups++;
        m.nextAt = now + (m.emptyLookups >= 12 ? 0 : Math.min(60_000, 5_000 * m.emptyLookups));
      } else m.emptyLookups = 0;
    } else if (command.kind === 'wait') {
      if (command.terminal) m.reconciliation.settles++;
      m.nextAt =
        now +
        (command.terminal ? Math.min(60_000, 10_000 + m.reconciliation.settles * 1_000) : actionsFallbackMs);
      // Preserve the finite terminal job-list settling cadence without polling active runs.
      if (command.terminal && m.run !== null) await armActionsWake(ctx, input, m, m.nextAt);
    } else if (command.kind === 'cancel-sent') {
      invariant(
        run.cancelRequested && m.run !== null,
        'WORK_STALE',
        'Cancel only the requested retained execution.',
      );
      m.reconciliation.cancelSent = true;
    } else if (command.kind === 'error') m.error = command.error;
    else if (command.kind === 'deleted' || command.kind === 'cleanup') {
      invariant(
        m.export &&
          hostedCheckTerminal(run) &&
          (!m.dispatching || (m.run !== null && run.executionId === String(m.run))),
        'WORK_STALE',
        'Record the exact run outcome before deleting its branch.',
      );
      if (command.kind === 'deleted') m.deleted = true;
    } else if (command.kind === 'heartbeat') m.lease.until = now + 180_000;
    else m.lease.until = now;
  }
  const saved = {
    projectId: input.projectId,
    runId: run.id,
    head: m.head,
    value: canonicalPayload(hostedActionsMappingSchema.parse(m)),
  };
  if (row) await ctx.db.replace(row._id, saved);
  else await ctx.db.insert('projectHostedActionsExports', saved);
  return { mapping: m, acquired: true, effect };
}
export const control = internalMutation({
  args: { projectId: v.id('hostedProjects'), runId: v.string(), command: v.string() },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      return canonicalPayload(
        await controlHostedActions(ctx, { ...input, command: JSON.parse(input.command) }),
      );
    } catch (error) {
      return report(error);
    }
  },
});

/** Current readers can inspect the retained source/export/run relationship and
 * actionable setup errors without access to credential values. */
export const status = query({
  args: { projectId: v.id('hostedProjects'), runId: v.string() },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read the Actions export.');
      await accessibleProject(ctx, input.projectId, user.subject);
      const row = await ctx.db
        .query('projectHostedActionsExports')
        .withIndex('by_project_and_run', q => q.eq('projectId', input.projectId).eq('runId', input.runId))
        .unique();
      const mapping = row ? hostedActionsMappingSchema.parse(JSON.parse(row.value)) : null;
      return canonicalPayload({
        mapping,
        error: mapping?.error
          ? {
              code: mapping.error === 'registration' ? 'GITHUB_APP_UNAVAILABLE' : 'GITHUB_APP_ACCESS',
              message: actionsAccessMessage(mapping.error),
            }
          : null,
      });
    } catch (error) {
      return report(error);
    }
  },
});
