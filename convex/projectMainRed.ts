// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// One main red, explained (Item ae068e0c): the failed audit run (what failed, a link to the full log), main's head,
// the landings since the last green, the landing that broke it when the bisect proved one (else those landings are
// candidates), and how it ended (passed again by a revert or a fix, counted as flaky, or still red). The web's
// Main broke view and the agent's `status {"main":…}` read this one query; nothing here writes.
//
// Budget per open: project access (2); the red event (one index range at its sequence, at most MAIN_RED_AT rows); the events
// around it (two index ranges of at most MAIN_RED_EVENTS rows each); main's audit row (1); the failed run row (1);
// the landings since the last green (one range of at most MAIN_RED_LANDINGS + 1 receipts); a culprit outside that
// page (1); a coverage landing outside that page (1); and only once it passed again, the landings that ended it (one range of at most MAIN_RED_RECOVERY + 1
// receipts plus one landing row each, for a revert). Reds are rare (a few a day) and the page reads this only on open:
// idle costs nothing and the FYI list reads none of it.
import { v } from 'convex/values';
import { query, type QueryCtx } from './cliServer';
import type { Doc, Id } from './_generated/dataModel';
import { accessibleProject } from './projectAuthority';
import { landingRow } from './projectHostedLandingStore';
import { hostedCheckRunSchema, type HostedCheckRun } from '../src/hosted-check';
import { summarizeCheckRun } from '../src/hosted-check-summary';
import { canonicalPayload } from '../src/hosted-source-operation';
import { invariant } from '../src/errors';
import { report } from './errors';
import { landingMessageText } from './projectHostedLandingMessageBody';
import { controlBuildReason } from './projectHostedMainAuditFields';

export const MAIN_RED_EVENTS = 20;
export const MAIN_RED_LANDINGS = 20;
const MAIN_RED_RECOVERY = 10;
/** Events read at one red's sequence: the red, stall retries, and a culprit or coverage event naming that head. */
const MAIN_RED_AT = 8;

type Event = Doc<'projectHostedMainAuditEvents'>;
type Receipt = {
  id: string;
  at: string;
  message?: string;
  messageRef?: string;
  actor?: { id: string; kind: string };
};
type MainRedLanding = {
  receiptId: string;
  sequence: number;
  at: number;
  title: string | null;
  actor: string | null;
  agent: boolean;
};
type MainRedEnd =
  | { how: 'red'; reason: string | null; tests: string[]; moreTests: number }
  | { how: 'flaky'; at: number; runId: string }
  | {
      how: 'recovered';
      at: number;
      runId: string;
      head: string;
      reverted: boolean;
      /** The landing that ended it: a revert of a landing, or the fix (the newest landing before the pass). */
      by: { kind: 'revert' | 'fix'; landing: MainRedLanding; of: number; more: boolean } | null;
    }
  | { how: 'not-reported' };

const title = (text: unknown) =>
  typeof text === 'string'
    ? (text
        .split('\n')
        .find(line => line.trim())
        ?.trim()
        .slice(0, 280) ?? null)
    : null;
async function landingOf(ctx: QueryCtx, row: Doc<'projectHostedAcceptances'>): Promise<MainRedLanding> {
  const receipt = JSON.parse(row.value) as Receipt;
  return {
    receiptId: receipt.id,
    sequence: row.sequence,
    at: Date.parse(receipt.at),
    title: title(await landingMessageText(ctx, row.projectId, receipt)),
    actor: receipt.actor?.id ?? null,
    agent: receipt.actor?.kind === 'agent',
  };
}
/** The provider's page for the whole run, when the runner has one; null otherwise (the log tail is read in Forge). */
export function runLink(run: HostedCheckRun) {
  if (run.ci?.link) return run.ci.link;
  if (run.configuration.provider === 'github-actions' && run.executionId)
    return `https://github.com/${run.configuration.repository}/actions/runs/${encodeURIComponent(run.executionId)}`;
  return null;
}

const oldest = (rows: Event[]) => rows.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))[0] ?? null;
/** How one red ended: the first green or flake written after it, at or after its sequence (pure). */
function endOf(red: Pick<Event, '_id' | 'at' | 'sequence'>, events: readonly Event[]) {
  const redAt = Date.parse(red.at);
  return oldest(
    events.filter(
      row =>
        (row.kind === 'green' || row.kind === 'flake') &&
        row._id !== red._id &&
        row.sequence >= red.sequence &&
        Date.parse(row.at) >= redAt,
    ),
  );
}
/** The oldest culprit-kind event carrying `field`, written after the red and before it ended, naming a landing
 * at or below the red's sequence (pure). */
function namedBy(
  red: Pick<Event, '_id' | 'at' | 'sequence'>,
  events: readonly Event[],
  field: 'culprit' | 'covered',
) {
  const redAt = Date.parse(red.at);
  const end = endOf(red, events);
  const until = end ? Date.parse(end.at) : Infinity;
  return (
    oldest(
      events.filter(
        row =>
          row.kind === 'culprit' &&
          row[field] &&
          row.sequence <= red.sequence &&
          Date.parse(row.at) >= redAt &&
          Date.parse(row.at) <= until,
      ),
    )?.[field] ?? null
  );
}
/**
 * The landing the bisect proved broke this red, or null (pure). The FYI row and this view use the same rule: the
 * oldest culprit event written after the red and before it ended, naming a landing at or below the red's sequence.
 * Nothing else is ever called the culprit: a coverage event (`covered`, no `culprit`) never is.
 */
export function culpritOf(red: Pick<Event, '_id' | 'at' | 'sequence' | 'culprit'>, events: readonly Event[]) {
  return red.culprit ?? namedBy(red, events, 'culprit');
}
/** The landing that made a newly covered red's tests run (Item 687d1eda), by the same rule (pure). */
export const coveredOf = (red: Pick<Event, '_id' | 'at' | 'sequence'>, events: readonly Event[]) =>
  namedBy(red, events, 'covered');

async function redAt(ctx: QueryCtx, projectId: Id<'hostedProjects'>, sequence: number | undefined) {
  if (sequence !== undefined) {
    const rows = await ctx.db
      .query('projectHostedMainAuditEvents')
      .withIndex('by_project_and_sequence', q => q.eq('projectId', projectId).eq('sequence', sequence))
      .order('desc')
      .take(MAIN_RED_AT);
    return rows.find(row => row.kind === 'red') ?? null;
  }
  // The newest red: reds are rare among audit events, so one bounded page finds it or says there is none.
  const rows = await ctx.db
    .query('projectHostedMainAuditEvents')
    .withIndex('by_project_and_sequence', q => q.eq('projectId', projectId))
    .order('desc')
    .take(MAIN_RED_EVENTS);
  return rows.find(row => row.kind === 'red') ?? null;
}

async function recovery(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  red: Event,
  end: Event,
  culprit: string | null,
) {
  const rows = await ctx.db
    .query('projectHostedAcceptances')
    .withIndex('by_project_and_sequence', q =>
      q.eq('projectId', projectId).gt('sequence', red.sequence).lte('sequence', end.sequence),
    )
    .order('desc')
    .take(MAIN_RED_RECOVERY + 1);
  const more = rows.length > MAIN_RED_RECOVERY;
  rows.splice(MAIN_RED_RECOVERY);
  if (!rows.length) return null;
  const reverts = [];
  for (const row of rows) {
    const landing = await landingRow(ctx, { projectId, submissionId: row.submissionId });
    const revertOf = landing
      ? (JSON.parse(landing.value) as { request?: { revertOf?: string } }).request?.revertOf
      : undefined;
    if (revertOf) reverts.push({ row, revertOf });
  }
  const revert = reverts.find(item => item.revertOf === culprit) ?? reverts[0];
  return revert
    ? { kind: 'revert' as const, landing: await landingOf(ctx, revert.row), of: rows.length, more }
    : { kind: 'fix' as const, landing: await landingOf(ctx, rows[0]!), of: rows.length, more };
}

export const read = query({
  args: { projectId: v.id('hostedProjects'), sequence: v.optional(v.number()) },
  returns: v.string(),
  handler: async (ctx, { projectId, sequence }) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read why main failed.');
      await accessibleProject(ctx, projectId, user.subject);
      const red = await redAt(ctx, projectId, sequence);
      if (!red)
        return canonicalPayload({
          red: null,
          note:
            sequence === undefined
              ? `No red among main's newest ${MAIN_RED_EVENTS} audit events; name an older one by its sequence.`
              : 'No red at this sequence.',
        });
      const [before, after, audit, runRow] = await Promise.all([
        ctx.db
          .query('projectHostedMainAuditEvents')
          .withIndex('by_project_and_sequence', q =>
            q.eq('projectId', projectId).lt('sequence', red.sequence),
          )
          .order('desc')
          .take(MAIN_RED_EVENTS),
        ctx.db
          .query('projectHostedMainAuditEvents')
          .withIndex('by_project_and_sequence', q =>
            q.eq('projectId', projectId).gte('sequence', red.sequence),
          )
          .order('asc')
          .take(MAIN_RED_EVENTS),
        ctx.db
          .query('projectHostedMainAudits')
          .withIndex('by_project', q => q.eq('projectId', projectId))
          .unique(),
        ctx.db
          .query('projectHostedCheckRuns')
          .withIndex('by_project_and_run', q => q.eq('projectId', projectId).eq('runId', red.runId))
          .unique(),
      ]);
      const events = [...before, ...after];
      const ended = endOf(red, after);
      // Still the open episode: main's audit row holds its live culprit, failing files and reason, and its last
      // green, which a full-checked landing can move without writing an audit event and which stays put while red.
      const live =
        audit?.red && !ended && Date.parse(audit.red.since) <= Date.parse(red.at) ? audit.red : null;
      const culprit = culpritOf(red, events) ?? live?.culprit ?? null;
      // While red, main's audit row names it; after recovery, the coverage event written once does.
      const covered = coveredOf(red, events) ?? live?.covered ?? null;
      const controlBuild = red.controlBuild;
      const event = before.find(row => row.kind === 'green') ?? null;
      const kept =
        live && audit?.lastGreen && audit.lastGreen.sequence < red.sequence ? audit.lastGreen : null;
      const lastGreen = controlBuild
        ? { ...controlBuild.lastGreen, at: Date.parse(controlBuild.lastGreen.at) }
        : kept && kept.sequence >= (event?.sequence ?? -1)
          ? {
              sequence: kept.sequence,
              head: kept.coveredHead ?? kept.head,
              runId: kept.runId,
              at: null,
              audited: false,
            }
          : event
            ? {
                sequence: event.sequence,
                head: event.head,
                runId: event.runId,
                at: Date.parse(event.at),
                audited: true,
              }
            : null;
      const since = lastGreen?.sequence ?? (before.length === MAIN_RED_EVENTS ? null : -1);
      const landingRows = await ctx.db
        .query('projectHostedAcceptances')
        .withIndex('by_project_and_sequence', q =>
          q
            .eq('projectId', projectId)
            .gt('sequence', since ?? red.sequence - MAIN_RED_LANDINGS - 1)
            .lte('sequence', red.sequence),
        )
        .order('desc')
        .take(MAIN_RED_LANDINGS + 1);
      const landings = await Promise.all(
        landingRows.slice(0, MAIN_RED_LANDINGS).map(row => landingOf(ctx, row)),
      );
      // A named landing outside the page costs one indexed read.
      const named = async (receiptId: string | null) => {
        if (!receiptId) return null;
        const listed = landings.find(row => row.receiptId === receiptId);
        if (listed) return listed;
        const row = await ctx.db
          .query('projectHostedAcceptances')
          .withIndex('by_project_and_receipt', q => q.eq('projectId', projectId).eq('receiptId', receiptId))
          .unique();
        return row ? landingOf(ctx, row) : null;
      };
      const [culpritLanding, coveredLanding] = await Promise.all([named(culprit), named(covered)]);
      // A run row that no longer parses (retired fields) leaves the rest of the answer: "not reported", not an error.
      const parsed = runRow ? hostedCheckRunSchema.safeParse(JSON.parse(runRow.value)) : null;
      const run = parsed?.success ? parsed.data : null;
      const end: MainRedEnd = ended
        ? ended.kind === 'flake'
          ? { how: 'flaky', at: Date.parse(ended.at), runId: ended.runId }
          : {
              how: 'recovered',
              at: Date.parse(ended.at),
              runId: ended.runId,
              head: ended.head,
              reverted: Boolean(ended.reverted),
              by: await recovery(ctx, projectId, red, ended, culprit),
            }
        : live
          ? {
              how: 'red',
              reason: live.reason ?? null,
              tests: live.tests ?? [],
              moreTests: live.moreTests ?? 0,
            }
          : { how: 'not-reported' };
      return canonicalPayload({
        red: {
          sequence: red.sequence,
          at: Date.parse(red.at),
          head: red.head,
          runId: red.runId,
          drill: red.drill ? { outcome: red.drill.outcome ?? null } : null,
        },
        run: run ? summarizeCheckRun(run) : null,
        runLink: run ? runLink(run) : null,
        /** `audited` false: main's own record while the red is open (a full-checked landing can move it); true:
         * the newest audit pass before the red, the only record left once it ended. */
        lastGreen,
        landings,
        /** True when more landings came since the last green than this page holds, or the last green is older
         * than the events read: the list is the newest MAIN_RED_LANDINGS. */
        landingsMore: landingRows.length > MAIN_RED_LANDINGS || since === null,
        culprit: culprit ? { receiptId: culprit, landing: culpritLanding } : null,
        /** The landing that made the failing tests run (they had no pass on the last green main): named, never
         * reverted, never the culprit (Item 687d1eda). */
        newlyCoveredBy: covered ? { receiptId: covered, landing: coveredLanding } : null,
        ...(controlBuild
          ? {
              controlBuildChange: controlBuild.change,
              controlBuildReason: controlBuildReason(controlBuild.change),
            }
          : {}),
        end,
      });
    } catch (error) {
      return report(error);
    }
  },
});
