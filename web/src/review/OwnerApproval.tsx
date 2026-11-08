// SPDX-License-Identifier: Apache-2.0
import type { ReactNode } from 'react';
import { Glyph } from '../ui/Glyph';
import { ErrorToast } from '../ui/Toast';
import { OwnerReviewActions, type OwnerReview } from '../lane/OwnerReviewActions';
import type { HostedLandingState } from '../../../src/hosted-landing';

export type OwnerApprovalPhase =
  | { kind: 'loading' }
  | { kind: 'signed-out' }
  | { kind: 'missing' }
  | { kind: 'read'; request: HostedLandingState; agent: boolean };
/** The /approve card (Issue fe5bea80): one landing held for the project owner. Pure; the container
 * supplies the live read and the actions, the server checks the owner. */
export function OwnerApproval({
  phase,
  review,
  reviewHref,
  signIn,
  error = '',
}: {
  phase: OwnerApprovalPhase;
  review: OwnerReview;
  reviewHref?: string;
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
  const full = reviewHref && (
    <p className="fx-dv-foot">
      <a href={reviewHref}>Open the full review</a>
    </p>
  );
  let body: ReactNode;
  if (phase.kind === 'loading') body = head('Review a landing', 'Reading the landing…');
  else if (phase.kind === 'signed-out')
    body = (
      <>
        {head('Review a landing', 'Sign in as the project owner to accept or decline it.')}
        <div className="fx-dv-actions fx-dv-stack">{signIn}</div>
      </>
    );
  else if (phase.kind === 'missing')
    body = head('Review a landing', 'This landing was not found, or you cannot read this project.', 'plain');
  else {
    const { request } = phase;
    const state = request.observation.state;
    const held = state === 'pending' && request.observation.pendingReason === 'waiting-for-review';
    body =
      state === 'landed' ? (
        <>
          {head('Landed', 'This landing is on main.', 'passed')}
          {full}
        </>
      ) : state !== 'pending' ? (
        <>
          {head(
            request.error?.code === 'REVIEW_DECLINED' ? 'Declined' : 'Landing ended',
            request.error?.message ?? 'This landing did not complete; main is unchanged.',
            'plain',
          )}
          {full}
        </>
      ) : held ? (
        <>
          {head(
            'Accept this landing?',
            `Submitted by ${phase.agent ? 'an agent' : 'you'}. Its check passed.`,
          )}
          <dl className="fx-dv-facts">
            <div>
              <dt>Held</dt>
              <dd className="fx-dv-untrusted">{request.error?.message ?? 'Waiting for review'}</dd>
            </div>
          </dl>
          <OwnerReviewActions review={review} />
          {full}
        </>
      ) : (
        <>
          {head(
            'Landing',
            request.error?.code === 'CHANNEL_CHANGED'
              ? 'main moved: this exact source is checked again on current main and lands with your approval.'
              : 'In progress. This page updates live.',
          )}
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
