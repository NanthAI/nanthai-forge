// SPDX-License-Identifier: Apache-2.0
'use node';
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { action } from './cliServer';
import { r2Config, presignGet } from './r2';
import { report } from './errors';
import { exchangeRequest } from '../src/exchange-request';
import { canonicalPayload } from '../src/hosted-source-operation';
import { decodeLandingCapsule } from '../src/landing-capsule-bytes';
import {
  capsuleObserveReply,
  capsuleStatusReply,
  capsuleAttemptsReply,
  capsuleInputSelection,
  capsuleInputsReply,
} from './projectLandingCapsuleProject';
import type { LandingCapsulePointer } from '../src/hosted-landing';
import { observeExchangeResponse } from '../src/exchange-observation-hooks';
import { invariant } from '../src/errors';

type Marker = { protocol: 1; submissionId: string; pointer: LandingCapsulePointer };
type Context = {
  landingCapsule?: Marker;
  [key: string]: unknown;
};

/** A content pin is an exact size check, not a history quota. Never buffer bytes beyond that pin. */
async function readObject(response: Response, expected: number, progressed: () => void) {
  invariant(response.ok && response.body, 'SOURCE_UNAVAILABLE', 'The stored landing capsule is unavailable.');
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > expected) await reader.cancel();
      invariant(size <= expected, 'EVIDENCE_CHANGED', 'Landing capsule bytes exceed their verified size.');
      chunks.push(part.value);
      observeExchangeResponse(part.value.length);
      progressed();
    }
  } finally {
    reader.releaseLock();
  }
  invariant(size === expected, 'EVIDENCE_CHANGED', 'Landing capsule bytes differ from their verified size.');
  return Buffer.concat(chunks, size);
}

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
      invariant(
        /^[a-f0-9]{64}$/.test(pointer.sha256),
        'EVIDENCE_CHANGED',
        'Landing capsule content pin is invalid.',
      );
      const key = `v1/p/${input.projectId}/landing-capsules/${pointer.sha256}`;
      const url = await presignGet(r2Config(), key);
      const body = await exchangeRequest(
        'Landing capsule read',
        url,
        {
          headers: { 'accept-encoding': 'identity' },
        },
        (response, progressed) => readObject(response, pointer.size, progressed),
      );
      const capsule = decodeLandingCapsule(body, pointer, input.projectId, submissionId);
      // Recheck current access and exact selected pointer, including revoked project/CLI access during IO.
      const latest = JSON.parse(await ctx.runQuery(reference, args)) as Context;
      invariant(
        latest.landingCapsule?.submissionId === submissionId &&
          latest.landingCapsule.pointer.sha256 === pointer.sha256,
        'WORK_STALE',
        'Landing capsule selection changed during the read; retry the original request.',
      );
      const result = { ...latest };
      delete result.landingCapsule;
      let projected: Record<string, unknown>;
      if (input.query === 'projectHostedFinishObserve:page')
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
