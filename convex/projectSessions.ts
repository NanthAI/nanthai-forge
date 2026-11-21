// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import type { Doc } from './_generated/dataModel';
import { query } from './cliServer';
import { memberProject } from './projectAuthority';
import { maySeeDeviceName } from './accessPolicy';
import { invariant } from '../src/errors';
import { canonicalPayload } from '../src/hosted-source-operation';
import { report } from './errors';
import { SESSION_QUIET_MS } from '../src/session-presence';
/** One bounded presence page. A page count is never presented as the project's total. No heartbeat. */
export const read = query({
  args: {
    projectId: v.id('hostedProjects'),
    cursor: v.union(v.string(), v.null()),
    filters: v.optional(
      v.object({
        find: v.optional(v.string()),
        person: v.optional(v.string()),
        app: v.optional(v.string()),
        device: v.optional(v.string()),
        deviceId: v.optional(v.string()),
      }),
    ),
    activity: v.optional(v.boolean()),
    observedAt: v.optional(v.number()),
  },
  returns: v.string(),
  handler: async (ctx, { projectId, cursor, filters, activity, observedAt }) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'AUTH_REQUIRED', 'Sign in to see project sessions.');
      await memberProject(ctx, projectId, user.subject);
      const at = observedAt ?? Date.now();
      const cutoff = at - SESSION_QUIET_MS;
      // One agent run's own page reads its Lanes from convex/projectAgentRun.ts.
      const selection = ctx.db
        .query('projectHostedPresence')
        .withIndex('by_project_and_at', q => {
          const inProject = q.eq('projectId', projectId);
          // Clients pin the cut-off for the life of the cursor. Older clients read the original range.
          if (observedAt === undefined) return inProject;
          return activity ? inProject.lte('at', cutoff) : inProject.gt('at', cutoff);
        })
        .order('desc');
      const scoped =
        filters?.person || filters?.app || filters?.device || filters?.deviceId
          ? selection.filter(q =>
              q.and(
                ...(filters.person ? [q.eq(q.field('actor'), filters.person)] : []),
                ...(filters.app ? [q.eq(q.field('session.app'), filters.app)] : []),
                ...(filters.device ? [q.eq(q.field('session.device.code'), filters.device)] : []),
                ...(filters.deviceId ? [q.eq(q.field('session.device.id'), filters.deviceId)] : []),
              ),
            )
          : selection;
      const page = await scoped.paginate({
        numItems: 25,
        cursor,
        maximumRowsRead: 100,
        maximumBytesRead: 64 * 1024,
      });
      const find = filters?.find?.trim().toLowerCase();
      const rows = page.page.filter(
        row =>
          (activity ? row.at <= cutoff : observedAt === undefined || row.at > cutoff) &&
          (!find || row.agent?.toLowerCase().includes(find)),
      );
      // Private labels stay in account-owned credentials, never in shared source journals.
      const names = new Map<string, string>();
      const devices = new Map(
        rows.flatMap(row => {
          const device = row.session?.device;
          return device && maySeeDeviceName(user.subject, device.owner) ? [[device.id, device] as const] : [];
        }),
      );
      for (const [id, device] of devices) {
        const cached = (ctx as { forgeDevice?: Doc<'cliCredentials'> | null }).forgeDevice;
        const credential =
          cached?.credentialId === id
            ? cached
            : await ctx.db
                .query('cliCredentials')
                .withIndex('by_credentialId', q => q.eq('credentialId', id))
                .unique();
        if (
          credential?.owner === device.owner &&
          credential.deviceCode === device.code &&
          credential.deviceApprovedAt === device.approvedAt
        )
          names.set(id, credential.name);
      }
      const split = page.pageStatus === 'SplitRequired' ? page.splitCursor : undefined;
      return canonicalPayload({
        observedAt: at,
        continueCursor: split ?? page.continueCursor,
        isDone: !split && page.isDone,
        rows: rows.map(row => {
          const device = row.session?.device;
          return {
            laneId: row.laneId,
            intentId: row.intentId,
            person: row.actor,
            name: row.agent ?? null,
            title: row.goal,
            lastSeen: row.at,
            sessionId: row.session?.sessionId ?? null,
            startedAt: row.session?.startedAt ?? null,
            app: row.session?.app ?? null,
            identityFrom: row.session?.identityFrom ?? null,
            device: device
              ? {
                  id: device.id,
                  code: device.code,
                  approvedAt: device.approvedAt,
                  ...(names.has(device.id) ? { name: names.get(device.id) } : {}),
                }
              : null,
          };
        }),
      });
    } catch (error) {
      return report(error);
    }
  },
});
