// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import type { Doc } from './_generated/dataModel';
import { query } from './cliServer';
import { memberProject } from './projectAuthority';
import { maySeeDeviceName } from './accessPolicy';
import { invariant } from '../src/errors';
import { canonicalPayload } from '../src/hosted-source-operation';
import { report } from './errors';
/** One bounded presence page. A page count is never presented as the project's total. No heartbeat. */
export const read = query({
  args: {
    projectId: v.id('hostedProjects'),
    cursor: v.union(v.string(), v.null()),
  },
  returns: v.string(),
  handler: async (ctx, { projectId, cursor }) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'AUTH_REQUIRED', 'Sign in to see project sessions.');
      await memberProject(ctx, projectId, user.subject);
      // One agent run's own page reads its Lanes from convex/projectAgentRun.ts.
      const selection = ctx.db
        .query('projectHostedPresence')
        .withIndex('by_project_and_at', q => q.eq('projectId', projectId))
        .order('desc');
      const page = await selection.paginate({
        numItems: 25,
        cursor,
        maximumRowsRead: 100,
        maximumBytesRead: 64 * 1024,
      });
      // Private labels stay in account-owned credentials, never in shared source journals.
      const names = new Map<string, string>();
      const devices = new Map(
        page.page.flatMap(row => {
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
      return canonicalPayload({
        observedAt: Date.now(),
        continueCursor: page.continueCursor,
        isDone: page.isDone,
        rows: page.page.map(row => {
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
