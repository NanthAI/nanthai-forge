// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { NativeSource } from './native-source.js';
import { invariant } from './errors.js';
import type { WorkData, WorkView } from './work-types.js';
/** Owner-approved path-disjoint composition. Source bytes, never graph absence, are evidence. */
export function composeOwnerAcceptance(
  source: NativeSource,
  data: WorkData,
  view: WorkView,
  expectedMain: string | null,
  currentMain: string | null,
) {
  invariant(currentMain, 'NEEDS_RECHECK', 'Needs re-check: main has no retained head.');
  const base = expectedMain ?? data.nativeHead;
  invariant(
    base && source.ancestors(currentMain).has(base),
    'NEEDS_RECHECK',
    'Needs re-check: expected main is not an ancestor of current main.',
  );
  invariant(
    source.ancestors(view.head!).has(base),
    'NEEDS_RECHECK',
    'Needs re-check: the requested Candidate does not contain expected main.',
  );
  const changed = (head: string) => {
    const before = new Map(source.state(base).files.map(f => [f.path, f])),
      after = new Map(source.state(head).files.map(f => [f.path, f]));
    return [...new Set([...before.keys(), ...after.keys()])].filter(
      path => JSON.stringify(before.get(path)) !== JSON.stringify(after.get(path)),
    );
  };
  const viewPaths = changed(view.head!),
    mainPaths = changed(currentMain);
  invariant(
    !viewPaths.some(a => mainPaths.some(b => a === b || a.startsWith(b + '/') || b.startsWith(a + '/'))),
    'NEEDS_RECHECK',
    'Needs re-check: main moved and changed paths overlap the requested Candidate.',
  );
  const merged = source.compose(
    currentMain,
    view.head!,
    'Owner-approved disjoint acceptance',
    new Date().toISOString(),
  );
  invariant(merged.head, 'NEEDS_RECHECK', 'Needs re-check: composition conflicts with current main.');
  const composed: WorkView = {
    intentId: view.intentId,
    base: view.base,
    inputs: view.inputs,
    ...(view.dependencies ? { dependencies: view.dependencies } : {}),
    status: 'clean',
    id: randomUUID(),
    head: merged.head,
    details: `Owner-approved disjoint composition of Candidate ${view.id} on main ${currentMain}; no re-check.`,
    at: new Date().toISOString(),
  };
  data.views.push(composed);
  return { view: composed, evidence: { base, viewPaths, mainPaths, currentMain } };
}
