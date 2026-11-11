// SPDX-License-Identifier: Apache-2.0
'use node';
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { action } from './cliServer';
import { getLandingCapsule } from './projectLandingCapsuleObject';
import { projectCapsuleRecovery } from './projectLandingCapsuleRecovery';
import { report } from './errors';
import { canonicalPayload } from '../src/hosted-source-operation';
import {
  capsuleObserveReply,
  capsuleStatusReply,
  capsuleAttemptsReply,
  capsuleInputSelection,
  capsuleInputsReply,
} from './projectLandingCapsuleProject';
import type { LandingCapsulePointer } from '../src/hosted-landing';
import { invariant } from '../src/errors';

type Marker = { protocol: 1; submissionId: string; pointer: LandingCapsulePointer };
type Context = {
  landingCapsule?: Marker;
  [key: string]: unknown;
};

/** Only this server action opens a capsule. The same public query authorizes before and after IO;
 * its live context is already redacted, and the action wrapper redacts the archived history. */
export const history = action({
  args: {
    projectId: v.id('hostedProjects'),
    query: v.union(
      v.literal('projectHostedFinishObserve:page'),
      v.literal('projectHostedLanding:status'),
      v.literal('projectHostedLanding:attempts'),
      v.literal('projectHostedLanding:candidate'),
      v.literal('projectHostedFinish:inputs'),
      v.literal('projectRecoveryHosted:page'),
    ),
    request: v.string(),
  },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, input) => {
    try {
      const command = JSON.parse(input.request);
      invariant(
        command && typeof command === 'object' && !Array.isArray(command),
        'BAD_ARGUMENT',
        'Select the original history request.',
      );
      const args = { ...command, projectId: input.projectId, capsuleProtocol: 1 };
      const reference = makeFunctionReference<'query'>(input.query);
      const first = await ctx.runQuery(reference, args);
      if (first === null) return null;
      const initial = JSON.parse(first) as Context;
      if (!initial.landingCapsule) return canonicalPayload(initial);
      const { pointer, submissionId } = initial.landingCapsule;
      const capsule = await getLandingCapsule(input.projectId, submissionId, pointer);
      invariant(capsule, 'SOURCE_UNAVAILABLE', 'The stored landing capsule is unavailable.');
      // Recheck current access and exact selected pointer, including revoked project/CLI access during IO.
      const latestText = await ctx.runQuery(reference, args);
      invariant(typeof latestText === 'string', 'WORK_STALE', 'Landing selection changed during the read.');
      const latest = JSON.parse(latestText) as Context;
      invariant(
        latest.landingCapsule?.submissionId === submissionId &&
          latest.landingCapsule.pointer.sha256 === pointer.sha256,
        'WORK_STALE',
        'Landing capsule selection changed during the read; retry the original request.',
      );
      const result = { ...latest };
      delete result.landingCapsule;
      let projected: Record<string, unknown>;
      if (input.query === 'projectRecoveryHosted:page') projected = projectCapsuleRecovery(capsule, result);
      else if (input.query === 'projectHostedFinishObserve:page')
        projected = capsuleObserveReply(capsule, result, command);
      else if (input.query === 'projectHostedLanding:attempts')
        projected = capsuleAttemptsReply(capsule, result, command);
      else if (input.query === 'projectHostedFinish:inputs') {
        const selection = capsuleInputSelection(capsule, result, command);
        const sources = selection.pins.length
          ? await ctx.runQuery(makeFunctionReference<'query'>('projectHostedLanes:states'), {
              projectId: input.projectId,
              laneIds: selection.pins.map(pin => pin.laneId),
              sourcePins: 1,
            })
          : [];
        projected = capsuleInputsReply(selection, result, command, sources);
      } else {
        const selected = capsuleStatusReply(capsule, result);
        projected = selected;
        if (input.query === 'projectHostedLanding:candidate' && selected.attempt.check) {
          projected.run = JSON.parse(
            await ctx.runQuery(makeFunctionReference<'query'>('projectHostedCheckRead:status'), {
              projectId: input.projectId,
              runId: selected.attempt.check.runId,
              features: ['ci-status-check'],
            }),
          );
        }
      }
      return canonicalPayload(projected);
    } catch (error) {
      return report(error);
    }
  },
});
