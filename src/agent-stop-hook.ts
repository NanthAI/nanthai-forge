// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  clearTurnBlocked,
  markTurnBlocked,
  readTurnLedger,
  settleTurnWork,
  type TurnWork,
} from './agent-turn-work.js';

/** A ledger entry observed this recently needs no hosted confirmation. */
export const TURN_WORK_WARM_MS = 30_000;
const PROBE_DEADLINE_MS = 2500;
export type TurnWorkProbe = (work: TurnWork) => Promise<'running' | 'terminal'>;
type StopInput = { session_id?: unknown; hook_event_name?: unknown };

export function turnEndMessage(work: Pick<TurnWork, 'id' | 'kind'>) {
  return `Your ${work.kind === 'check' ? 'check run' : 'landing'} ${work.id.slice(0, 8)} is still running. Run: nforge wait ${work.id}. To stop anyway, stop again.`;
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/** Claude Code Stop / Codex Stop hook. Blocks only the first stop attempt while this
 * session owns unfinished Forge work; the next attempt is always allowed. Cost: one
 * local ledger read; at most one hosted query, only when no live or recent observation
 * exists; nothing while idle. Any failure allows the stop. */
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
  if (!ledger.work.length) return {};
  const now = options.now ?? Date.now();
  let selected =
    ledger.work.find(work => work.pid !== null && alive(work.pid)) ??
    ledger.work.find(work => now - work.observedAt < TURN_WORK_WARM_MS);
  if (!selected) {
    // Cold cache: confirm only the most recent entry with one hosted query.
    const candidate = ledger.work[0]!;
    const state = await withDeadline((options.probe ?? hostedTurnWorkProbe)(candidate));
    if (state === 'terminal') {
      settleTurnWork([candidate.id], session);
      return {};
    }
    selected = candidate;
  }
  // Block only when the second attempt is guaranteed to pass.
  if (!markTurnBlocked(selected.id, session, now)) return {};
  return { decision: 'block', reason: turnEndMessage(selected) };
}
async function withDeadline(probe: Promise<'running' | 'terminal'>) {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      probe,
      new Promise<'running'>(done => {
        timer = setTimeout(() => done('running'), PROBE_DEADLINE_MS);
      }),
    ]);
  } catch {
    return 'running' as const;
  } finally {
    clearTimeout(timer);
  }
}

/** Exactly one HTTP query: the selected run's status, or the submission's current state
 * (nextVersion past the end returns no history events). */
export async function hostedTurnWorkProbe(work: TurnWork): Promise<'running' | 'terminal'> {
  const { hostedAgentAddress } = await import('./hosted-agent-cli.js');
  const address = hostedAgentAddress(work.root, {});
  if (!address) return 'running';
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
    return run?.status && hostedCheckTerminal(run) ? 'terminal' : 'running';
  }
  const page = decode(
    await exchange.client.query(makeFunctionReference<'query'>('projectHostedFinishObserve:page'), {
      projectId: address.projectId,
      operationId: work.id,
      nextVersion: Number.MAX_SAFE_INTEGER,
    }),
  ) as { submission?: { observation?: { state?: string } } };
  const state = page.submission?.observation?.state;
  return state && state !== 'pending' ? 'terminal' : 'running';
}

export async function runTurnEndHook(text: string) {
  try {
    const { editHooksEnabled } = await import('./agent-hook-settings.js');
    if (!editHooksEnabled()) return {};
    return await turnEndDecision(JSON.parse(text) as StopInput);
  } catch {
    return {};
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
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
