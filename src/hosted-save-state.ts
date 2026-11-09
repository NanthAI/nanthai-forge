// SPDX-License-Identifier: Apache-2.0
// The state of one hosted save and what to do about it (Issue 68361cd5, SM-E). A refusal for a
// moved Lane (WORK_STALE) and one for a live finish (LANE_FINISH_ACTIVE) used to share `stale`;
// each has its own state, label and next step. The server writes `status` and renders `progress`
// from this module, so the CLI, MCP and web read the same words.
export const hostedSaveStatuses = [
  'staging',
  'ready',
  'submitted',
  'completed',
  'stale',
  'refused',
  'failed',
] as const;
export type HostedSaveStatus = (typeof hostedSaveStatuses)[number];

const states = {
  staging: { label: 'Receiving changes', nextStep: null },
  ready: { label: 'Changes staged', nextStep: null },
  submitted: { label: 'Saving', nextStep: null },
  completed: { label: 'Saved', nextStep: null },
  stale: {
    label: 'Lane moved',
    nextStep:
      'The Lane changed under this save and your delta is retained: sync to rebase it onto the moved Lane, then save again.',
  },
  refused: {
    label: 'A live finish holds the Lane',
    nextStep:
      'Wait for the active finish to land or fail, then save again; to end it first use land --withdraw; to replace it on purpose save with supersedeFinish:true.',
  },
  failed: { label: 'Save failed', nextStep: null },
} satisfies Record<HostedSaveStatus, { label: string; nextStep: string | null }>;

/** The additive fields `progress` carries next to the record's own `state`. */
export const hostedSaveState = (status: HostedSaveStatus) => ({
  saveState: status,
  stateLabel: states[status].label,
  nextStep: states[status].nextStep,
});
