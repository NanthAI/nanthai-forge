// SPDX-License-Identifier: Apache-2.0
import { sourceAuthority, type SourceAuthority } from './hosted-source-authority.js';

/** Binding alone is not a cutover. Native-owner, shadow and rollback retain
 * native recovery; a pending switch to server already closes owner admission. */
export function serverRecoveryAuthority(state: {
  binding?: { sourceAuthority?: SourceAuthority | undefined } | undefined;
  authorityTransition?: { mode: SourceAuthority['mode'] } | undefined;
}) {
  return (
    sourceAuthority(state.binding ?? {}).mode === 'server' || state.authorityTransition?.mode === 'server'
  );
}
