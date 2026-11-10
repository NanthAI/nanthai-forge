// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { query } from './cliServer';
import { hostedRecordPage, readHostedRecord } from './projectHostedRecords';
import { hostedRecordsReadSchema, recordCollectionKinds } from '../src/hosted-record-read';
import { invariant } from '../src/errors';
import { report } from './errors';

/** One indexed page or one exact version, using the same current access and lifecycle overlays as
 * source operations. 100 heads / 128 KiB of indexed rows per page; O(page) record descriptors,
 * no body hydration on a list, writes, worker wakes or idle calls. Source bytes remain in R2. */
export const read = query({
  args: { projectId: v.id('hostedProjects'), request: v.string() },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read hosted Work records.');
      const command = hostedRecordsReadSchema.parse(JSON.parse(input.request));
      const kind = recordCollectionKinds[command.collection];
      if (command.id) {
        const row = await readHostedRecord(ctx, {
          projectId: input.projectId,
          actor: user.subject,
          kind,
          key: command.id,
          ...(command.version === undefined ? {} : { version: command.version }),
        });
        invariant(row, 'NOT_FOUND', 'Hosted Work record not found on this project.');
        return JSON.stringify({
          collection: command.collection,
          record: {
            id: row.key,
            kind,
            version: row.version,
            parentId: row.parent,
            status: row.status,
            source: { recordId: row._id, digest: row.digest, bytes: row.bytes },
            value: JSON.parse(row.value),
          },
        });
      }
      const page = await hostedRecordPage(ctx, {
        projectId: input.projectId,
        actor: user.subject,
        kind,
        ...(command.parentId === undefined ? {} : { parent: command.parentId }),
        ...(command.status === undefined ? {} : { status: command.status }),
        cursor: command.cursor,
      });
      const items = await Promise.all(
        page.page.map(async head => {
          const row = await ctx.db.get(head.recordId);
          invariant(
            row &&
              row.projectId === input.projectId &&
              row.kind === kind &&
              row.key === head.key &&
              row.version === head.version,
            'SOURCE_UNAVAILABLE',
            'A selected Work record descriptor is unavailable.',
          );
          return {
            id: head.key,
            kind,
            version: head.version,
            parentId: head.parent,
            status: head.status,
            source: { recordId: row._id, digest: row.digest, bytes: row.bytes },
          };
        }),
      );
      return JSON.stringify({
        collection: command.collection,
        items,
        nextCursor: page.isDone ? null : page.continueCursor,
        coverage: 'Each row pins its immutable version; this page is not a project-wide snapshot.',
      });
    } catch (error) {
      return report(error);
    }
  },
});
