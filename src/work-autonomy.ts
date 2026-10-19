// SPDX-License-Identifier: Apache-2.0
import { userInfo } from 'node:os';
import { NativeSource } from './native-source.js';
import { reviewPaths } from './native-source-review.js';
import { workGit } from './work-git.js';
import { digest } from './hash.js';
import { invariant } from './errors.js';
import {
  effectivePolicy,
  editedPolicy,
  policyWriteSchema,
  reviewReason,
  type AcceptanceActor,
} from './autonomy-policy.js';
import type { WorkStore } from './work-store.js';
import type { WorkData, WorkView } from './work-types.js';
export const localPerson = (): AcceptanceActor => ({ kind: 'person', id: userInfo().username });
export const localAgent = (): AcceptanceActor => ({
  kind: 'agent',
  id: process.env.FORGE_ACTOR ?? userInfo().username,
});
export const readPolicy = (store: WorkStore) => effectivePolicy(store.readRecords()?.data() ?? store.load());
export function setPolicy(store: WorkStore, input: unknown, actor: AcceptanceActor, revision: number) {
  const parsed = policyWriteSchema.safeParse(input);
  invariant(
    parsed.success,
    'BAD_ARGUMENT',
    'Send set-policy with an operation UUID and preset or edited fields.',
  );
  const command = parsed.data;
  return store.locked(() => {
    const data = store.load(),
      request = digest(JSON.stringify(command)),
      original = data.policyChanges?.find(item => item.id === command.operationId);
    if (original) {
      invariant(
        original.request === request && original.actor === actor.id,
        'WORK_OPERATION_CHANGED',
        'Retry policy with its original values.',
      );
      return { revision: data.revision, result: original };
    }
    invariant(data.revision === revision, 'WORK_STALE', 'Work changed. Refresh before editing policy.');
    const previous = effectivePolicy(data);
    invariant(
      !command.expectedPolicy || JSON.stringify(command.expectedPolicy) === JSON.stringify(previous),
      'POLICY_CHANGED',
      'Project policy changed. Refresh it before editing.',
    );
    const policy = editedPolicy(previous, command),
      change = {
        id: command.operationId,
        request,
        actor: actor.id,
        previous,
        policy,
        at: new Date().toISOString(),
      };
    data.autonomyPolicy = policy;
    (data.policyChanges ??= []).push(change);
    data.schema = Math.max(data.schema, policy.acceptance.disjointFastPath ? 14 : 11) as WorkData['schema'];
    data.revision++;
    store.save(data);
    return { revision: data.revision, result: change };
  });
}
export function acceptancePaths(store: WorkStore, view: WorkView, previous: string | null): string[] {
  const bases = [...new Set([view.base, ...(previous ? [previous] : [])])];
  if (store.native) {
    const source = new NativeSource(store.root),
      after = source.state(view.head!).files;
    return [
      ...new Set(
        bases.flatMap(base =>
          reviewPaths(source.state(base).files, after)
            .filter(item => item.status !== 'unchanged')
            .map(item => item.path),
        ),
      ),
    ];
  }
  return [
    ...new Set(
      bases.flatMap(base =>
        workGit(store.root, [
          '--no-replace-objects',
          'diff',
          '--no-ext-diff',
          '--no-textconv',
          '--no-renames',
          '--name-only',
          '-z',
          base,
          view.head!,
          '--',
        ])
          .split('\0')
          .filter(Boolean),
      ),
    ),
  ];
}
export function enforceAcceptance(
  store: WorkStore,
  data: WorkData,
  view: WorkView,
  previous: string | null,
  actor: AcceptanceActor,
) {
  const policy = effectivePolicy(data),
    reason = reviewReason(
      policy,
      actor,
      actor.kind === 'person' ? [] : acceptancePaths(store, view, previous),
    );
  invariant(!reason, 'REVIEW_REQUIRED', reason ?? 'Waiting for review by a person; not in main yet');
  if (actor.kind === 'person') return undefined;
  const run = data.runs.find(
    run => run.viewId === view.id && run.head === view.head && run.status === 'passed',
  );
  invariant(
    run,
    'CHECK_REQUIRED',
    'Automatic acceptance requires a passing check on this exact View with its recorded check definition.',
  );
  return {
    actor: actor.id,
    runId: run.id,
    policy,
    summary: `Automatically accepted View ${view.id}`,
    undo: 'Accepted work is retained. To undo, propose a compensating change in a new Lane and accept its checked View; do not rewind main.',
  };
}
