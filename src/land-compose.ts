// SPDX-License-Identifier: Apache-2.0
import { NativeSource } from './native-source.js';
import { workGit, gitIsAncestor, commitTree, executionGuard } from './work-git.js';
import { invariant } from './errors.js';
import { retryWorkPhase } from './work-retry.js';
import type { WorkService } from './work.js';
import type { WorkView } from './work-types.js';
/** Merge main as the composition base, without turning its inputs into lifecycle dependencies. */
export async function composeSavedMain(work: WorkService, view: WorkView, main: string | null, id: string) {
  const original = work.store.select('views', id);
  if (original) return original;
  const base = main ?? view.base;
  const merged = work.store.native
    ? new NativeSource(work.store.root).compose(base, view.head!, 'Selected saved Lane landing', view.at)
    : composeGitMain(work.store.root, base, view.head!);
  const candidate: WorkView = {
    id,
    intentId: view.intentId,
    inputs: view.inputs,
    dependencies: view.dependencies,
    at: view.at,
    base,
    composedMain: base,
    head: merged.head,
    status: merged.head ? 'clean' : 'conflict',
    details: merged.head
      ? 'Saved inputs composed on the pinned Channel head.'
      : `Conflicting saved paths:\n${merged.conflicts.join('\n')}`,
  };
  // The source bytes above are immutable. Publish one selected record; acceptance rechecks main.
  return retryWorkPhase(id, () =>
    work.store.locked(() => {
      const data = work.store.load(),
        retained = data.views.find(view => view.id === id);
      if (retained) return retained;
      invariant(
        data.views.some(item => item.id === view.id && item.head === view.head),
        'VIEW_STALE',
        'Original saved Candidate changed.',
      );
      if (!work.store.native && candidate.head)
        workGit(work.store.root, ['update-ref', `refs/forge/views/${id}`, candidate.head]);
      data.views.push(candidate);
      data.revision++;
      work.store.save(data);
      return candidate;
    }),
  );
}

function composeGitMain(root: string, main: string, saved: string): { head?: string; conflicts: string[] } {
  executionGuard(root);
  if (gitIsAncestor(root, main, saved)) return { head: saved, conflicts: [] };
  if (gitIsAncestor(root, saved, main)) return { head: main, conflicts: [] };
  const output = workGit(root, ['merge-tree', '--write-tree', '--messages', main, saved], undefined, true);
  const [tree, ...messages] = output.trimEnd().split('\n');
  invariant(
    tree && /^[0-9a-f]{40,64}$/.test(tree),
    'COMPOSITION_FAILED',
    'Git could not compose the saved inputs with main.',
  );
  if (messages.some(line => /^\d{6} [0-9a-f]+ [123]\t/.test(line) || line.startsWith('CONFLICT ')))
    return { conflicts: messages };
  return { head: commitTree(root, tree, [main, saved], 'Selected saved Lane landing'), conflicts: [] };
}
