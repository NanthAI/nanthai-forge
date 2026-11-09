// SPDX-License-Identifier: Apache-2.0
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { clientCacheRoot } from './root-paths.js';
import { checkoutPathExists } from './hosted-checkout-files.js';
import { HostedAgentJournal } from './hosted-agent-journal.js';
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
  cancel: server,
  revert: server,
  abandon: server,
  complete: server,
  pin: server,
  'complete-merged': server,
  'abandon-dormant': server,
  reopen: server,
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
