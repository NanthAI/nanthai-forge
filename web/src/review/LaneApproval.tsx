// SPDX-License-Identifier: Apache-2.0
import type { ReactNode } from 'react';
import { Glyph } from '../ui/Glyph';
import { ErrorToast } from '../ui/Toast';
import { OwnerReviewActions, type OwnerReview } from '../lane/OwnerReviewActions';

/** One Lane's approval request as projectHostedApprovals:observe {detail:1} returns it. */
export type LaneApprovalRead = {
  laneId: string;
  status: 'none' | 'requested' | 'granted' | 'declined';
  live: boolean;
  reason?: string;
  /** A Forge handle, or absent when the viewer may not see people. */
  requester?: string;
  agent?: string;
  head?: string;
  currentHead?: string;
  decision?: { by?: string; head: string; reason?: string; via: 'lane' | 'landing' };
  ended?: { kind: 'landed' | 'withdrawn' };
  landing: { submissionId: string; held: boolean } | null;
};
export type LaneApprovalPhase =
  | { kind: 'loading' }
  | { kind: 'signed-out' }
  | { kind: 'missing' }
  | { kind: 'read'; approval: LaneApprovalRead };

/** The /approve?lane= card (Issue fe5bea80): a builder asked the project owner for a go on one Lane.
 * Pure; the container supplies the live read and the actions, the server checks the owner. */
export function LaneApproval({
  phase,
  review,
  laneHref,
  signIn,
  error = '',
}: {
  phase: LaneApprovalPhase;
  review: OwnerReview;
  laneHref?: string;
  signIn: ReactNode;
  error?: string;
}) {
  const head = (title: string, lead?: ReactNode, tone: 'brand' | 'passed' | 'plain' = 'brand') => (
    <header className="fx-dv-head">
      <span className={`fx-dv-icon fx-dv-icon-${tone}`} aria-hidden="true">
        <Glyph name={tone === 'passed' ? 'passed' : 'review'} size={20} />
      </span>
      <h1>{title}</h1>
      {lead && <p className="fx-dv-lead">{lead}</p>}
    </header>
  );
  const full = laneHref && (
    <p className="fx-dv-foot">
      <a href={laneHref}>Open the Lane and its changes</a>
    </p>
  );
  let body: ReactNode;
  if (phase.kind === 'loading') body = head('Approval request', 'Reading the request…');
  else if (phase.kind === 'signed-out')
    body = (
      <>
        {head('Approval request', 'Sign in as the project owner to grant or decline it.')}
        <div className="fx-dv-actions fx-dv-stack">{signIn}</div>
      </>
    );
  else if (phase.kind === 'missing' || phase.approval.status === 'none')
    body = head(
      'Approval request',
      'This Lane has no approval request, or you cannot read this project.',
      'plain',
    );
  else {
    const { approval } = phase;
    const who = approval.requester
      ? `@${approval.requester}${approval.agent ? `/${approval.agent}` : ''}`
      : 'its builder';
    const facts = (
      <dl className="fx-dv-facts">
        <div>
          <dt>Reason</dt>
          <dd className="fx-dv-untrusted">{approval.reason}</dd>
        </div>
        {approval.landing?.held && (
          <div>
            <dt>Landing</dt>
            <dd>Its check passed and it waits for you; granting lands it.</dd>
          </div>
        )}
      </dl>
    );
    body = !approval.live ? (
      head(
        approval.ended?.kind === 'landed' ? 'Landed' : 'Request closed',
        approval.ended?.kind === 'landed'
          ? 'This Lane landed with your approval.'
          : 'The builder withdrew this request.',
        approval.ended?.kind === 'landed' ? 'passed' : 'plain',
      )
    ) : approval.status === 'granted' ? (
      <>
        {head('Granted', 'This exact Lane work can land. A later save needs your approval again.', 'passed')}
        {facts}
        {full}
      </>
    ) : (
      <>
        {head(
          approval.status === 'declined' ? 'Declined — grant instead?' : 'Grant this Lane?',
          `Requested by ${who}. Landing it holds until you grant it.`,
        )}
        {facts}
        {approval.status === 'declined' && approval.decision?.reason && (
          <p className="fx-dv-lead fx-dv-untrusted">You said: {approval.decision.reason}</p>
        )}
        <OwnerReviewActions review={{ ...review, labels: { accept: 'Grant', decline: 'Decline' } }} />
        {full}
      </>
    );
  }
  return (
    <div className="fx-page fx-dv">
      <section className="fx-panel fx-dv-card" aria-live="polite">
        {body}
        {error && <ErrorToast error={error} />}
      </section>
    </div>
  );
}
