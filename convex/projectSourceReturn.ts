// SPDX-License-Identifier: Apache-2.0
'use node';
import { v } from 'convex/values';
import { action } from './cliServer';
import { internal } from './_generated/api';
import type { Doc } from './_generated/dataModel';
import { exchangeObjectReader } from './projectExchangeReader';
import { caller, source, load } from './projectWorkActions';
import { invariant } from '../src/errors';
import { sourceReturnSchema } from '../src/work-types';
import { applyHostedEvent, metadataRequest, workDigest, validateWorkSize } from '../src/work-metadata';
import { hostedWorkEventDocument } from './schema';
import { report } from './errors';
import { sourceReturnIndex } from './projectSourceReturnIndex';
import { validateSourceReturn } from '../src/work-source-return';
import { returnProgress } from './projectSourceReturnProgress';
import { readOwnerDerived } from './projectOwnerDerived';
import { returnChanges } from './coordinationReturnChanges';
import { recordReturn } from './projectWorkRecordReturn';
import { meteredStorage } from './storageMeter';
import type { ReturnAccounting } from './projectSourceReturnStep';

const accounting = v.object({
  storageReads: v.number(),
  storageBytes: v.number(),
  steps: v.number(),
  invocations: v.number(),
});
// A completing durable (cursor) return reports this push's storage reads, steps
// and invocations. One-action returns and replays return the stored receipt only.
// The stored receipt (journal event) is unchanged; accounting is never persisted there.
const receiptWithAccounting = v.object({
  ...hostedWorkEventDocument.fields,
  accounting: v.optional(accounting),
});
type Receipt = Doc<'projectWorkEvents'> & { accounting?: ReturnAccounting };

export const returnSource = action({
  args: {
    projectId: v.id('hostedProjects'),
    backupId: v.id('projectBackups'),
    expectedBackupId: v.id('projectBackups'),
    revision: v.number(),
    operationId: v.string(),
    continuation: v.optional(v.boolean()),
    statusOnly: v.optional(v.boolean()),
    ownerDerived: v.optional(v.object({ sha256: v.string(), size: v.number() })),
  },
  returns: v.union(
    receiptWithAccounting,
    v.object({ pending: v.literal(true), progress: v.optional(v.string()), resumed: v.boolean() }),
  ),
  handler: async (
    unmetered,
    input,
  ): Promise<Receipt | { pending: true; progress?: string; resumed: boolean }> => {
    const ctx = meteredStorage(unmetered);
    try {
      invariant(
        /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(input.operationId) &&
          Number.isSafeInteger(input.revision) &&
          input.revision >= 0,
        'BAD_ARGUMENT',
        'Use the original return operation UUID and hosted Work revision.',
      );
      const owner = await caller(ctx);
      await ctx.runQuery(internal.projectWork.owner, { projectId: input.projectId, owner });
      const candidateInfo = await ctx.runQuery(internal.projectBackups.get, { id: input.backupId, owner }),
        previousInfo = await ctx.runQuery(internal.projectBackups.get, { id: input.expectedBackupId, owner });
      invariant(
        candidateInfo.project._id === input.projectId &&
          previousInfo.project._id === input.projectId &&
          candidateInfo.backup.status === 'stored',
        'PROJECT_UNAVAILABLE',
        'Select stored checkpoints from this Forge project.',
      );
      const original: Doc<'projectWorkEvents'> | null = await ctx.runQuery(internal.projectWork.find, {
        projectId: input.projectId,
        owner,
        operationId: input.operationId,
      });
      if (original) {
        const command = sourceReturnSchema.safeParse(JSON.parse(original.command));
        invariant(
          command.success &&
            command.data.archiveSha256 === candidateInfo.backup.digest &&
            command.data.previousArchiveSha256 === previousInfo.backup.digest &&
            command.data.previousRevision === input.revision,
          'WORK_OPERATION_CHANGED',
          'Reconcile this return’s original source, Work and hosted base.',
        );
        return original;
      }
      const pending = async (receipt: Receipt | null) => {
        if (receipt) return receipt;
        invariant(
          input.continuation,
          'SOURCE_RETURN_PENDING',
          'Source return is still preparing. Push again with the original operation to continue.',
        );
        const stage = await ctx.runQuery(internal.projectReturnIndexStage.resume, {
          projectId: input.projectId,
          owner,
          backupId: input.backupId,
          revision: candidateInfo.backup.preview.revision + 1,
          operationId: input.operationId,
        });
        return {
          pending: true as const,
          ...(stage?.returnProgress ? { progress: stage.returnProgress } : {}),
          resumed: !!priorStage?.returnCursor,
        };
      };
      const priorStage: Doc<'projectWorkGenerations'> | null = await ctx.runQuery(
        internal.projectReturnIndexStage.resume,
        {
          projectId: input.projectId,
          owner,
          backupId: input.backupId,
          revision: candidateInfo.backup.preview.revision + 1,
          operationId: input.operationId,
        },
      );
      if (input.statusOnly)
        return {
          pending: true,
          progress:
            priorStage?.returnProgress ??
            JSON.stringify({
              phase: 'preparing',
              step: 0,
              done: 0,
              total: 0,
              elapsedMs: 0,
              etaSeconds: null,
            }),
          resumed: !!priorStage?.returnCursor,
        };
      if (priorStage?.returnCursor) return pending(await returnProgress(ctx, priorStage, input, owner));
      console.log('source-return prepare', { revision: input.revision });
      const reader = exchangeObjectReader(ctx, true);
      const records = await recordReturn(
        ctx,
        input,
        owner,
        reader,
        candidateInfo.backup,
        previousInfo.backup,
        priorStage?.returnAt,
      );
      if (records) return pending(records.receipt);
      const current = await load(ctx, input.projectId, owner, reader);
      invariant(
        current.backup._id === input.expectedBackupId && current.data.revision === input.revision,
        'WORK_STALE',
        'Hosted source or Work changed. The uploaded checkpoint and current work remain available.',
      );
      const candidate = await source(ctx, input.backupId, owner, reader);
      validateSourceReturn(current.data, candidate.data, candidate.manifest);
      console.log('source-return prepared', {
        objects: candidate.manifest.files.length,
        logicalBytes: candidate.manifest.files.reduce((sum, p) => sum + p.size, 0),
        views: candidate.data.views.length,
        lanes: candidate.data.lanes.length,
      });
      const ownerDerived = await readOwnerDerived(
        input.ownerDerived,
        async () => (await reader.read(input.projectId, owner, [input.ownerDerived!]))[0]!,
      );
      const command = sourceReturnSchema.parse({
          action: 'source-return',
          archiveSha256: candidate.backup.digest,
          workSha256: workDigest(candidate.data),
          previousArchiveSha256: current.backup.digest,
          previousRevision: current.data.revision,
        }),
        request = metadataRequest(command);
      const staged: Doc<'projectWorkGenerations'> | null = await ctx.runQuery(
        internal.projectReturnIndexStage.resume,
        {
          projectId: input.projectId,
          owner,
          backupId: input.backupId,
          revision: candidate.data.revision + 1,
          operationId: input.operationId,
        },
      );
      const at = staged?.returnAt ?? new Date().toISOString();
      applyHostedEvent(candidate.data, {
        projectKey: current.project.key,
        archiveSha256: candidate.backup.digest,
        id: input.operationId,
        actor: owner,
        at,
        request,
        previousRevision: candidate.data.revision,
        command,
      });
      validateWorkSize(candidate.data);
      if (
        candidate.backup.transport === 'objects' &&
        candidate.manifest.kind === 'forge-native-work-backup'
      ) {
        const generation: Doc<'projectWorkGenerations'> | null = await ctx.runQuery(
          internal.projectWorkIndexStore.current,
          { projectId: input.projectId, owner },
        );
        if (
          generation &&
          generation.backupId === input.expectedBackupId &&
          generation.revision === input.revision
        ) {
          const partitionId = await ctx.runMutation(internal.projectReturnIndexStage.begin, {
            projectId: input.projectId,
            owner,
            generationId: generation._id,
            revision: input.revision,
            backupId: input.backupId,
            localRevision: candidate.manifest.revision,
            metadata: '{}',
            operationId: input.operationId,
            at,
            progress: true,
          });
          invariant(partitionId, 'WORK_STALE', 'Hosted Work changed during source-return preparation.');
          const stage: Doc<'projectWorkGenerations'> | null = await ctx.runQuery(
            internal.projectReturnIndexStage.resume,
            {
              projectId: input.projectId,
              owner,
              backupId: input.backupId,
              revision: candidate.manifest.revision + 1,
              operationId: input.operationId,
            },
          );
          invariant(stage, 'WORK_STALE', 'Source-return staging changed.');
          const changes = await returnChanges(
            reader,
            input.projectId,
            owner,
            current.data,
            candidate.data,
            candidate.manifest,
          );
          return pending(
            await returnProgress(ctx, stage, input, owner, {
              snapshot: { data: candidate.data, manifest: candidate.manifest, backup: candidate.backup },
              generationId: generation._id,
              ownerDerived,
              generation,
              previous: { data: current.data, manifest: current.manifest, backup: current.backup },
              final: {
                projectId: input.projectId,
                owner,
                backupId: input.backupId,
                expectedBackupId: input.expectedBackupId,
                expectedRevision: input.revision,
                localRevision: candidate.manifest.revision,
                operationId: input.operationId,
                request,
                command: JSON.stringify(command),
                at,
                changes,
              },
            }),
          );
        }
      }
      const projection = await sourceReturnIndex(ctx, {
        projectId: input.projectId,
        owner,
        expectedBackupId: input.expectedBackupId,
        revision: input.revision,
        operationId: input.operationId,
        at,
        data: candidate.data,
        backup: candidate.backup,
        manifest: candidate.manifest,
        transport: candidate.backup.transport,
      });
      const changes = await returnChanges(
        reader,
        input.projectId,
        owner,
        current.data,
        candidate.data,
        candidate.manifest,
      );
      return await ctx.runMutation(internal.projectWork.returnSource, {
        projectId: input.projectId,
        owner,
        backupId: input.backupId,
        expectedBackupId: input.expectedBackupId,
        expectedRevision: input.revision,
        localRevision: candidate.manifest.revision,
        operationId: input.operationId,
        request,
        command: JSON.stringify(command),
        at,
        ...(projection ? { projection } : {}),
        changes,
      });
    } catch (error) {
      return report(error);
    }
  },
});
