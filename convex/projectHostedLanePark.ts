// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { mutation } from './cliServer';
import { hostedWriteProject, readHostedRecord, writeHostedRecord } from './projectHostedRecords';
import { projectRole } from './projectRole';
import { hostedLaneSchema } from '../src/hosted-lane';
import { agentActor, isAgentSlug } from '../src/agent-slug';
import { PARK_REASON_CHARS, parkedFor, samePark, type LanePark } from '../src/hosted-records';
import { canonicalPayload } from '../src/hosted-source-operation';
import { invariant } from '../src/errors';
import { report } from './errors';

const NAME_HOLDER =
  'Name a person (@handle) or their agent run (handle/word-word) who can read this project.';

/** Park a Lane (Item e1633718; CLI `save {park}`): who it waits on and why, as one optional field on the Lane record
 * (mirrored on its presence row, so the holder's Needs me lists it), or clear it with `park: null`. The Lane's
 * starter, its current holder or the project owner may park it; the person a park names may clear it (with write
 * access, like every Lane write). A named holder must already hold a role on the
 * project (owner, write or read): an unknown handle and a handle without access are refused alike, so a park never
 * probes accounts and never shows a Lane to someone who cannot read it. One Lane read, at most two reads for the
 * holder, and one record write; a repeat with the same holder and reason writes nothing. */
export const set = mutation({
  args: {
    projectId: v.id('hostedProjects'),
    authorityEpoch: v.number(),
    laneId: v.string(),
    /** The caller's agent run slug, when an agent parks (shown as `handle/slug`). */
    agent: v.optional(v.string()),
    park: v.union(v.null(), v.object({ holder: v.optional(v.string()), reason: v.string() })),
  },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to change hosted work.');
      const actor = user.subject;
      const project = await hostedWriteProject(ctx, input.projectId, actor, input.authorityEpoch);
      const current = await readHostedRecord(ctx, {
        projectId: input.projectId,
        actor,
        kind: 'lane',
        key: input.laneId,
      });
      invariant(current, 'NOT_FOUND', 'Hosted Lane not found on this project.');
      const lane = hostedLaneSchema.parse(JSON.parse(current.value));
      // The person a park names may release it (as a requested reviewer can dismiss the request), never re-park it.
      const named = input.park === null && !!lane.park?.to && parkedFor(lane.park, lane.actor) === actor;
      invariant(
        actor === lane.actor || actor === lane.holder?.actor || actor === project.owner || named,
        'PROJECT_UNAVAILABLE',
        'The person who started this Lane, its holder or the project owner may park it; the person it names may clear it.',
      );
      let next: LanePark | undefined;
      if (input.park) {
        invariant(lane.state === 'active', 'BAD_ARGUMENT', 'Only an open Lane can be parked.');
        const reason = input.park.reason.replace(/\s+/g, ' ').trim();
        invariant(
          reason.length >= 1 && reason.length <= PARK_REASON_CHARS,
          'BAD_ARGUMENT',
          `park.reason: give why it waits, in at most ${PARK_REASON_CHARS} characters.`,
        );
        let to: string | undefined;
        if (input.park.holder) {
          const [handle, slug, extra] = input.park.holder.trim().replace(/^@/, '').toLowerCase().split('/');
          invariant(
            handle && extra === undefined && (slug === undefined || isAgentSlug(slug)),
            'BAD_ARGUMENT',
            NAME_HOLDER,
          );
          const account = await ctx.db
            .query('accountHandles')
            .withIndex('by_handle', q => q.eq('handle', handle))
            .unique();
          invariant(account && (await projectRole(ctx, project, account.owner)), 'BAD_ARGUMENT', NAME_HOLDER);
          to = agentActor(account.owner, slug);
        }
        const by = agentActor(actor, input.agent);
        const same = lane.park && lane.park.to === to && lane.park.reason === reason;
        next = same ? lane.park : { ...(to ? { to } : {}), reason, at: Date.now(), by };
      }
      const result = (changed: boolean, version: number) =>
        canonicalPayload({ laneId: lane.id, park: next ?? null, changed, version });
      if (samePark(next, lane.park)) return result(false, lane.version);
      const { park, ...rest } = lane;
      void park;
      await writeHostedRecord(ctx, {
        projectId: input.projectId,
        actor,
        authorityEpoch: input.authorityEpoch,
        expectedVersion: lane.version,
        record: {
          ...rest,
          ...(next ? { park: next } : {}),
          version: lane.version + 1,
          at: new Date().toISOString(),
        },
      });
      return result(true, lane.version + 1);
    } catch (error) {
      return report(error);
    }
  },
});
