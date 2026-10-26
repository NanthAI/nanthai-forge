// SPDX-License-Identifier: Apache-2.0
import { basename, relative, sep } from 'node:path';
import { realpathSync } from 'node:fs';
import { invariant } from './errors.js';
import { readHostState } from './host-binding.js';
import type { WorkStore } from './work-store.js';
import type { Lane, WorkData, CheckRun } from './work-types.js';

export function currentLane(store: WorkStore, selector?: string): Lane {
  if (!selector) {
    const part = relative(store.directory, realpathSync(process.cwd())).split(sep)[0];
    if (part?.startsWith('lane-')) selector = part.slice(5);
  }
  invariant(selector, 'BAD_ARGUMENT', 'Select a Lane ID, or run inside its Lane directory.');
  // A gh number is intentionally a UUID here: no second numbering authority.
  const lane = store.select('lanes', selector);
  invariant(lane, 'NOT_FOUND', 'Lane not found. Use the stable Lane UUID.');
  return lane;
}
export function checkRow(run: CheckRun) {
  const bucket =
    run.status === 'passed'
      ? 'pass'
      : ['queued', 'preparing', 'running'].includes(run.status)
        ? 'pending'
        : run.status === 'cancelled'
          ? 'cancel'
          : 'fail';
  return {
    id: run.id,
    name: run.check.name,
    state: run.status,
    bucket,
    startedAt: run.startedAt,
    completedAt: run.endedAt ?? null,
    link: null,
    viewId: run.viewId,
    head: run.head,
  };
}
export function laneChecks(data: WorkData, lane: Lane) {
  const view = data.views
    .slice()
    .reverse()
    .find(view => view.inputs.some(input => input.laneId === lane.id && input.head === lane.head));
  if (!view) return [];
  // Keep only the latest run of each check on this exact View/head.
  const seen = new Set<string>();
  return data.runs
    .slice()
    .reverse()
    .filter(run => {
      if (run.viewId !== view.id || run.head !== view.head || seen.has(run.check.id)) return false;
      seen.add(run.check.id);
      return true;
    })
    .map(checkRow);
}
export function laneRow(store: WorkStore, data: WorkData, lane: Lane) {
  const intent = data.intents.find(intent => intent.id === lane.intentId),
    view = data.views
      .slice()
      .reverse()
      .find(view => view.inputs.some(input => input.laneId === lane.id && input.head === lane.head)),
    merged = data.channelMoves.some(
      move =>
        move.status === 'accepted' &&
        data.views.some(
          view =>
            view.id === move.viewId &&
            view.inputs.some(input => input.laneId === lane.id && input.head === lane.head),
        ),
    );
  return {
    operationId: lane.agentStart?.id ?? intent?.agentStart?.id ?? null,
    id: lane.id,
    number: lane.id,
    laneId: lane.id,
    intentId: lane.intentId,
    title: intent?.outcome ?? lane.name,
    body: intent?.constraints ?? '',
    state: merged ? 'MERGED' : ['completed', 'abandoned'].includes(lane.state) ? 'CLOSED' : 'OPEN',
    headRefName: lane.id,
    headRefOid: lane.head,
    baseRefName: intent?.baseChannel?.name ?? 'main',
    baseRefOid: lane.base,
    url: null,
    path: store.path(lane.id),
    viewId: view?.id ?? null,
    statusCheckRollup: laneChecks(data, lane),
  };
}
export function repoRow(store: WorkStore, data: WorkData) {
  const binding = readHostState(store).binding,
    name = binding?.name ?? basename(store.root),
    move = data.channelMoves
      .slice()
      .reverse()
      .find(move => move.channel === 'main' && move.status === 'accepted');
  return {
    id: binding?.projectId ?? store.root,
    name,
    nameWithOwner: name,
    url: binding?.projectUrl ?? null,
    path: store.root,
    engine: store.native ? 'forge-native' : 'git',
    defaultBranchRef: { name: 'main', target: { oid: move?.head ?? null } },
  };
}
