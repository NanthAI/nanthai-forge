// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import type { AcceptanceActor, AutonomyPolicy } from './autonomy-policy.js';

/** Secret-scan allow entries (Issue 93e14bb0). V8-safe: Convex builds the receipt mark
 * and the owner alert from here; the scan itself lives in src/secret-scan.ts. */
export const SECRET_SCAN_ALLOW_FILE = '.forge-secret-allow.json';
/** At most this many changed allow entries ride a check plan, a receipt and an alert. */
export const SECRET_ALLOW_MAX_CHANGES = 20;
export const SECRET_ALLOW_REASON_MAX = 200;
export const SECRET_ALLOW_PATH_MAX = 512;

/** One added or edited allow entry, as the executor diffed it against the base (main)
 * allow file. `sameLanding`: the change under check also adds the finding it allows.
 * Value-free: path, fingerprint and the author's reason (withheld when it looks like a credential). */
export const secretAllowChangeSchema = z
  .object({
    path: z.string().min(1).max(SECRET_ALLOW_PATH_MAX),
    fingerprint: z.string().regex(/^[0-9a-f]{16}$/),
    reason: z.string().min(1).max(SECRET_ALLOW_REASON_MAX),
    change: z.enum(['added', 'edited']),
    sameLanding: z.boolean(),
  })
  .strict();
export type SecretAllowChange = z.infer<typeof secretAllowChangeSchema>;
/** Carried on the check plan (only when the allow file changed) and copied to the receipt. */
export const secretAllowEvidenceSchema = z
  .object({
    entries: z.array(secretAllowChangeSchema).max(SECRET_ALLOW_MAX_CHANGES),
    more: z.number().int().nonnegative(),
  })
  .strict();
export type SecretAllowEvidence = z.infer<typeof secretAllowEvidenceSchema>;
/** Receipt `secretAllowAdded`. `scanned: false`: the allow file changed but no Forge
 * executor diffed it (a bring-your-own check, an older runner or no check), so the
 * entries are unknown and the owner is still told. */
export const secretAllowMarkSchema = secretAllowEvidenceSchema.extend({ scanned: z.boolean() }).strict();
export type SecretAllowMark = z.infer<typeof secretAllowMarkSchema>;

/** The receipt mark, from the run plan and the changed-path list the landing already has.
 * Undefined when no allow entry was added or edited: no mark, no alert, no extra call. */
export function secretAllowMark(
  evidence: unknown,
  paths: readonly string[] | null,
): SecretAllowMark | undefined {
  const parsed = evidence === undefined ? null : secretAllowEvidenceSchema.safeParse(evidence);
  if (parsed?.success)
    return parsed.data.entries.length || parsed.data.more ? { ...parsed.data, scanned: true } : undefined;
  return paths?.includes(SECRET_SCAN_ALLOW_FILE) ? { entries: [], more: 0, scanned: false } : undefined;
}

/** Policy hook: approvals (517523cf) and agent identity (d730121f, df06081d) can later
 * require a person for agent-added entries. Today an allow change never blocks a landing;
 * on Forge's own project the allow file is a protected path instead (docs/security.md).
 * Called by single publication (convex/projectHostedAcceptancePublish.ts); a batch must
 * fall back to single landings for it once this can return a reason. */
export function secretAllowReview(
  _policy: AutonomyPolicy,
  _actor: AcceptanceActor,
  _mark: SecretAllowMark | undefined,
): string | null {
  return null;
}

/** One owner alert per landing that adds or edits an allow entry. Never carries a value:
 * the entries hold only path, fingerprint and reason. */
export function secretAllowAlert(
  mark: SecretAllowMark,
  input: {
    project: string;
    receiptId: string;
    submissionId: string;
    operationId: string;
    actor: string;
    agentRun?: string | undefined;
    batchId?: string | undefined;
  },
) {
  const who = input.agentRun ? `${input.actor} (run ${input.agentRun})` : input.actor;
  const lines = [
    `Secret-scan allow entry landed: ${input.project}, receipt ${input.receiptId}, submission ${input.submissionId}${input.batchId ? ` (batch ${input.batchId})` : ''}, by ${who}.`,
    ...mark.entries.map(
      entry =>
        `- ${entry.change} ${entry.path} fingerprint ${entry.fingerprint}: ${entry.reason}` +
        (entry.sameLanding
          ? ' [SELF-ALLOW: this same landing also adds the finding it allows; the entry did not count for this check]'
          : ''),
    ),
    ...(mark.more ? [`- +${mark.more} more entries; read ${SECRET_SCAN_ALLOW_FILE} at this receipt.`] : []),
    ...(mark.scanned
      ? []
      : [
          `- ${SECRET_SCAN_ALLOW_FILE} changed, but no Forge check diffed it; read the file at this receipt.`,
        ]),
    'Allow entries take effect only once they are on main. If an entry covers a real credential, remove it, ' +
      'remove the credential and rotate it at its provider.',
    `Read it: nforge agent ROOT landing '{"operationId":"${input.operationId}"}'`,
  ];
  const self = mark.entries.some(entry => entry.sameLanding);
  return {
    subject: `[Forge] Secret-scan allow ${self ? 'self-allow ' : ''}entry landed: ${input.project}`,
    text: lines.join('\n'),
  };
}
