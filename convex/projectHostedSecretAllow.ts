// SPDX-License-Identifier: Apache-2.0
import { makeFunctionReference } from 'convex/server';
import type { MutationCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import type { HostedAcceptance } from '../src/hosted-acceptance';
import { secretAllowAlert } from '../src/secret-allow';
import { effectivePolicy } from '../src/autonomy-policy';
import { effectiveAgentDefaults } from '../src/agent-parallel-defaults';
import { canonicalPayload } from '../src/hosted-source-operation';

/** Issue 93e14bb0: a landing whose receipt carries `secretAllowAdded` tells the project
 * owners once, on the stall-alert channel (7e38bf5e). Publication runs once per receipt
 * (a replay returns the stored receipt first), so this is at most one scheduler write per
 * such landing and nothing otherwise. Entries carry path, fingerprint and reason only. */
export async function alertSecretAllowAdded(
  ctx: MutationCtx,
  project: Doc<'hostedProjects'>,
  receipt: HostedAcceptance,
) {
  const mark = receipt.secretAllowAdded;
  if (!mark) return null;
  const settings = effectiveAgentDefaults(effectivePolicy(project).agentDefaults).stallAlerts;
  if (!settings.enabled) return null;
  const value = secretAllowAlert(mark, {
    project: project.name,
    receiptId: receipt.id,
    submissionId: receipt.submissionId,
    operationId: receipt.operationId,
    actor: receipt.actor.kind === 'agent' ? 'an agent' : 'a person',
    agentRun: receipt.agentRun,
    batchId: receipt.batchId,
  });
  await ctx.scheduler.runAfter(0, makeFunctionReference<'action'>('projectHostedLandingStallAlert:deliver'), {
    subject: value.subject,
    text: value.text,
    settings: canonicalPayload(settings),
  });
  return value;
}
