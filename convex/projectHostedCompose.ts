import { sourceProgress } from './projectSourceProgress';
import { semanticPayload } from '../src/semantic-payload';
import {
  mainSemanticMembers,
  mergeSemanticMembers,
  semanticMember,
  semanticBaseSequence,
} from './projectSemanticContracts';
// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { mutation, query, type MutationCtx, type QueryCtx } from './cliServer';
import type { Id } from './_generated/dataModel';
import { activeProject } from './projectAuthority';
import { readHostedRecord } from './projectHostedRecords';
import { beginHostedOperation } from './projectHostedOperations';
import { hostedStartMain } from './projectHostedChannels';
import { saveLaneRecord, sameSaveLane, saveObject } from './projectHostedSaveStore';
import {
  composeRow,
  loadCompose,
  writeComposeState,
  hostedComposeInput,
  type ComposeState,
  composeStateSchema,
} from './projectHostedComposeStore';
import {
  composeRequestSchema,
  validateComposePage,
  composeLaneSchema,
  composeDependencySchema,
} from '../src/hosted-compose';
import { hostedRecordSchema } from '../src/hosted-records';
import { canonicalPayload, hostedPayloadHash } from '../src/hosted-source-operation';
import { savePin } from '../src/hosted-save';
import { invariant } from '../src/errors';
import { report } from './errors';
const identity = { projectId: v.id('hostedProjects'), operationId: v.string() };
async function caller(
  ctx: QueryCtx | MutationCtx,
  input: { projectId: Id<'hostedProjects'>; operationId: string },
) {
  const user = await ctx.auth.getUserIdentity();
  invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to compose hosted source.');
  await activeProject(ctx, input.projectId, user.subject);
  return { projectId: input.projectId, operationId: input.operationId, actor: user.subject };
}
export const prepare = mutation({
  args: { projectId: v.id('hostedProjects'), request: v.string() },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const request = composeRequestSchema.parse(JSON.parse(input.request)),
        auth = await caller(ctx, { projectId: input.projectId, operationId: request.operationId });
      const expected = {
        authorityEpoch: request.authorityEpoch,
        head: request.expectedMain.head,
        receiptId: request.expectedMain.receiptId,
      };
      const prepared = await beginHostedOperation(ctx, {
        ...auth,
        payload: request,
        request: { schema: 1, ...auth, expected, payloadHash: hostedPayloadHash(request, expected) },
        firstAttempt: {
          projectId: auth.projectId,
          operationId: auth.operationId,
          id: crypto.randomUUID(),
          parentAttemptId: null,
          at: new Date().toISOString(),
          expected,
          ids: {
            candidate: crypto.randomUUID(),
            job: crypto.randomUUID(),
            jobOperation: crypto.randomUUID(),
          },
        },
      });
      if (prepared.replayed) {
        const old = await composeRow(ctx, auth);
        invariant(old, 'SOURCE_UNAVAILABLE', 'The original composition is unavailable.');
        return canonicalPayload({
          state: composeStateSchema.parse(JSON.parse(old.value)),
          terminal: prepared.operation.terminal,
        });
      }
      const main = await hostedStartMain(ctx, input.projectId);
      invariant(
        main.head === request.expectedMain.head &&
          main.receipt.id === request.expectedMain.receiptId &&
          main.authority.epoch === request.authorityEpoch,
        'CHANNEL_CHANGED',
        'Compose against the exact observed main head and receipt.',
      );
      const intent = await readHostedRecord(ctx, { ...auth, kind: 'intent', key: request.intentId });
      invariant(intent, 'NOT_FOUND', 'Hosted Intent not found on this project.');
      const peers = await mainSemanticMembers(ctx, auth, request.expectedMain.receiptId);
      const ownIntent = hostedRecordSchema.options[0].parse(JSON.parse(intent.value));
      const afterSequence = peers.length
        ? await semanticBaseSequence(ctx, input.projectId, ownIntent.base.receiptId)
        : 0;
      const state: ComposeState = {
        ...(peers.length
          ? { semanticPlan: { primaryIntentId: request.intentId, afterSequence, members: peers } }
          : {}),
        request,
        ownerInputs: true,
        main: await saveObject(ctx, input.projectId, { sha256: main.head }),
        inputs: { next: request.inputs.root, pages: 0, count: 0 },
        dependencies: { next: request.dependencies.root, pages: 0, count: 0 },
        candidateId: prepared.operation.firstAttempt.ids.candidate!,
        jobOperationId: prepared.operation.firstAttempt.ids.jobOperation!,
        status: 'staging',
      };
      await ctx.db.insert('projectHostedComposes', {
        ...auth,
        jobId: prepared.operation.firstAttempt.ids.job!,
        value: semanticPayload(state),
      });
      return canonicalPayload({ state, terminal: null });
    } catch (error) {
      return report(error);
    }
  },
});
export const stage = mutation({
  args: {
    ...identity,
    kind: v.union(v.literal('inputs'), v.literal('dependencies')),
    index: v.number(),
    page: v.string(),
  },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const auth = await caller(ctx, input),
        { row, state, operation, project } = await loadCompose(ctx, auth);
      const page = validateComposePage(JSON.parse(input.page)),
        pin = savePin(page),
        progress = state[input.kind],
        manifest = state.request[input.kind];
      const old = await ctx.db
        .query('projectHostedComposePages')
        .withIndex('by_project_and_actor_and_operation_and_kind_and_index', q =>
          q
            .eq('projectId', auth.projectId)
            .eq('actor', auth.actor)
            .eq('operationId', auth.operationId)
            .eq('kind', input.kind)
            .eq('index', input.index),
        )
        .unique();
      if (old) {
        invariant(old.digest === pin.sha256, 'WORK_OPERATION_CHANGED', 'Retry the original compose page.');
        return canonicalPayload(state);
      }
      invariant(
        !operation.terminal &&
          state.status === 'staging' &&
          input.index === progress.pages &&
          canonicalPayload(progress.next) === canonicalPayload(pin),
        'WORK_OPERATION_CHANGED',
        'Stage the next original compose page.',
      );
      await saveObject(ctx, input.projectId, pin);
      const contractMembers = new Map<string, Awaited<ReturnType<typeof semanticMember>>>();
      for (const value of page.entries) {
        const entry = (input.kind === 'inputs' ? composeLaneSchema : composeDependencySchema).parse(value);
        const key = 'laneId' in entry ? entry.laneId : entry.candidateId;
        const duplicate = await ctx.db
          .query('projectHostedComposeSelections')
          .withIndex('by_project_and_actor_and_operation_and_kind_and_key', q =>
            q
              .eq('projectId', auth.projectId)
              .eq('actor', auth.actor)
              .eq('operationId', auth.operationId)
              .eq('kind', input.kind)
              .eq('key', key),
          )
          .unique();
        invariant(!duplicate || input.kind === 'dependencies', 'BAD_ARGUMENT', 'Select each Lane once.');
        if ('laneId' in entry) {
          const { lane, ownerOnly } = await saveLaneRecord(ctx, { ...auth, laneId: entry.laneId });
          state.ownerInputs = state.ownerInputs === true && lane.actor === project.owner && ownerOnly;
          invariant(
            lane.intentId === state.request.intentId && sameSaveLane(lane, entry),
            'WORK_STALE',
            'Selected Lane changed or belongs to another Intent.',
          );
          if (lane.restoreBase)
            state.restoreBases = {
              ...state.restoreBases,
              [lane.id]: await saveObject(ctx, input.projectId, { sha256: lane.restoreBase }),
            };
          invariant(
            lane.resolution?.status !== 'pending',
            'CONFLICT_MARKERS',
            'Complete the pinned resolution before composing its Lane.',
          );
        } else {
          const row = await readHostedRecord(ctx, { ...auth, kind: 'candidate', key: entry.candidateId });
          invariant(row, 'NOT_FOUND', 'Pinned dependency Candidate is unavailable.');
          const candidate = hostedRecordSchema.parse(JSON.parse(row.value));
          invariant(
            candidate.kind === 'candidate' &&
              candidate.result.status === 'clean' &&
              candidate.result.head === entry.head,
            'WORK_STALE',
            'Select the exact clean dependency Candidate.',
          );
          state.ownerInputs = state.ownerInputs === true && candidate.governance?.ownerInputs === true;
          if (!contractMembers.has(candidate.intentId))
            contractMembers.set(candidate.intentId, await semanticMember(ctx, auth, candidate.intentId));
          const member = contractMembers.get(candidate.intentId);
          const semantic = mergeSemanticMembers(
            state.request.intentId,
            state.semanticPlan?.members,
            candidate.semanticPlan?.members,
            member ? [member] : [],
          );
          if (semantic.members.length)
            state.semanticPlan = { ...semantic, afterSequence: state.semanticPlan?.afterSequence ?? 0 };
        }
        const registered = await ctx.db
          .query('projectHostedStates')
          .withIndex('by_project_and_head', q => q.eq('projectId', input.projectId).eq('head', entry.head))
          .unique();
        invariant(
          registered || entry.head === state.main.object.sha256,
          'SOURCE_UNAVAILABLE',
          'The selected State needs trusted source registration.',
        );
        const stored = await saveObject(ctx, input.projectId, { sha256: entry.head });
        invariant(
          canonicalPayload(stored) === canonicalPayload(entry.state) &&
            (!registered || registered.size === stored.object.size),
          'SOURCE_HASH_MISMATCH',
          'Compose State differs from its committed registered binding.',
        );
        if (!duplicate)
          await ctx.db.insert('projectHostedComposeSelections', { ...auth, kind: input.kind, key });
      }
      const next = {
        next: page.next,
        pages: progress.pages + 1,
        count: progress.count + page.entries.length,
      };
      invariant(
        next.pages <= manifest.pages &&
          next.count <= manifest.count &&
          (page.next === null) === (next.pages === manifest.pages) &&
          (page.next !== null || next.count === manifest.count),
        'WORK_OPERATION_CHANGED',
        'Compose page counts differ from preparation.',
      );
      state[input.kind] = next;
      if (state.inputs.next === null && state.dependencies.next === null) state.status = 'ready';
      await ctx.db.insert('projectHostedComposePages', {
        ...auth,
        kind: input.kind,
        index: input.index,
        digest: pin.sha256,
      });
      await writeComposeState(ctx, row._id, state);
      return canonicalPayload(state);
    } catch (error) {
      return report(error);
    }
  },
});
export const progress = query({
  args: identity,
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const auth = await caller(ctx, input),
        { row, state, operation } = await loadCompose(ctx, auth, false);
      return canonicalPayload({
        ...(state.status === 'submitted' || state.status === 'failed'
          ? await sourceProgress(ctx, input.projectId, row.jobId)
          : {}),
        ...(operation.terminal?.outcome.status === 'failed'
          ? { status: 'failed', error: operation.terminal.outcome.error }
          : {}),
        state,
        terminal: operation.terminal,
        input: state.status === 'staging' ? null : hostedComposeInput(state, operation.firstAttempt.at),
      });
    } catch (error) {
      return report(error);
    }
  },
});
export const candidate = query({
  args: { projectId: v.id('hostedProjects'), candidateId: v.string() },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read a Candidate.');
      const row = await readHostedRecord(ctx, {
        ...input,
        actor: user.subject,
        kind: 'candidate',
        key: input.candidateId,
      });
      invariant(row, 'NOT_FOUND', 'Candidate not found.');
      return row.value;
    } catch (error) {
      return report(error);
    }
  },
});
