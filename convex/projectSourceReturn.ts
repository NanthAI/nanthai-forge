// SPDX-License-Identifier: Apache-2.0
'use node';
import { v, ConvexError } from 'convex/values';
import { action } from './cliServer';
import { internal } from './_generated/api';
import type { Doc } from './_generated/dataModel';
import { exchangeObjectReader } from './projectExchangeReader';
import { caller, source, load } from './projectWorkActions';
import { invariant, ForgeError } from '../src/errors';
import { sourceReturnSchema } from '../src/work-types';
import { applyHostedEvent, metadataRequest, workDigest, validateWorkSize } from '../src/work-metadata';
import { hostedWorkEventDocument } from './schema';
import { report } from './errors';
import { validateSourceReturn } from '../src/work-source-return';
import { returnProgress } from './projectSourceReturnProgress';
import { readOwnerDerived, requireOwnerDerived, CLI_UPGRADE_MESSAGE } from './projectOwnerDerived';
import { gitReturnIndex } from './projectGitReturnIndex';
import { returnChanges } from './coordinationReturnChanges';
import { recordReturn } from './projectWorkRecordReturn';
import { meteredStorage } from './storageMeter';
import type { ReturnAccounting } from './projectSourceReturnStep';
import { prepareLargeReturn } from './projectSourceReturnPrepare';

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
    const started = Date.now();
    const ctx = meteredStorage(unmetered);
    let raced:
      (() => Promise<Receipt | { pending: true; progress?: string; resumed: boolean } | null>) | undefined;
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
      const replay = async () => {
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
        return null;
      };
      const original = await replay();
      if (original) return original;
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
          ...(stage?.returnCommitPlan
            ? {
                progress: JSON.stringify({
                  phase: 'committing',
                  step: stage.returnStep ?? 0,
                  done: stage.returnCommitOffset ?? 0,
                  total: 0,
                  cursor: stage.returnCommitCursor ?? null,
                  itemPending: stage.returnCommitCopied ? 0 : 1,
                  elapsedMs: Date.now() - Date.parse(stage.returnAt!),
                  etaSeconds: null,
                }),
              }
            : stage?.returnProgress
              ? { progress: stage.returnProgress }
              : {}),
          resumed: !!(
            priorStage?.returnCursor ||
            priorStage?.returnMetadataCursor ||
            priorStage?.returnPrepareCursor
          ),
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
      raced = async () => {
        const receipt = await replay();
        if (receipt) return receipt;
        const selected = await ctx.runQuery(internal.projectWork.get, { projectId: input.projectId, owner });
        if (selected.work?.backupId !== input.expectedBackupId || selected.work.revision !== input.revision)
          return null;
        const latest: Doc<'projectWorkGenerations'> | null = await ctx.runQuery(
          internal.projectReturnIndexStage.resume,
          {
            projectId: input.projectId,
            owner,
            backupId: input.backupId,
            revision: candidateInfo.backup.preview.revision + 1,
            operationId: input.operationId,
          },
        );
        if (
          latest &&
          input.continuation &&
          (!priorStage ||
            latest.returnStep !== priorStage.returnStep ||
            latest.returnPrepareCursor !== priorStage.returnPrepareCursor ||
            latest.returnMetadataCursor !== priorStage.returnMetadataCursor ||
            latest.returnCursor !== priorStage.returnCursor)
        )
          return {
            pending: true,
            resumed: true,
            ...(latest.returnProgress ? { progress: latest.returnProgress } : {}),
          };
        return null;
      };
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
          resumed: !!(
            priorStage?.returnCursor ||
            priorStage?.returnMetadataCursor ||
            priorStage?.returnPrepareCursor
          ),
        };
      invariant(candidateInfo.backup.displayProtocol === 3, 'CLI_UPGRADE_REQUIRED', CLI_UPGRADE_MESSAGE);
      if (priorStage?.returnCursor || priorStage?.returnMetadataCursor)
        return pending(await returnProgress(ctx, priorStage, input, owner, undefined, started));
      console.log('source-return prepare', { revision: input.revision });
      const reader = exchangeObjectReader(ctx, true);
      const records =
        priorStage?.returnPrepareCursor || input.revision - previousInfo.backup.preview.revision >= 100
          ? undefined
          : await recordReturn(
              ctx,
              input,
              owner,
              reader,
              candidateInfo.backup,
              previousInfo.backup,
              priorStage?.returnAt,
              started,
            );
      if (records) return pending(records.receipt);
      const prepared = await prepareLargeReturn(
        ctx,
        input,
        owner,
        // Large compatibility reads consume each byte once per action. Avoid
        // retaining a second raw-history window beside the parsed candidate.
        exchangeObjectReader(ctx, false, 0),
        candidateInfo.backup,
        previousInfo.backup,
        priorStage,
        started,
      );
      if (prepared?.pending) return pending(null);
      const current =
        prepared?.current ?? (await load(ctx, input.projectId, owner, reader, { metadata: true }));
      if (!prepared)
        console.log('source-return prepare load done', {
          reason: 'complete-compatibility',
          revision: input.revision,
        });
      invariant(
        current.backup._id === input.expectedBackupId && current.data.revision === input.revision,
        'WORK_STALE',
        'Hosted source or Work changed. The uploaded checkpoint and current work remain available.',
      );
      const candidate = prepared?.candidate ?? (await source(ctx, input.backupId, owner, reader, true));
      if (!prepared) {
        console.log('source-return prepare source done', {
          reason: 'complete-compatibility',
          revision: input.revision,
        });
        validateSourceReturn(current.data, candidate.data, candidate.manifest);
      }
      console.log('source-return prepared', {
        objects: candidate.manifest.files.length,
        logicalBytes: candidate.manifest.files.reduce((sum, p) => sum + p.size, 0),
        views: candidate.data.views.length,
        lanes: candidate.data.lanes.length,
      });
      input.ownerDerived ??= candidate.backup.ownerDerived;
      const ownerDerived =
        candidate.manifest.kind === 'forge-native-work-backup'
          ? (candidate.publication?.ownerDerived ??
            (await readOwnerDerived(
              input.ownerDerived,
              async () => (await reader.read(input.projectId, owner, [input.ownerDerived!]))[0]!,
              pins => reader.read(input.projectId, owner, pins),
            )))
          : undefined;
      if (candidate.manifest.kind === 'forge-native-work-backup') requireOwnerDerived(ownerDerived);
      const command = sourceReturnSchema.parse({
          action: 'source-return',
          archiveSha256: candidate.backup.digest,
          workSha256: prepared?.records?.digest ?? workDigest(candidate.data),
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
      applyHostedEvent(
        candidate.data,
        {
          projectKey: current.project.key,
          archiveSha256: candidate.backup.digest,
          id: input.operationId,
          actor: owner,
          at,
          request,
          previousRevision: candidate.data.revision,
          command,
        },
        prepared?.records ? { sourceReturnDigest: prepared.records.digest } : {},
      );
      // Original Intent records were schema-validated page by page before
      // projection. Revalidate the remaining context and newly appended event.
      validateWorkSize(prepared?.records ? { ...candidate.data, intents: [] } : candidate.data);
      if (candidate.manifest.kind === 'forge-native-work-backup') {
        const generation: Doc<'projectWorkGenerations'> | null = await ctx.runQuery(
          internal.projectWorkIndexStore.current,
          { projectId: input.projectId, owner },
        );
        if (
          !generation ||
          (generation.backupId === input.expectedBackupId && generation.revision === input.revision)
        ) {
          invariant(
            generation || (ownerDerived as import('../src/owner-derived').OwnerDerived).complete,
            'WORK_STALE',
            'The display baseline changed. Prepare complete owner display data locally.',
          );
          const partitionId = await ctx.runMutation(internal.projectReturnIndexStage.begin, {
            projectId: input.projectId,
            owner,
            generationId: generation?._id,
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
            prepared?.before ?? current.data,
            candidate.data,
            candidate.manifest,
            ownerDerived as import('../src/owner-derived').OwnerDerived,
          );
          return pending(
            await returnProgress(
              ctx,
              stage,
              input,
              owner,
              {
                accounting: prepared?.accounting,
                records: prepared?.records,
                snapshot: {
                  data: candidate.data,
                  manifest: candidate.manifest,
                  backup: candidate.backup,
                },
                generationId: generation?._id,
                ownerDerived,
                metadataOnly: true,
                ...(!prepared && generation
                  ? {
                      generation,
                      previous: { data: current.data, manifest: current.manifest, backup: current.backup },
                    }
                  : {}),
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
              },
              started,
            ),
          );
        }
      }
      const projection =
        candidate.manifest.kind === 'forge-source-and-work'
          ? await gitReturnIndex(ctx, {
              projectId: input.projectId,
              owner,
              expectedBackupId: input.expectedBackupId,
              revision: input.revision,
              operationId: input.operationId,
              at,
              data: candidate.data,
              backup: candidate.backup,
              manifest: candidate.manifest,
            })
          : undefined;
      const changes = await returnChanges(
        reader,
        input.projectId,
        owner,
        prepared?.before ?? current.data,
        candidate.data,
        candidate.manifest,
        ownerDerived as import('../src/owner-derived').OwnerDerived,
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
      const code =
        error instanceof ForgeError
          ? error.code
          : error instanceof ConvexError && error.data && typeof error.data === 'object'
            ? (error.data as { code?: unknown }).code
            : undefined;
      if (raced && (code === 'WORK_STALE' || code === 'WORK_OPERATION_CHANGED')) {
        try {
          const recovered = await raced();
          if (recovered) return recovered;
        } catch (recoveryError) {
          return report(recoveryError);
        }
      }
      return report(error);
    }
  },
});
