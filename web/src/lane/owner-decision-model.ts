// SPDX-License-Identifier: Apache-2.0
export function ownerDecisionLabel(input: {
  channel?: string;
  state?: 'requested' | 'accepted' | 'rejected';
  reason?: string;
  machineName?: string;
  justRequested?: boolean;
}) {
  if (input.state === 'accepted') return `Accepted into ${input.channel ?? 'main'}`;
  if (input.state === 'rejected') return `Not accepted: ${input.reason ?? 'See the owner receipt.'}`;
  if (input.state === 'requested' || input.justRequested)
    return input.machineName ? `Waiting for ${input.machineName}` : 'Requested';
  return 'Ready';
}

/** One acceptance state shared by the header and decision panel. */
export function ownerDecisionState(input: {
  state?: 'requested' | 'accepted' | 'rejected';
  machineName?: string;
  optimistic?: boolean;
  accepted?: boolean;
}) {
  if (input.accepted || (!input.optimistic && input.state === 'accepted'))
    return { label: 'Accepted', tone: 'passed' as const };
  if (!input.optimistic && input.state === 'rejected')
    return { label: 'Not accepted', tone: 'failed' as const };
  if (input.optimistic || input.state === 'requested')
    return {
      label: input.machineName ? `Waiting for ${input.machineName}` : 'Requested',
      tone: 'waiting' as const,
    };
  return { label: 'Ready', tone: 'passed' as const };
}
export function ownerRecovery(receipt: { code?: string; reason?: string } | null) {
  if (
    receipt?.code === 'NEEDS_RECHECK' ||
    /main moved.*(?:paths overlap|changed paths overlap)/i.test(receipt?.reason ?? '')
  )
    return 'recheck';
  if (['OWNER_ACCEPT_FAILED', 'OWNER_UNAVAILABLE', 'NETWORK_ERROR', 'TIMEOUT'].includes(receipt?.code ?? ''))
    return 'retry';
  return 'none';
}

/** Indexed ancestry is meaningful only for the current observed main. */
export function mainAncestryGate(input: {
  included?: boolean | null;
  indexedMain?: string | null;
  currentMain?: string | null;
  rejection?: { code?: string; reason?: string } | null;
}) {
  const rejectedMain = /main moved|main.*(?:advanced|changed)|NEEDS_RECHECK|STALE_MAIN/i.test(
    `${input.rejection?.code ?? ''} ${input.rejection?.reason ?? ''}`,
  );
  const moved = Boolean(input.currentMain && input.currentMain !== input.indexedMain);
  const known =
    rejectedMain ||
    input.included === false ||
    (input.currentMain !== undefined && input.indexedMain !== undefined && !moved && input.included === true);
  const pinned =
    input.currentMain !== undefined &&
    input.indexedMain !== undefined &&
    input.currentMain === input.indexedMain;
  const ok = !rejectedMain && pinned && input.included === true;
  return {
    ok,
    warn: !known,
    title: ok
      ? 'Includes everything on main'
      : rejectedMain || input.included === false
        ? 'Needs an update from main'
        : moved
          ? 'Main has moved · ancestry needs refreshing'
          : 'Main ancestry unavailable',
    body: '',
  };
}
