// SPDX-License-Identifier: Apache-2.0
import { checkEnvironment } from './check-environment.js';
import { previewChecks } from './integration-preview-checks.js';
import { PeersCache } from './agent-peers-cache.js';
import { PeersSource } from './agent-peers-source.js';
import { digest } from './hash.js';
import { nativeChannels } from './native-work.js';
import { channelStatus } from './work-channel.js';
import type { Lane, WorkData } from './work-types.js';
import type { WorkStore } from './work-store.js';

/** Frozen source closure for each root. Intent dependencies are exact pins;
 * ordering dependencies select saved inputs once, never during a check. */
export function previewClosure(data: WorkData, roots: Lane[]) {
  const dependencies: { laneId: string; heads: string[]; errors: string[]; pins: string[] }[] = [];
  for (const root of roots) {
    const heads: string[] = [],
      pins: string[] = [],
      errors: string[] = [],
      visiting = new Set<string>(),
      seen = new Set<string>();
    const visit = (key: string, head: string, children: () => void) => {
      if (visiting.has(key)) {
        errors.push(`Cyclic integration dependency: ${key}`);
        return;
      }
      if (seen.has(key)) return;
      visiting.add(key);
      children();
      visiting.delete(key);
      seen.add(key);
      if (!heads.includes(head)) heads.push(head);
    };
    const view = (id: string, head?: string) => {
      const selected = data.views.find(item => item.id === id);
      if (!selected || selected.status !== 'clean' || !selected.head || (head && selected.head !== head)) {
        errors.push(`Unavailable pinned integration Candidate: ${id}`);
        return;
      }
      pins.push(JSON.stringify({ kind: 'view', viewId: id, head: selected.head }));
      visit(`view:${id}:${selected.head}`, selected.head, () => {
        for (const pin of selected.dependencies ?? []) dependency(pin);
      });
    };
    const dependency = (pin: NonNullable<WorkData['intents'][number]['dependencies']>[number]) => {
      pins.push(JSON.stringify(pin));
      if (pin.kind === 'view') view(pin.viewId, pin.head);
      else {
        // Validate retained PR pins locally; never refresh a remote observation.
        const observation = data.intents.find(item => item.id === pin.intentId)?.external?.observations[
          pin.observation
        ];
        const head = pin.part === 'base' ? observation?.base : observation?.head;
        if (head !== pin.head)
          errors.push(`Unavailable pinned integration PR observation: ${pin.intentId}:${pin.observation}`);
        else if (!heads.includes(pin.head)) heads.push(pin.head);
      }
    };
    const intent = (id: string) => {
      pins.push(JSON.stringify({ afterIntent: id }));
      const lanes = data.lanes.filter(lane => lane.intentId === id && lane.state !== 'abandoned');
      if (!lanes.length) errors.push(`Unavailable integration dependency Intent: ${id}`);
      for (const selected of lanes.sort((a, b) => a.id.localeCompare(b.id))) lane(selected);
    };
    const lane = (selected: Lane) => {
      if (!selected.checkpoints.length) {
        errors.push(`Unsaved integration dependency Lane: ${selected.id}`);
        return;
      }
      pins.push(
        JSON.stringify({
          laneId: selected.id,
          head: selected.head,
          after: selected.after,
          stack: selected.stack,
        }),
      );
      visit(`lane:${selected.id}:${selected.head}`, selected.head, () => {
        const owner = data.intents.find(item => item.id === selected.intentId);
        if (!owner) errors.push(`Unavailable integration Intent: ${selected.intentId}`);
        for (const pin of owner?.dependencies ?? []) dependency(pin);
        if (selected.stack && !selected.stack.detached) {
          const parent = data.lanes.find(item => item.id === selected.stack!.laneId);
          if (!parent) errors.push(`Unavailable integration stack parent: ${selected.stack.laneId}`);
          else lane({ ...parent, head: selected.stack.head });
        } else if (selected.after) {
          if ('viewId' in selected.after) view(selected.after.viewId);
          else intent(selected.after.intentId);
        }
      });
    };
    lane(root);
    dependencies.push({ laneId: root.id, heads, errors, pins });
  }
  return dependencies;
}

export function previewTuple(store: WorkStore, data: WorkData, lanes: Lane[], main: string) {
  const source = new PeersSource(store, ''),
    checks = previewChecks(source, main, data.checks),
    environment = checkEnvironment(),
    dependencies = previewClosure(data, lanes),
    inputs = lanes.map(lane => ({ laneId: lane.id, head: lane.head }));
  const configuration = digest(JSON.stringify([checks, environment.fingerprint]));
  const availableLaneIds = data.lanes
    .filter(lane => lane.state === 'active' && lane.checkpoints.length)
    .map(lane => lane.id)
    .sort();
  const key = digest(
    JSON.stringify(['integration-v3', main, inputs, dependencies, configuration, availableLaneIds]),
  );
  return { key, main, inputs, dependencies, configuration, source, checks, environment };
}

/** Read-only applicability check shared by receipts and peer/status advice. */
export function previewCurrent(
  store: WorkStore,
  result: { main: string; inputs: { laneId: string; head: string }[]; key: string },
) {
  try {
    const data = store.load(),
      main = (store.native ? nativeChannels(data) : channelStatus(store, data)).find(
        channel => channel.name === 'main',
      )?.head;
    if (main !== result.main) return false;
    const lanes = result.inputs.flatMap(pin => {
      const lane = data.lanes.find(lane => lane.id === pin.laneId);
      return lane?.head === pin.head && lane.state === 'active' ? [lane] : [];
    });
    return lanes.length === result.inputs.length && previewTuple(store, data, lanes, main).key === result.key;
  } catch {
    return false;
  }
}

/** Notices retain history, while only the latest exact observation is inbox advice. */
export function previewAdviceCurrent(
  store: WorkStore,
  advice: { main: string; key: string; inputs?: { laneId: string; head: string }[] },
  noticeId: string,
) {
  if (!advice.inputs) return false;
  const latest = new PeersCache(store.root).read<{ notices: { noticeId: string }[] }>(
    `integration:${advice.key}`,
  );
  return (
    !!latest?.notices.some(notice => notice.noticeId === noticeId) &&
    previewCurrent(store, { ...advice, inputs: advice.inputs })
  );
}
