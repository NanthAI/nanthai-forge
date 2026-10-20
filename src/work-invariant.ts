// SPDX-License-Identifier: Apache-2.0
import { digest } from './hash.js';
import { invariant } from './errors.js';
import { evidenceView } from './work-evidence.js';
import { checkEnvironment } from './work-run.js';
import { NativeSource } from './native-source.js';
import { executionGuard, workGit } from './work-git.js';
import { matchesReviewMapping, observeGithubReviews } from './work-review-policy.js';
import type { WorkStore } from './work-store.js';
import type { InvariantAssessment, InvariantCommand, WorkData } from './work-types.js';

export function assessInvariant(
  store: WorkStore,
  data: WorkData,
  command: Extract<InvariantCommand, { action: 'assess-invariant' }>,
  githubReview?: InvariantAssessment['githubReview'],
): InvariantAssessment {
  // ponytail: scan retained Work history; index within this owner if measured assessment latency warrants it.
  const view = evidenceView(data, command.viewId, command.expectedHead);
  if (store.native) new NativeSource(store.root).state(command.expectedHead);
  else
    invariant(
      workGit(store.root, [
        '--no-lazy-fetch',
        '--no-replace-objects',
        'rev-parse',
        '--verify',
        `refs/forge/views/${view.id}^{commit}`,
      ]).trim() === view.head,
      'VIEW_STALE',
      'The retained Candidate ref changed. Source and evidence are preserved.',
    );
  const policy = data.invariants.find(
    item => item.id === command.id && item.definition === command.definition,
  );
  invariant(
    policy && policy.intentId === view.intentId,
    'NOT_FOUND',
    'Select a retained Invariant for this Candidate’s Intent.',
  );
  const currentPolicy =
    data.invariants.filter(item => item.id === policy.id).at(-1)?.definition === policy.definition;
  const environment = checkEnvironment();
  const checks: InvariantAssessment['checks'] = policy.checkIds.map(id => {
    const check = data.checks.find(item => item.id === id);
    const run = data.runs.filter(item => item.viewId === view.id && item.check.id === id).at(-1);
    const reasons: string[] = [];
    if (!check) reasons.push('The check definition is unavailable.');
    if (!run) reasons.push('No run exists for this exact Candidate.');
    if (run) {
      if (
        run.head !== view.head ||
        run.base !== view.base ||
        JSON.stringify(run.inputs) !== JSON.stringify(view.inputs) ||
        JSON.stringify(run.dependencies) !== JSON.stringify(view.dependencies ?? [])
      )
        reasons.push('Source, ordered inputs or dependencies differ.');
      if (check?.definition !== run.check.definition) reasons.push('The check definition changed.');
      if (environment.fingerprint !== run.environment.fingerprint)
        reasons.push('Recorded runtime settings changed.');
      if (run.cancelRequested) reasons.push('Cancellation was requested.');
      if (run.status === 'passed' && (!run.endedAt || run.exitCode !== 0 || run.signal))
        reasons.push('A complete successful outcome is unavailable.');
    }
    const status = !run
      ? 'missing'
      : reasons.length
        ? 'stale'
        : run.status === 'queued' || run.status === 'preparing' || run.status === 'running'
          ? 'pending'
          : run.status;
    return {
      id,
      name: check?.name ?? run?.check.name ?? id,
      definition: check?.definition,
      runId: run?.id,
      status,
      reasons,
    };
  });
  const reviews = policy.reviewers.map(reviewer => {
    const review = data.reviews
      .filter(
        item =>
          item.viewId === view.id &&
          item.head === view.head &&
          item.reviewer === reviewer &&
          item.invariant?.id === policy.id &&
          item.invariant.definition === policy.definition,
      )
      .at(-1);
    return {
      reviewer,
      reviewId: review?.id,
      decision: review?.decision,
      satisfied: review?.decision === 'approve',
      reasons: review
        ? review.decision === 'approve'
          ? []
          : ['Latest policy-bound review does not approve.']
        : ['No review names this exact Candidate and policy version.'],
    };
  });
  const providerSatisfied =
    !policy.githubReview ||
    Boolean(
      githubReview &&
      matchesReviewMapping(data, policy, githubReview) &&
      githubReview.complete &&
      githubReview.beforeHead === view.head &&
      githubReview.afterHead === view.head &&
      JSON.stringify(githubReview.reviews.map(item => item.accountId)) ===
        JSON.stringify(policy.githubReview.accountIds) &&
      githubReview.reviews.every(item => item.satisfied),
    );
  return {
    policy,
    currentPolicy,
    viewId: view.id,
    head: command.expectedHead,
    base: view.base,
    inputs: view.inputs,
    dependencies: view.dependencies ?? [],
    environment,
    checks,
    reviews,
    ...(githubReview ? { githubReview } : {}),
    satisfied:
      currentPolicy &&
      providerSatisfied &&
      checks.every(item => item.status === 'passed') &&
      reviews.every(item => item.satisfied),
    at: new Date().toISOString(),
    coverage: policy.githubReview
      ? 'Selected GitHub User account IDs and latest submitted approval decisions are observed for this PR and exact commit. User-declared labels stay separate. Provider pagination is not atomic; this does not verify a physical human, organization role, complete coverage or continued approval after observation.'
      : 'Only the named checks and user-declared reviewer labels are assessed. External inputs and coverage are unknown; this is not verified identity or proof of the statement.',
  };
}

export async function invariantWork(store: WorkStore, command: InvariantCommand, revision: number) {
  invariant(Number.isSafeInteger(revision) && revision >= 0, 'BAD_ARGUMENT', 'Send a valid work revision.');
  if (command.action === 'assess-invariant') {
    const data = store.locked(() => {
      if (!store.native) executionGuard(store.root);
      const current = store.load();
      assessInvariant(store, current, command);
      return current;
    });
    const policy = data.invariants.find(
      item => item.id === command.id && item.definition === command.definition,
    );
    invariant(
      !store.native || !policy?.githubReview,
      'UNSUPPORTED_NATIVE_WORK',
      'Native GitHub review policy needs an explicit projection mapping; local checks and user-declared reviews remain available.',
    );
    const observation = policy?.githubReview
      ? await observeGithubReviews(store, data, policy, command.expectedHead)
      : undefined;
    return store.locked(() => {
      if (!store.native) executionGuard(store.root);
      const current = store.load();
      return { revision: current.revision, result: assessInvariant(store, current, command, observation) };
    });
  }
  return store.locked(() => {
    if (!store.native) executionGuard(store.root);
    const data = store.load();
    invariant(
      !store.native || !command.githubReview,
      'UNSUPPORTED_NATIVE_WORK',
      'Native GitHub review policy needs an explicit projection mapping; local checks and user-declared reviews remain available.',
    );
    const fields = {
      intentId: command.intentId,
      name: command.name,
      statement: command.statement,
      checkIds: [...new Set(command.checkIds)].sort(),
      reviewers: [...new Set(command.reviewers)].sort(),
      ...(command.githubReview
        ? {
            githubReview: {
              ...command.githubReview,
              accountIds: [...new Set(command.githubReview.accountIds)].sort((a, b) => a - b),
            },
          }
        : {}),
    };
    const request = digest(
      JSON.stringify({
        id: command.invariantId,
        previousDefinition: command.expectedDefinition ?? null,
        ...fields,
      }),
    );
    const retained = data.invariants.find(item => item.operationId === command.operationId);
    if (retained) {
      invariant(
        retained.request === request,
        'WORK_OPERATION_CHANGED',
        'This operation has another definition. Reconcile its original inputs.',
      );
      return { revision: data.revision, result: retained };
    }
    invariant(
      data.revision === revision,
      'WORK_STALE',
      'Work changed. Refresh before defining an Invariant.',
    );
    const current = data.invariants.filter(item => item.id === command.invariantId).at(-1);
    invariant(
      current?.definition === command.expectedDefinition,
      'INVARIANT_CHANGED',
      'The Invariant changed. Its earlier definitions remain available.',
    );
    invariant(
      !current || current.intentId === command.intentId,
      'INVARIANT_CHANGED',
      'An Invariant stays with its original Intent.',
    );
    invariant(
      data.intents.some(item => item.id === command.intentId) &&
        fields.checkIds.every(id => data.checks.some(item => item.id === id)),
      'NOT_FOUND',
      'Select an existing Intent and check definitions.',
    );
    if (fields.githubReview) {
      const target = fields.githubReview.target;
      invariant(
        target.kind === 'publication'
          ? data.publications.some(item => item.id === target.id && item.number)
          : data.intents.some(item => item.id === target.id && item.external),
        'NOT_FOUND',
        'Select an existing GitHub PR mapping.',
      );
    }
    const version = (current?.version ?? 0) + 1;
    const policy = {
      id: command.invariantId,
      operationId: command.operationId,
      request,
      previousDefinition: command.expectedDefinition,
      version,
      ...fields,
      definition: digest(JSON.stringify({ id: command.invariantId, version, ...fields })),
      at: new Date().toISOString(),
    };
    data.invariants.push(policy);
    data.revision++;
    store.save(data);
    return { revision: data.revision, result: policy };
  });
}
