// SPDX-License-Identifier: Apache-2.0
// Report abuse (Item b6588425 line 2). A signed-in account reports a project, a message, a comment or an account; the
// report is one row in the operator review queue, charged to the shared account limiter (10 / 30 a day), and alerts
// the operator. The operator opens the queue and reviews each report: suspend the account, purge the content or
// dismiss, each with a boardAudit row. Both operator functions are internal: run them with the deployment key.
//   npx convex run abuseReports:queue '{}'
//   npx convex run abuseReports:review '{"reportId":"…","action":"suspend","reason":"…","operationId":"<uuid>"}'
import { v } from 'convex/values';
import { makeFunctionReference, paginationOptsValidator } from 'convex/server';
import { mutation } from './cliServer';
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from './server';
import type { Doc, Id } from './_generated/dataModel';
import { abuseReportStatus } from './abuseReportFields';
import { chargeAccountChannel } from './accountLimits';
import { requireAccountWriteAccess } from './accessPolicy';
import { accessibleProject, requireDeviceWrite } from './projectAuthority';
import { audienceOf, coordinationAccess } from './projectAudience';
import { projectRole } from './projectRole';
import { recordHead } from './projectHostedRecords';
import { record, recordPartition, selectedGeneration } from './projectWorkIndexStore';
import { retainedItem } from './discussionAttachmentRead';
import { publicWorkPlan } from './publicWorkPlan';
import { accountOf, applySwitch, purgeMessages } from './projectBoardOperator';
import { commentRoute, purgeComment } from './projectCommentPurge';
import { report as reportError } from './errors';
import { abuseReportInputSchema, type AbuseReportInput } from '../src/hosted-record-input';
import { planningIssueArguments } from '../src/planning-issue-arguments';
import { canonicalPayload } from '../src/hosted-source-operation';
import { invariant } from '../src/errors';
import { digest } from '../src/state/hash';

/** What the reporter saw, kept for the operator. */
const EXCERPT_CHARACTERS = 1_000;
/** At most one operator alert in this long: a report sooner after the last alert joins the queue that alert already
 * pointed to, so a burst or a steady stream is one push each window, never none. */
const REPORT_ALERT_MS = 10 * 60_000;
/** What a purged coordination message reads as. */
export const PURGED_TEXT = 'Removed by the Forge operator.';
const QUEUE_PAGE = 50;
/** Answers to one coordination question: one receipt per recipient. */
const ANSWER_PAGE = 100;

type Target = Pick<Doc<'abuseReports'>, 'kind' | 'subject' | 'excerpt'> &
  Partial<Pick<Doc<'abuseReports'>, 'projectId' | 'targetId' | 'itemId' | 'noteId' | 'eventId'>>;

/** What the reporter names, as stored: a replay of the operation must name the same. */
function targetRef(input: AbuseReportInput) {
  if (input.target === 'account') return { targetId: input.handle!.replace(/^@/, '').toLowerCase() };
  if (input.target === 'message') return { targetId: input.messageId! };
  if (input.target === 'comment') return { targetId: input.commentId!, itemId: input.planningItemId! };
  return {};
}

/** Every unreadable message answers exactly like a missing one. */
const missingMessage = 'No board note or message with that id on this project.';
const missingComment = 'No comment with that id on that Item.';

/** The message the reporter can read under that id: a board note by the board's rule, else a coordination message or
 * handoff by coordination's. The board: the team reads every note; a contributor (board audience
 * `team-and-contributors`) only their own notes and the replies to them (convex/projectBoard.ts readableMessage).
 * Coordination: the team and a private project's readers; a conversation (Item or Lane discussion) the team only
 * (convex/coordinationFeed.ts). At most three point reads and one bounded range. */
async function readableMessage(
  ctx: MutationCtx,
  project: Doc<'hostedProjects'>,
  reporter: string,
  audience: ReturnType<typeof audienceOf>,
  messageId: string,
) {
  const projectId = project._id;
  const noteOf = (id: string) =>
    ctx.db
      .query('projectBoardMessages')
      .withIndex('by_project_and_id', q => q.eq('projectId', projectId).eq('id', id))
      .unique();
  const note = audience.team || audience.contributor ? await noteOf(messageId) : null;
  if (
    note &&
    (audience.team ||
      note.author === reporter ||
      (note.replyTo !== undefined && (await noteOf(note.replyTo))?.author === reporter))
  )
    return { noteId: note._id, author: note.author, text: note.body };
  const event = (
    await ctx.db
      .query('projectCoordinationEvents')
      .withIndex('by_project_and_operation', q => q.eq('projectId', projectId).eq('operationId', messageId))
      .take(4)
  ).find(row => row.command.kind === 'message' || row.command.kind === 'handoff');
  const command = event?.command;
  if (!event || (command?.kind !== 'message' && command?.kind !== 'handoff')) return null;
  if (!(await coordinationAccess(ctx, project, reporter))) return null;
  if (event.conversation && !audience.team) return null;
  return {
    eventId: event._id,
    author: event.actor,
    text: command.kind === 'message' ? command.text : command.summary,
  };
}

/** A planning comment on its Item, in either Work store, by the discussion reader's rule: the Item is retained, and a
 * viewer without a role on a public project sees only a publicly visible Item (convex/discussionAttachmentRead.ts). */
async function readableComment(
  ctx: MutationCtx,
  project: Doc<'hostedProjects'>,
  role: unknown,
  itemId: string,
  commentId: string,
) {
  if (!(await retainedItem(ctx, project, itemId))) return null;
  if (
    project.visibility === 'public' &&
    !role &&
    !(await publicWorkPlan(ctx, project, new Map()).selectionVisible(itemId))
  )
    return null;
  let value: string | undefined, actor: string | undefined;
  if (project.workStore === 'records') {
    const head = await recordHead(ctx, project._id, 'comment', commentId);
    if (head?.status !== 'comment' || head.parent !== itemId) return null;
    const version = await ctx.db.get(head.recordId);
    const body = version && (await ctx.db.get(version.bodyId));
    value = head.value ?? body?.value;
    actor = body?.actor;
  } else {
    const generation = await selectedGeneration(ctx, project);
    const row = generation && (await record(ctx, recordPartition(generation), 'planningComments', commentId));
    if (!row || row.parent !== itemId) return null;
    value = row.value;
    actor = row.actor;
  }
  const comment = value ? (JSON.parse(value) as { text?: string; author?: string }) : {};
  const author = comment.author ?? actor;
  return author ? { author, text: comment.text ?? '' } : null;
}

/** What the report is about and whose it is. A report is a write: a device needs the scope the same write needs (a
 * project write for project content, the account-write scope for an account). The reporter must be able to read the
 * target, and anything they cannot read answers exactly like a missing one, so a report never confirms content. */
async function targetOf(
  ctx: MutationCtx,
  reporter: string,
  projectId: Id<'hostedProjects'> | undefined,
  input: AbuseReportInput,
): Promise<Target> {
  const ref = targetRef(input);
  if (input.target === 'account') {
    requireAccountWriteAccess((ctx as { forgeDevice?: Doc<'cliCredentials'> | null }).forgeDevice);
    return {
      kind: 'account',
      ...ref,
      subject: await accountOf(ctx, ref.targetId!),
      excerpt: `@${ref.targetId}`,
    };
  }
  invariant(projectId, 'BAD_ARGUMENT', `Report a ${input.target} from its project.`);
  await requireDeviceWrite(ctx, projectId);
  const project = await accessibleProject(ctx, projectId, reporter);
  if (input.target === 'project')
    return { kind: 'project', projectId, subject: project.owner, excerpt: project.name };
  const role = await projectRole(ctx, project, reporter);
  if (input.target === 'message') {
    const found = await readableMessage(ctx, project, reporter, audienceOf(project, role), ref.targetId!);
    invariant(found, 'NOT_FOUND', missingMessage);
    const { author, text, ...exact } = found;
    return { kind: 'message', projectId, ...ref, ...exact, subject: author, excerpt: text };
  }
  const found = await readableComment(ctx, project, role, ref.itemId!, ref.targetId!);
  invariant(found, 'NOT_FOUND', missingComment);
  return { kind: 'comment', projectId, ...ref, subject: found.author, excerpt: found.text };
}

/** Report abuse: one row in the review queue. A retry with the same operationId returns the same report, uncharged. */
export const report = mutation({
  args: { projectId: v.optional(v.id('hostedProjects')), request: v.string() },
  returns: v.string(),
  handler: async (ctx, { projectId, request }) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'AUTH_REQUIRED', 'Sign in to report abuse.');
      let value: unknown;
      try {
        value = JSON.parse(request);
      } catch {
        invariant(
          false,
          'BAD_ARGUMENT',
          'request: expected a JSON object with target, reason and operationId.',
        );
      }
      const { operationId, ...rest } = (value ?? {}) as { operationId?: unknown };
      invariant(
        typeof operationId === 'string' && /^[0-9a-f-]{36}$/i.test(operationId),
        'BAD_ARGUMENT',
        'operationId: expected a UUID.',
      );
      // The CLI's Item-id aliases (id, itemId) name planningItemId, as for every Item-taking action.
      const parsed = abuseReportInputSchema.safeParse(
        planningIssueArguments('report-abuse', rest as Record<string, unknown>),
      );
      invariant(
        parsed.success,
        'BAD_ARGUMENT',
        `Invalid report-abuse parameters: ${parsed.success ? '' : parsed.error.issues.map(issue => `${issue.path.join('.') || 'request'}: ${issue.message}`).join('; ')}. Run nforge agent ROOT report-abuse --help.`,
      );
      const reporter = user.subject;
      const old = await ctx.db
        .query('abuseReports')
        .withIndex('by_reporter_and_operation', q =>
          q.eq('reporter', reporter).eq('operationId', operationId),
        )
        .unique();
      if (old) {
        const ref = targetRef(parsed.data);
        invariant(
          old.kind === parsed.data.target &&
            old.reason === parsed.data.reason &&
            old.targetId === ref.targetId &&
            old.itemId === ref.itemId &&
            (old.kind === 'account' || old.projectId === projectId),
          'WORK_OPERATION_CHANGED',
          'Replay the original report inputs, or use a new operationId for a new report.',
        );
        return canonicalPayload({ reportId: old._id, status: 'received' });
      }
      const target = await targetOf(ctx, reporter, projectId, parsed.data);
      invariant(
        target.subject !== reporter,
        'BAD_ARGUMENT',
        'This is your own account or content; there is nothing to report.',
      );
      await chargeAccountChannel(ctx, reporter, 'report');
      const now = Date.now();
      const [alerted] = await ctx.db
        .query('abuseReports')
        .withIndex('by_alerted_at', q => q.gt('alertedAt', 0))
        .order('desc')
        .take(1);
      const alert = !alerted?.alertedAt || now - alerted.alertedAt >= REPORT_ALERT_MS;
      const reportId = await ctx.db.insert('abuseReports', {
        operationId,
        reporter,
        ...target,
        excerpt: target.excerpt.slice(0, EXCERPT_CHARACTERS),
        reason: parsed.data.reason,
        status: 'open',
        at: now,
        ...(alert ? { alertedAt: now } : {}),
      });
      // The push names no one and carries no report text: the operator reads both in the queue.
      if (alert)
        await ctx.scheduler.runAfter(0, makeFunctionReference<'action'>('projectBoardLimits:deliver'), {
          subject: '[Forge] Abuse report',
          text: `A ${target.kind} was reported (report ${reportId}). Review the open reports: npx convex run abuseReports:queue '{}'`,
          email: true,
        });
      return canonicalPayload({ reportId, status: 'received' });
    } catch (error) {
      return reportError(error);
    }
  },
});

async function handleOf(ctx: QueryCtx, subject: string) {
  const account = await ctx.db
    .query('forgeAccounts')
    .withIndex('by_owner', q => q.eq('owner', subject))
    .unique();
  return account?.handle ? `@${account.handle}` : null;
}

/** The operator queue, newest first, one bounded page. Read only when the operator opens it. */
export const queue = internalQuery({
  args: { status: v.optional(abuseReportStatus), paginationOpts: v.optional(paginationOptsValidator) },
  handler: async (ctx, { status = 'open', paginationOpts }) => {
    const page = await ctx.db
      .query('abuseReports')
      .withIndex('by_status_and_at', q => q.eq('status', status))
      .order('desc')
      .paginate({
        cursor: paginationOpts?.cursor ?? null,
        numItems: Math.min(paginationOpts?.numItems ?? QUEUE_PAGE, QUEUE_PAGE),
      });
    const handles = new Map<string, Promise<string | null>>();
    const handle = (subject: string) => {
      if (!handles.has(subject)) handles.set(subject, handleOf(ctx, subject));
      return handles.get(subject)!;
    };
    return {
      page: await Promise.all(
        page.page.map(async row => ({
          reportId: row._id,
          kind: row.kind,
          status: row.status,
          at: new Date(row.at).toISOString(),
          reported: (await handle(row.subject)) ?? row.subject,
          reporter: (await handle(row.reporter)) ?? row.reporter,
          ...(row.projectId ? { projectId: row.projectId } : {}),
          ...(row.itemId ? { itemId: row.itemId } : {}),
          ...(row.targetId ? { targetId: row.targetId } : {}),
          reason: row.reason,
          excerpt: row.excerpt,
          actions,
        })),
      ),
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});

/** The review actions each kind of report supports: every kind can be suspended, purged or dismissed. */
const actions = ['suspend', 'purge', 'dismiss'];

/** Removes the one reported message document, never another under the same id. A board note is deleted (its
 * evidence row stays). A coordination message keeps its envelope with its text replaced, and every copy of that text
 * goes too: the offered choices, each answer's chosen choice and resume prompt, and a hand-back's `left`. Returns how
 * many messages were removed (0: already gone). Bounded: one point read, one receipt page and an ack read each. */
async function purgeMessage(ctx: MutationCtx, row: Doc<'abuseReports'>) {
  if (row.noteId) {
    const note = await ctx.db.get(row.noteId);
    if (!note) return 0;
    await ctx.db.delete(note._id);
    const counter = await ctx.db
      .query('projectBoardProjects')
      .withIndex('by_project', q => q.eq('projectId', note.projectId))
      .unique();
    if (counter) await ctx.db.patch(counter._id, { live: Math.max(0, counter.live - 1) });
    return 1;
  }
  const event = row.eventId && (await ctx.db.get(row.eventId));
  if (!event) return 0;
  const { command } = event;
  if (command.kind === 'message') {
    const purged = { ...command, text: PURGED_TEXT };
    delete purged.choices;
    await ctx.db.patch(event._id, { command: purged });
  } else if (command.kind === 'handoff')
    await ctx.db.patch(event._id, {
      command: {
        ...command,
        summary: PURGED_TEXT,
        ...(command.handBack ? { handBack: { left: PURGED_TEXT } } : {}),
      },
    });
  else return 0;
  const answers = await ctx.db
    .query('projectCoordinationReceipts')
    .withIndex('by_project_and_message_and_actor', q =>
      q.eq('projectId', event.projectId).eq('messageId', event.operationId),
    )
    .take(ANSWER_PAGE);
  for (const answer of answers) {
    if (answer.choice === undefined) continue;
    await ctx.db.patch(answer._id, { choice: PURGED_TEXT });
    const ack = await ctx.db
      .query('projectCoordinationEvents')
      .withIndex('by_project_and_operation', q =>
        q.eq('projectId', event.projectId).eq('operationId', answer.ackId),
      )
      .unique();
    if (ack?.command.kind !== 'ack') continue;
    await ctx.db.patch(ack._id, {
      command: { ...ack.command, ...(ack.command.choice !== undefined ? { choice: PURGED_TEXT } : {}) },
      resumePrompt: undefined,
    });
  }
  return 1;
}

/** Reviews of one report whose retry still returns its first result. */
const REVIEW_RECEIPTS = 16;
const statusOf = { suspend: 'suspended', purge: 'purged', dismiss: 'dismissed' } as const;

/** How long an archived comment's purge may run (its retries' backoff included) before a retry of its review starts
 * it again. */
const ARCHIVED_STALL_MS = 2 * 60 * 60_000;
const archivedCommentPurge = makeFunctionReference<
  'action',
  {
    projectId: Id<'hostedProjects'>;
    itemId: string;
    commentId: string;
    operationId: string;
    auditId: Id<'boardAudit'>;
    attempt?: number;
  }
>('projectCommentPurgeArchive:run');

/** The Work operation of a comment purge, derived from its review, so a retry of the review appends nothing new and
 * no other Work operation can share it. */
const commentPurgeOperation = (reportId: string, operationId: string) => {
  const hex = digest(JSON.stringify(['abuse-comment-purge', reportId, operationId]));
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

/** Review one report: suspend the reported account, purge the reported content, or dismiss. Each writes a boardAudit
 * row naming the report. Suspend is the account switch (every channel at once, devices and sessions signed out,
 * public projects unlisted). Purge removes the reported message or comment (convex/projectCommentPurge.ts: every
 * copy of its text, the Item kept), or every board note of a reported project or account. A retry with the same operationId returns the first result and changes nothing; a later review of the
 * same report (say, suspend after dismiss) takes a new operationId. */
export const review = internalMutation({
  args: {
    reportId: v.id('abuseReports'),
    action: v.union(v.literal('suspend'), v.literal('purge'), v.literal('dismiss')),
    reason: v.string(),
    operationId: v.string(),
  },
  returns: v.object({
    reportId: v.id('abuseReports'),
    status: abuseReportStatus,
    removed: v.optional(v.number()),
  }),
  handler: async (ctx, { reportId, action, reason, operationId }) => {
    invariant(reason.trim(), 'BAD_ARGUMENT', 'Give a reason; it is kept in the audit row.');
    invariant(/^[0-9a-f-]{36}$/i.test(operationId), 'BAD_ARGUMENT', 'operationId: expected a UUID.');
    const row = await ctx.db.get(reportId);
    invariant(row, 'NOT_FOUND', 'No abuse report with that id.');
    const receipt = row.reviews?.find(review => review.operationId === operationId);
    if (receipt || row.reviewOperationId === operationId) {
      invariant(
        receipt ? receipt.action === action : row.status === statusOf[action],
        'WORK_OPERATION_CHANGED',
        'Replay the original review, or use a new operationId for a new review.',
      );
      const removed = receipt ? receipt.removed : row.removed;
      // An archived comment's purge that has not finished starts again once it is out of retries (`failed`) or has
      // made no progress for ARCHIVED_STALL_MS; a run still in its retries is left alone.
      const audit = receipt?.auditId && (await ctx.db.get(receipt.auditId));
      const state = audit ? (JSON.parse(audit.detail ?? '{}') as { done?: boolean; failed?: string }) : {};
      if (audit && state.done !== true && (state.failed || audit.at + ARCHIVED_STALL_MS <= Date.now()))
        await ctx.scheduler.runAfter(0, archivedCommentPurge, {
          projectId: row.projectId!,
          itemId: row.itemId!,
          commentId: row.targetId!,
          operationId: commentPurgeOperation(reportId, operationId),
          auditId: audit._id,
        });
      return { reportId, status: statusOf[action], ...(removed === undefined ? {} : { removed }) };
    }
    const detail = JSON.stringify({ reportId, operationId });
    const now = Date.now();
    let removed: number | undefined;
    let auditId: Id<'boardAudit'> | undefined;
    if (action === 'suspend')
      await applySwitch(ctx, { scope: 'account', owner: row.subject, off: true, reason, detail });
    else if (action === 'dismiss')
      await ctx.db.insert('boardAudit', {
        action: 'dismiss',
        target: `report:${reportId}`,
        reason,
        at: now,
        detail,
      });
    else if (row.kind === 'account' || row.kind === 'project') {
      // The first page now; a longer purge continues through the scheduler and keeps its count on its audit row.
      const scope = row.kind;
      removed = (
        await purgeMessages(ctx, {
          scope,
          ...(scope === 'account' ? { owner: row.subject } : { projectId: row.projectId! }),
          reason,
          reportId,
        })
      ).deleted;
    } else if (
      row.kind === 'comment' &&
      (await commentRoute(ctx, row.projectId!, row.targetId!)) !== 'live'
    ) {
      // A comment row archived in an R2 journal segment, or a comment in the stored base checkpoint: the purge reads
      // it there and rewrites that segment or scrubs that base (convex/projectCommentPurgeArchive.ts), and marks this
      // audit row done when it finishes.
      removed = 0;
      auditId = await ctx.db.insert('boardAudit', {
        action: 'purge',
        target: `comment:${row.projectId}:${row.targetId}`,
        reason,
        at: now,
        detail: JSON.stringify({ reportId, operationId, deleted: 0, done: false }),
      });
      await ctx.scheduler.runAfter(0, archivedCommentPurge, {
        projectId: row.projectId!,
        itemId: row.itemId!,
        commentId: row.targetId!,
        operationId: commentPurgeOperation(reportId, operationId),
        auditId,
      });
    } else {
      removed =
        row.kind === 'comment'
          ? await purgeComment(ctx, {
              projectId: row.projectId!,
              itemId: row.itemId!,
              commentId: row.targetId!,
              operationId: commentPurgeOperation(reportId, operationId),
            })
          : await purgeMessage(ctx, row);
      await ctx.db.insert('boardAudit', {
        action: 'purge',
        target: `${row.kind}:${row.projectId}:${row.targetId}`,
        reason,
        at: now,
        detail: JSON.stringify({ reportId, operationId, deleted: removed, done: true }),
      });
    }
    const status = statusOf[action];
    await ctx.db.patch(reportId, {
      status,
      reviewedAt: now,
      reviewOperationId: operationId,
      removed,
      reviews: [
        ...(row.reviews ?? []),
        {
          operationId,
          action,
          ...(removed === undefined ? {} : { removed }),
          ...(auditId === undefined ? {} : { auditId }),
        },
      ].slice(-REVIEW_RECEIPTS),
    });
    return { reportId, status, ...(removed === undefined ? {} : { removed }) };
  },
});
