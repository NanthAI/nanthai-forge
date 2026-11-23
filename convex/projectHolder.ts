// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { v } from 'convex/values';
import { query } from './cliServer';
import { memberProject } from './projectAuthority';
import { readHostedRecord } from './projectHostedRecords';
import { hostedLaneSchema, hostedIntentSchema } from '../src/hosted-lane';
import { sourceAuthority } from '../src/hosted-source-authority';
import { canonicalPayload } from '../src/hosted-source-operation';
import { effectivePolicy } from '../src/autonomy-policy';
import { mayTakeLane, takeoverNeedsReason } from './accessPolicy';
import { digest } from '../src/state/hash';
import { PRESENCE } from '../src/presence';
import { invariant } from '../src/errors';
import { report } from './errors';
export const read = query({
  args: { projectId: v.id('hostedProjects'), laneId: v.string() },
  returns: v.string(),
  handler: async (ctx, { projectId, laneId }) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'AUTH_REQUIRED', 'Sign in to read a holder.');
      const actor = user.subject,
        project = await memberProject(ctx, projectId, actor);
      const record = await readHostedRecord(ctx, { projectId, actor, kind: 'lane', key: laneId });
      invariant(record, 'NOT_FOUND', 'Lane not found.');
      const lane = hostedLaneSchema.parse(JSON.parse(record.value));
      const intent = await readHostedRecord(ctx, { projectId, actor, kind: 'intent', key: lane.intentId });
      const session = (user as { forgeAuthSession?: string }).forgeAuthSession;
      const now = Date.now();
      return canonicalPayload({
        laneId,
        title: intent ? hostedIntentSchema.parse(JSON.parse(intent.value)).outcome : lane.id,
        head: lane.head,
        version: lane.version,
        state: lane.state,
        authorityEpoch: sourceAuthority(project).epoch,
        holder: lane.holder ?? null,
        at: now,
        canTake: mayTakeLane(actor, lane.actor, project.owner),
        needsReason: takeoverNeedsReason(
          Boolean(lane.holder && now - lane.holder.lastSeen <= PRESENCE.workingMs),
        ),
        browserSessionId: session ? digest(`forge-browser:${session}`) : null,
        enabled: effectivePolicy(project).accessIdentities?.laneHolders === true,
      });
    } catch (error) {
      return report(error);
    }
  },
});
