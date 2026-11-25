// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// One-off purge of the retired Secret Objects (Item 41a0df87, slice 6). The Secret Object modules and the server
// keyring are gone, so nothing reads or writes these rows; this deletes them, and clears the retired state that other
// rows still carry, so the next landing can drop the tables and fields from the schema. Run each function with
// `apply: false` first: it writes nothing and reports what it would do. A run that finds nothing writes nothing, so a
// replay is free. Delete this file in the landing that drops the tables (docs/development.md, "Secret Object purge").
//
// There is no export path left: the owner's browser screens went before this slice and the export routes go with it.
// `purgeRows` therefore refuses to delete until the caller passes `reviewed: true`, and its dry run lists each
// object by name, repository, reference and version (never an owner or a value), so the owner can see that every
// one is synthetic, reissuable at its provider, or already held elsewhere.
//
// `purgeRows` reads and deletes at most `limit` rows in all (default 25, at most 100) and stops a table at
// BYTES_READ, whichever comes first, children before parents: events, grants, versions, deletion receipts, then the
// objects. Call again until it returns `more: false` with 0 deleted.
// `clearFields` reads one page of at most `limit` rows of one table (the same bounds) and clears the retired state from
// the rows that still hold it; call again with `after` set to the returned `next` until it is null.
// Never scheduled: idle costs nothing.
import { v } from 'convex/values';
import { internalMutation } from './server';
import { invariant } from '../src/errors';

const DEFAULT_LIMIT = 25,
  MAX_LIMIT = 100,
  /** A call reads at most about this many bytes of one table: far under Convex's per-transaction read limit. */
  BYTES_READ = 4 * 1024 * 1024,
  OBJECTS_LISTED = 20;
/** Children before parents, so a crash between pages never leaves a row naming a deleted object. */
const TABLES = [
  'secretEvents',
  'secretGrants',
  'secretVersions',
  'secretDeletions',
  'secretObjects',
] as const;
const RETIRED_KINDS = new Set(['secret', 'secrets']);
const withoutSecrets = (kinds: string[]) => kinds.filter(kind => kind !== 'secrets');

function checkLimit(limit: number) {
  invariant(
    Number.isInteger(limit) && limit >= 1 && limit <= MAX_LIMIT,
    'BAD_ARGUMENT',
    `limit is a whole number from 1 to ${MAX_LIMIT}.`,
  );
}

export const purgeRows = internalMutation({
  args: { apply: v.boolean(), reviewed: v.optional(v.boolean()), limit: v.optional(v.number()) },
  returns: v.object({
    counted: v.object({
      secretEvents: v.number(),
      secretGrants: v.number(),
      secretVersions: v.number(),
      secretDeletions: v.number(),
      secretObjects: v.number(),
    }),
    /** What the objects are, by name only, for the owner's review (a dry run lists them; an apply lists none). */
    objects: v.array(
      v.object({
        name: v.string(),
        repository: v.string(),
        ref: v.string(),
        version: v.number(),
        at: v.number(),
      }),
    ),
    deleted: v.number(),
    more: v.boolean(),
  }),
  handler: async (ctx, { apply, reviewed, limit = DEFAULT_LIMIT }) => {
    checkLimit(limit);
    invariant(
      !apply || reviewed === true,
      'BAD_ARGUMENT',
      'Pass "reviewed": true once the owner has seen the object list from the dry run: no export path remains.',
    );
    const counted = {
      secretEvents: 0,
      secretGrants: 0,
      secretVersions: 0,
      secretDeletions: 0,
      secretObjects: 0,
    };
    const objects: { name: string; repository: string; ref: string; version: number; at: number }[] = [];
    let budget = limit,
      deleted = 0,
      more = false;
    for (const table of TABLES) {
      if (budget === 0) {
        // A table not read yet may hold rows: ask for another call.
        more = true;
        break;
      }
      const page = await ctx.db
        .query(table)
        .paginate({ numItems: budget, cursor: null, maximumBytesRead: BYTES_READ });
      if (!page.isDone) more = true;
      counted[table] = page.page.length;
      budget -= page.page.length;
      if (!apply && table === 'secretObjects')
        for (const row of (page.page as { [k: string]: unknown }[]).slice(0, OBJECTS_LISTED))
          objects.push({
            name: String(row.name),
            repository: String(row.repository),
            ref: String(row.ref),
            version: Number(row.version),
            at: Number(row._creationTime),
          });
      if (apply) {
        for (const row of page.page) await ctx.db.delete(row._id);
        deleted += page.page.length;
      }
    }
    return { counted, objects, deleted, more };
  },
});

type Page = { scanned: number; holding: number; next: string | null };
const bounds = (after: string | null | undefined, limit: number) => ({
  cursor: after ?? null,
  numItems: limit,
  maximumBytesRead: BYTES_READ,
});

export const clearFields = internalMutation({
  args: {
    table: v.union(
      v.literal('agentGrants'),
      v.literal('forgeAccounts'),
      v.literal('accountOperations'),
      v.literal('accountItems'),
    ),
    apply: v.boolean(),
    limit: v.optional(v.number()),
    after: v.optional(v.union(v.string(), v.null())),
  },
  returns: v.object({
    scanned: v.number(),
    holding: v.number(),
    cleared: v.number(),
    next: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, { table, apply, limit = DEFAULT_LIMIT, after }) => {
    checkLimit(limit);
    const out: Page = { scanned: 0, holding: 0, next: null };
    if (table === 'agentGrants') {
      const page = await ctx.db.query('agentGrants').paginate(bounds(after, limit));
      for (const row of page.page)
        if (row.sealed !== undefined) {
          out.holding++;
          if (apply) await ctx.db.patch(row._id, { sealed: undefined });
        }
      out.scanned = page.page.length;
      out.next = page.isDone ? null : page.continueCursor;
    } else if (table === 'forgeAccounts') {
      const page = await ctx.db.query('forgeAccounts').paginate(bounds(after, limit));
      for (const row of page.page) {
        const closing = row.closing;
        // A close begun while secret grants existed resumes at its receipts, without the retired epoch.
        const retiredClose = !!closing && (closing.phase === 'secrets' || closing.below !== undefined);
        if (
          row.secretsReview === undefined &&
          row.secretsLeftBelow === undefined &&
          row.secretsLeftBefore === undefined &&
          !retiredClose
        )
          continue;
        out.holding++;
        if (!apply) continue;
        await ctx.db.patch(row._id, {
          secretsReview: undefined,
          secretsLeftBelow: undefined,
          secretsLeftBefore: undefined,
        });
        if (closing && retiredClose) {
          const resumed = closing.phase === 'secrets';
          await ctx.db.patch(row._id, {
            closing: {
              operationId: closing.operationId,
              at: closing.at,
              ...(closing.task ? { task: closing.task } : {}),
              phase: resumed ? ('receipts' as const) : closing.phase,
              cursor: resumed ? null : closing.cursor,
            },
          });
        }
      }
      out.scanned = page.page.length;
      out.next = page.isDone ? null : page.continueCursor;
    } else if (table === 'accountOperations') {
      const page = await ctx.db.query('accountOperations').paginate(bounds(after, limit));
      for (const row of page.page) {
        const retired =
          row.secretsBelow !== undefined ||
          row.secretsBefore !== undefined ||
          row.secretsDone !== undefined ||
          row.secretsCursor !== undefined ||
          row.secretsTask !== undefined ||
          row.leave.includes('secrets') ||
          row.captured.includes('secrets');
        if (!retired) continue;
        out.holding++;
        // The retired leave kind goes from the stored lists, so the follow-up validator no longer has to allow it.
        if (apply)
          await ctx.db.patch(row._id, {
            secretsBelow: undefined,
            secretsBefore: undefined,
            secretsDone: undefined,
            secretsCursor: undefined,
            secretsTask: undefined,
            leave: withoutSecrets(row.leave) as typeof row.leave,
            captured: withoutSecrets(row.captured) as typeof row.captured,
          });
      }
      out.scanned = page.page.length;
      out.next = page.isDone ? null : page.continueCursor;
    } else {
      const page = await ctx.db.query('accountItems').paginate(bounds(after, limit));
      for (const row of page.page) {
        // A Your data item for an object or grant that no longer exists: nothing is left to do, so it ends as done and
        // its receipt stops waiting on it (a receipt that waits on it would block closing the account).
        if (!RETIRED_KINDS.has(row.kind)) continue;
        const open = row.state !== 'completed' && row.state !== 'changed';
        if (!open && row.expected === undefined) continue;
        out.holding++;
        if (!apply) continue;
        await ctx.db.patch(row._id, { expected: undefined, state: 'completed' });
        const account = open ? await ctx.db.get(row.accountId) : null;
        if (account) {
          const pending = Math.max(0, account.pending - 1);
          await ctx.db.patch(account._id, {
            pending,
            stage: pending === 0 && account.stage === 'running' ? 'completed' : account.stage,
          });
        }
      }
      out.scanned = page.page.length;
      out.next = page.isDone ? null : page.continueCursor;
    }
    return { scanned: out.scanned, holding: out.holding, cleared: apply ? out.holding : 0, next: out.next };
  },
});
