// SPDX-License-Identifier: Apache-2.0
import { isMainModule } from '../scripts/main-module.mjs';
import { existsSync, readFileSync } from 'node:fs';
import {
  clearTurnBlocked,
  markTurnBlocked,
  readTurnLedger,
  settleTurnWork,
  type TurnWork,
} from './agent-turn-work.js';
import { WAKE_BUDGET_SECONDS } from './agent-wake.js';
import {
  turnEntryStale,
  turnObserverAlive,
  TURN_WORK_STALE_MS,
  TURN_WORK_WARM_MS,
} from './agent-turn-state.js';

export { TURN_WORK_STALE_MS, TURN_WORK_WARM_MS };
const PROBE_DEADLINE_MS = 2500;
/** `unknown`: the probe could not confirm either way (no address, error, deadline). */
export type TurnWorkState = 'running' | 'terminal' | 'unknown';
export type TurnWorkProbe = (work: TurnWork) => Promise<TurnWorkState>;
type StopInput = { session_id?: unknown; hook_event_name?: unknown; cwd?: unknown };

export function turnEndMessage(work: Pick<TurnWork, 'id' | 'kind' | 'wake'>, watched = false) {
  const what = `Your ${work.kind === 'check' ? 'check run' : 'landing'} ${work.id.slice(0, 8)} is still running.`;
  if (!work.wake) return `${what} Run: nforge wait ${work.id}. To stop anyway, stop again.`;
  // A client that wakes on background exit needs one settle wait, never a waiting turn.
  const block = 'If ending your turn ends your task, block on it with your harness wait tool';
  return watched
    ? `${what} Its settle wait runs in the background. ${block}; otherwise stop again: its exit wakes you.`
    : `${what} Run once in the background: nforge wait ${work.id} --budget ${WAKE_BUDGET_SECONDS}; its exit wakes you when it settles. ${block}. To stop anyway, stop again.`;
}
/** Claude Code Stop / Codex Stop hook. Blocks only the first stop attempt while this
 * session owns unfinished Forge work; the next attempt is always allowed. Cost: one
 * local ledger read; at most one hosted query, only when no live or recent observation
 * exists; nothing while idle. Stale entries (dead observer past the queue's maximum
 * life, or a root that no longer exists) are pruned with the same local read. Any
 * failure, and any state the probe cannot confirm, allows the stop. */
export async function turnEndDecision(
  input: StopInput,
  options: { now?: number; probe?: TurnWorkProbe } = {},
): Promise<{ decision?: 'block'; reason?: string }> {
  const session = typeof input.session_id === 'string' && input.session_id ? input.session_id : undefined;
  if (!session || (input.hook_event_name !== undefined && input.hook_event_name !== 'Stop')) return {};
  const ledger = readTurnLedger(session);
  if (ledger.blocked) {
    // Second consecutive stop attempt: the agent chose to stop. Never block it.
    clearTurnBlocked(session);
    return {};
  }
  // A live observer the owner trusts to wake the agent (turn end never ends its task):
  // stopping now costs nothing, the observer's exit re-invokes the agent on settle.
  const now = options.now ?? Date.now();
  const stale = ledger.work.filter(work => turnEntryStale(work, now));
  if (stale.length)
    settleTurnWork(
      stale.map(work => work.id),
      session,
    );
  const unwatched = ledger.work.filter(
    work => !stale.includes(work) && !(work.wake === 'trusted' && turnObserverAlive(work)),
  );
  if (!unwatched.length) return {};
  let selected =
    unwatched.find(work => turnObserverAlive(work)) ??
    unwatched.find(work => now - work.observedAt < TURN_WORK_WARM_MS);
  if (!selected) {
    // Cold cache: confirm only the most recent entry with one hosted query.
    const candidate = unwatched[0]!;
    const state = await withDeadline((options.probe ?? hostedTurnWorkProbe)(candidate));
    if (state === 'terminal') settleTurnWork([candidate.id], session);
    // Never block on a state nobody confirmed.
    if (state !== 'running') return {};
    selected = candidate;
  }
  // Block only when the second attempt is guaranteed to pass.
  if (!markTurnBlocked(selected.id, session, now)) return {};
  return {
    decision: 'block',
    reason: turnEndMessage(selected, turnObserverAlive(selected)),
  };
}
async function withDeadline(probe: Promise<TurnWorkState>): Promise<TurnWorkState> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      probe,
      new Promise<'unknown'>(done => {
        timer = setTimeout(() => done('unknown'), PROBE_DEADLINE_MS);
      }),
    ]);
  } catch {
    return 'unknown';
  } finally {
    clearTimeout(timer);
  }
}

/** Exactly one HTTP query: the selected run's status, or the submission's current state
 * (nextVersion past the end returns no history events). */
export async function hostedTurnWorkProbe(work: TurnWork): Promise<TurnWorkState> {
  if (!existsSync(work.root)) return 'unknown';
  const { hostedAgentAddress } = await import('./hosted-agent-cli.js');
  const address = hostedAgentAddress(work.root, {});
  if (!address) return 'unknown';
  const { ConvexExchange } = await import('./exchange-client.js');
  const { makeFunctionReference } = await import('convex/server');
  const exchange = new ConvexExchange(address.url, process.env.FORGE_AUTH_TOKEN, address.projectId, '', null);
  const decode = (value: unknown) => (typeof value === 'string' ? JSON.parse(value) : value);
  if (work.kind === 'check') {
    const { hostedCheckTerminal } = await import('./hosted-check.js');
    const run = decode(
      await exchange.client.query(makeFunctionReference<'query'>('projectHostedCheckRead:status'), {
        projectId: address.projectId,
        runId: work.id,
      }),
    );
    if (!run?.status) return 'unknown';
    return hostedCheckTerminal(run) ? 'terminal' : 'running';
  }
  const page = decode(
    await exchange.client.query(makeFunctionReference<'query'>('projectHostedFinishObserve:page'), {
      projectId: address.projectId,
      operationId: work.id,
      nextVersion: Number.MAX_SAFE_INTEGER,
    }),
  ) as { submission?: { observation?: { state?: string } } };
  const state = page.submission?.observation?.state;
  if (!state) return 'unknown';
  return state === 'pending' ? 'running' : 'terminal';
}

export async function runTurnEndHook(text: string) {
  try {
    const { editHooksEnabled } = await import('./agent-hook-settings.js');
    if (!editHooksEnabled()) return {};
    return await turnEndWithSnapshot(JSON.parse(text) as StopInput);
  } catch {
    return {};
  }
}
/** The turn-end answer plus the turn-end snapshot (Issue 7ac4e32f). Only a stop that is allowed
 * ends the turn, so the snapshot runs once per turn and never before a block. A snapshot failure
 * never changes the answer. */
export async function turnEndWithSnapshot(
  input: StopInput,
  snapshot: (input: StopInput) => Promise<unknown> = snapshotAtTurnEnd,
) {
  const decision = await turnEndDecision(input);
  if (!decision.decision && (input.hook_event_name === undefined || input.hook_event_name === 'Stop'))
    try {
      await snapshot(input);
    } catch {
      /* Advisory: the next command snapshots again. */
    }
  return decision;
}
async function snapshotAtTurnEnd(input: StopInput) {
  const { turnEndSnapshot } = await import('./agent-turn-snapshot.js');
  await turnEndSnapshot(input, async ({ url, projectId }) => {
    const { ConvexExchange } = await import('./exchange-client.js');
    return new ConvexExchange(url, process.env.FORGE_AUTH_TOKEN, projectId, '', null).client;
  });
}

if (isMainModule(import.meta.url)) {
  let text = '';
  try {
    text = readFileSync(0, 'utf8');
  } catch {
    /* no input: allow */
  }
  const output = await runTurnEndHook(text);
  process.stdout.write(`${JSON.stringify(output)}\n`);
  // Close any lingering client socket: the hook never outlives its answer.
  process.exit(0);
}
