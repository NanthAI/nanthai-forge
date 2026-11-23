// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { MutationCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import type { CrossHeadProof } from '../src/hosted-cross-head-proof';
import type { HostedMainV2 } from '../src/hosted-main';
import { loadHostedCheck } from './projectHostedCheckStore';
import { requireHostedCheckEvidence } from './projectHostedCheckRead';
import { acceptanceRow } from './projectHostedAcceptanceStore';
import { hostedAcceptanceSchema } from '../src/hosted-acceptance';
import { invariant } from '../src/errors';
/** Publication rechecks the exact full passing predecessor used by recovery.
 * A reduced pass never seeds green, and a reused head never claims a full pass.
 * `savedAudit` is the main audit row the caller already read for mainGate (no extra read). */
export async function requireReuseAudit(
  ctx: MutationCtx,
  input: {
    projectId: Id<'hostedProjects'>;
    actor: string;
    authorityEpoch: number;
    proof: CrossHeadProof;
    main: HostedMainV2;
    check: { checkId: string; definition: string; configuration: string; environment: string };
    savedAudit: Doc<'projectHostedMainAudits'> | null;
  },
) {
  const row = input.savedAudit;
  const audit = input.proof.audit;
  const { run } = await loadHostedCheck(ctx, { projectId: input.projectId, runId: audit.runId });
  await requireHostedCheckEvidence(
    ctx,
    {
      ...input.check,
      projectId: input.projectId,
      actor: input.actor,
      authorityEpoch: input.authorityEpoch,
      candidateId: run.request.candidateId,
      head: audit.head,
      runId: audit.runId,
    },
    run,
  );
  invariant(
    run.planDigest === audit.planDigest &&
      run.terminalDigest === audit.terminalDigest &&
      run.plan?.selection.sha256 === audit.selection,
    'EVIDENCE_CHANGED',
    'The exact main audit proof changed.',
  );
  if (audit.source === 'audit') {
    invariant(
      row?.lastGreen && row.lastGreen.sequence >= audit.sequence,
      'CHECK_EVIDENCE_REFRESH',
      'The passing main audit baseline changed.',
    );
  } else {
    const accepted = await acceptanceRow(ctx, {
      projectId: input.projectId,
      receiptId: input.main.receipt.id,
    });
    const receipt = accepted ? hostedAcceptanceSchema.parse(JSON.parse(accepted.value)) : null;
    invariant(
      receipt &&
        // A coverage landing's own run is never main's full baseline (Item 687d1eda, review 0594f115).
        row?.firstCheck !== receipt.snapshot.revision &&
        !receipt.crossHeadProof &&
        receipt.check?.runId === audit.runId &&
        receipt.candidate.head === audit.head &&
        receipt.candidate.digest === run.candidate.digest &&
        receipt.snapshot.revision === audit.sequence &&
        audit.sequence === input.main.sourceRevision,
      'EVIDENCE_CHANGED',
      'Seed audit coverage only from the current exact full-passed main receipt.',
    );
  }
}
