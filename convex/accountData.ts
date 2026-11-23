// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
/** Account > Your data reads (reviews 8e86eb09, ae15c5ca). Person-only: accountActor refuses every device, agent and
 * legacy CLI credential before an account row is read.
 *
 * - `overview`: the one read on open. The first OVERVIEW_SHOWN rows of each owned kind by its owner index, projected
 *   from the rows themselves (no second read per row, no provider call), with safe labels, plus the latest receipts.
 *   Labels never carry a repository location: a location needs a fresh provider check, which only the export (the
 *   inventory action, on press) pays for.
 * - `owned`: one page of one owned kind with its pins, for the review before a cleanup.
 * - `review`: the one write of a review (on press): issues the review epoch its token starts from.
 * - `shared`: one page of what others shared with the person that they can see, for the review, and the token that
 *   binds the cleanup to exactly that review (accountActions.begin re-reads the same pages and refuses on any
 *   difference). The token is the review's epoch and a digest of the shown rows only. Secret grants are never read
 *   here: leaving them is bound to the review's epoch instead (accountExecute.leaveSecrets), so no reply, token, page
 *   boundary or refusal depends on a hidden grant.
 * - `watch`: reactive marks of the resources a cleanup is waiting on (accountResources.resourceMark), compared with
 *   the marks its last step returned, so the page advances when one of them changes instead of on a timer. It re-runs
 *   only when those rows are written; nothing runs while the tab is idle.
 *
 * Bounds (accountResources PAGE_BYTES, LABEL_MAX): no Convex paginated query anywhere (index-key cursors). overview:
 * per kind at most OVERVIEW_SHOWN + 1 rows or OVERVIEW_BYTES plus one document, and RECEIPTS_SHOWN receipts; owned:
 * OWNED_PAGE rows or PAGE_BYTES plus one document; shared: SHARED_PAGE grants and their parents, about twice PAGE_BYTES
 * plus one parent at most; watch: at most WATCH_MAX resources or WATCH_BYTES plus one resource, answering for the
 * prefix it read. Replies carry ids, pins, marks and clipped labels only. */
import { v, getDocumentSize } from 'convex/values';
import { accountMutation, query } from './cliServer';
import { ensureAccount } from './urlIdentity';
import { nextReview } from './secretGrantAuthority';
import {
  accountActor,
  clip,
  ownedPage,
  ownedProjection,
  incomingPage,
  incomingLink,
  incomingStart,
  publicCursor,
  serverCursor,
  PAGE_BYTES,
  resourceMark,
  type ResourceKind,
} from './accountResources';
import { accountReceipt, resourceKind, sharedKind } from './accountTypes';
import { metadataBytes } from './accountMetadata';
import { digest } from '../src/state/hash';
import { invariant } from '../src/errors';
import { report } from './errors';

export const OVERVIEW_SHOWN = 10;
export const RECEIPTS_SHOWN = 10;
export const OWNED_PAGE = 100;
/** Per kind on open: enough for OVERVIEW_SHOWN ordinary rows many times over. */
export const OVERVIEW_BYTES = 32 * 1024;
export const WATCH_MAX = 50;
/** One watch reads at most this much (plus the last resource it marks); the page chains watches to cover the rest. */
export const WATCH_BYTES = 512 * 1024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export const KINDS = ['project', 'import', 'secret', 'agent', 'team', 'view', 'interest'] as const;

const ownedRow = v.object({
  id: v.string(),
  pin: v.string(),
  label: v.string(),
  /** A removed project: in the trash, or its deletion already running. */
  note: v.optional(v.union(v.literal('trash'), v.literal('deleting'))),
});
const sharedRow = v.object({ id: v.string(), label: v.string() });

/** A label safe to show without a provider check: names, never repository locations. */
function label(kind: ResourceKind, m: Record<string, unknown>): string {
  const name = typeof m.name === 'string' ? m.name : '';
  const locations = [
    m.repository,
    m.ref,
    m.sourceId,
    m.gitHead,
    (m.route as { file?: unknown } | undefined)?.file,
    (m.route as { symbol?: unknown } | undefined)?.symbol,
    ...(Array.isArray(m.files) ? m.files : []),
  ].filter((x): x is string => typeof x === 'string' && x.length > 0);
  const safe = name && !/[\\/]/.test(name) && !locations.some(x => name.includes(x)) ? name : '';
  if (kind === 'project' || kind === 'team') return clip(name);
  if (kind === 'secret') return clip(safe) || 'Secret';
  if (kind === 'agent') return clip(safe) || 'Agent grant';
  if (kind === 'view') return clip(safe) || 'Saved view';
  if (kind === 'import') return 'Private repository import';
  return 'Watched repository';
}
function rowsOf(kind: ResourceKind, page: unknown[], actor: string) {
  return page.flatMap(r => {
    const m = ownedProjection(kind, r as Record<string, unknown> & { _id: string }, actor);
    // A permanently deleted project is a tombstone with nothing left in it: neither held nor deletable.
    if (!m || ('removal' in m && m.removal === 'deleted')) return [];
    const note =
      'removal' in m && (m.removal === 'trash' || m.removal === 'deleting') ? m.removal : undefined;
    return [{ id: m.id, pin: digest(metadataBytes(m)), label: label(kind, m), ...(note ? { note } : {}) }];
  });
}

export const overview = query({
  args: {},
  returns: v.object({
    kinds: v.array(v.object({ kind: resourceKind, rows: v.array(ownedRow), more: v.boolean() })),
    receipts: v.array(accountReceipt),
  }),
  handler: async ctx => {
    try {
      const actor = await accountActor(ctx);
      const kinds = await Promise.all(
        KINDS.map(async kind => {
          const p = await ownedPage(ctx, kind, actor, {
            cursor: null,
            numItems: OVERVIEW_SHOWN + 1,
            maximumBytesRead: OVERVIEW_BYTES,
          });
          const rows = rowsOf(kind, p.page, actor);
          return {
            kind,
            rows: rows.slice(0, OVERVIEW_SHOWN),
            more: rows.length > OVERVIEW_SHOWN || !p.isDone,
          };
        }),
      );
      const receipts = await ctx.db
        .query('accountOperations')
        .withIndex('by_owner', q => q.eq('owner', actor))
        .order('desc')
        .take(RECEIPTS_SHOWN);
      return {
        kinds,
        receipts: receipts.map(r => ({
          operationId: r.operationId,
          request: r.request,
          stage: r.stage,
          at: r.at,
          kept: r.kept ?? 0,
        })),
      };
    } catch (e) {
      return report(e);
    }
  },
});

export const owned = query({
  args: { kind: resourceKind, cursor: v.union(v.string(), v.null()) },
  returns: v.object({ rows: v.array(ownedRow), isDone: v.boolean(), continueCursor: v.string() }),
  handler: async (ctx, { kind, cursor }) => {
    try {
      const actor = await accountActor(ctx);
      const p = await ownedPage(ctx, kind, actor, {
        cursor: serverCursor(cursor, actor),
        numItems: OWNED_PAGE,
        maximumBytesRead: PAGE_BYTES,
      });
      return {
        rows: rowsOf(kind, p.page, actor),
        isDone: p.isDone,
        continueCursor: publicCursor(p.continueCursor),
      };
    } catch (e) {
      return report(e);
    }
  },
});

/** Starts a review: issues the person's next review epoch (secretGrantAuthority.nextReview) and the token the review's
 * first shared page chains from. The one write of a review, on press, never on open; a retry with the same `review`
 * id returns the same token. Secret grants given before this write fall under the review, any given after it do not,
 * whatever the clock (reviews s1-sol62 r4 #1, s1-astra62 r4 #3). */
export const review = accountMutation('person')({
  args: { review: v.string() },
  returns: v.object({ token: v.string() }),
  handler: async (ctx, { review }) => {
    try {
      invariant(UUID.test(review), 'BAD_ARGUMENT', 'Start each review with a fresh UUID.');
      const account = await ensureAccount(ctx, await accountActor(ctx));
      return { token: incomingStart(await nextReview(ctx, account, review)) };
    } catch (e) {
      return report(e);
    }
  },
});

export const shared = query({
  args: {
    kind: sharedKind,
    cursor: v.union(v.string(), v.null()),
    /** The chain so far: on the first page, the token `review` issued. */
    token: v.string(),
  },
  returns: v.object({
    rows: v.array(sharedRow),
    token: v.string(),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, { kind, cursor, token }) => {
    try {
      const actor = await accountActor(ctx);
      const p = await incomingPage(ctx, kind, actor, serverCursor(cursor, actor));
      return {
        rows: p.shown,
        token: incomingLink(token, kind, p.bound),
        isDone: p.isDone,
        continueCursor: publicCursor(p.continueCursor),
      };
    } catch (e) {
      return report(e);
    }
  },
});

export const watch = query({
  args: { operationId: v.string(), resources: v.array(v.object({ kind: resourceKind, id: v.string() })) },
  returns: v.object({
    stage: v.string(),
    marks: v.array(v.object({ kind: resourceKind, id: v.string(), mark: v.string() })),
  }),
  handler: async (ctx, { operationId, resources }) => {
    try {
      invariant(
        resources.length <= WATCH_MAX,
        'BAD_ARGUMENT',
        `Watch at most ${WATCH_MAX} resources at once.`,
      );
      const actor = await accountActor(ctx);
      const account = await ctx.db
        .query('accountOperations')
        .withIndex('by_owner_and_operation', q => q.eq('owner', actor).eq('operationId', operationId))
        .unique();
      invariant(account, 'ACCOUNT_UNAVAILABLE', 'This Forge data operation is unavailable.');
      const marks = [];
      let bytes = 0;
      for (const { kind, id } of resources) {
        // Byte-capped (review fdd5e2f4): a resource can be a 1 MiB row. The marks come back for a prefix; the page
        // watches the rest with the next watch, from where this one stopped.
        if (marks.length && bytes >= WATCH_BYTES) break;
        // Only resources this operation selected: the watch never reads anyone else's rows.
        const item = await ctx.db
          .query('accountItems')
          .withIndex('by_account_and_key', q => q.eq('accountId', account._id).eq('key', `${kind}:${id}`))
          .unique();
        invariant(
          item && !item.hidden,
          'ACCOUNT_UNAVAILABLE',
          'That resource is not part of this operation.',
        );
        bytes += getDocumentSize(item);
        marks.push({
          kind,
          id,
          mark: await resourceMark(ctx, kind, id, doc => {
            if (doc) bytes += getDocumentSize(doc);
          }),
        });
      }
      return { stage: account.stage, marks };
    } catch (e) {
      return report(e);
    }
  },
});
