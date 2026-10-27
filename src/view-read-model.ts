import { candidateTestContract } from './intent-test-contract.js';
// SPDX-License-Identifier: Apache-2.0
import type { WorkData, WorkView, Lane } from './work-types.js';

export function saveChain(lane: Lane, head: string, base: string, at?: string) {
  const result: { saveIndex: number; save: Lane['checkpoints'][number] }[] = [];
  let cursor = head;
  for (let index = lane.checkpoints.length - 1; index >= 0 && cursor !== base; index--) {
    const save = lane.checkpoints[index]!;
    if (save.head !== cursor || (at && save.at > at)) continue;
    result.push({ saveIndex: index, save });
    cursor = save.parent;
  }
  return result.reverse();
}
export function viewWhyIntents(data: WorkData, view: WorkView) {
  const ids = new Set<string>(),
    seen = new Set<string>(),
    views = new Map(data.views.map(view => [view.id, view]));
  function visit(selected: WorkView) {
    if (seen.has(selected.id)) return;
    seen.add(selected.id);
    ids.add(selected.intentId);
    for (const dep of selected.dependencies ?? []) {
      if (dep.kind === 'pr') ids.add(dep.intentId);
      else {
        const nested = views.get(dep.viewId);
        if (nested?.head === dep.head) visit(nested);
      }
    }
  }
  visit(view);
  return [...ids];
}
export function viewReadModels(data: WorkData, selection?: number) {
  if (selection !== undefined && (!Number.isSafeInteger(selection) || selection < 0)) return [];
  const lanes = new Map(data.lanes.map(lane => [lane.id, lane])),
    intents = new Map(data.intents.map(intent => [intent.id, intent])),
    latest = new Map<string, string>();
  const family = (view: WorkView) => JSON.stringify([view.intentId, view.inputs.map(i => i.laneId).sort()]);
  for (const view of data.views) latest.set(family(view), view.id);
  const selected = selection === undefined ? data.views : data.views.slice(selection, selection + 1);
  return selected.map(view => {
    const accepted = [
      ...data.channelMoves
        .filter(move => move.viewId === view.id && move.status === 'accepted')
        .map(move => ({
          id: move.id,
          channel: move.channel,
          head: move.head,
          at: move.at,
          actor: move.acceptedBy ?? null,
          canonical: true,
        })),
      ...(data.hostedChannelMoves ?? [])
        .filter(move => move.viewId === view.id)
        .map(move => ({
          id: move.id,
          channel: move.channel,
          head: move.head,
          at: move.at,
          actor: move.actor,
          canonical: false,
        })),
    ];
    const intent = intents.get(view.intentId),
      supersededBy = latest.get(family(view))!;
    return {
      viewId: view.id,
      intentId: view.intentId,
      base: view.base,
      head: view.head ?? null,
      at: view.at,
      inputs: view.inputs.map(input => {
        const lane = lanes.get(input.laneId);
        return {
          ...input,
          saveIndex: lane ? lastSaveIndex(lane, input.head, view.at) : -1,
        };
      }),
      dependencies: view.dependencies ?? [],
      status: accepted.length
        ? ('accepted' as const)
        : supersededBy !== view.id
          ? ('superseded' as const)
          : view.status === 'conflict'
            ? ('conflict' as const)
            : ('ready' as const),
      sourceStatus: view.status,
      supersededBy: supersededBy === view.id ? null : supersededBy,
      accepted,
      contract: candidateTestContract(intent, view.id, view.head),
      why: { intentId: view.intentId, outcome: intent?.outcome ?? null },
      whyIntentIds: viewWhyIntents(data, view),
    };
  });
}
function lastSaveIndex(lane: Lane, head: string, at: string) {
  for (let index = lane.checkpoints.length - 1; index >= 0; index--) {
    const save = lane.checkpoints[index]!;
    if (save.at <= at && save.head === head) return index;
  }
  return -1;
}
export type ViewReadModel = ReturnType<typeof viewReadModels>[number];
export function viewContributors(data: WorkData, view: WorkView) {
  const views = new Map(data.views.map(value => [value.id, value])),
    lanes = new Map(data.lanes.map(value => [value.id, value])),
    seen = new Set<string>();
  const result: {
    viewId: string;
    laneId: string;
    head: string;
    laneActor: Lane['startedBy'] | null;
    saves: ReturnType<typeof saveChain>;
  }[] = [];
  function visit(selected: WorkView) {
    if (seen.has(selected.id)) return;
    seen.add(selected.id);
    for (const input of selected.inputs) {
      const lane = lanes.get(input.laneId);
      if (lane)
        result.push({
          viewId: selected.id,
          ...input,
          laneActor: lane.startedBy ?? null,
          saves: saveChain(lane, input.head, view.base, selected.at),
        });
    }
    for (const dep of selected.dependencies ?? []) {
      const dependency = dep.kind === 'view' ? views.get(dep.viewId) : undefined;
      if (dependency?.head === dep.head) visit(dependency);
    }
  }
  visit(view);
  return result;
}
export function whyNotes(data: WorkData, intentId: string, path?: string) {
  return (data.intents.find(intent => intent.id === intentId)?.notes ?? []).flatMap((note, index) =>
    path && note.anchor && note.anchor.file !== path
      ? []
      : [
          {
            id: `${intentId}:${index}`,
            kind: note.kind,
            excerpt: note.text.slice(0, 500),
            at: note.at,
            ...(note.anchor ? { anchor: note.anchor } : {}),
          },
        ],
  );
}
