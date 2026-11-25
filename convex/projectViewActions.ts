// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
'use node';
import { providerLogUrl, runLogRecord } from '../src/check-log-policy';
import type { CheckRun } from '../src/work-types';
import { v } from 'convex/values';
import { action } from './cliServer';
import { internal } from './_generated/api';
import { source } from './projectWorkLoad';
import { isR2Object } from './projectObjectFields';
import { invariant } from '../src/errors';
import { report } from './errors';

/** Retained bytes from the selected checkpoint; never implies the local runner is online. */
export const log = action({
  args: {
    projectId: v.id('hostedProjects'),
    generationId: v.id('projectWorkGenerations'),
    runId: v.string(),
    stream: v.union(v.literal('stdout'), v.literal('stderr')),
    offset: v.number(),
  },
  returns: v.string(),
  handler: async (ctx, input): Promise<string> => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read check output.');
      invariant(
        Number.isSafeInteger(input.offset) && input.offset >= 0,
        'BAD_ARGUMENT',
        'Use a nonnegative byte offset.',
      );
      const generation = await ctx.runQuery(internal.projectWorkIndexStore.current, {
        projectId: input.projectId,
        owner: user.subject,
      });
      invariant(
        generation?._id === input.generationId,
        'WORK_STALE',
        'Reload the current checkpoint before reading output.',
      );
      const [row] = await ctx.runQuery(internal.projectWorkIndexStore.lookups, {
        projectId: input.projectId,
        owner: user.subject,
        generationId: input.generationId,
        keys: [{ collection: 'runs', key: input.runId }],
      });
      invariant(row, 'NOT_FOUND', 'Check run not found in this checkpoint.');
      const selectedRun = JSON.parse(row.value) as CheckRun;
      const providerUrl = providerLogUrl(selectedRun);
      if (providerUrl)
        return JSON.stringify({
          status: 'provider-held',
          providerUrl,
          executionIds: selectedRun.backend?.executionIds ?? [],
          available: false,
          offset: 0,
          nextOffset: 0,
          bytes: 0,
          text: selectedRun.failureSummary ?? '',
          more: false,
        });
      const { backup } = await ctx.runQuery(internal.projectBackups.get, {
        id: generation.backupId,
        owner: user.subject,
      });
      if (backup.transport !== 'objects')
        return JSON.stringify({
          available: false,
          offset: 0,
          nextOffset: 0,
          bytes: 0,
          text: '',
          more: false,
        });
      const snapshot = await source(ctx, generation.backupId, user.subject);
      const run = snapshot.data.runs.find(run => run.id === input.runId);
      const disposition = run && runLogRecord(snapshot.data, run);
      if (disposition && disposition.status !== 'included')
        return JSON.stringify({
          ...disposition,
          available: false,
          offset: 0,
          nextOffset: 0,
          bytes: 0,
          text: run?.failureSummary ?? '',
          more: false,
        });
      const pin = snapshot.manifest.files.find(
        file => file.path === `check-${input.runId}/${input.stream}.log`,
      );
      if (!pin)
        return JSON.stringify({
          available: false,
          offset: 0,
          nextOffset: 0,
          bytes: 0,
          text: '',
          more: false,
        });
      const args = { projectId: input.projectId, actor: user.subject, digests: [pin.sha256] };
      const [object] = await ctx.runQuery(internal.projectObjects.resolve, args);
      invariant(
        object?.size === pin.size,
        'INVALID_WORK_BACKUP',
        'Log bytes differ from their retained pin.',
      );
      if (isR2Object(object))
        // The browser verifies complete leaf/file bytes and applies the same redaction before paging.
        return JSON.stringify({
          direct: { sha256: pin.sha256, size: pin.size },
          offset: input.offset,
          backupId: generation.backupId,
          generationId: generation._id,
        });
      invariant(false, 'INVALID_WORK_BACKUP', 'Retained log is unavailable.');
    } catch (error) {
      return report(error);
    }
  },
});
