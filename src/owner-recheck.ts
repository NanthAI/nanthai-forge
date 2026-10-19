// SPDX-License-Identifier: Apache-2.0
import { defaultCheck } from './agent-defaults.js';
import { finishChild } from './agent-finish-journal.js';
import { nativeChannels } from './native-work.js';
import { WorkService } from './work.js';
import { invariant } from './errors.js';
import type { WorkStore } from './work-store.js';
import type { WorkView } from './work-types.js';
/** Recompose pinned reviewed bytes on the observed latest main, then use the normal queued runner. */
export async function queueOwnerRecheck(
  store: WorkStore,
  request: {
    operationId: string;
    viewId: string;
    head: string;
    requester: string;
    actorKind: 'person' | 'agent';
  },
) {
  const work = new WorkService(store.root, { kind: request.actorKind, id: request.requester });
  const composeId = finishChild(request.operationId, 'recheck-compose');
  const runId = finishChild(request.operationId, 'recheck-run');
  let view = store.load().views.find(view => view.operation?.id === composeId);
  if (!view) {
    const data = store.load(),
      original = data.views.find(view => view.id === request.viewId);
    invariant(
      original?.head === request.head && original.status === 'clean',
      'VIEW_STALE',
      'Select the retained reviewed View.',
    );
    const main = nativeChannels(data).find(channel => channel.name === 'main');
    const move = data.channelMoves.find(move => move.id === main?.moveId);
    invariant(main?.head && move, 'SOURCE_UNAVAILABLE', 'Current main has no retained acceptance View.');
    const pins = [
      { kind: 'view' as const, viewId: move.viewId, head: main.head },
      { kind: 'view' as const, viewId: original.id, head: request.head },
    ];
    view = (
      await work.dispatch(
        {
          action: 'compose',
          operationId: composeId,
          intentId: original.intentId,
          inputs: [],
          dependencies: [...new Map(pins.map(pin => [pin.viewId, pin])).values()],
        },
        store.revision(),
      )
    ).result as WorkView;
  }
  const recheck = {
    operationId: request.operationId,
    sourceViewId: request.viewId,
    sourceHead: request.head,
    viewId: view.id,
    head: view.head ?? null,
    runId: null as string | null,
  };
  if (view.status !== 'clean' || !view.head)
    return { status: 'rejected', code: 'COMPOSITION_CONFLICT', reason: view.details, recheck };
  const existing = store.select('runs', runId);
  if (!existing) {
    const originalRuns = store
      .load()
      .runs.filter(run => run.viewId === request.viewId && run.head === request.head);
    const previous = originalRuns.at(-1);
    const check = (previous && store.select('checks', previous.check.id)) || defaultCheck(store);
    await work.dispatch(
      {
        action: 'run-check',
        operationId: runId,
        viewId: view.id,
        expectedHead: view.head,
        checkId: check.id,
        expectedDefinition: check.definition,
        expectedEnvironment: work.status().environment.fingerprint,
      },
      store.revision(),
    );
  }
  return { status: 'accepted', recheck: { ...recheck, runId } };
}
