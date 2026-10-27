// SPDX-License-Identifier: Apache-2.0
'use node';
import { v } from 'convex/values';
import { action } from './cliServer';
import { internalAction } from './_generated/server';
import { internal } from './_generated/api';
import { readLogCleanup, prepareLogCleanup } from './projectCheckLogCleanupLedger';
import { source } from './projectWorkLoad';
import { planProjectCheckLogs } from './projectCheckLogCleanup';
import { purgeHostedLogStream } from './projectHostedLogCleanup';
import { checkPin } from '../src/hosted-check';
import { runLogRecord } from '../src/check-log-policy';
import { deleteR2Object } from './r2Operations';
import { r2Config } from './r2';
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
        const snapshot = await source(ctx, input.backupId, user.subject);
        invariant(
          snapshot.project._id === input.projectId,
          'PROJECT_UNAVAILABLE',
          'Select your project’s backup.',
        );
        for (const run of snapshot.data.runs) {
          const record = runLogRecord(snapshot.data, run);
          if (
            'expiresAt' in record &&
            record.expiresAt &&
            snapshot.manifest.files.some(
              file =>
                file.path === `check-${run.id}/stdout.log` || file.path === `check-${run.id}/stderr.log`,
            )
          )
            entries.push({
              key: `backup:${input.backupId}:${run.id}`,
              expiresAt: Date.parse(record.expiresAt),
            });
        }
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
  args: { projectId: v.id('hostedProjects') },
  returns: v.null(),
  handler: async (ctx, { projectId }) => {
    const due = JSON.parse(await ctx.runQuery(internal.projectCheckLogRetention.due, { projectId }));
    if (!due.owner || !due.entries.length) return null;
    const hash = checkPin(due.entries.map((row: { _id: string }) => row._id));
    const operationId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
    const identity = { projectId, actor: due.owner, operationId };
    const original = await readLogCleanup(ctx, identity);
    const state =
      original?.phase === 'ready' ? original : await planProjectCheckLogs(ctx, projectId, due.owner, true);
    const saved = await prepareLogCleanup(ctx, identity, state);
    for (const stream of state.hostedOutputs)
      await purgeHostedLogStream(ctx, { projectId, actor: due.owner, ...stream });
    while (saved.offset < saved.objects.length) {
      const pending = JSON.parse(
        await ctx.runMutation(internal.projectCheckLogCleanupStore.claim, {
          ...identity,
          offset: saved.offset,
        }),
      );
      if (pending.jobs.length) for (const job of pending.jobs) await deleteR2Object(r2Config(), job.key);
      Object.assign(
        saved,
        JSON.parse(await ctx.runMutation(internal.projectCheckLogCleanupStore.complete, identity)),
      );
    }
    await ctx.runMutation(internal.projectCheckLogRetention.settled, {
      projectId,
      ids: due.entries.map((row: { _id: string }) => row._id),
    });
    return null;
  },
});
