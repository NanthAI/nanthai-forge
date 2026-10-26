// SPDX-License-Identifier: Apache-2.0
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { landingMatch, prepareLandingRecords } from './landing-records-index.js';
import { readFragment } from './work-records.js';
import { finishChild } from './finish-child.js';
import { ForgeError, invariant } from './errors.js';
import type { WorkStore } from './work-store.js';
import type { WorkRecordTransaction } from './work-record-transaction.js';
import type { WorkData, ChannelMove, CheckRun } from './work-types.js';

type Collection = 'channelMoves' | 'runs';
type HeaderFields = {
  id: string;
  channel: string;
  head: string;
  viewId: string;
  status: string;
  at?: string;
  endedAt?: string;
  mainCheck?: CheckRun['mainCheck'];
  recovery?: CheckRun['recovery'];
  postAccept?: ChannelMove['postAccept'];
  postAcceptRunId?: string;
  postAcceptAuditRunId?: string;
  optimisticRecovery?: ChannelMove['optimisticRecovery'];
};
type Header = { position: number; fields: HeaderFields };
type Index = { pages: string; hashes: Map<string, HeaderFields>; rows: Header[] };
const indexes = new WeakMap<WorkStore, Map<Collection, Index>>();
function* headers(store: WorkStore, tx: WorkRecordTransaction, collection: Collection) {
  let owner = indexes.get(store);
  if (!owner) indexes.set(store, (owner = new Map()));
  const index = tx.manifest.collections[collection],
    pages = JSON.stringify(index?.pages ?? []),
    previous = owner.get(collection);
  if (previous?.pages === pages) return previous.rows;
  const hashes = new Map<string, HeaderFields>(),
    rows: Header[] = [];
  for (let position = 0; position < (index?.count ?? 0); position++) {
    const hash = tx.versionAt(collection, position);
    let fields = previous?.hashes.get(hash);
    if (!fields) {
      const raw = readFragment(store.directory, hash).fields;
      invariant(
        ['id', 'head', 'viewId', 'status'].every(key => typeof raw[key] === 'string'),
        'INVALID_WORK_STORE',
        'Audit scheduling header is invalid.',
      );
      fields = Object.fromEntries(
        [
          'id',
          'channel',
          'head',
          'viewId',
          'status',
          'at',
          'endedAt',
          'mainCheck',
          'recovery',
          'postAccept',
          'postAcceptRunId',
          'postAcceptAuditRunId',
          'optimisticRecovery',
        ].map(key => [key, raw[key]]),
      ) as HeaderFields;
    }
    hashes.set(hash, fields);
    rows.push({ position, fields });
    yield;
  }
  owner.set(collection, { pages, hashes, rows });
  return rows;
}
function retainedHeaders(store: WorkStore, tx: WorkRecordTransaction, collection: Collection) {
  const read = headers(store, tx, collection);
  let next = read.next();
  while (!next.done) next = read.next();
  return next.value;
}
export async function preparePostAcceptRecords(
  store: WorkStore,
  tx: WorkRecordTransaction,
  signal?: AbortSignal,
) {
  let turn = performance.now();
  for (const collection of ['channelMoves', 'runs'] as const) {
    const read = headers(store, tx, collection);
    for (let next = read.next(); !next.done; next = read.next()) {
      if (performance.now() - turn < 8) continue;
      await yieldTurn();
      if (signal?.aborted)
        throw new ForgeError('CANCELLED', 'Main audit driver stopped; pending work is retained.');
      turn = performance.now();
    }
  }
}
/** Scheduling uses the latest request, main and covering audit per channel,
 * active audits and only unresolved failed evidence. Header hints locate rows;
 * every selected record is read and validated by the pinned transaction. */
export function postAcceptRecords(
  store: WorkStore,
  tx: WorkRecordTransaction,
  push?: { channel: string; checkId: string },
  historyChannel?: string,
): WorkData {
  const data = tx.data(),
    moves = retainedHeaders(store, tx, 'channelMoves'),
    runs = retainedHeaders(store, tx, 'runs');
  const selectedMoves = new Set<number>(),
    selectedRuns = new Set<number>(),
    selectedViews = new Set<string>(),
    checks = new Set<string>(),
    intents = new Set<string>();
  const latestMain = new Map<string, Header>(),
    latestRequest = new Map<string, Header>(),
    latestAudit = new Map<string, Header>();
  const recovery = new Map<string, Header>();
  for (const row of moves) {
    const fields = row.fields;
    if (fields.status === 'accepted') {
      latestMain.set(fields.channel, row);
      if (fields.channel === historyChannel) selectedMoves.add(row.position);
    }
    if (fields.postAccept) latestRequest.set(fields.channel, row);
    if (fields.postAcceptAuditRunId) latestAudit.set(fields.channel, row);
    if (fields.optimisticRecovery) recovery.set(fields.optimisticRecovery.auditRunId, row);
  }
  for (const row of [...latestMain.values(), ...latestRequest.values(), ...latestAudit.values()])
    selectedMoves.add(row.position);
  for (const row of latestRequest.values()) {
    checks.add(row.fields.postAccept!.checkId);
    selectedViews.add(row.fields.viewId);
  }
  if (push) checks.add(push.checkId);
  for (const row of runs) {
    const run = row.fields;
    if (!run.mainCheck) {
      if (run.recovery && !run.endedAt) selectedRuns.add(row.position);
      continue;
    }
    const main = latestMain.get(run.mainCheck.channel);
    if (run.mainCheck.channel === historyChannel) selectedRuns.add(row.position);
    if ((!run.endedAt && !run.recovery) || run.head === main?.fields.head) selectedRuns.add(row.position);
    if (run.status !== 'failed' || !run.endedAt || run.recovery) continue;
    const fix = finishChild(run.head, `fix-main:${run.mainCheck.channel}`);
    if (tx.positions('intents', fix).length) {
      intents.add(fix);
      continue;
    }
    const recovered = recovery.get(run.id);
    if (recovered && ['flaky', 'reverted'].includes(recovered.fields.optimisticRecovery!.status)) continue;
    selectedRuns.add(row.position);
    if (recovered) selectedMoves.add(recovered.position);
    const landing = moves.find(
      move =>
        move.fields.head === run.head &&
        move.fields.channel === run.mainCheck!.channel &&
        move.fields.status === 'accepted',
    );
    if (landing) selectedMoves.add(landing.position);
  }
  for (const position of selectedMoves) {
    const row = moves[position]!.fields;
    selectedViews.add(row.viewId);
    for (const id of [row.postAcceptRunId, row.postAcceptAuditRunId])
      if (id) for (const found of tx.positions('runs', id)) selectedRuns.add(found);
  }
  for (const row of latestMain.values()) {
    const previous = runs.filter(
      run => run.fields.mainCheck?.channel === row.fields.channel && run.fields.head === row.fields.head,
    ).length;
    const runId = finishChild(row.fields.id, previous ? `post-accept-main:${previous}` : 'post-accept-main');
    selectedViews.add(finishChild(runId, 'main-view'));
  }
  data.channelMoves = [...selectedMoves]
    .sort((a, b) => a - b)
    .map(position => tx.at('channelMoves', position));
  data.runs = [...selectedRuns].sort((a, b) => a - b).map(position => tx.at('runs', position));
  for (const run of data.runs) selectedViews.add(run.viewId);
  data.views = [...selectedViews].flatMap(id => tx.find('views', id)?.record ?? []);
  for (const run of data.runs) checks.add(run.check.id);
  data.checks = [...checks].flatMap(id => tx.find('checks', id)?.record ?? []);
  if (historyChannel) {
    const batchPositions = new Set(
      data.channelMoves.flatMap(move => landingMatch(store, tx, 'landingBatches', 'acceptanceId', move.id)),
    );
    data.landingBatches = [...batchPositions].map(position => tx.at('landingBatches', position));
    data.landingEntries = [...new Set(data.landingBatches.flatMap(batch => batch.entryIds))].flatMap(
      id => tx.find('landingEntries', id)?.record ?? [],
    );
    for (const entry of data.landingEntries)
      if (!data.views.some(view => view.id === entry.viewId)) {
        const view = tx.find('views', entry.viewId)?.record;
        if (view) data.views.push(view);
      }
  }
  // Scheduling needs only Intent identity/status. These compact records are
  // read-only; recovery must select the full record before editing its history.
  data.intents = [...intents].flatMap(id => tx.fields('intents', id)?.record ?? []);
  return data;
}
export async function observePostAcceptRecords(
  store: WorkStore,
  push?: { channel: string; checkId: string },
  signal?: AbortSignal,
) {
  const tx = store.readRecords?.();
  if (!tx) return store.load();
  try {
    await preparePostAcceptRecords(store, tx, signal);
    return postAcceptRecords(store, tx, push);
  } finally {
    tx.dispose();
  }
}

export async function observeRecoveryRecords(store: WorkStore, channel: string) {
  const tx = store.readRecords();
  if (!tx) return store.load();
  try {
    await preparePostAcceptRecords(store, tx);
    await prepareLandingRecords(store, tx);
    return postAcceptRecords(store, tx, undefined, channel);
  } finally {
    tx.dispose();
  }
}
