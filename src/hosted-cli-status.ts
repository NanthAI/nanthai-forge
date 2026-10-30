// SPDX-License-Identifier: Apache-2.0
import { HostedAgentTransport } from './hosted-agent-transport.js';
import { hostedAgentAddress } from './hosted-agent-cli.js';
import { hostedMirrorStatusText, type HostedMirrorStatus } from './hosted-github-mirror-status.js';

/** Ownerless hosted checkouts have no local Work/graph status to assemble. */
export async function readHostedCliStatus(root: string, supplied?: Pick<HostedAgentTransport, 'dispatch'>) {
  const address = supplied ? null : hostedAgentAddress(root, {});
  if (!supplied && !address) return null;
  const response = await (supplied ?? new HostedAgentTransport(root, address!)).dispatch('status', {});
  const result = response.result as { githubMirror?: HostedMirrorStatus | null; needsFix?: unknown[] };
  return {
    value: { transport: 'hosted', ...result },
    text: result.githubMirror
      ? hostedMirrorStatusText(result.githubMirror, Date.now())
      : 'Hosted status: GitHub mirror status unavailable.',
  };
}
