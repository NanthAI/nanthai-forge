// SPDX-License-Identifier: Apache-2.0
import { hostedCheckTerminal, type HostedCheckRun } from './hosted-check.js';
import { invariant } from './errors.js';

export type HostedCheckDispatch = Pick<
  HostedCheckRun,
  | 'id'
  | 'projectId'
  | 'request'
  | 'check'
  | 'configuration'
  | 'candidate'
  | 'dispatchKey'
  | 'fence'
  | 'plan'
  | 'planDigest'
>;
export type HostedCheckDispatchResult =
  { status: 'accepted'; executionId: string } | { status: 'unknown' } | { status: 'rejected' };
export interface HostedCheckProvider {
  readonly id: string;
  /** Stable dispatchKey must be deduplicated by the adapter/provider, including
   * lost replies. Never silently retry a non-idempotent paid request. */
  dispatch(input: HostedCheckDispatch): Promise<HostedCheckDispatchResult>;
  lookup(
    input: HostedCheckDispatch,
  ): Promise<
    | { status: 'found'; executionId: string }
    | { status: 'unknown' }
    | { status: 'empty'; authoritative: true; receipt: string }
  >;
}
type ControlReply = { run: HostedCheckRun; acquired: boolean; dispatch: boolean };
export interface HostedCheckControlStore {
  control(command: unknown): Promise<ControlReply>;
}
const dispatchInput = (run: HostedCheckRun): HostedCheckDispatch => ({
  id: run.id,
  projectId: run.projectId,
  request: run.request,
  check: run.check,
  configuration: run.configuration,
  candidate: run.candidate,
  dispatchKey: run.dispatchKey,
  fence: run.fence,
  plan: run.plan,
  planDigest: run.planDigest,
});
/** One bounded tick: at most two lookups and one submit. As in H05, a single
 * recovery needs distinct authoritative empty receipts, with the final lookup
 * immediately before reservation. Eventually consistent absence is unknown.
 * Recovery reuses the exact key/plan and requires provider deduplication. */
export async function dispatchHostedCheck(
  store: HostedCheckControlStore,
  provider: HostedCheckProvider,
  owner: string,
  leaseMs = 60_000,
) {
  const claim = await store.control({ kind: 'claim', owner, leaseMs });
  let run = claim.run;
  if (!claim.acquired || hostedCheckTerminal(run) || run.executionId) return run;
  invariant(
    provider.id === run.configuration.provider && run.plan && run.planDigest,
    'RUNNER_UNAVAILABLE',
    'Use the original configured provider and prepared plan.',
  );
  const token = run.lease!.token;
  let recovery = false;
  if (run.dispatchStarted) {
    for (let i = 0; i < 2; i++) {
      let found: Awaited<ReturnType<HostedCheckProvider['lookup']>>;
      try {
        found = await provider.lookup(dispatchInput(run));
      } catch {
        found = { status: 'unknown' };
      }
      if (found.status === 'empty' && found.authoritative !== true) found = { status: 'unknown' };
      if (found.status !== 'empty' || run.recoveryUsed || run.cancelRequested) {
        return (
          await store.control({
            kind: 'observe',
            owner,
            token,
            result:
              found.status === 'found'
                ? { status: 'accepted', executionId: found.executionId }
                : { status: 'unknown' },
          })
        ).run;
      }
      const recorded = await store.control({ kind: 'empty', owner, token, receipt: found.receipt });
      run = recorded.run;
      if (run.executionId || hostedCheckTerminal(run)) return run;
    }
    if (run.emptyLookups.length !== 2)
      return (await store.control({ kind: 'observe', owner, token, result: { status: 'unknown' } })).run;
    recovery = true;
  }
  const reserved = await store.control({ kind: 'reserve', owner, token, recovery });
  run = reserved.run;
  if (!reserved.dispatch || hostedCheckTerminal(run)) return run;
  let result: HostedCheckDispatchResult;
  try {
    result = await provider.dispatch(dispatchInput(run));
  } catch {
    result = { status: 'unknown' };
  }
  return (await store.control({ kind: 'observe', owner, token, result })).run;
}
