// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { query } from './cliServer';
import { accessibleProject } from './projectAuthority';
import { readHostedRecord } from './projectHostedRecords';
import { saveObject } from './projectHostedSaveStore';
import { hostedLaneSchema } from '../src/hosted-lane';
import { hostedRecordSchema } from '../src/hosted-records';
import { saveExpectedSchema } from '../src/hosted-save';
import { canonicalPayload } from '../src/hosted-source-operation';
import { invariant } from '../src/errors';
import { report } from './errors';

/** Exact selected canonical records and descriptors, never the Work/catalog.
 * Staging independently rechecks these versions, lifecycle, epoch and source pins. */
export const page = query({
  args: {
    projectId: v.id('hostedProjects'),
    inputs: v.array(
      v.object({
        laneId: v.string(),
        expected: v.optional(
          v.object({
            head: v.string(),
            version: v.number(),
            sourceVersion: v.number(),
            lifecycleVersion: v.number(),
          }),
        ),
      }),
    ),
    dependencies: v.array(v.object({ candidateId: v.string(), head: v.optional(v.string()) })),
  },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to select hosted source.');
      await accessibleProject(ctx, input.projectId, user.subject);
      invariant(
        input.inputs.length + input.dependencies.length <= 100,
        'BAD_ARGUMENT',
        'Select source in pages of at most 100.',
      );
      const auth = { projectId: input.projectId, actor: user.subject };
      const states = new Map<string, Awaited<ReturnType<typeof saveObject>>>();
      const state = async (head: string) => {
        if (!states.has(head)) states.set(head, await saveObject(ctx, input.projectId, { sha256: head }));
        return states.get(head)!;
      };
      const inputs = [];
      for (const item of input.inputs) {
        const row = await readHostedRecord(ctx, { ...auth, kind: 'lane', key: item.laneId });
        invariant(row, 'NOT_FOUND', 'Hosted Lane not found on this project.');
        const lane = hostedLaneSchema.parse(JSON.parse(row.value));
        const expected = saveExpectedSchema.parse({
          head: lane.head,
          version: lane.version,
          sourceVersion: lane.sourceVersion,
          lifecycleVersion: lane.lifecycleVersion,
        });
        invariant(
          !item.expected || canonicalPayload(item.expected) === canonicalPayload(expected),
          'WORK_STALE',
          'The selected Lane pins changed.',
        );
        inputs.push({
          intentId: lane.intentId,
          entry: {
            laneId: lane.id,
            ...expected,
            state: await state(lane.head),
          },
        });
      }
      const dependencies = [];
      for (const item of input.dependencies) {
        const row = await readHostedRecord(ctx, { ...auth, kind: 'candidate', key: item.candidateId });
        invariant(row, 'NOT_FOUND', 'Candidate not found.');
        const candidate = hostedRecordSchema.options[3].parse(JSON.parse(row.value));
        invariant(
          candidate.result.status === 'clean' && (!item.head || candidate.result.head === item.head),
          'VIEW_STALE',
          'Select an exact clean dependency Candidate.',
        );
        dependencies.push({
          intentId: candidate.intentId,
          entry: {
            candidateId: candidate.id,
            head: candidate.result.head,
            state: await state(candidate.result.head),
          },
        });
      }
      return canonicalPayload({ inputs, dependencies });
    } catch (error) {
      return report(error);
    }
  },
});
