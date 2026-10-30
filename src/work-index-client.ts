// SPDX-License-Identifier: Apache-2.0
import { makeFunctionReference, type FunctionReference } from 'convex/server';
import { continueLongAction } from './long-action.js';
import { hostProgress, formatHostProgress, type ProgressSink } from './host-progress.js';
import { currentExchangeProgress } from './exchange-progress-hooks.js';
export function indexProgressReporter(sink?: ProgressSink) {
  const progress = hostProgress(
    sink ??
      (event => {
        currentExchangeProgress()?.progress?.(formatHostProgress(event));
        if (typeof process !== 'undefined' && process.stderr)
          process.stderr.write(`${JSON.stringify(event)}\n`);
      }),
  );
  let started = false;
  return (value: string) => {
    if (!started) {
      progress.phase('building Work index');
      started = true;
    }
    progress.index(value);
  };
}
/** Explicit operator repair only. Reads and ordinary commands never call this. */
export function rebuildWorkIndex(
  client: {
    action(ref: FunctionReference<'action'>, args: Record<string, unknown>): Promise<unknown>;
  },
  projectId: string,
  onProgress = indexProgressReporter(),
) {
  return continueLongAction(
    'Building Work index',
    projectId,
    continuation =>
      client.action(makeFunctionReference<'action'>('projectWorkIndexActions:ensure'), {
        projectId,
        rebuild: true,
        continuation,
      }),
    onProgress,
  );
}
