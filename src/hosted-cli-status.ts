// SPDX-License-Identifier: Apache-2.0
import { HostedAgentTransport } from './hosted-agent-transport.js';
import type { LandingHold } from './hosted-landing-hold.js';
import { reviewHoldLine } from './receipt-slim.js';
import { hostedAgentAddress } from './hosted-agent-address.js';
import { hookHealth, hookHealthText } from './agent-hook-health.js';
import { hostedMirrorStatusText, type HostedMirrorStatus } from './hosted-github-mirror-status.js';
import type { laneDiskUsage } from './lane-disk-usage.js';
import { shellQuote } from './shell-quote.js';

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
    mainToday?: { words: string; state?: string };
    landingHold?: LandingHold;
    scratchPath?: string;
    disk?: ReturnType<typeof laneDiskUsage>;
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
  const main = result.mainToday
    ? `\nmain: ${result.mainToday.words} (UTC day)${result.mainToday.state ? ` · ${result.mainToday.state}` : ''}`
    : '';
  const hold = result.landingHold;
  const approval = hold?.kind === 'review' ? `\n${reviewHoldLine(hold.review)}` : '';
  const scratch = result.scratchPath ? `\nLane scratch: ${JSON.stringify(result.scratchPath)}` : '';
  const disk = result.disk;
  const bytes = (size: number, complete: boolean) =>
    `${complete ? '' : 'at least '}${size.toLocaleString()} bytes`;
  const usage = disk
    ? `\nLane disk: ${bytes(disk.bytes, disk.complete)}, scratch ${bytes(disk.scratchBytes, disk.scratchComplete)}${disk.largeScratch ? ' (large scratch, over 10% of free disk)' : ''}`
    : '';
  // Fix-needed notices name their next step in the plain text too (friction 5078cc76: a red main with no
  // per-file evidence showed its notice only on the culprit Lane's status). Already in the reply; no read.
  const notices = (result.needsFix ?? []).filter(
    (item): item is { intentId: string; state?: string; receiptId?: string; undo?: string } =>
      typeof (item as { intentId?: unknown } | null)?.intentId === 'string',
  );
  // The notice's own next command (a culprit's notice names its fix Intent), on this checkout's root.
  const command = (notice: (typeof notices)[number]) =>
    typeof notice.undo === 'string' && notice.undo.startsWith('nforge agent ROOT ')
      ? `nforge agent ${shellQuote(root)} ${notice.undo.slice('nforge agent ROOT '.length)}`
      : `nforge agent ${shellQuote(root)} start ${shellQuote(JSON.stringify({ intentId: notice.intentId }))}`;
  const fixes = notices
    .slice(0, 3)
    .map(
      notice =>
        `\n${notice.state === 'reverted' ? 'Reverted' : 'Fix needed'}${
          notice.receiptId ? ` (receipt ${notice.receiptId.slice(0, 8)})` : ''
        }: ${command(notice)}`,
    )
    .join('');
  const moreFixes =
    notices.length > 3
      ? `\n${notices.length - 3} more notices: nforge agent ${shellQuote(root)} status '{}'`
      : '';
  const budget = response.keptApplyBudget;
  const kept = budget ? `\n${budget.note}${budget.clearCommand ? `\n${budget.clearCommand}` : ''}` : '';
  return {
    value: { transport: 'hosted', ...result, hooks, ...(budget ? { keptApplyBudget: budget } : {}) },
    text: `${text}${main}${fixes}${moreFixes}${approval}${scratch}${usage}${kept}${hookText ? `\n${hookText}` : ''}`,
  };
}
