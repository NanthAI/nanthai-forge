// SPDX-License-Identifier: Apache-2.0
import { checkMeaning, latestRun } from './check-meaning';
export { latestRun } from './check-meaning';
import type { Lane, WorkView, CheckRun } from '../../../src/work-types';
import { attentionRank, type Tone } from '../ui/status';

/** The cockpit's view of one Lane: everything a row needs, derived only from recorded Work. */
export type CockpitLane = {
  id: string;
  name: string;
  head: string;
  intentId: string;
  intent: string;
  owner: string;
  /** Who started the Lane, as recorded by `agent start` or the person who created it. */
  startedBy?: { kind: 'person' | 'agent'; name: string; tool?: string };
  /** Recorded by the agent workflow (agent start or agent checkpoints), not inferred from a name. */
  byAgent: boolean;
  tone: Tone;
  label: string;
  /** One sentence: the most important fact about this Lane right now. */
  fact: string;
  lastAt?: string;
  viewId?: string;
  runStatus?: CheckRun['status'];
  laterViewId?: string;
  conflicts: string[];
  checkpoints: number;
  open: boolean;
  /** Recorded Lane pause, independent of the derived check tone. */
  paused?: boolean;
  /** The head reached main; completing an unaccepted Lane is a separate fact. */
  accepted?: boolean;
  /** Whether the checked head already contains main (true/false), when known. */
  mainIncluded?: boolean;
  /** Saved changes against the Lane base, when known. */
  changes?: { add?: number; del?: number; files: number };
  /** The live session reporting work on this Lane, when one exists. */
  session?: {
    name: string;
    tone: Tone;
    lastSeen: number;
    environment?: string;
    person?: boolean;
    /** The coding tool the session reported, e.g. codex. */
    harness?: string;
    /** The session id, to address a message to it. */
    id?: string;
  };
};

/** Local records and deliberately slim hosted summaries share only these cockpit fields. */
export type CockpitWork = {
  channelMoves?: readonly { channel: string; status?: string; head?: string; viewId: string; at?: string }[];
  intents: readonly {
    id: string;
    outcome: string;
    status?: string;
    createdAt?: string;
    agentStart?: { laneId: string };
  }[];
  lanes: readonly (Pick<Lane, 'id' | 'intentId' | 'name' | 'head' | 'base' | 'state' | 'assignment'> & {
    startedBy?: Lane['startedBy'];
    checkpoints?: Lane['checkpoints'];
    lifecycle?: Lane['lifecycle'];
    pendingMerge?: Lane['pendingMerge'];
    changes?: CockpitLane['changes'] | string;
    checkpointCount?: number;
    lastCheckpointAt?: string;
    lastCheckpointMessage?: string;
    /** For Lanes only: whether this head is already contained in hosted main. */
    main?: { head: string | null; included: boolean | null };
  })[];
  views: readonly (Pick<WorkView, 'id' | 'intentId' | 'base' | 'head' | 'status' | 'at'> & {
    inputs?: WorkView['inputs'];
    dependencies?: WorkView['dependencies'];
  })[];
  runs: readonly (Pick<CheckRun, 'id' | 'viewId' | 'status'> & {
    head?: string;
    startedAt?: string;
    endedAt?: string;
    check?: { name?: string };
    checkName?: string;
    exitCode?: number | null;
    failureSummary?: string;
    checkQuarantine?: NonNullable<CheckRun['backend']>['quarantine'];
    mainCheck?: { channel: string };
    environment?: CheckRun['environment'];
    /** Hosted summaries say whether the checked head contains the hosted main. */
    main?: { included: boolean | null };
  })[];
};

function latest<T>(items: readonly T[], at: (item: T) => string | undefined): T | undefined {
  return items.reduce<T | undefined>(
    (best, item) => (!best || (at(item) ?? '') >= (at(best) ?? '') ? item : best),
    undefined,
  );
}

export function cockpitLanes(work: CockpitWork): CockpitLane[] {
  const outcomes = new Map(work.intents.map(intent => [intent.id, intent.outcome]));
  const created = new Map(work.intents.map(intent => [intent.id, intent.createdAt]));
  const agentLanes = new Set(
    work.intents.flatMap(intent => (intent.agentStart ? [intent.agentStart.laneId] : [])),
  );
  const accepted = (work.channelMoves ?? []).filter(
    move => move.channel === 'main' && (move.status === undefined || move.status === 'accepted'),
  );
  const acceptedHeads = new Set(accepted.map(move => move.head));
  const acceptedViews = new Set(accepted.map(move => move.viewId));
  const landedInputs = new Set(
    work.views
      .filter(view => acceptedViews.has(view.id))
      .flatMap(view => (view.inputs ?? []).map(input => JSON.stringify([input.laneId, input.head]))),
  );
  return work.lanes.map(lane => {
    const checkpoints = lane.checkpoints ?? [];
    const view = latest(
      work.views.filter(item =>
        (item.inputs ?? []).some(input => input.laneId === lane.id && input.head === lane.head),
      ),
      item => item.at,
    );
    const run = view && latestRun(work.runs, view.id);
    const meaning = run && view ? checkMeaning(work, view.id, run.status) : undefined;
    const conflicts = lane.pendingMerge?.conflicts?.map(conflict => conflict.path) ?? [];
    const byAgent =
      agentLanes.has(lane.id) || checkpoints.some(checkpoint => checkpoint.operation !== undefined);
    const reachedMain =
      lane.main?.included === true ||
      acceptedHeads.has(lane.head) ||
      landedInputs.has(JSON.stringify([lane.id, lane.head]));
    const open =
      !['completed', 'abandoned'].includes(lane.state) &&
      lane.main?.included !== true &&
      !acceptedHeads.has(lane.head) &&
      !landedInputs.has(JSON.stringify([lane.id, lane.head]));
    const saves = lane.checkpointCount ?? checkpoints.length;
    // A Lane without saves is as fresh as its Intent; never call new work quiet.
    const lastAt = [
      created.get(lane.intentId),
      lane.lastCheckpointAt ?? checkpoints.at(-1)?.at,
      view?.at,
      run?.endedAt ?? run?.startedAt,
    ]
      .filter((value): value is string => Boolean(value))
      .sort()
      .at(-1);
    let tone: Tone = 'active',
      label = 'Working',
      fact = saves ? `${saves} ${saves === 1 ? 'save' : 'saves'}` : 'No saved changes yet';
    if (!open) {
      tone = 'plain';
      label = lane.state === 'abandoned' ? 'Abandoned' : 'Done';
      fact = lane.state === 'abandoned' ? 'Abandoned' : 'Complete';
    } else if (conflicts.length) {
      tone = 'conflict';
      label = 'Conflict';
      fact = `Updating from ${lane.pendingMerge?.channel ?? 'main'} conflicts in ${conflicts.length === 1 ? conflicts[0] : `${conflicts.length} files`}`;
    } else if (view?.status === 'conflict') {
      tone = 'conflict';
      label = 'Conflict';
      fact = 'Its View could not combine cleanly';
    } else if (run && ['interrupted', 'cancelled'].includes(run.status)) {
      tone = 'plain';
      label = run.status === 'cancelled' ? 'Cancelled' : 'Interrupted';
      fact = `Check ${run.status}`;
    } else if (meaning && 'laterViewId' in meaning) {
      tone = 'plain';
      label = 'Check failed';
      fact = meaning.label;
    } else if (run?.status === 'failed') {
      tone = 'failed';
      label = run.status === 'failed' ? 'Check failed' : `Check ${run.status}`;
      const checkName = run.checkName ?? run.check?.name;
      const name = checkName?.trim() || 'Check';
      fact = `${name}${/failed$/i.test(name) ? '' : ' failed'}${typeof run.exitCode === 'number' ? ` · exit ${run.exitCode}` : ''}${byAgent || lane.startedBy?.kind === 'agent' ? '' : ' · nobody’s on it'}`;
    } else if (run && (run.status === 'queued' || run.status === 'running' || run.status === 'preparing')) {
      tone = run.status === 'queued' ? 'waiting' : 'running';
      label = run.status === 'queued' ? 'Queued' : 'Checking';
      fact =
        run.status === 'queued' ? 'Check queued for machine capacity' : 'Check running on its latest View';
    } else if (run?.status === 'passed' && run.main?.included === false) {
      tone = 'waiting';
      label = 'Needs update';
      fact = 'Check passed, but main has moved since; finishing again updates it';
    } else if (run?.status === 'passed') {
      tone = 'passed';
      label = 'Ready';
      fact = 'Check passed on its latest View';
    } else if (lane.state === 'paused') {
      tone = 'waiting';
      label = 'Paused';
    } else if (lane.state === 'ready') {
      tone = 'waiting';
      label = 'Waiting';
      fact = 'Marked ready; no passing check yet';
    }
    return {
      id: lane.id,
      name: lane.name,
      head: lane.head,
      intentId: lane.intentId,
      intent: outcomes.get(lane.intentId) ?? 'Unknown Intent',
      owner: (lane.assignment ?? '').trim(),
      ...(lane.startedBy ? { startedBy: lane.startedBy } : {}),
      byAgent: byAgent || lane.startedBy?.kind === 'agent',
      tone,
      label,
      fact,
      ...(lastAt ? { lastAt } : {}),
      ...(view ? { viewId: view.id } : {}),
      ...(run ? { runStatus: run.status } : {}),
      ...(meaning && 'laterViewId' in meaning ? { laterViewId: meaning.laterViewId } : {}),
      conflicts,
      ...(typeof lane.changes === 'object' ? { changes: lane.changes } : {}),
      checkpoints: saves,
      open,
      paused: lane.state === 'paused',
      accepted: reachedMain,
      ...(typeof run?.main?.included === 'boolean' ? { mainIncluded: run.main.included } : {}),
    };
  });
}

/** Open Lanes first by what needs a decision, then most recent activity. */
export function byAttention(lanes: readonly CockpitLane[]): CockpitLane[] {
  return [...lanes].sort(
    (a, b) => attentionRank[a.tone] - attentionRank[b.tone] || (b.lastAt ?? '').localeCompare(a.lastAt ?? ''),
  );
}
