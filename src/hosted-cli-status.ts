// SPDX-License-Identifier: Apache-2.0
import { HostedAgentTransport } from './hosted-agent-transport.js';
import { hostedAgentAddress } from './hosted-agent-address.js';
import { hookHealth, hookHealthText } from './agent-hook-health.js';
import { hostedMirrorStatusText, type HostedMirrorStatus } from './hosted-github-mirror-status.js';

/** Ownerless hosted checkouts have no local Work/graph status to assemble. */
export async function readHostedCliStatus(root: string, supplied?: Pick<HostedAgentTransport, 'dispatch'>) {
  const address = supplied ? null : hostedAgentAddress(root, {});
  if (!supplied && !address) return null;
  const response = await (supplied ?? new HostedAgentTransport(root, address!)).dispatch('status', {});
  const result = response.result as {
    clone?: { status: string; sourceRevisionsBehind: number | null; next: string | null };
    githubMirror?: HostedMirrorStatus | null;
    needsFix?: unknown[];
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
  return {
    value: { transport: 'hosted', ...result, hooks },
    text: hookText ? `${text}\n${hookText}` : text,
  };
}
