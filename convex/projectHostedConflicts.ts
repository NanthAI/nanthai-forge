// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import type { Doc, Id } from './_generated/dataModel';
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from './server';
import { effectivePolicy } from '../src/autonomy-policy';
import { earlyResolutionForProject } from './projectFinishReadReader';
import { conflictPredecessor } from './projectHostedConflictPredecessor';
import { landingQueue } from './projectHostedLandingEvents';
import { readHostedRecord } from './projectHostedRecords';
import { findObject } from './projectObjectFind';
import { query } from './cliServer';
import { accessibleProject } from './projectAuthority';
import { report } from './errors';
import { wakeConflictLane } from './projectHostedConflictDelivery';
import { invariant } from '../src/errors';
import { canonicalPayload } from '../src/hosted-source-operation';
import { hostedMainV2Schema } from '../src/hosted-main';
import { sameResolution, sameStack, type OverlapChange } from '../src/hosted-overlap';
import { overlapMainSince } from './projectHostedOverlapMainLog';
import { overlapLaneChanges, overlapLaneEntries } from './projectHostedOverlapChanges';
import { presenceMayShare } from '../src/hosted-presence';
import { NOTICE_PATHS } from '../src/conflict-notice-paths';
import type { TrialTask } from '../src/hosted-trial-merge';
import {
  TRIAL_FILE_BYTES,
  TRIAL_MAIN_STATE_BYTES,
  TRIAL_PATHS,
  TRIAL_PEERS,
  trialObject,
  type TrialObject,
  type TrialPlan,
} from '../src/hosted-trial-plan';

/** Exact conflicts at save (flip 4, Issue 853fcde3). A Lane record whose head moved (an explicit save,
 * sync or resolve; hidden snapshots never write the Lane record) plans a trial merge here, inside the
 * record write that already runs: one slim presence range and point reads of the peers that saved a
 * shared file. Nothing shared schedules nothing, so such a save makes no added call. A shared file
 * schedules one action (projectHostedConflictMerge:run) that reads the bytes from R2, merges, and
 * records through one mutation (`record`): two calls, no file bytes in Convex. */

type Row = Doc<'projectHostedOverlapLanes'>;
type Cleared = 'save' | 'landed' | 'abandoned';
const MAIN = 'main';
/** Open rows read per Lane, as the overlap read's peer window. Local (not imported) because this
 * module sits under the Lane record write, which the dormancy and channel modules import. */
const PEER_WINDOW = 51;
const channelRow = (ctx: QueryCtx, projectId: Id<'hostedProjects'>) =>
  ctx.db
    .query('projectHostedChannels')
    .withIndex('by_project_and_name', q => q.eq('projectId', projectId).eq('name', 'main'))
    .unique();

async function openRows(ctx: QueryCtx, projectId: Id<'hostedProjects'>, laneId: string) {
  const [mine, about] = await Promise.all([
    ctx.db
      .query('projectHostedConflictNotices')
      .withIndex('by_project_and_lane_and_open', q =>
        q.eq('projectId', projectId).eq('laneId', laneId).eq('open', true),
      )
      .take(PEER_WINDOW),
    ctx.db
      .query('projectHostedConflictNotices')
      .withIndex('by_project_and_peer_and_open', q =>
        q.eq('projectId', projectId).eq('peer', laneId).eq('open', true),
      )
      .take(PEER_WINDOW),
  ]);
  return { mine, about };
}

/** Close this Lane's open notices and the notices other Lanes hold about it, except the pairs `keep`
 * still has to decide. Reads two small index ranges; usually both are empty. */
export async function closeConflictNotices(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  laneId: string,
  cleared: Cleared,
  keep: ReadonlySet<string> = new Set(),
) {
  const { mine, about } = await openRows(ctx, projectId, laneId);
  const now = Date.now();
  const endedPeers = new Set<string>();
  for (const row of mine)
    if (!keep.has(row.peer)) {
      await ctx.db.patch(row._id, { open: false, clearedAt: now, cleared });
      if (row.peer !== MAIN) endedPeers.add(row.peer);
    }
  for (const row of about)
    if (!keep.has(row.laneId)) {
      await ctx.db.patch(row._id, { open: false, clearedAt: now, cleared });
      endedPeers.add(row.laneId);
    }
  // Nothing left open on either side of this Lane: its later writes skip these reads again.
  if (!keep.size) {
    const lane = await laneRow(ctx, projectId, laneId);
    if (lane?.conflicted) await ctx.db.patch(lane._id, { conflicted: undefined });
  }
  // Ending a pair also ends the other Lane's flag when it has no other notices.
  // Otherwise a live mark (and future saves) would keep a stale overlap forever.
  endedPeers.delete(laneId);
  for (const peer of endedPeers) {
    const [own, named] = await Promise.all([
      ctx.db
        .query('projectHostedConflictNotices')
        .withIndex('by_project_and_lane_and_open', q =>
          q.eq('projectId', projectId).eq('laneId', peer).eq('open', true),
        )
        .take(1),
      ctx.db
        .query('projectHostedConflictNotices')
        .withIndex('by_project_and_peer_and_open', q =>
          q.eq('projectId', projectId).eq('peer', peer).eq('open', true),
        )
        .take(1),
    ]);
    if (!own.length && !named.length) {
      const other = await laneRow(ctx, projectId, peer);
      if (other?.conflicted) await ctx.db.patch(other._id, { conflicted: undefined });
    }
  }
}
/** A write that takes files out of the Lane before its new head is published (a background save's
 * pending paths): every notice that names only files the Lane no longer changes ends now, on both
 * sides, so status, peers and the board agree with the save reply (Item 3f70760d, frictions
 * 9ad0df2e, e58dee09). A file the Lane does not change cannot conflict. Pairs that still share a file
 * are decided by the trial merge of the published head. Only for a Lane with open notices: the same
 * two index ranges `closeConflictNotices` reads. */
export async function closeLeftConflicts(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  laneId: string,
  paths: ReadonlySet<string>,
) {
  const { mine, about } = await openRows(ctx, projectId, laneId);
  const keep = new Set<string>();
  for (const row of [...mine, ...about])
    if (row.paths.some(file => paths.has(file.path))) keep.add(row.laneId === laneId ? row.peer : row.laneId);
  if (keep.size < new Set([...mine.map(row => row.peer), ...about.map(row => row.laneId)]).size)
    await closeConflictNotices(ctx, projectId, laneId, 'save', keep);
}
const laneRow = (ctx: QueryCtx, projectId: Id<'hostedProjects'>, laneId: string) =>
  ctx.db
    .query('projectHostedOverlapLanes')
    .withIndex('by_project_and_lane', q => q.eq('projectId', projectId).eq('laneId', laneId))
    .unique();

/** The Lane's saved head is landed work (its own landing, or its resolution's) or was superseded by a
 * landing of its Intent: no exact conflict names it (Item 3f70760d). */
const finishedAtHead = (row: Pick<Row, 'head' | 'landed' | 'superseded'>) =>
  (row.landed?.laneHead === row.head && !row.landed.revertedBy) || row.superseded?.laneHead === row.head;
/** The Lane's saved entries, or with `only` just those of the given paths (a slim peer reads only their buckets). */
const changesOf = async (
  ctx: QueryCtx,
  row: Pick<Row, 'changes' | 'projectId' | 'laneId'>,
  only?: ReadonlySet<string>,
): Promise<OverlapChange[]> => {
  try {
    return JSON.parse(
      only ? await overlapLaneEntries(ctx, row, only) : await overlapLaneChanges(ctx, row),
    ) as OverlapChange[];
  } catch {
    return [];
  }
};
const fileOf = (file: OverlapChange['before']) => (file ? { blob: file.blob, mode: file.mode } : null);

const acceptanceSequence = async (ctx: QueryCtx, projectId: Id<'hostedProjects'>, receiptId: string) =>
  (
    await ctx.db
      .query('projectHostedAcceptances')
      .withIndex('by_project_and_receipt', q => q.eq('projectId', projectId).eq('receiptId', receiptId))
      .unique()
  )?.sequence;

/** A Lane kept open after its own landing and saved again since (friction 8366f56e): the head that
 * landed, when that landing came after the Lane's base. Main holds that head's files, so the trial
 * measures this Lane's edits from it, not from the older base, and its own accepted lines never read
 * as a conflict with main. One indexed read, only for such a Lane. */
async function landedSinceBase(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  row: Row,
  baseSequence: number | undefined,
) {
  const landed = row.landed;
  if (!landed || landed.revertedBy || landed.laneHead === row.head || baseSequence === undefined) return;
  const sequence = await acceptanceSequence(ctx, projectId, landed.receiptId);
  return sequence !== undefined && sequence > baseSequence ? landed.laneHead : undefined;
}

/** Main's changed paths after the Lane's base: the per-landing log after the base (Issue 750c5929),
 * or the whole main path history the overlap read uses when the log cannot answer. */
async function mainChanged(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  baseSequence: number | undefined,
  paths: Set<string>,
) {
  if (baseSequence === undefined) return new Set<string>();
  const history =
    (await overlapMainSince(ctx, projectId, baseSequence)) ??
    (await ctx.db
      .query('projectHostedOverlapMain')
      .withIndex('by_project', q => q.eq('projectId', projectId))
      .unique());
  if (!history || history.sequence <= baseSequence) return new Set<string>();
  const changed = new Set<string>();
  for (const [path, sequence] of JSON.parse(history.changes) as [string, number][])
    if (sequence > baseSequence && paths.has(path)) changed.add(path);
  return changed;
}

/** Plan this Lane's trial merge after its record write. `previousHead` is the head before the write. */
export async function planTrialMerge(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  row: Row,
  previousHead: string | undefined,
) {
  if (!row.open || row.head === previousHead) return;
  const changes = await changesOf(ctx, row);
  const mine = new Map(changes.map(change => [change.path, change]));
  if (!mine.size) {
    if (row.conflicted) await closeConflictNotices(ctx, projectId, row.laneId, 'save');
    return;
  }
  // Slim presence rows name each open Lane's saved paths (complete when pathCount fits); only a peer
  // that may share a file costs a point read of its overlap row.
  const presence = await ctx.db
    .query('projectHostedPresence')
    .withIndex('by_project_and_at', q => q.eq('projectId', projectId))
    .order('desc')
    .take(PEER_WINDOW);
  const minePaths = new Set(mine.keys());
  const candidates = presence
    .filter(peer => peer.laneId !== row.laneId && presenceMayShare(peer, minePaths))
    .slice(0, TRIAL_PEERS * 2);
  const peerRows = (
    await Promise.all(
      candidates.map(peer =>
        ctx.db
          .query('projectHostedOverlapLanes')
          .withIndex('by_project_and_lane', q => q.eq('projectId', projectId).eq('laneId', peer.laneId))
          .unique(),
      ),
    )
  ).filter(
    (peer): peer is Row =>
      !!peer && peer.open && !finishedAtHead(peer) && !sameResolution(row, peer) && !sameStack(row, peer),
  );
  const tasks = new Map<string, TrialTask>();
  const peers = new Map<string, { laneId: string; head: string; goal: string }>();
  for (const peer of peerRows) {
    if (peers.size >= TRIAL_PEERS) break;
    let shared = false;
    for (const change of await changesOf(ctx, peer, minePaths)) {
      const own = mine.get(change.path);
      if (!own || (tasks.size >= TRIAL_PATHS && !tasks.has(change.path))) continue;
      const task = tasks.get(change.path) ?? {
        path: change.path,
        mine: { before: fileOf(own.before), after: fileOf(own.after) },
        peers: [],
      };
      task.peers.push({
        laneId: peer.laneId,
        before: fileOf(change.before),
        after: fileOf(change.after),
      });
      tasks.set(change.path, task);
      shared = true;
    }
    if (shared)
      peers.set(peer.laneId, {
        laneId: peer.laneId,
        head: peer.head,
        goal: peer.intent,
      });
  }
  const baseSequence = row.baseSequence ?? (await acceptanceSequence(ctx, projectId, row.baseReceiptId));
  const onMain = await mainChanged(ctx, projectId, baseSequence, new Set(mine.keys()));
  const mainState = onMain.size || tasks.size ? await mainStateObject(ctx, projectId) : undefined;
  let main: TrialPlan['main'];
  if (mainState) {
    // Main is a side on every selected file it changed; only main-only files count against the cap.
    main = { ...mainState, paths: [] };
    let added = 0;
    for (const path of onMain) {
      if (!tasks.has(path)) {
        if (added >= TRIAL_PATHS) continue;
        added++;
        const own = mine.get(path)!;
        tasks.set(path, {
          path,
          mine: { before: fileOf(own.before), after: fileOf(own.after) },
          peers: [],
        });
      }
      main.paths.push(path);
    }
  }
  // Pairs no longer sharing a file (and main when it no longer changes one) close now.
  if (row.conflicted)
    await closeConflictNotices(
      ctx,
      projectId,
      row.laneId,
      'save',
      new Set([...peers.keys(), ...(main ? [MAIN] : [])]),
    );
  if (!tasks.size) return;
  const digests = new Set<string>();
  for (const task of tasks.values())
    for (const file of [task.mine.before, task.mine.after, ...task.peers.flatMap(p => [p.before, p.after])])
      if (file && file.mode !== 'symlink' && file.mode !== 'gitlink') digests.add(file.blob);
  const objects: TrialObject[] = [];
  for (const digest of digests) {
    const found = await findObject(ctx, projectId, digest);
    if (found && !found.recipe && found.size <= TRIAL_FILE_BYTES) objects.push(trialObject(found));
  }
  const sources: NonNullable<TrialPlan['sources']> = [];
  const states = new Map<string, TrialObject>();
  if (mainState) states.set(mainState.head, mainState.state);
  const sourceState = async (head: string) => {
    if (states.has(head)) return states.get(head);
    const object = await findObject(ctx, projectId, head);
    if (!object || object.recipe || object.size > TRIAL_MAIN_STATE_BYTES) return undefined;
    const selected = trialObject(object);
    states.set(head, selected);
    return selected;
  };
  for (const source of [row, ...peerRows.filter(peer => peers.has(peer.laneId))]) {
    const base = await sourceState(source.baseHead),
      head = await sourceState(source.head);
    if (base && head) {
      // Only a resolution pays this read. The authoritative right State, not its draft
      // delta, proves which exact peer edits the author has already reconciled.
      const record = source.resolutionLeft
        ? await readHostedRecord(ctx, {
            projectId,
            actor: source.actor,
            kind: 'lane',
            key: source.laneId,
          })
        : null;
      const right = record ? JSON.parse(record.value).resolution?.right : undefined;
      const resolved = right ? await sourceState(right) : undefined;
      // A kept-open Lane that landed and saved again is measured from its landed head, mine or a peer's.
      const landedHead = await landedSinceBase(
        ctx,
        projectId,
        source,
        source === row ? baseSequence : (source.baseSequence ?? undefined),
      );
      const landed = landedHead ? await sourceState(landedHead) : undefined;
      sources.push({
        laneId: source.laneId,
        base,
        head,
        ...(resolved ? { resolved } : {}),
        ...(landed ? { landed } : {}),
      });
    }
  }
  const plan: TrialPlan = {
    laneId: row.laneId,
    head: row.head,
    peers: [...peers.values()].map(({ laneId, head }) => ({ laneId, head })),
    tasks: [...tasks.values()],
    objects,
    sources,
    ...(main ? { main } : {}),
  };
  await ctx.scheduler.runAfter(0, makeFunctionReference<'action'>('projectHostedConflictMerge:run'), {
    projectId,
    plan: JSON.stringify(plan),
  });
}

/** Main's head State object, where an action reads main's files (two point reads), or undefined
 * when it is too large or only a recipe. Read off the save and landing writes (it is the row every
 * landing changes): by the trial merge's and the would-conflict pass's action, only when a conflict
 * needs main's forge.json merge lists. */
export const mainState = internalQuery({
  args: { projectId: v.id('hostedProjects') },
  handler: (ctx, { projectId }) => mainStateObject(ctx, projectId).then(found => found ?? null),
});
export async function mainStateObject(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
): Promise<{ head: string; state: TrialObject } | undefined> {
  const channel = await channelRow(ctx, projectId);
  const selected = channel ? hostedMainV2Schema.safeParse(JSON.parse(channel.selection)) : null;
  const state = selected?.success ? await findObject(ctx, projectId, selected.data.head) : null;
  return selected?.success && state && state.size <= TRIAL_MAIN_STATE_BYTES && !state.recipe
    ? { head: selected.data.head, state: trialObject(state) }
    : undefined;
}

const rangeList = v.array(v.array(v.number()));
/** The trial merge's one write. Each pair is decided only while both saved heads are still the ones
 * merged; a newer save of either Lane plans its own merge and decides the pair again. */
export const record = internalMutation({
  args: {
    projectId: v.id('hostedProjects'),
    laneId: v.string(),
    head: v.string(),
    peers: v.array(v.object({ laneId: v.string(), head: v.string() })),
    mainHead: v.optional(v.string()),
    conflicts: v.array(
      v.object({
        peer: v.string(),
        path: v.string(),
        mine: rangeList,
        theirs: rangeList,
        reason: v.string(),
      }),
    ),
  },
  returns: v.null(),
  handler: async (ctx, input) => {
    const lane = (laneId: string) => laneRow(ctx, input.projectId, laneId);
    const me = await lane(input.laneId);
    // Landed or superseded since the trial was planned: its work is in main, so it names nothing.
    if (!me?.open || me.head !== input.head || finishedAtHead(me)) {
      return null;
    }
    const now = Date.now();
    // Each peer conflict writes both directions. Share these two reads instead of
    // reading the queue/policy separately for each direction, including an empty queue.
    let predecessorContext:
      | Promise<{
          queue: Awaited<ReturnType<typeof landingQueue>>;
          enabled: boolean;
        }>
      | undefined;
    const context = () =>
      (predecessorContext ??= Promise.all([
        landingQueue(ctx, { projectId: input.projectId, channel: 'main' }),
        ctx.db.get(input.projectId),
      ]).then(([queue, project]) => ({
        queue,
        enabled: Boolean(project && effectivePolicy(project).acceptance.earlyResolve !== 'off'),
      })));
    // Lanes this trial decided a pair for, and those that still hold a notice from it.
    const seen = new Set<string>(),
      kept = new Set<string>();
    const write = async (
      owner: Row,
      peer: string,
      peerHead: string,
      goal: string,
      found: {
        path: string;
        mine: number[][];
        theirs: number[][];
        reason: string;
      }[],
      swap: boolean,
    ) => {
      seen.add(owner.laneId);
      const existing = (
        await ctx.db
          .query('projectHostedConflictNotices')
          .withIndex('by_project_and_lane_and_open', q =>
            q.eq('projectId', input.projectId).eq('laneId', owner.laneId).eq('open', true),
          )
          .take(PEER_WINDOW)
      ).find(row => row.peer === peer);
      if (!found.length) {
        if (existing)
          await ctx.db.patch(existing._id, {
            open: false,
            clearedAt: now,
            cleared: 'save',
          });
        return;
      }
      kept.add(owner.laneId);
      const paths = found.slice(0, NOTICE_PATHS).map(item => ({
        path: item.path,
        mine: swap ? item.theirs : item.mine,
        theirs: swap ? item.mine : item.theirs,
        reason: item.reason,
      }));
      const predecessor = peer !== MAIN ? await context() : undefined;
      const earlyResolution = predecessor?.enabled
        ? await conflictPredecessor(
            ctx,
            input.projectId,
            [
              {
                peer,
                peerHead,
                paths,
                flaggedAt: existing?.flaggedAt ?? now,
              },
            ],
            predecessor.queue,
          )
            .then(early => (early ? canonicalPayload(early.advice) : undefined))
            // Unavailable is not absent for the same saved source pair. Never carry
            // advice for old heads into a new generation when its lookup fails.
            .catch(() =>
              existing?.laneHead === owner.head && existing.peerHead === peerHead
                ? existing.earlyResolution
                : undefined,
            )
        : undefined;
      // Only a changed source pair, ranges or visible advice publishes a generation.
      // Hidden metadata may still be cleaned up without a new inbox clock/wake.
      if (
        existing &&
        existing.laneHead === owner.head &&
        existing.peerHead === peerHead &&
        canonicalPayload(existing.paths) === canonicalPayload(paths) &&
        (!predecessor?.enabled || existing.earlyResolution === earlyResolution)
      ) {
        if (existing.earlyResolution !== earlyResolution)
          await ctx.db.patch(existing._id, { earlyResolution });
        return;
      }
      const updatedAt = await wakeConflictLane(
        ctx,
        input.projectId,
        owner.laneId,
        now,
        owner.holderActor ?? owner.actor,
        peer,
      );
      const value = {
        paths,
        ...(earlyResolution ? { earlyResolution } : {}),
        laneHead: owner.head,
        peerHead,
        peerGoal: goal.slice(0, 160),
        updatedAt,
      };
      if (!owner.conflicted) await ctx.db.patch(owner._id, { conflicted: true });
      if (existing) await ctx.db.patch(existing._id, { ...value, earlyResolution });
      else
        await ctx.db.insert('projectHostedConflictNotices', {
          projectId: input.projectId,
          laneId: owner.laneId,
          peer,
          open: true,
          flaggedAt: now,
          laneStartedAt: owner._creationTime,
          ...value,
        });
    };
    for (const planned of input.peers) {
      const peer = await lane(planned.laneId);
      if (!peer?.open || peer.head !== planned.head || finishedAtHead(peer)) continue;
      const found = input.conflicts.filter(item => item.peer === planned.laneId);
      await write(me, planned.laneId, peer.head, peer.intent, found, false);
      await write(peer, me.laneId, me.head, me.intent, found, true);
    }
    if (input.mainHead !== undefined)
      await write(
        me,
        MAIN,
        input.mainHead,
        'main',
        input.conflicts.filter(item => item.peer === MAIN),
        false,
      );
    // A Lane's flag (the line's purple Conflict) follows its open notices once every pair is decided (Item 9b9057a9):
    // a clean pair that ended its last notice clears it, a conflicting one decided later in this trial keeps it. Only
    // a Lane left with no notice from this trial is checked (one point and one indexed read); a retried unchanged
    // notice costs nothing extra.
    for (const laneId of seen) {
      if (kept.has(laneId)) continue;
      const row = await lane(laneId);
      if (!row?.conflicted) continue;
      const [open] = await ctx.db
        .query('projectHostedConflictNotices')
        .withIndex('by_project_and_lane_and_open', q =>
          q.eq('projectId', input.projectId).eq('laneId', laneId).eq('open', true),
        )
        .take(1);
      if (!open) await ctx.db.patch(row._id, { conflicted: undefined });
    }
    return null;
  },
});

/** First land of a Lane (the lead-time measurement): stamped on its open notices once. */
export async function markConflictLand(ctx: MutationCtx, projectId: Id<'hostedProjects'>, laneId: string) {
  const rows = await ctx.db
    .query('projectHostedConflictNotices')
    .withIndex('by_project_and_lane_and_open', q =>
      q.eq('projectId', projectId).eq('laneId', laneId).eq('open', true),
    )
    .take(PEER_WINDOW);
  const now = Date.now();
  for (const row of rows)
    if (row.firstLandAt === undefined) await ctx.db.patch(row._id, { firstLandAt: now });
}

/** Open notices for a Lane (for its current head when given), as the overlap read returns them. */
export async function laneConflicts(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  laneId: string,
  head?: string,
  after?: number,
  authorizedProject?: Doc<'hostedProjects'>,
) {
  const rows = await ctx.db
    .query('projectHostedConflictNotices')
    .withIndex('by_project_and_lane_and_open', q =>
      q.eq('projectId', projectId).eq('laneId', laneId).eq('open', true),
    )
    .take(20);
  const currentHead =
    after !== undefined && rows.some(row => row.updatedAt > after)
      ? (await laneRow(ctx, projectId, laneId))?.head
      : head;
  const candidates = rows.filter(
    row =>
      (currentHead === undefined || row.laneHead === currentHead) &&
      (after === undefined || row.updatedAt > after),
  );
  // A notice is live only while the peer Lane is open at the head it was decided against (Item
  // 0487bccb): a peer's newer save is re-decided by its own trial merge. One point read per peer, and
  // only when an open notice names one; main rows need none. A peer whose saved head already landed,
  // or that a landing of its Intent superseded at that head, holds no work left to agree an order
  // with (Item 3f70760d): the same row says so, no added read.
  const peers = new Map(
    await Promise.all(
      [...new Set(candidates.map(row => row.peer).filter(peer => peer !== MAIN))].map(
        async peer => [peer, await laneRow(ctx, projectId, peer)] as const,
      ),
    ),
  );
  const current = candidates.filter(row => {
    if (row.peer === MAIN) return true;
    const peer = peers.get(row.peer);
    return Boolean(peer?.open && peer.head === row.peerHead && !finishedAtHead(peer));
  });
  const project = current.some(row => row.earlyResolution)
    ? (authorizedProject ?? (await ctx.db.get(projectId)))
    : null;
  const enabled = project && (await earlyResolutionForProject(ctx, project));
  return current.map(row => ({
    with: row.peer,
    goal: row.peerGoal,
    flaggedAt: new Date(row.flaggedAt).toISOString(),
    generation: row.updatedAt,
    // The saved head this notice was decided for: a settling save drops the head it replaces.
    head: row.laneHead,
    files: row.paths,
    ...(enabled && row.earlyResolution ? { earlyResolution: JSON.parse(row.earlyResolution) } : {}),
  }));
}

/** Notices read per summary: a week of dogfood is well under this. */
const SUMMARY_ROWS = 500;
/** Read-only lead-time summary for `metrics` (flip 4): notices flagged in the window, how each ended,
 * and the time from flag to the Lane's first land, with the Lane's age at the flag. One indexed range,
 * at most SUMMARY_ROWS rows of a few hundred bytes. */
export const summary = query({
  args: { projectId: v.id('hostedProjects'), from: v.number(), to: v.number() },
  returns: v.string(),
  handler: async (ctx, { projectId, from, to }) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read project metrics.');
      await accessibleProject(ctx, projectId, user.subject);
      const rows = await ctx.db
        .query('projectHostedConflictNotices')
        .withIndex('by_project_and_flagged', q =>
          q.eq('projectId', projectId).gte('flaggedAt', from).lt('flaggedAt', to),
        )
        .take(SUMMARY_ROWS + 1);
      const shown = rows.slice(0, SUMMARY_ROWS);
      const seconds = (ms: number) => Math.round(ms / 1000);
      const leads = shown
        .filter(row => row.firstLandAt !== undefined && row.firstLandAt >= row.flaggedAt)
        .map(row => seconds(row.firstLandAt! - row.flaggedAt))
        .sort((a, b) => a - b);
      return JSON.stringify({
        notices: shown.length,
        complete: rows.length <= SUMMARY_ROWS,
        withMain: shown.filter(row => row.peer === MAIN).length,
        open: shown.filter(row => row.open).length,
        cleared: {
          save: shown.filter(row => row.cleared === 'save').length,
          landed: shown.filter(row => row.cleared === 'landed').length,
          abandoned: shown.filter(row => row.cleared === 'abandoned').length,
        },
        leadToFirstLandSeconds: {
          count: leads.length,
          median: leads.length ? leads[Math.floor(leads.length / 2)]! : null,
          max: leads.at(-1) ?? null,
        },
        items: shown.slice(-50).map(row => ({
          laneId: row.laneId,
          with: row.peer,
          flaggedAt: new Date(row.flaggedAt).toISOString(),
          ...(row.firstLandAt !== undefined ? { firstLandAt: new Date(row.firstLandAt).toISOString() } : {}),
          laneAgeMinutes: Math.round((row.flaggedAt - row.laneStartedAt) / 60_000),
          files: row.paths.length,
          ...(row.cleared ? { cleared: row.cleared } : {}),
        })),
      });
    } catch (error) {
      return report(error);
    }
  },
});

/** The web Lane view's open exact conflicts (flip 4). A reactive read of one indexed range of at most
 * 20 rows: it re-runs only when one of this Lane's notices changes, so an open idle tab costs nothing. */
export const forLane = query({
  args: { projectId: v.id('hostedProjects'), laneId: v.string() },
  returns: v.string(),
  handler: async (ctx, { projectId, laneId }) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read Lane conflicts.');
      await accessibleProject(ctx, projectId, user.subject);
      return JSON.stringify(await laneConflicts(ctx, projectId, laneId));
    } catch (error) {
      return report(error);
    }
  },
});
