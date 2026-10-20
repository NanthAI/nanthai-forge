// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { digest } from './hash.js';
import { invariant } from './errors.js';
import { validateNativeProjection } from './native-git.js';
import { githubInput } from './github.js';
import { workGithubApi } from './work-github.js';
import {
  githubCheckSchema,
  type CheckEnvironment,
  type CheckRun,
  type EvidenceCommand,
  type LocalWorkCommand,
  type WorkData,
} from './work-types.js';
import type { WorkStore } from './work-store.js';

export function evidenceView(data: WorkData, id: string, head: string) {
  const view = data.views.find(v => v.id === id);
  invariant(
    view?.status === 'clean' && view.head === head,
    'VIEW_STALE',
    'Choose an existing clean Candidate and its exact committed head. Existing work is preserved.',
  );
  return view;
}
export function recordEvidence(
  data: WorkData,
  command: Extract<LocalWorkCommand, { action: 'define-check' | 'review-view' }>,
  at: string,
) {
  if (command.action === 'review-view') {
    const view = evidenceView(data, command.viewId, command.expectedHead);
    if (command.invariant) {
      const current = data.invariants.filter(item => item.id === command.invariant!.id).at(-1);
      invariant(
        current?.definition === command.invariant.definition && current.intentId === view.intentId,
        'INVARIANT_CHANGED',
        'Select the current Invariant for this Candidate’s Intent. Earlier reviews remain available.',
      );
    }
    const review = {
      id: randomUUID(),
      viewId: command.viewId,
      head: command.expectedHead,
      reviewer: command.reviewer,
      decision: command.decision,
      text: command.text,
      at,
      provenance: 'user-declared' as const,
      ...(command.invariant ? { invariant: command.invariant } : {}),
    };
    data.reviews.push(review);
    return review;
  }
  if (command.declaredInputs?.length && data.schema < 5) data.schema = 5; // Only selecting the optional feature promotes the reader contract.
  const current = command.checkId ? data.checks.find(c => c.id === command.checkId) : undefined;
  invariant(!command.checkId || current, 'NOT_FOUND', 'Check definition not found.');
  const definition = {
    name: command.name,
    executable: command.executable,
    args: command.args,
    environmentLabel: command.environmentLabel,
    ...(command.env?.length ? { env: [...new Set(command.env)].sort() } : {}),
    ...(command.credentials?.length ? { credentials: [...new Set(command.credentials)].sort() } : {}),
    ...(command.artifactPaths?.length ? { artifactPaths: [...new Set(command.artifactPaths)] } : {}),
    ...(command.measureResources ? { measureResources: true } : {}),
    ...(command.declaredInputs?.length ? { declaredInputs: command.declaredInputs } : {}),
  };
  const check = {
    ...definition,
    id: current?.id ?? randomUUID(),
    definition: digest(JSON.stringify(definition)),
    at,
  };
  if (current) data.checks[data.checks.indexOf(current)] = check;
  else data.checks.push(check);
  return check;
}
export function evidenceApplicability(data: WorkData, viewId: string) {
  const view = data.views.find(v => v.id === viewId);
  return data.views.filter(v => v.intentId === view?.intentId && !v.mainCheck).at(-1)?.id === viewId
    ? ('current' as const)
    : ('historical' as const);
}
export function runApplicability(data: WorkData, run: CheckRun, environment: CheckEnvironment) {
  const reasons = [];
  if (evidenceApplicability(data, run.viewId) === 'historical')
    reasons.push('A different Candidate is now the latest candidate.');
  if (data.checks.find(c => c.id === run.check.id)?.definition !== run.check.definition)
    reasons.push('The check definition changed.');
  if (environment.fingerprint !== run.environment.fingerprint)
    reasons.push('Recorded runtime settings changed.');
  return { applicability: reasons.length ? ('historical' as const) : ('current' as const), reasons };
}

export async function importChecks(
  store: WorkStore,
  command: Extract<EvidenceCommand, { action: 'import-checks' }>,
  revision: number,
) {
  invariant(
    Number.isSafeInteger(revision) && revision >= 0,
    'BAD_ARGUMENT',
    'Send a valid expected work revision.',
  );
  const repository = githubInput(command.repository).repository;
  invariant(
    !repository.split('/').some(part => part === '.' || part === '..'),
    'BAD_ARGUMENT',
    'Choose a valid GitHub repository.',
  );
  const sameScope = (record: WorkData['githubChecks'][number]) => {
    invariant(
      record.viewId === command.viewId &&
        record.head === command.expectedHead &&
        record.repository === repository,
      'EVIDENCE_CHANGED',
      'This import operation already has different pins. Its observation is retained.',
    );
    return record;
  };
  const existing = store.locked(() => {
    const data = store.load();
    const saved = data.githubChecks.find(c => c.id === command.operationId);
    if (saved) return sameScope(saved);
    invariant(
      data.revision === revision,
      'WORK_STALE',
      'Work changed. Refresh before importing check results.',
    );
    evidenceView(data, command.viewId, command.expectedHead);
    return undefined;
  });
  if (existing) return { revision: store.load().revision, result: existing };
  const projection = store.native
    ? store.locked(() => {
        const publication = store
          .load()
          .publications.find(
            item =>
              item.viewId === command.viewId &&
              item.head === command.expectedHead &&
              item.repository.toLowerCase() === repository.toLowerCase() &&
              item.projection,
          );
        invariant(
          publication?.projection,
          'NOT_FOUND',
          'Publish this native Candidate to select its exact Git projection before importing provider checks.',
        );
        return validateNativeProjection(store, command.expectedHead, publication.projection);
      })
    : undefined;
  const providerHead = projection?.head ?? command.expectedHead;
  const checks = new Map<number, z.infer<typeof githubCheckSchema>>();
  let changed = false;
  for (let page = 1; ; page++) {
    const response = z
      .object({ total_count: z.number().int().nonnegative(), check_runs: z.array(githubCheckSchema) })
      .safeParse(
        await workGithubApi(
          store,
          `repos/${repository}/commits/${providerHead}/check-runs?filter=all&per_page=100&page=${page}`,
        ),
      );
    invariant(
      response.success && response.data.check_runs.every(c => c.head_sha === providerHead),
      'EVIDENCE_CHANGED',
      'GitHub returned invalid or mismatched check pins. Existing evidence is retained.',
    );
    const newIds = response.data.check_runs.some(c => !checks.has(c.id));
    for (const check of response.data.check_runs) {
      changed ||= checks.has(check.id);
      checks.set(check.id, check);
    }
    if (response.data.check_runs.length < 100) {
      changed ||= checks.size !== response.data.total_count;
      break;
    }
    // A changing provider list is not an atomic snapshot; stop repeated pages without losing observations.
    if (!newIds && page > 1) break;
  }
  return store.locked(() => {
    const data = store.load();
    const saved = data.githubChecks.find(c => c.id === command.operationId);
    if (saved) return { revision: data.revision, result: sameScope(saved) };
    evidenceView(data, command.viewId, command.expectedHead);
    const record = {
      id: command.operationId,
      viewId: command.viewId,
      head: command.expectedHead,
      repository,
      at: new Date().toISOString(),
      ...(projection ? { projection } : {}),
      checks: [...checks.values()],
      details: changed
        ? 'Provider list changed during pagination; retained observations may be incomplete.'
        : 'GitHub check observations for the pinned commit; coverage and external inputs are unknown.',
    };
    data.githubChecks.push(record);
    data.revision++;
    store.save(data);
    return { revision: data.revision, result: record };
  });
}
