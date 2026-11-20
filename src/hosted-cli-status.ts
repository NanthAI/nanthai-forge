// SPDX-License-Identifier: Apache-2.0
import { HostedAgentTransport } from './hosted-agent-transport.js';
import type { LandingHold } from './hosted-landing-hold.js';
import { reviewHoldLine } from './receipt-slim.js';
import { hostedAgentAddress } from './hosted-agent-address.js';
import { hookHealth, hookHealthText } from './agent-hook-health.js';
import { hostedMirrorStatusText, type HostedMirrorStatus } from './hosted-github-mirror-status.js';

/** Ownerless hosted checkouts have no local Work/graph status to assemble. */
export async function readHostedCliStatus(root: string, supplied?: Pick<HostedAgentTransport, 'dispatch'>) {
  const address = supplied ? null : hostedAgentAddress(root, {});
  if (!supplied && !address) return null;
  const transport = supplied ?? new HostedAgentTransport(root, address!);
  if (transport instanceof HostedAgentTransport) transport.plainStatus = true;
  const response = await transport.dispatch('status', {});
  const result = response.result as {
    clone?: { status: string; sourceRevisionsBehind: number | null; next: string | null };
    githubMirror?: HostedMirrorStatus | null;
    needsFix?: unknown[];
    mainToday?: { words: string };
    landingHold?: LandingHold;
  };
  const hooks = hookHealth(root);
  const hookText = hookHealthText(hooks);
  const text = result.clone
    ? result.clone.status === 'current'
      ? 'Forge clone: current with main.'
      : `Forge clone: behind main${result.clone.sourceRevisionsBehind === null ? '' : ` by ${result.clone.sourceRevisionsBehind} source revisions`}. Next: ${result.clone.next}`
    : result.githubMirror
      ? hostedMirrorStatusText(result.githubMirror, Date.now())
      : 'Hosted status: GitHub mirror status unavailable.';
  // The top bar's main figure (Item 32e8de50), from the same summary row; the project day is the UTC day.
  const main = result.mainToday ? `\nmain: ${result.mainToday.words} (UTC day)` : '';
  const hold = result.landingHold;
  const approval = hold?.kind === 'review' ? `\n${reviewHoldLine(hold.review)}` : '';
  return {
    value: { transport: 'hosted', ...result, hooks },
    text: `${text}${main}${approval}${hookText ? `\n${hookText}` : ''}`,
  };
}
