import { ContractTimingReader } from './contract-test-timings.js';
// SPDX-License-Identifier: Apache-2.0
import { digest } from './hash.js';
import { hostedActionsRecipeSchema } from './hosted-actions.js';
import { randomUUID } from 'node:crypto';
import { ActionsApiError, type ActionsJob, type ActionsRun } from './github-actions-api.js';
import { actionsJobLogEvidence } from './github-actions-job-evidence.js';
import {
  actionsMappingMatches,
  type HostedActionsMapping,
  type HostedActionsRecipe,
} from './hosted-actions.js';
import type { HostedActionsStore } from './hosted-actions-controller.js';
import { HostedActionsAccessError, type HostedActionsRemote } from './hosted-actions-remote.js';
import { actionsCallback } from './hosted-actions-evidence.js';
import { signHostedCheckCallback, type HostedCheckCallback } from './hosted-check-evidence.js';
import { checkPin, type HostedCheckRun } from './hosted-check.js';
import { invariant } from './errors.js';

export interface ActionsReconcileStore extends HostedActionsStore {
  claim(
    owner: string,
  ): Promise<{ run: HostedCheckRun; mapping: HostedActionsMapping | null; acquired: boolean }>;
  evidence(input: {
    owner: string;
    token: number;
    commit: string;
    callback: HostedCheckCallback;
    signature: string;
  }): Promise<HostedCheckRun>;
}
type Job = ActionsJob & { run_id: number; head_sha: string };
/** One outstanding-run observation, outside Convex. The caller durably schedules
 * ONLY this run at returned nextAt (or wakes it on a provider event). No idle scan,
 * sleep, viewer dependency or completion-log claim of live output. */
export async function reconcileHostedActions(
  store: ActionsReconcileStore,
  remote: HostedActionsRemote,
  recipeBytes: Uint8Array,
  key: string,
  now: () => number = Date.now,
) {
  const owner = randomUUID(),
    claim = await store.claim(owner);
  let run = claim.run;
  if (!claim.mapping) return { run, nextAt: null };
  if (!claim.acquired) return { run, nextAt: claim.mapping.lease.until };
  let m = claim.mapping;
  const token = m.lease.token;
  const save = async (command: Record<string, unknown>) => {
    m = (await store.control({ ...command, owner, token })).mapping;
  };
  const emit = async (result: HostedCheckCallback['result']) => {
    const callback = actionsCallback(run, m, result);
    run = await store.evidence({
      owner,
      token,
      commit: m.export!.commit,
      callback,
      signature: signHostedCheckCallback(callback, key),
    });
  };
  try {
    actionsMappingMatches(m, run);
    const recipe: HostedActionsRecipe = hostedActionsRecipeSchema.parse(
      JSON.parse(Buffer.from(recipeBytes).toString('utf8')),
    );
    invariant(
      digest(recipeBytes) === run.plan?.manifest.sha256 && recipeBytes.length === run.plan.manifest.size,
      'EVIDENCE_CHANGED',
      'Read the exact retained plan bytes.',
    );
    const { pin, ...pins } = recipe;
    invariant(
      pin === checkPin(pins) &&
        recipe.head === m.head &&
        recipe.definition === run.check.definition &&
        run.plan?.shardCount === recipe.groups.length + 1 &&
        checkPin(recipe.command) ===
          checkPin([
            /(?:^|\/)node$/.test(run.check.executable) ? 'node' : run.check.executable,
            ...run.check.args,
          ]),
      'EVIDENCE_CHANGED',
      'Use the exact original Actions recipe.',
    );
    if (!m.run || !m.export || m.deleted) return { run, nextAt: null };
    if (now() < m.nextAt) return { run, nextAt: m.nextAt };
    const base = `repos/${m.repository}/actions`,
      observed = await remote.api.request<ActionsRun>(`${base}/runs/${m.run}`);
    invariant(
      observed.id === m.run &&
        observed.head_sha === m.export.commit &&
        observed.display_title === m.branch &&
        observed.run_attempt === 1,
      'EVIDENCE_CHANGED',
      'Actions run source or attempt changed.',
    );
    if (run.cancelRequested && observed.status !== 'completed' && !m.reconciliation.cancelSent) {
      // Cancel is idempotent for this exact retained run. Unknown ack is retried,
      // and never claims that remote compute has stopped.
      await remote.api.request(`${base}/runs/${m.run}/cancel`, 'POST');
      await save({ kind: 'cancel-sent' });
    }
    const latest = new Map<number, Job>();
    // Provider pages live on the fixed worker, never inside a Convex transaction.
    for (let page = 1; ; page++) {
      const response: { jobs: Job[] } = await remote.api.request<{ jobs: Job[] }>(
        `${base}/runs/${m.run}/jobs?filter=latest&per_page=50&page=${page}`,
      );
      invariant(Array.isArray(response.jobs), 'GITHUB_ACTIONS_UNKNOWN', 'Actions job page is incomplete.');
      for (const job of response.jobs) {
        const index =
          job.name === 'forge-static' ? recipe.groups.length : /^forge-shard-(\d+)$/.exec(job.name)?.[1];
        if (index === undefined) continue;
        const shard = Number(index);
        invariant(
          shard < run.plan!.shardCount &&
            job.run_id === m.run &&
            job.head_sha === m.export.commit &&
            job.run_attempt === 1 &&
            !latest.has(shard),
          'EVIDENCE_CHANGED',
          'Actions job source, membership or attempt changed.',
        );
        latest.set(shard, job);
      }
      if (response.jobs.length < 50) break;
      await save({ kind: 'heartbeat' });
    }
    const terminal = observed.status === 'completed';
    const unsettled =
      latest.size !== run.plan!.shardCount || [...latest.values()].some(j => j.status !== 'completed');
    if (
      terminal &&
      unsettled &&
      !run.cancelRequested &&
      !['cancelled', 'startup_failure'].includes(observed.conclusion ?? '') &&
      m.reconciliation.settles < 30
    ) {
      await save({ kind: 'wait', terminal: true });
      return { run, nextAt: m.nextAt };
    }
    const contractReader = new ContractTimingReader();
    let failed = ['failure', 'action_required'].includes(observed.conclusion ?? '');
    let allPassed = latest.size === run.plan!.shardCount;
    for (const [index, job] of latest) {
      let retainedLog: string | undefined;
      let status: 'running' | 'passed' | 'failed' | 'cancelled' | 'interrupted' = 'running';
      if (job.status === 'completed')
        status =
          job.conclusion === 'success'
            ? 'passed'
            : ['failure', 'action_required'].includes(job.conclusion ?? '')
              ? 'failed'
              : job.conclusion === 'cancelled'
                ? 'cancelled'
                : 'interrupted';
      else if (terminal) {
        // Port the LOCAL controller rule: only complete logs corroborated by a
        // green run and noncontradictory job conclusion can recover stuck status.
        invariant(
          remote.log,
          'RUNNER_UNAVAILABLE',
          'Complete Actions logs are unavailable for stuck-job recovery.',
        );
        let text = '';
        try {
          text = await remote.log(job.id, m.repository);
        } catch (error) {
          if (!(error instanceof ActionsApiError)) throw error;
        }
        retainedLog = text;
        const evidence = actionsJobLogEvidence(text, recipe.groups[index] ?? []);
        status =
          evidence.status === 'failed'
            ? 'failed'
            : evidence.status === 'passed' &&
                observed.conclusion === 'success' &&
                [null, 'success'].includes(job.conclusion)
              ? 'passed'
              : 'interrupted';
      }
      if (terminal && (run.semanticPlan || retainedLog !== undefined) && remote.log) {
        const text = retainedLog ?? (await remote.log(job.id, m.repository));
        contractReader.accept(text.endsWith('\n') ? text : text + '\n');
      }
      failed ||= status === 'failed';
      allPassed &&= status === 'passed';
      // Terminal-only shard callbacks are stable across reconnects. Running output
      // arrives through the independent H12 runner collector, not a fake log tail.
      if (status !== 'running')
        await emit({
          kind: 'shard',
          shard: {
            index,
            attempt: 0,
            executionId: String(job.id),
            status,
            exitCode: status === 'passed' ? 0 : status === 'failed' ? 1 : null,
            output: null,
          },
        });
    }
    if (terminal) {
      const status =
        run.cancelRequested || observed.conclusion === 'cancelled'
          ? 'cancelled'
          : failed
            ? 'failed'
            : allPassed && observed.conclusion === 'success'
              ? 'passed'
              : 'interrupted';
      await emit({
        kind: 'complete',
        ...(Object.keys(contractReader.reports).length ? { contractReports: contractReader.reports } : {}),
        status,
        exitCode: status === 'passed' ? 0 : status === 'failed' ? 1 : null,
        output: null,
        cost: { status: 'unknown' },
      });
      return { run, nextAt: null };
    }
    await save({ kind: 'wait', terminal: false });
    return { run, nextAt: m.nextAt };
  } catch (error) {
    if (!(error instanceof ActionsApiError) && !(error instanceof HostedActionsAccessError)) throw error;
    if (error instanceof HostedActionsAccessError) await save({ kind: 'error', error: error.reason });
    await save({ kind: 'wait', terminal: false });
    return { run, nextAt: m.nextAt };
  } finally {
    await save({ kind: 'release' });
  }
}
