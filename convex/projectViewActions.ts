// SPDX-License-Identifier: Apache-2.0
'use node';
import { providerLogUrl, runLogRecord } from '../src/check-log-policy';
import type { CheckRun } from '../src/work-types';
import { hostedText } from '../src/hosted-paths';
import { blobStore } from './blobStore';
import { v } from 'convex/values';
import { paginationOptsValidator } from 'convex/server';
import { action } from './cliServer';
import { api, internal } from './_generated/api';
import { checkLogPage } from '../src/check-log-page';
import { source } from './projectWorkLoad';
import { rawMetadata } from './projectObjectContent';
import { isR2Object } from './projectObjectFields';
import { exchangeObjectReader } from './projectExchangeReader';
import { readFileProvenance } from '../src/view-provenance';
import type { FileProvenancePlan } from '../src/view-provenance-plan';
import { invariant } from '../src/errors';
import { report } from './errors';

/** Source bytes are read only for the selected file page; no Work replay. */
export const read = action({
  args: {
    projectId: v.id('hostedProjects'),
    generationId: v.optional(v.id('projectWorkGenerations')),
    action: v.union(v.literal('view'), v.literal('provenance'), v.literal('views')),
    viewId: v.optional(v.string()),
    laneId: v.optional(v.string()),
    file: v.optional(v.string()),
    lines: v.optional(v.boolean()),
    paginationOpts: paginationOptsValidator,
  },
  returns: v.string(),
  handler: async (ctx, input): Promise<string> => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read project provenance.');
      const { lines, ...selection } = input;
      const result = JSON.parse(await ctx.runQuery(api.projectViewReads.read, selection));
      if (input.action === 'views') return JSON.stringify(result);
      const pins = new Map<string, { sha256: string; size: number }>(
        result.blobPins.filter(Boolean).map((pin: { sha256: string; size: number }) => [pin.sha256, pin]),
      );
      delete result.blobPins;
      if (!result.provenanceAvailable || result.sourceTransport !== 'objects')
        return JSON.stringify({
          ...result,
          available: false,
          reason:
            result.sourceStatus === 'conflict'
              ? 'Conflicted View has no composed file version.'
              : 'Source provenance requires the retained native object checkpoint; local reads remain available.',
        });
      const reader = exchangeObjectReader(ctx);
      const read = async (blob: string) => {
        const pin = pins.get(blob);
        invariant(pin, 'SOURCE_UNAVAILABLE', 'Selected provenance blob is unavailable.');
        return (await reader.read(input.projectId, user.subject, [pin]))[0]!;
      };
      result.files.items = await Promise.all(
        result.files.items.map(async (file: FileProvenancePlan & { why: unknown }) => {
          const resolved = await readFileProvenance(file, read, lines ?? false, blob => {
            const pin = pins.get(blob);
            invariant(pin, 'SOURCE_UNAVAILABLE', 'Selected provenance blob metadata is unavailable.');
            return pin.size;
          });
          return input.action === 'view'
            ? {
                path: resolved.path,
                status: resolved.status,
                additions: resolved.additions,
                deletions: resolved.deletions,
              }
            : { ...resolved, why: file.why };
        }),
      );
      const current = await ctx.runQuery(internal.projectWorkIndexStore.current, {
        projectId: input.projectId,
        owner: user.subject,
      });
      invariant(
        current && current._id === result.generationId && current.revision === result.revision,
        'WORK_STALE',
        'Hosted Work changed while reading provenance.',
      );
      return JSON.stringify({ ...result, available: true });
    } catch (error) {
      return report(error);
    }
  },
});

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
      if (isR2Object(object) || !object.storageId) {
        // The browser verifies complete leaf/file bytes and applies the same redaction before paging.
        return JSON.stringify({
          direct: { sha256: pin.sha256, size: pin.size },
          offset: input.offset,
          backupId: generation.backupId,
          generationId: generation._id,
        });
      }
      // Redact the complete text before paging: a local path may cross a page boundary.
      await rawMetadata(ctx, object, pin);
      const blob = await blobStore(ctx).get(object.storageId);
      invariant(blob && blob.size === pin.size, 'INVALID_WORK_BACKUP', 'Retained log is unavailable.');
      const original = Buffer.from(await blob.arrayBuffer());
      await ctx.runQuery(internal.projectObjects.resolve, args);
      const current = await ctx.runQuery(internal.projectWorkIndexStore.current, {
        projectId: input.projectId,
        owner: user.subject,
      });
      invariant(
        current?.backupId === generation.backupId,
        'WORK_STALE',
        'Checkpoint changed while reading output. Retry the read.',
      );
      const portable = Buffer.from(hostedText(original.toString('utf8')));
      const offset = Math.min(input.offset, portable.length);
      return JSON.stringify(checkLogPage(portable.subarray(offset, offset + 16384), offset, portable.length));
    } catch (error) {
      return report(error);
    }
  },
});
