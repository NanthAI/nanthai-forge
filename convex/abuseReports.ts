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
import { report as reportError } from './errors';
import { abuseReportInputSchema, type AbuseReportInput } from '../src/hosted-record-input';
import { planningIssueArguments } from '../src/planning-issue-arguments';
import { canonicalPayload } from '../src/hosted-source-operation';
import { invariant } from '../src/errors';

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
          actions: actionsFor(row.kind),
        })),
      ),
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});

/** The review actions each kind of report supports. One planning comment cannot be purged yet: its text is kept in
 * every Work store and only the whole-Item purge rewrites them all. */
const actionsFor = (kind: Doc<'abuseReports'>['kind']) =>
  kind === 'comment' ? ['suspend', 'dismiss'] : ['suspend', 'purge', 'dismiss'];

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

const statusOf = { suspend: 'suspended', purge: 'purged', dismiss: 'dismissed' } as const;

/** Review one report: suspend the reported account, purge the reported content, or dismiss. Each writes a boardAudit
 * row naming the report. Suspend is the account switch (every channel at once, devices and sessions signed out,
 * public projects unlisted). Purge removes the reported message, or every board note of a reported project or
 * account. A retry with the same operationId returns the first result and changes nothing; a later review of the
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
    if (row.reviewOperationId === operationId) {
      invariant(
        row.status === statusOf[action],
        'WORK_OPERATION_CHANGED',
        'Replay the original review, or use a new operationId for a new review.',
      );
      return { reportId, status: row.status, ...(row.removed === undefined ? {} : { removed: row.removed }) };
    }
    invariant(
      actionsFor(row.kind).includes(action),
      'HOSTED_ACTION_UNSUPPORTED',
      'One planning comment cannot be purged yet. Suspend the account or dismiss the report.',
    );
    const detail = JSON.stringify({ reportId, operationId });
    const now = Date.now();
    let removed: number | undefined;
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
    } else {
      removed = await purgeMessage(ctx, row);
      await ctx.db.insert('boardAudit', {
        action: 'purge',
        target: `message:${row.projectId}:${row.targetId}`,
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
    });
    return { reportId, status, ...(removed === undefined ? {} : { removed }) };
  },
});
