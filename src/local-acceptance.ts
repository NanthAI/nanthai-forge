// SPDX-License-Identifier: Apache-2.0
import { readHostState } from './host-binding.js';
import { ForgeError } from './errors.js';
import { requireSourceAuthority, sourceAuthority } from './hosted-source-authority.js';
import type { WorkStore } from './work-store.js';

/** Once hosted holds source authority (or a switch to it is pending), hosted landing
 * is the only acceptance writer; no offline override. Before the switch and after a
 * rollback, the native owner accepts at its pinned native-owner epoch. */
export function requireLocalAcceptance(store: WorkStore, epoch: number): void {
  const state = readHostState(store),
    binding = state.binding;
  if (!binding) return;
  if (sourceAuthority(binding).mode !== 'server' && state.authorityTransition?.mode !== 'server') {
    requireSourceAuthority(binding, { mode: 'native-owner', epoch });
    return;
  }
  const command = `nforge agent ROOT finish '${JSON.stringify({
    url: binding.deployment,
    projectId: binding.projectId,
    laneId: 'HOSTED_LANE_ID',
    accept: true,
  })}'`;
  throw new ForgeError(
    'HOSTED_AUTHORITY',
    `This project accepts only through hosted landing (projectHostedLanding / projectHostedAcceptance). Open ${binding.projectUrl} to review and accept, or submit with ${command}. If hosted is unavailable, landing pauses; editing can continue.`,
  );
}
