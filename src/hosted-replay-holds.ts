// SPDX-License-Identifier: Apache-2.0
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { clientCacheRoot } from './root-paths.js';
import { checkoutPathExists } from './hosted-checkout-files.js';
import { HostedAgentJournal, hostedAgentDirectory } from './hosted-agent-journal.js';
import { durableReplace } from './native-durability.js';
import { hostedLaneDirty } from './hosted-lane-dirty.js';
import { readHostedLaneCheckout } from './hosted-lane-checkout-marker.js';
import { hostedRootLanePath } from './hosted-root-checkout.js';
import { supersededSync } from './hosted-sync-retained.js';
import { withdrawDone } from './hosted-agent-withdraw.js';
import type { HostedAgentAddress, hostedAgentCommandSchemas } from './hosted-agent-contract.js';

/**
 * A replay is valid only while the state its receipt reports still holds (Issue ca49dc6c). An
 * auto-addressed request (no operationId) replays the earlier identical request, so a lost reply
 * never repeats work. Where that receipt describes state that can change after it ran (the Lane's
 * files, the checkout folder, pins), the binding is checked here first: once it no longer holds,
 * the call starts fresh work instead of answering from the old receipt. Local reads only; no call.
 *
 * Every hosted agent action declares its binding (the build fails on a new action without one):
 * - `checked`: `superseded` says when the retained replay no longer describes current state;
 * - `transport`: checked in the transport because it needs a read (start: closedStart);
 * - `server`: the receipt is the server operation's own outcome, idempotent by id, and holds forever;
 * - `read`: no replay; every call reads current state.
 */
type Context = { root: string; address: HostedAgentAddress; actor: string; command: unknown };
type Binding =
  | { kind: 'checked'; superseded: (context: Context) => boolean }
  | { kind: 'transport' | 'server' | 'read' };
const server = { kind: 'server' } as const,
  read = { kind: 'read' } as const;

/** A save already settled here whose Lane files have changed since: its receipt no longer says what
 * is saved, so the identical request saves the new edits (friction 9694afff). A save still pending
 * here keeps replaying, so a lost reply resumes it rather than starting a second save. */
export function supersededSave({ root, address, actor, command }: Context): boolean {
  try {
    const previous = HostedAgentJournal.previous(root, address, actor, 'save', command);
    if (!previous) return false;
    const directory = join(clientCacheRoot(realpathSync(root)), 'saves', previous.operationId);
    if (
      checkoutPathExists(join(directory, 'command.json')) &&
      !checkoutPathExists(join(directory, 'terminal.json'))
    )
      return false;
    return hostedLaneDirty(root);
  } catch {
    return false;
  }
}
/** An open whose Lane folder no longer holds that Lane (deleted or emptied): installing it again is
 * new work, never a replayed success with no files. */
export function supersededOpen({ root, address, actor, command }: Context): boolean {
  try {
    if (!HostedAgentJournal.previous(root, address, actor, 'open', command)) return false;
    const laneId = (command as { laneId?: unknown }).laneId;
    if (typeof laneId !== 'string') return false;
    const path = hostedRootLanePath(root, address, laneId) ?? root;
    return readHostedLaneCheckout(path)?.selection.laneId !== laneId;
  } catch {
    return false;
  }
}

type LifecycleAction = 'abandon' | 'reopen' | 'complete';
const lifecycleFile = (root: string) => join(hostedAgentDirectory(root), 'lifecycle-last.json');
const lifecycleKey = (command: unknown) => {
  const laneId = (command as { laneId?: unknown } | null)?.laneId;
  return typeof laneId === 'string' ? laneId : '';
};
function readLifecycleLast(root: string): Record<string, string> {
  const path = lifecycleFile(root);
  if (!checkoutPathExists(path)) return {};
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  return value && typeof value === 'object' ? (value as Record<string, string>) : {};
}
/** True when a lifecycle result (the server's, or the checkout client's `{phase,result}` wrapper) says
 * the change was applied; pending, stale and failed results keep their receipt replayable. */
export function lifecycleApplied(value: unknown): boolean {
  let result = value;
  if (typeof result === 'string') {
    try {
      result = JSON.parse(result);
    } catch {
      return false;
    }
  }
  const inner = (result as { result?: unknown } | null)?.result ?? result;
  return (inner as { status?: unknown } | null)?.status === 'applied';
}
/** Remember the lifecycle change this client last applied to a Lane (small map, one write per change). */
export function recordLifecycleApplied(root: string, action: LifecycleAction, command: unknown): void {
  const last = readLifecycleLast(root);
  last[lifecycleKey(command)] = action;
  const entries = Object.entries(last).slice(-200);
  durableReplace(lifecycleFile(root), JSON.stringify(Object.fromEntries(entries)));
}
/** A lifecycle change (abandon, reopen, complete) the identical request would replay, though a different
 * change was applied to that Lane since: the receipt describes a state the Lane has left, so the call is
 * new work (friction 48366bb2: a replayed reopen left the Lane completed). The same change repeated, or a
 * reply lost before anything else happened, keeps replaying; an explicit operationId always replays. */
export function supersededLifecycle(action: LifecycleAction) {
  return ({ root, command }: Context): boolean => {
    try {
      const last = readLifecycleLast(root)[lifecycleKey(command)];
      return last !== undefined && last !== action;
    } catch {
      return false;
    }
  };
}

export const replayBindings: Record<keyof typeof hostedAgentCommandSchemas, Binding> = {
  start: { kind: 'transport' },
  open: { kind: 'checked', superseded: supersededOpen },
  save: { kind: 'checked', superseded: supersededSave },
  sync: {
    kind: 'checked',
    superseded: ({ root, address, actor, command }) => supersededSync(root, address, actor, command),
  },
  withdraw: {
    kind: 'checked',
    superseded: ({ root, address, actor, command }) => withdrawDone(root, address, actor, command),
  },
  // Pull keeps its own pending record: a completed pull is never replayed (hosted-pull.ts).
  pull: read,
  friction: server,
  'friction-list': read,
  'friction-triage': server,
  decide: server,
  decisions: read,
  'peer-ack': server,
  'overlap-acks': server,
  tests: server,
  'confirm-tests': server,
  compose: server,
  'recover-apply': server,
  resolve: server,
  check: server,
  // Finish selects its own operation (selectHostedFinish) against the Lane's current saved head.
  finish: { kind: 'transport' },
  prioritize: server,
  ack: server,
  preflight: read,
  'source-pack': read,
  snapshots: read,
  cancel: server,
  revert: server,
  abandon: { kind: 'checked', superseded: supersededLifecycle('abandon') },
  complete: { kind: 'checked', superseded: supersededLifecycle('complete') },
  pin: server,
  'complete-merged': server,
  'abandon-dormant': server,
  reopen: { kind: 'checked', superseded: supersededLifecycle('reopen') },
  status: read,
  observe: read,
  metrics: read,
  capabilities: read,
  'configure-check': server,
  'configure-runner': server,
  'check-settings': read,
  // Returns a link for the owner's approval page; no operation.
  'approve-link': read,
  // One mutation keyed by its own operationId; a retry replays the same request.
  'request-approval': server,
  policy: read,
  'set-policy': server,
  planning: read,
  'put-planning-item': server,
  'comment-planning-item': server,
};

/** True when the identical auto-addressed request's retained replay no longer holds (see above). */
export function autoReplaySuperseded(action: string, context: Context): boolean {
  const binding = (replayBindings as Record<string, Binding | undefined>)[action];
  return binding?.kind === 'checked' && binding.superseded(context);
}
