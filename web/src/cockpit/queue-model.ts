// SPDX-License-Identifier: Apache-2.0
import { hostedHref } from './hosted-links';
import { pendingStatus, type PendingData, type PendingStatus } from '../../../src/pending-status';
import type { ConflictNotice } from '../../../src/agent-conflict-notice';
import type { handoffSummary } from '../../../src/agent-handoff-types';
import type { CockpitWork } from './model';
import { seenAt, type Tone } from '../ui/status';
import type { Step } from '../lane/LaneParts';
import type { FeedItem } from './attention';
export type HandoffSummary = NonNullable<ReturnType<typeof handoffSummary>>;
export type QueueFact = {
  laneId: string;
  head: string;
  tone: Tone;
  label: string;
  glyph?: import('../ui/Glyph').GlyphName;
  text: string;
  tip?: string;
  since?: string;
  link?: {
    kind: 'run' | 'repair-intent' | 'later-candidate' | 'lane';
    id: string;
    label: string;
    viewId?: string;
    intentId?: string;
  };
  historical?: boolean;
  undo?: string;
  automatic?: boolean;
  state:
    | 'queued'
    | 'checking'
    | 'review'
    | 'dependency'
    | 'machine'
    | 'failed'
    | 'conflict'
    | 'not-run'
    | 'later'
    | 'landed'
    | 'working';
  meta?: string;
  candidateMeta?: string;
  viewId?: string;
  intentId: string;
  runId?: string;
  repairIntentId?: string;
  check?: string;
  handoff?: string;
  decisionSubtitle?: string;
  step?: Step;
  events: FeedItem[];
};
const clock = (at: string | null | undefined) =>
  at ? new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) : '';
const short = (head: string) => head.slice(0, 7);
const notRunTip = 'The check could not run. Forge retries when capacity returns; the code was not judged.';

/** The only web adaptation of the shared submission projection. Missing collections preserve legacy UI. */
export function queueStatus(work: CockpitWork): PendingStatus | undefined {
  if (work.pendingStatus) return work.pendingStatus;
  if (!work.landingEntries) return undefined;
  // Hosted summaries deliberately omit execution configuration; only recorded status/identity is read.
  return pendingStatus(
    {
      revision: work.revision ?? 0,
      intents: work.intents.map(intent => ({ ...intent, notes: intent.notes ?? [] })),
      lanes: work.lanes.map(lane => ({ ...lane, checkpoints: lane.checkpoints ?? [] })),
      views: work.views.map(view => ({ ...view, inputs: view.inputs ?? [] })),
      runs: work.runs.map(run => ({
        ...run,
        ...(run.cause === 'infra' && run.status === 'failed' ? { status: 'interrupted' } : {}),
        ...(run.cause === 'unknown-outcome' ? { exitCode: null, signal: null } : {}),
        check: { ...run.check, name: run.checkName ?? run.check?.name ?? 'Check' },
      })),
      channelMoves: work.channelMoves ?? [],
      landingEntries: work.landingEntries,
      landingBatches: work.landingBatches,
    } as PendingData,
    work.landingWorker ? { landingWorker: work.landingWorker } : {},
  );
}

export function queueFacts(
  status: PendingStatus,
  notices: readonly ConflictNotice[] = [],
  handoffs: ReadonlyMap<string, HandoffSummary> = new Map(),
): Map<string, QueueFact> {
  const facts = new Map<string, QueueFact>();
  for (const lane of status.lanes) {
    const submission = lane.submission;
    if (!submission) continue;
    const entry = lane.entries.find(item => item.id === submission.entryOperationId);
    const run = entry?.run;
    const check = run?.check.name ?? 'Check';
    const exit = typeof run?.exitCode === 'number' ? ` · exit ${run.exitCode}` : '';
    const at = entry?.arrivedAt;
    const current = notices.find(
      notice =>
        notice.applicability === 'current' &&
        notice.participants.some(pin => pin.lane === lane.laneId && pin.head === lane.head) &&
        notice.evidence?.some(item => item.kind === 'check' && item.runId === run?.id),
    );
    const handoff = handoffs.get(lane.laneId) ?? lane.handoff;
    const fact: QueueFact = {
      laneId: lane.laneId,
      head: lane.head,
      intentId: lane.intentId,
      tone: 'plain',
      label: 'Not run',
      text: "Check didn't run · recovery pending",
      state: 'not-run',
      events: [],
      ...(at ? { since: at } : {}),
      ...(entry ? { viewId: run?.viewId ?? entry.viewId } : {}),
      ...(run ? { runId: run.id, check: `${check}${exit}` } : {}),
      ...(current?.repairIntentId ? { repairIntentId: current.repairIntentId } : {}),
      ...(handoff?.head === lane.head ? { handoff: handoff.summary.slice(0, 200) } : {}),
    };
    if (submission.state === 'superseded' && submission.outcome === 'landed') {
      const submittedIndex = lane.checkpoints.findIndex(save => save.head === submission.attemptHead);
      const saves =
        lane.savesSinceSubmission?.find(item => item.head === submission.attemptHead)?.saves ??
        (submittedIndex >= 0 ? lane.checkpoints.length - submittedIndex - 1 : undefined);
      Object.assign(fact, {
        state: 'working',
        tone: 'active',
        label: 'Working',
        candidateMeta: entry?.move?.at ? `landed ${clock(entry.move.at)}` : undefined,
        text: `Landed ${short(submission.attemptHead)} on main · ${saves === undefined ? '' : `${saves} ${saves === 1 ? 'save' : 'saves'} since · `}not submitted`,
      });
    } else if (submission.state === 'superseded') {
      Object.assign(fact, {
        state: 'later',
        tone: 'stale',
        label: 'Later save',
        text: `Saved again after check ${run?.status ?? 'not recorded'} on ${short(submission.attemptHead)} · earlier outcome kept`,
        meta: `later save · ${short(submission.attemptHead)} kept`,
        candidateMeta: 'later save kept',
        tip: `This Lane was saved after its check. The recorded result stays with ${short(submission.attemptHead)}; the new head is not submitted.`,
      });
    } else if (submission.state === 'landed') {
      Object.assign(fact, {
        state: 'landed',
        label: 'Done',
        text: `Landed on main${entry?.move?.automatic ? ' · accepted by auto' : ''}`,
        meta: `landed ${clock(entry?.move?.at)} · ${short(submission.attemptHead)}`,
        candidateMeta: `landed ${clock(entry?.move?.at)}`,
        automatic: !!entry?.move?.automatic,
        undo: entry?.move?.automatic?.undo,
      });
    } else if (submission.state === 'pending') {
      const event = status.landingWorker.observedAt;
      const last = event ? ` · last event ${clock(event)}` : '';
      switch (submission.pendingReason) {
        case 'queued': {
          Object.assign(fact, {
            state: 'queued',
            tone: 'waiting',
            label: 'Queued',
            text: `In the landing queue${at ? ` · since ${clock(at)}` : ''}`,
            meta: at ? `queued ${clock(at)}` : undefined,
            candidateMeta: at ? `queued ${clock(at)}` : undefined,
            tip: 'Waits for its turn on main. Nothing to do; it lands or stops by itself.',
            step: {
              tone: 'waiting',
              glyph: 'waiting',
              title: 'In the landing queue',
              body: `It lands or stops on its own; nothing to do here.`,
            },
          });
          break;
        }
        case 'checking':
          Object.assign(fact, {
            state: 'checking',
            tone: 'running',
            label: 'Checking',
            text: `${check} running${run?.startedAt ? ` · started ${clock(run.startedAt)}` : ''}`,
            meta: `in check ${clock(run?.startedAt)}`,
            step: {
              tone: 'running',
              glyph: 'running',
              title: 'Checking…',
              body: 'The check is running on the latest Candidate of this Lane.',
            },
          });
          break;
        case 'waiting-for-review':
          Object.assign(fact, {
            state: 'review',
            tone: 'passed',
            label: 'Ready',
            text: `${check} passed · waiting for a person`,
            meta: at ? `queued ${clock(at)}` : undefined,
            step: {
              tone: 'passed',
              glyph: 'review',
              title: 'Stopped for your review. The check passed on exactly this code.',
              body: fact.handoff ?? '',
            },
          });
          break;
        case 'waiting-for-dependency':
          Object.assign(fact, {
            state: 'dependency',
            tone: 'waiting',
            label: 'Waiting',
            text: lane.stackParent
              ? `Waiting for parent Lane «${lane.stackParent.name}» to land`
              : (lane.stack?.summary ?? ''),
            step: lane.stackParent
              ? {
                  tone: 'waiting',
                  glyph: 'waiting',
                  title: `Waiting for «${lane.stackParent.name}» to land`,
                  body: 'Lands right after its parent; no action needed.',
                }
              : undefined,
            ...(lane.stackParent
              ? { link: { kind: 'lane', id: lane.stackParent.laneId, label: 'Open parent Lane' } }
              : {}),
          });
          break;
        case 'pending-infra':
          Object.assign(fact, {
            state: 'machine',
            tone: 'waiting',
            label: 'Waiting',
            text: `Waiting for a machine${last}`,
            tip: 'No check machine has picked this up yet. Not a failure of the code.',
            step: {
              tone: 'waiting',
              glyph: 'waiting',
              title: 'Waiting for a machine',
              body: `${event ? `Last event ${clock(event)}. ` : ''}The code has not been judged.`,
            },
          });
          break;
      }
      if (submission.stall)
        Object.assign(fact, {
          text: `${fact.text} · ${submission.stall.message}`,
          tip: submission.stall.message,
        });
    } else if (
      notices.some(
        notice =>
          notice.applicability === 'historical' &&
          notice.evidence?.some(e => e.kind === 'check' && e.runId === run?.id),
      ) &&
      !current
    ) {
      Object.assign(fact, {
        state: 'not-run',
        label: 'Not run',
        tone: 'plain',
        text: 'Check outcome not recorded',
        historical: true,
      });
    } else if (submission.cause === 'check-failed' && (!run || run.cause === 'check-failed')) {
      Object.assign(fact, {
        state: 'failed',
        decisionSubtitle: `${check} failed${exit}${run?.endedAt ? ` · ${clock(run.endedAt)}` : ''}`,
        tone: 'failed',
        label: 'Check failed',
        meta: `in check ${clock(run?.startedAt)}${run?.endedAt ? ` · failed ${clock(run.endedAt)}` : ''}`,
        text: `${check} failed${exit} · nobody's on it`,
        step: {
          tone: 'failed',
          glyph: 'failed',
          queue: true,
          title: 'Not ready to accept: the check failed',
          body: `${check}${exit} · retained output kept with this Candidate.`,
        },
        ...(run
          ? {
              link: {
                kind: 'run',
                id: run.id,
                viewId: run.viewId,
                intentId: run.intentId,
                label: 'Open run',
              },
            }
          : {}),
      });
    } else if (submission.cause === 'conflict') {
      const count = current?.conflicts.length;
      Object.assign(fact, {
        state: 'conflict',
        tone: 'conflict',
        label: 'Conflict',
        text: `Can't update from main${count ? ` · ${count} ${count === 1 ? 'file' : 'files'}` : ''}`,
      });
    } else if (run && run.cause === 'unknown-outcome') {
      fact.text = `Check outcome not recorded${status.landingWorker.observedAt ? ` · last event ${clock(status.landingWorker.observedAt)}` : ''}`;
    }
    fact.glyph = fact.state === 'working' ? 'passed' : fact.tone;
    if (fact.state === 'not-run') {
      if (entry?.status === 'cancelled') fact.text = "Check didn't run";
      else fact.tip = notRunTip;
      fact.candidateMeta = "check didn't run";
      fact.meta = fact.text;
    }
    for (const item of lane.entries) {
      fact.events.push({
        id: `submitted:${item.id}`,
        laneId: lane.laneId,
        at: item.arrivedAt,
        tone: 'waiting',
        glyph: 'waiting',
        text: 'Submitted to main queue',
      });
      if (item.move)
        fact.events.push({
          id: `move:${item.move.id}`,
          laneId: lane.laneId,
          at: item.move.at,
          tone: 'passed',
          glyph: 'passed',
          text: `Landed on main · ${short(item.move.head)} · ${Math.max(0, Math.round((Date.parse(item.move.at) - Date.parse(item.arrivedAt)) / 60000))} min after submit`,
          ...(item.move.automatic ? { automatic: item.move.automatic } : {}),
        });
      if (item.run && item.status === 'failed' && item.run.cause === 'check-failed')
        fact.events.push({
          id: `run:${item.run.id}`,
          laneId: lane.laneId,
          at: item.run.endedAt ?? item.run.startedAt,
          tone: 'failed',
          glyph: 'failed',
          text: `Check failed in the queue · ${item.run.check.name}${typeof item.run.exitCode === 'number' ? ` · exit ${item.run.exitCode}` : ''}`,
        });
      if (
        item.run &&
        ['failed', 'interrupted', 'cancelled', 'runner-unavailable', 'runner-budget-exhausted'].includes(
          item.run.status,
        ) &&
        item.run.cause !== 'check-failed'
      )
        fact.events.push({
          id: `run:${item.run.id}`,
          laneId: lane.laneId,
          at: item.run.endedAt ?? item.run.startedAt,
          tone: 'plain',
          glyph: 'check',
          text: item.run.cause === 'unknown-outcome' ? 'Check outcome not recorded' : "Check didn't run",
        });
    }
    if (fact.state === 'later')
      fact.events.push({
        id: `later:${submission.submissionId}`,
        laneId: lane.laneId,
        at: lane.checkpoints.at(-1)?.at ?? at ?? '',
        tone: 'plain',
        glyph: 'stale',
        text: `Saved again · earlier result kept with ${short(submission.attemptHead)}`,
      });
    const syncs = [
      ...new Map(
        notices
          .flatMap(notice => notice.syncs ?? [])
          .filter(sync => sync.laneId === lane.laneId)
          .map(sync => [sync.operationId, sync]),
      ).values(),
    ];
    for (const sync of syncs) {
      const save = lane.checkpoints.find(save => save.head === sync.head);
      const paths = save?.sync?.changedPaths;
      if (!save) continue;
      fact.events.push({
        id: `sync:${sync.operationId}`,
        laneId: lane.laneId,
        at: save.at,
        tone: 'plain',
        glyph: 'sync',
        text: `Updated from main${paths ? ` · ${paths.length} ${paths.length === 1 ? 'file' : 'files'}` : ''}`,
        automatic: {
          summary: 'Updated from main',
          undo: sync.undoneBy.length ? 'Already undone' : JSON.stringify(sync.undo),
        },
        ...(sync.undoneBy.length ? { undone: true } : {}),
      });
    }
    for (const save of lane.checkpoints)
      if (
        save.automatic &&
        save.sync &&
        !fact.events.some(event => event.id === `sync:${save.sync?.operation?.id ?? save.operation?.id}`)
      ) {
        fact.events.push({
          id: `sync:${save.sync.operation?.id ?? save.operation?.id ?? save.head}`,
          laneId: lane.laneId,
          at: save.at,
          tone: 'plain',
          glyph: 'sync',
          text: `Updated from main · ${save.sync.changedPaths.length} ${save.sync.changedPaths.length === 1 ? 'file' : 'files'}`,
          automatic: save.automatic,
        });
      }
    for (const event of fact.events) event.detail = lane.name;
    facts.set(lane.laneId, fact);
  }
  return facts;
}

export function serviceLastSeen(
  status: PendingStatus,
  now: number,
): { tone: 'plain' | 'stale'; text: string; tip: string } | null {
  const pending = status.lanes.filter(lane => lane.submission?.state === 'pending');
  const worker = status.landingWorker;
  if (!pending.length || worker.status === 'unknown') return null;
  const at = worker.observedAt ? Date.parse(worker.observedAt) : NaN;
  const recent =
    ['driving', 'idle', 'recovering'].includes(worker.status) && Number.isFinite(at) && now - at < 600_000;
  const waiting = pending.filter(lane => lane.submission?.pendingReason !== 'checking').length;
  const checking = pending.length - waiting;
  return {
    tone: recent ? 'plain' : 'stale',
    text: recent
      ? ['queue', waiting && `${waiting} waiting`, checking && `${checking} checking`]
          .filter(Boolean)
          .join(' · ')
      : Number.isFinite(at)
        ? `owner not seen since ${seenAt(at, now)}`
        : 'owner not seen yet',
    tip: `${Number.isFinite(at) ? `Last landing event ${seenAt(at, now)}. ` : ''}Queued work is kept and lands when the owner is back. This is not a failure.`,
  };
}

export function queueHref(link: NonNullable<QueueFact['link']>): string {
  return hostedHref(
    link.kind === 'run'
      ? {
          projectTab: 'intent',
          intent: link.intentId ?? '',
          intentTab: 'delivery',
          classic: '1',
          reviewView: link.viewId ?? '',
          checkRun: link.id,
        }
      : link.kind === 'repair-intent'
        ? { projectTab: 'intent', intent: link.id }
        : link.kind === 'lane'
          ? { projectTab: 'lanes', lane: link.id }
          : { projectTab: 'view', viewId: link.id },
  );
}
