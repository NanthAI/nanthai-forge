// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { ActionsApiError, type ActionsRun } from './github-actions-api.js';
import type {
  HostedCheckDispatch,
  HostedCheckProvider,
  HostedCheckDispatchResult,
} from './hosted-check-controller.js';
import type { HostedActionsMapping, ActionsExport } from './hosted-actions.js';
import { HostedActionsAccessError, type HostedActionsRemote } from './hosted-actions-remote.js';
import { invariant } from './errors.js';
import { checkPin } from './hosted-check.js';

export interface HostedActionsStore {
  control(command: unknown): Promise<{ mapping: HostedActionsMapping; acquired: boolean; effect: boolean }>;
}
/** A tick does one export, one ref publication, or at most one lookup + dispatch.
 * No polling/sleep loop or Convex action waits for a check. H22b owns wakes,
 * terminal reconciliation/cancellation and the exact job/log verdict. */
export class HostedActionsProvider implements HostedCheckProvider {
  readonly id = 'github-actions';
  constructor(
    private readonly store: HostedActionsStore,
    private readonly remote: HostedActionsRemote,
    private readonly exporter: (
      input: HostedCheckDispatch,
      progress: () => Promise<void>,
      mapping: HostedActionsMapping,
    ) => Promise<ActionsExport>,
    private readonly now: () => number = Date.now,
  ) {}
  async dispatch(input: HostedCheckDispatch): Promise<HostedCheckDispatchResult> {
    return this.tick(input);
  }
  async lookup(input: HostedCheckDispatch): ReturnType<HostedCheckProvider['lookup']> {
    const result = await this.tick(input);
    // GitHub list absence is not authoritative absence to H10. The adapter owns
    // the LOCAL path's one bounded recovery on this retained run-owned branch.
    return result.status === 'accepted' ? { status: 'found', executionId: result.executionId } : result;
  }
  private async tick(input: HostedCheckDispatch): Promise<HostedCheckDispatchResult> {
    invariant(
      input.configuration.provider === this.id && input.plan && input.planDigest,
      'RUNNER_UNAVAILABLE',
      'Use the original Actions provider and plan.',
    );
    const owner = randomUUID();
    const claimed = await this.store.control({ kind: 'claim', owner });
    if (!claimed.acquired) return { status: 'unknown' };
    let m = claimed.mapping;
    invariant(
      m.dispatchKey === input.dispatchKey &&
        m.runId === input.id &&
        m.planDigest === input.planDigest &&
        m.configuration === input.request.expectedConfiguration &&
        checkPin(input.configuration) === m.configuration &&
        m.repository === input.configuration.repository &&
        m.head === input.request.expectedHead,
      'EVIDENCE_CHANGED',
      'The Actions controller selected a different retained run.',
    );
    const token = m.lease.token;
    const save = async (command: Record<string, unknown>) => {
      const reply = await this.store.control({ ...command, owner, token });
      m = reply.mapping;
      return reply;
    };
    let lastHeartbeat = this.now();
    try {
      if (m.run !== null) return { status: 'accepted', executionId: String(m.run) };
      if (m.deleted || this.now() < m.nextAt) return { status: 'unknown' };
      if (!m.export) {
        const exported = await this.exporter(
          input,
          async () => {
            if (this.now() - lastHeartbeat >= 30_000) {
              await save({ kind: 'heartbeat' });
              lastHeartbeat = this.now();
            }
          },
          m,
        );
        await save({ kind: 'export', export: exported });
        return { status: 'unknown' };
      }
      if (!m.published) {
        await this.remote.publish(m);
        await save({ kind: 'published' });
        return { status: 'unknown' };
      }
      const base = `repos/${m.repository}`;
      let branch: { commit: { sha: string } };
      try {
        branch = await this.remote.api.request(`${base}/branches/${encodeURIComponent(m.branch)}`);
      } catch (error) {
        if (error instanceof ActionsApiError && error.httpStatus === 404) return { status: 'unknown' };
        throw error;
      }
      invariant(branch.commit?.sha === m.export.commit, 'EVIDENCE_CHANGED', 'Actions branch source changed.');
      let recovery = false;
      if (m.dispatching) {
        const runs = await this.remote.api.pages<ActionsRun>(
          `${base}/actions/runs?branch=${encodeURIComponent(m.branch)}&per_page=100`,
          'workflow_runs',
        );
        const matches = runs.filter(r => r.head_sha === m.export!.commit && r.display_title === m.branch);
        invariant(
          matches.length <= 1,
          'EVIDENCE_CHANGED',
          'Multiple Actions runs match the retained dispatch.',
        );
        if (matches[0]) {
          await save({ kind: 'lookup', run: matches[0].id, empty: false });
          return { status: 'accepted', executionId: String(matches[0].id) };
        }
        await save({ kind: 'lookup', run: null, empty: runs.length === 0 });
        // Twelve bounded observations exhaust the original lookup window. A
        // thirteenth fresh complete EMPTY branch query immediately precedes the
        // sole recovery. A mismatching run is never treated as an empty branch.
        if (m.outcome !== 'ambiguous' || m.recoveryUsed || m.emptyLookups < 13 || runs.length)
          return { status: 'unknown' };
        recovery = true;
      }
      const reserved = await save({ kind: 'reserve', recovery });
      if (!reserved.effect) return { status: 'unknown' };
      let outcome: 'accepted' | 'rejected' | 'ambiguous' = 'accepted',
        httpStatus: number | null = null;
      try {
        await this.remote.api.request(`${base}/actions/workflows/forge-check.yml/dispatches`, 'POST', {
          ref: m.branch,
          inputs: {
            runId: input.id,
            plan: JSON.stringify(
              input.plan.shardCount > 1 ? Array.from({ length: input.plan.shardCount - 1 }, (_, i) => i) : [],
            ),
          },
        });
      } catch (error) {
        // HTTP 400 is ambiguous, exactly as in the local Actions API classifier.
        if (error instanceof HostedActionsAccessError) throw error;
        outcome = error instanceof ActionsApiError ? error.outcome : 'ambiguous';
        httpStatus = error instanceof ActionsApiError ? (error.httpStatus ?? null) : null;
      }
      await save({ kind: 'dispatch', outcome, httpStatus });
      return m.outcome === 'rejected' && m.rejections >= 5 && !m.recoveryUsed
        ? { status: 'rejected' }
        : { status: 'unknown' };
    } catch (error) {
      if (!(error instanceof HostedActionsAccessError)) throw error;
      await save({ kind: 'error', error: error.reason });
      return m.dispatching ? { status: 'unknown' } : { status: 'rejected' };
    } finally {
      // A failed release is safe: the next worker waits for the original lease.
      await save({ kind: 'release' });
    }
  }
}

/** Called only after H22b has committed a terminal exact run. A lost delete
 * acknowledgement retries the same leased ref; mapping history stays retained. */
export async function cleanupHostedActions(store: HostedActionsStore, remote: HostedActionsRemote) {
  const owner = randomUUID(),
    claim = await store.control({ kind: 'claim', owner });
  if (!claim.acquired) return;
  const m = claim.mapping,
    token = m.lease.token;
  try {
    if (m.deleted) return;
    // The control reducer checks terminal ownership before remote deletion too.
    const checked = await store.control({ kind: 'cleanup', owner, token });
    await remote.delete(checked.mapping);
    await store.control({ kind: 'deleted', owner, token });
  } finally {
    await store.control({ kind: 'release', owner, token });
  }
}
