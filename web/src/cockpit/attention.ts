// SPDX-License-Identifier: Apache-2.0
import { queueFacts, type QueueFact } from './queue-model';
import { displayLaneName } from '../../../src/lane-name';
import type { CockpitWork } from './model';
import type { CockpitLane } from './model';
import { checkMeaning } from './check-meaning';
export { overlapDecisions } from './overlap-decisions';
export { needsFixDecisions } from './needs-fix';

/** Something that needs a decision from the viewer, with its one-click answers. */
export type DecisionItem = {
  id: string;
  githubMirror?: boolean;
  queue?: QueueFact;
  kind: 'review' | 'conflict' | 'handoff' | 'message' | 'failed' | 'overlap' | 'revert' | 'needs-fix';
  files?: { path: string; with: string }[];
  noticeIds?: string[];
  overlapCount?: number;
  tests?: string[];
  moreTests?: number;
  exact?: { reverted?: string; audit?: string; undo: string };
  title: string;
  /** Recorded sender and audience belong in the item metadata, outside its body. */
  sender?: { name: string; agent: boolean };
  audience?: string;
  broadcast?: boolean;
  body?: string;
  quote?: { from: string; to?: string; text: string };
  at?: string | number;
  laneId?: string;
  viewId?: string;
  runId?: string;
  messageId?: string;
  intentId?: string;
  /** Other unacknowledged messages folded under the latest one. */
  earlier?: DecisionItem[];
  /** Session or participant a reply goes to. */
  replyTo?: string;
  /** The message asks something, so replying is the expected answer. */
  question?: boolean;
  /** One-click answers the sender offered. */
  choices?: string[];
  /** Quiet context after the title, e.g. "merged-detection, claude-3". */
  subtitle?: string;
  /** Ready-to-accept facts: check on this head, whether main is included, overlapping Lanes. */
  gates?: { main?: boolean; overlaps: number; queuedAt?: string };
  /** Small fact beside the answers, e.g. "6 files · +212 −38". */
  hint?: string;
  /** The person or agent best placed to take it next. */
  owner?: string;
  /** The live session that can simply continue the work. */
  continues?: { name: string; environment?: string; harness?: string; recipient?: string };
  /** The work it is about, for headers: status, Lane and Intent. */
  subject?: { tone: CockpitLane['tone']; label: string; lane: string; intent: string };
};

export type FeedItem = {
  id: string;
  at: string | number;
  automatic?: { summary: string; undo: string };
  historical?: boolean;
  undone?: boolean;
  links?: { href: string; label: string }[];
  tone: 'passed' | 'failed' | 'conflict' | 'waiting' | 'active' | 'plain' | 'stale';
  glyph:
    | 'passed'
    | 'failed'
    | 'conflict'
    | 'channel'
    | 'message'
    | 'handoff'
    | 'claim'
    | 'file'
    | 'sync'
    | 'check'
    | 'waiting'
    | 'stale';
  text: string;
  detail?: string;
  laneId?: string;
  laterViewId?: string;
};

const ownerOf = (lane: CockpitLane) =>
  lane.session?.name ?? lane.startedBy?.name ?? (lane.owner || undefined);

/**
 * Decisions from recorded state: Lanes whose check passed on their current head, and Lanes stuck in a
 * conflict. `overlaps` counts other Lanes touching the same files.
 */
export function laneDecisions(
  lanes: readonly CockpitLane[],
  overlaps: ReadonlyMap<string, number> = new Map(),
): DecisionItem[] {
  return lanes
    .filter(
      lane =>
        lane.open &&
        (lane.tone === 'conflict' ||
          (lane.queue ? ['review', 'failed'].includes(lane.queue.state) : lane.tone === 'passed')),
    )
    .map(lane => {
      const owner = ownerOf(lane);
      const continues = lane.session
        ? {
            name: lane.session.name,
            ...(lane.session.environment ? { environment: lane.session.environment } : {}),
            ...(lane.session.harness ? { harness: lane.session.harness } : {}),
            ...(lane.session.id ? { recipient: lane.session.id } : {}),
          }
        : lane.startedBy?.kind === 'agent'
          ? {
              name: lane.startedBy.name,
              ...(lane.startedBy.tool ? { environment: lane.startedBy.tool } : {}),
            }
          : undefined;
      const base = {
        laneId: lane.id,
        ...(lane.queue ? { queue: lane.queue } : {}),
        subject: { tone: lane.tone, label: lane.label, lane: lane.name, intent: lane.intent },
        ...(lane.lastAt ? { at: lane.lastAt } : {}),
        ...(owner ? { owner } : {}),
        ...(continues ? { continues } : {}),
      };
      if (lane.queue?.state === 'failed')
        return {
          ...base,
          id: `failed:${lane.id}`,
          kind: 'failed' as const,
          title: lane.name,
          subtitle: lane.queue.decisionSubtitle ?? lane.queue.text,
          runId: lane.queue.runId,
          viewId: lane.queue.viewId,
          hint: 'Retained output stays with this Candidate.',
        };
      if (lane.tone === 'passed') {
        const changes = lane.changes;
        return {
          ...base,
          id: `review:${lane.id}`,
          kind: 'review' as const,
          title: lane.intent,
          subtitle:
            lane.queue?.handoff ?? [lane.name !== lane.intent && lane.name, owner].filter(Boolean).join(', '),
          gates: {
            overlaps: overlaps.get(lane.id) ?? 0,
            ...(lane.queue?.since ? { queuedAt: lane.queue.since } : {}),
            ...(lane.mainIncluded !== undefined ? { main: lane.mainIncluded } : {}),
          },
          ...(changes?.add !== undefined
            ? {
                hint: `${changes.files} ${changes.files === 1 ? 'file' : 'files'} · +${changes.add} −${changes.del ?? 0}`,
              }
            : {}),
          ...(lane.viewId ? { viewId: lane.viewId } : {}),
        };
      }
      const [first, ...rest] = lane.conflicts;
      return {
        ...base,
        id: `conflict:${lane.id}`,
        kind: 'conflict' as const,
        title: `${lane.name} can't update from main`,
        body: first
          ? `${first}${rest.length ? ` and ${rest.length} more` : ''} changed on main and in this Lane.`
          : lane.fact,
      };
    });
}

type LocalRecords = {
  pendingStatus?: CockpitWork['pendingStatus'];
  landingEntries?: CockpitWork['landingEntries'];
  landingBatches?: CockpitWork['landingBatches'];
  intents?: readonly { id: string; outcome: string }[];
  lanes: readonly {
    id: string;
    name: string;
    intentId?: string;
    checkpoints: readonly { head: string; message: string; at: string }[];
  }[];
  views: readonly { id: string; intentId?: string; at?: string; inputs: readonly { laneId: string }[] }[];
  runs: readonly {
    id: string;
    viewId: string;
    status: string;
    startedAt: string;
    endedAt?: string;
    check?: { name?: string };
  }[];
  channelMoves: readonly {
    id: string;
    channel: string;
    viewId: string;
    head: string;
    at: string;
    status: string;
  }[];
};

/** Recent recorded activity for local projects: saves, check results and acceptances, newest first. */
export function localFeed(work: LocalRecords, since: number, limit = 8): FeedItem[] {
  const laneOfView = new Map(work.views.map(view => [view.id, view.inputs[0]?.laneId]));
  const laneName = new Map(
    work.lanes.map(lane => [
      lane.id,
      displayLaneName(
        lane.name,
        work.intents?.find(intent => intent.id === lane.intentId)?.outcome ?? lane.name,
      ),
    ]),
  );
  const items: FeedItem[] = [];
  for (const lane of work.lanes)
    for (const save of lane.checkpoints)
      items.push({
        id: `save:${save.head}`,
        at: save.at,
        tone: 'plain',
        glyph: save.message.startsWith('Sync main') ? 'sync' : 'file',
        text: `${laneName.get(lane.id)} · saved`,
        detail: save.message,
        laneId: lane.id,
      });
  for (const run of work.runs) {
    if (!['passed', 'failed', 'cancelled', 'interrupted'].includes(run.status)) continue;
    const laneId = laneOfView.get(run.viewId);
    const state = checkMeaning(work, run.viewId, run.status);
    items.push({
      id: `run:${run.id}`,
      at: run.endedAt ?? run.startedAt,
      tone: state.tone === 'running' ? 'active' : state.tone,
      glyph: state.glyph === 'running' ? 'sync' : state.glyph === 'plain' ? 'check' : state.glyph,
      ...('laterViewId' in state ? { laterViewId: state.laterViewId } : {}),
      text:
        'laterViewId' in state
          ? state.label
          : `${laneId ? (laneName.get(laneId) ?? 'A Candidate') : 'A Candidate'} · check ${run.check?.name ? `${run.check.name} ` : ''}${run.status}`,
      ...(laneId ? { laneId } : {}),
    });
  }
  for (const move of work.channelMoves)
    if (move.status === 'accepted') {
      const laneId = laneOfView.get(move.viewId);
      items.push({
        id: `move:${move.id}`,
        at: move.at,
        tone: 'passed',
        glyph: 'channel',
        text: `${laneId ? (laneName.get(laneId) ?? 'A Candidate') : 'A Candidate'} · accepted into ${move.channel}`,
        detail: move.head.slice(0, 7),
        ...(laneId ? { laneId } : {}),
      });
    }
  const queue = work.pendingStatus ? queueFacts(work.pendingStatus) : undefined;
  for (const fact of queue?.values() ?? [])
    for (const event of fact.events) {
      const index = items.findIndex(item => item.id === event.id);
      if (index >= 0) items.splice(index, 1);
      const lane = work.lanes.find(lane => lane.id === fact.laneId);
      items.push({
        ...event,
        detail: [lane?.name, work.intents?.find(intent => intent.id === lane?.intentId)?.outcome]
          .filter(Boolean)
          .join(' · '),
      });
    }
  return items
    .filter(item => Date.parse(String(item.at)) >= since)
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
    .slice(0, limit);
}

/** Fold messages about one Lane/Intent; the latest message keeps its answers. */
export function groupDecisions(items: readonly DecisionItem[]): DecisionItem[] {
  const groups = new Map<string, DecisionItem[]>();
  for (const item of items) {
    const context = item.laneId ?? item.intentId;
    const key = item.kind === 'message' && context ? `message:${context}` : item.id;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return [...groups.values()].map(group => {
    group.sort((a, b) => new Date(b.at ?? 0).getTime() - new Date(a.at ?? 0).getTime());
    const [latest, ...earlier] = group;
    return earlier.length ? { ...latest!, earlier } : latest!;
  });
}

/** Keep a failed accepted-main run visible even after its input Lanes complete. */
export function mainCheckDecisions(runs: CockpitWork['runs']): DecisionItem[] {
  const latest = new Map<string, CockpitWork['runs'][number]>();
  for (const run of runs)
    if (run.mainCheck && !['queued', 'preparing', 'running'].includes(run.status)) {
      const previous = latest.get(run.mainCheck.channel);
      if (!previous || (run.startedAt ?? '') >= (previous.startedAt ?? ''))
        latest.set(run.mainCheck.channel, run);
    }
  return [...latest].flatMap(([channel, run]) =>
    ['failed', 'interrupted', 'cancelled'].includes(run.status)
      ? [
          {
            id: `main-check:${run.id}`,
            kind: 'failed' as const,
            title: `${channel} full check ${run.status} after acceptance`,
            body: `${run.failureSummary ? `${run.failureSummary}\n\n` : ''}Inspect the failing run and the Fix main Intent's agent prompt. Fix forward from current ${channel}; accepted work has not been rewound.`,
            viewId: run.viewId,
            runId: run.id,
            ...(run.endedAt ? { at: run.endedAt } : {}),
          },
        ]
      : [],
  );
}

/** Local owner metadata is derived from refresh receipts, never a Work record. */
export function ownerRootDecisions(notice?: {
  status: string;
  head: string;
  message: string;
  recovery: string;
}): DecisionItem[] {
  return notice?.status === 'skipped'
    ? [
        {
          id: `owner-root:${notice.head}`,
          kind: 'conflict',
          title: 'Owner folder needs refresh',
          body: notice.message,
          hint: notice.recovery,
        },
      ]
    : [];
}

export function githubPushDecisions(
  status?: import('../../../src/github-sync-types').GithubAutoPush,
): DecisionItem[] {
  if (status?.status !== 'needs-you') return [];
  return [
    {
      id: `github-mirror:${status.operationId}`,
      kind: 'conflict',
      githubMirror: true,
      title: `GitHub mirror ${status.repository} diverged`,
      at: status.at,
      body: `Both heads are retained. Forge State: ${status.state}. Forge Git head: ${status.localHead ?? 'not projected'}. GitHub head: ${status.remoteHead ?? 'unknown'}. Expected GitHub head: ${status.expectedHead ?? 'unknown'}. Reconcile the histories before retrying publication.`,
    },
  ];
}

/** Latest runner receipt contains the project quarantine snapshot, including release. */
export function quarantineDecisions(runs: CockpitWork['runs']): DecisionItem[] {
  const latest = runs
    .filter(run => run.checkQuarantine !== undefined && run.endedAt)
    .sort((a, b) => b.endedAt!.localeCompare(a.endedAt!) || b.id.localeCompare(a.id))[0];
  return (latest?.checkQuarantine ?? []).map(item => ({
    id: `check-quarantine:${item.test}`,
    kind: 'failed',
    title: `Quarantined test: ${item.test}`,
    body: `Two supported flake verdicts occurred within seven days. This test still runs and reports; failures on related changes or without source evidence still block landing. ${item.consecutivePasses}/20 consecutive passes toward automatic release. An explicit fix also releases quarantine.`,
    viewId: latest!.viewId,
    runId: latest!.id,
    at: latest!.endedAt,
  }));
}
