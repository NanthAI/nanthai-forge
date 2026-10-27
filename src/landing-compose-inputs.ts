import { NativeSource } from './native-source.js';
import { nativeDiff } from './native-diff.js';
import type { WorkView } from './work-types.js';
// SPDX-License-Identifier: Apache-2.0
import { commandSchema, type WorkData } from './work-types.js';
import { prepareNativeComposition } from './native-composition-candidate.js';
import { digest } from './hash.js';
import { invariant } from './errors.js';
import { retryWorkPhase } from './work-retry.js';
import type { WorkStore } from './work-store.js';
import type { WorkRecordTransaction } from './work-record-transaction.js';

/** The normal native composer and pin revalidation, with selected-record
 * publication. Queue admission must not hydrate every historical Lane first. */
export async function composeLandingInputs(
  store: WorkStore,
  input: unknown,
  options: { compact?: boolean; beforePublish?: () => void } = {},
) {
  const response = (revision: number, view: WorkView) => {
    const source = new NativeSource(store.root);
    return {
      revision,
      result:
        view.status === 'clean' && view.head
          ? options.compact
            ? { ...view, details: '', detailDeferred: true }
            : {
                ...view,
                details: nativeDiff(source, source.state(view.base).files, source.state(view.head).files),
              }
          : view,
    };
  };
  const parsed = commandSchema.safeParse(input);
  invariant(parsed.success, 'UNSUPPORTED_NATIVE_WORK', 'Select a native composition command.');
  const command = parsed.data;
  invariant(
    command.action === 'compose' && command.operationId,
    'BAD_ARGUMENT',
    'Choose a pinned composition.',
  );
  const operationId = command.operationId;
  const read = (tx: WorkRecordTransaction): WorkData => {
    const data = tx.data();
    const intent = tx.find('intents', command.intentId)?.record;
    data.intents = intent ? [intent] : [];
    data.lanes = command.inputs.flatMap(pin => tx.find('lanes', pin.laneId)?.record ?? []);
    for (const pin of command.dependencies ?? intent?.dependencies ?? []) {
      if (pin.kind === 'view') {
        const dependency = tx.find('views', pin.viewId)?.record;
        if (dependency) data.views.push(dependency);
      } else {
        const dependency = tx.find('intents', pin.intentId)?.record;
        if (dependency && !data.intents.some(item => item.id === dependency.id))
          data.intents.push(dependency);
      }
    }
    data.channelMoves = tx.all('channelMoves', 'main', 'channel');
    return data;
  };
  const original = (tx: WorkRecordTransaction) => {
    const view = tx.all('views', operationId, 'operation')[0];
    if (view)
      invariant(
        view.operation?.request === digest(JSON.stringify(command)),
        'WORK_OPERATION_CHANGED',
        'Reconcile the original native composition inputs.',
      );
    return view;
  };
  const tx = store.readRecords();
  invariant(tx, 'INVALID_WORK_STORE', 'Selected landing composition needs indexed Work.');
  const retained = original(tx);
  if (retained)
    return store.locked(() => {
      options.beforePublish?.();
      const current = store.readRecords()!;
      return response(current.revision, original(current)!);
    });
  const prepared = prepareNativeComposition(store.root, read(tx), command);
  return retryWorkPhase(
    operationId,
    () =>
      store.locked(() => {
        options.beforePublish?.();
        const current = store.records(),
          existing = original(current);
        if (existing) return response(current.revision, existing);
        invariant(
          !current.manifest.collections.automations?.count,
          'WORK_STALE',
          'Composition automations changed; retry the original composition through its normal owner.',
        );
        prepared.assertCurrent(read(current));
        prepared.restore();
        current.append('views', prepared.view);
        const intent = current.find('intents', command.intentId)!;
        intent.record.dependencies = prepared.dependencies;
        current.replace('intents', intent.position, intent.record);
        store.commitRecords(current);
        return response(store.revision(), prepared.view);
      }),
    ['WORK_BUSY'],
  );
}
