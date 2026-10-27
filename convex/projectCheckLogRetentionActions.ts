// SPDX-License-Identifier: Apache-2.0
'use node';
import { v } from 'convex/values';
import { action } from './cliServer';
import { internalAction } from './_generated/server';
import { internal } from './_generated/api';
import { resumePlan, planStep } from './projectCheckLogCleanupPlan';
import { snapshotReader } from './projectCheckLogCleanupSnapshot';
import { applyPlanStep } from './projectCheckLogCleanup';
import { runLogRecord } from '../src/check-log-policy';
import { invariant } from '../src/errors';
import { report } from './errors';
export const registerBackup = action({
  args: { projectId: v.id('hostedProjects'), backupId: v.id('projectBackups'), hasLogs: v.boolean() },
  returns: v.null(),
  handler: async (ctx, input) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to retain local log expiry.');
      const entries: { key: string; expiresAt: number }[] = [];
      if (input.hasLogs) {
        const { backup, project } = await ctx.runQuery(internal.projectBackups.get, {
          id: input.backupId,
          owner: user.subject,
        });
        invariant(project._id === input.projectId, 'PROJECT_UNAVAILABLE', 'Select your project’s backup.');
        const read = snapshotReader(ctx, {
          projectId: input.projectId,
          actor: user.subject,
          operationId: input.backupId,
        });
        let offset = 0;
        do {
          const snapshot = await read(backup, offset);
          for (const run of snapshot.data.runs) {
            const record = runLogRecord(snapshot.data, run);
            if (
              'expiresAt' in record &&
              record.expiresAt &&
              snapshot.files.some(
                file =>
                  file.path === `check-${run.id}/stdout.log` || file.path === `check-${run.id}/stderr.log`,
              )
            )
              entries.push({
                key: `backup:${input.backupId}:${run.id}`,
                expiresAt: Date.parse(record.expiresAt),
              });
          }
          offset += snapshot.files.length;
          if (entries.length) {
            await ctx.runMutation(internal.projectCheckLogRetention.register, {
              projectId: input.projectId,
              actor: user.subject,
              entries: entries.splice(0),
            });
          }
          if (offset >= snapshot.total) break;
        } while (true);
      }
      for (let i = 0; i < Math.max(1, entries.length); i += 50)
        await ctx.runMutation(internal.projectCheckLogRetention.register, {
          projectId: input.projectId,
          actor: user.subject,
          entries: entries.slice(i, i + 50),
        });
      return null;
    } catch (error) {
      return report(error);
    }
  },
});
/** A finite event sweep. No expiry timer or periodic scan exists while idle. */
export const sweep = internalAction({
  args: { projectId: v.id('hostedProjects'), operationId: v.string(), sequence: v.number() },
  returns: v.null(),
  handler: async (ctx, input) => {
    const claimed = await ctx.runMutation(internal.projectCheckLogRetention.claimSweep, input);
    if (!claimed) return null;
    const { actor, settling } = JSON.parse(claimed);
    let complete = settling;
    try {
      if (!settling) {
        const identity = { projectId: input.projectId, operationId: input.operationId, actor };
        let state = await resumePlan(ctx, identity, true);
        const snapshot = snapshotReader(ctx, identity),
          started = Date.now();
        for (let steps = 0; steps < 20 && Date.now() - started < 5000; steps++) {
          state =
            state.phase === 'ready'
              ? await applyPlanStep(ctx, identity, state)
              : await planStep(ctx, identity, state, snapshot);
          complete =
            state.phase === 'ready' &&
            state.offset === state.counts.objects &&
            state.outputOffset === state.counts.hostedOutputs;
          if (complete) break;
        }
      }
    } catch (error) {
      const failure = error as { code?: string; data?: { code?: string } };
      if ((failure.data?.code ?? failure.code) !== 'WORK_STALE') throw error;
      // Keep the stale plan receipt. A changed source guard gets a fresh plan,
      // never a silent rewrite of the reviewed/original deletion scope.
      await ctx.runMutation(internal.projectCheckLogRetention.advanceSweep, {
        ...input,
        complete: false,
        restart: true,
      });
      return null;
    }
    await ctx.runMutation(internal.projectCheckLogRetention.advanceSweep, { ...input, complete });
    return null;
  },
});
