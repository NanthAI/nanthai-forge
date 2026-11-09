// SPDX-License-Identifier: Apache-2.0
import type { ReactNode } from 'react';
import { Glyph } from '../ui/Glyph';
import { ErrorToast } from '../ui/Toast';
import { OwnerReviewActions, type OwnerReview } from '../lane/OwnerReviewActions';
import { deriveApproval, type ApprovalPhase } from '../../../src/approval-state';

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
  /** A fork pull request's run request (Issue f7793473): granting runs its check, never lands. */
  pullRequest?: number;
  ended?: { kind: 'landed' | 'withdrawn' | 'settled' | 'applied' };
  landing: { submissionId: string; held: boolean } | null;
  /** Issue 470ef29b: a held settings change from an agent sign-in, not a Lane. */
  setting?: { origin: 'policy' | 'check-definition' | 'check-import' | 'runner' | 'main-audit' };
  /** The change as the agent sent it (the owner's read only). */
  change?: unknown;
};
type Words = { title: string; lead: string; tone: 'passed' | 'plain' };
/** Lane approval wording for every state that is not an open or granted request. */
const LANE_WORDS = {
  requested: { title: 'Grant this Lane?', lead: 'The request is open.', tone: 'plain' },
  granted: { title: 'Granted', lead: 'This exact Lane work can land.', tone: 'passed' },
  declined: { title: 'Declined', lead: 'You declined this request.', tone: 'plain' },
  landed: { title: 'Landed', lead: 'This Lane landed with your approval.', tone: 'passed' },
  applied: { title: 'Granted', lead: 'Your grant was applied.', tone: 'passed' },
  withdrawn: { title: 'Request closed', lead: 'The builder withdrew this request.', tone: 'plain' },
  settled: {
    title: 'Request closed',
    lead: 'Nothing waits on this request any more; the work it covered settled.',
    tone: 'plain',
  },
  unknown: {
    title: 'Approval request',
    lead: 'This request is in a state this page cannot confirm. Reload, or ask the builder.',
    tone: 'plain',
  },
} satisfies Record<ApprovalPhase, Words>;
const SETTING_LABEL: Record<NonNullable<LaneApprovalRead['setting']>['origin'], string> = {
  policy: 'project policy',
  'check-definition': 'check definition',
  'check-import': 'check definition',
  runner: 'check runner',
  'main-audit': 'main audit setting',
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
  else if (phase.approval.setting) body = settingBody(phase.approval);
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
    const state = deriveApproval(approval).state;
    body =
      approval.pullRequest !== undefined ? (
        forkBody(approval, state, head, facts, full, review)
      ) : state === 'requested' || (state === 'declined' && approval.live) ? (
        <>
          {head(
            state === 'declined' ? 'Declined — grant instead?' : 'Grant this Lane?',
            `Requested by ${who}. Landing it holds until you grant it.`,
          )}
          {facts}
          {state === 'declined' && approval.decision?.reason && (
            <p className="fx-dv-lead fx-dv-untrusted">You said: {approval.decision.reason}</p>
          )}
          <OwnerReviewActions review={{ ...review, labels: { accept: 'Grant', decline: 'Decline' } }} />
          {full}
        </>
      ) : state === 'granted' ? (
        <>
          {head(
            'Granted',
            'This exact Lane work can land. A later save needs your approval again.',
            'passed',
          )}
          {facts}
          {full}
        </>
      ) : (
        (() => {
          const words = LANE_WORDS[state];
          return head(words.title, words.lead, words.tone);
        })()
      );
  }
  function settingBody(approval: LaneApprovalRead) {
    const what = SETTING_LABEL[approval.setting!.origin];
    const who = approval.requester
      ? `@${approval.requester}${approval.agent ? `/${approval.agent}` : ''}`
      : 'an agent';
    const state = deriveApproval(approval).state;
    if (state === 'granted' || state === 'applied' || state === 'landed')
      return head('Applied', `You granted this ${what} change and it is in effect.`, 'passed');
    if (state === 'declined') return head('Declined', `The ${what} change was not applied.`, 'plain');
    if (state !== 'requested')
      return head(
        'Request closed',
        state === 'unknown'
          ? 'This request is in a state this page cannot confirm. Reload to read it again.'
          : 'The agent withdrew or replaced this request.',
        'plain',
      );
    return (
      <>
        {head(
          `Apply this ${what} change?`,
          `Requested by ${who}, signed in as an agent. ${what[0]!.toUpperCase()}${what.slice(1)} changes decide what every landing must pass, so they need you.`,
        )}
        <dl className="fx-dv-facts">
          <div>
            <dt>Change</dt>
            <dd className="fx-dv-untrusted">
              <pre>{JSON.stringify(approval.change ?? null, null, 2)}</pre>
            </dd>
          </div>
        </dl>
        <OwnerReviewActions review={{ ...review, labels: { accept: 'Grant', decline: 'Decline' } }} />
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
/** A fork PR head's run request: the owner grants or declines one check-only run on the project's
 * runner; its result is the PR's forge/verify status. */
function forkBody(
  approval: LaneApprovalRead,
  state: ApprovalPhase,
  head: (title: string, lead?: ReactNode, tone?: 'brand' | 'passed' | 'plain') => ReactNode,
  facts: ReactNode,
  full: ReactNode,
  review: OwnerReview,
) {
  const pr = `fork PR #${approval.pullRequest}`;
  if (state === 'granted' || state === 'applied' || state === 'landed')
    return (
      <>
        {head(
          'Granted',
          `The check of ${pr} runs on this project's runner; its result shows as forge/verify on the PR.`,
          'passed',
        )}
        {full}
      </>
    );
  if (state === 'declined') return head('Declined', `You declined the check of ${pr}.`, 'plain');
  if (state !== 'requested')
    return head(
      'Request closed',
      state === 'withdrawn'
        ? 'The request was withdrawn.'
        : state === 'unknown'
          ? 'This request is in a state this page cannot confirm. Reload to read it again.'
          : 'A newer push replaced this pull request head, or the request expired.',
      'plain',
    );
  return (
    <>
      {head(
        `Run the check of ${pr}?`,
        "A pull request from a fork waits for you. Granting runs the Forge check on this project's runner, without private submodules.",
      )}
      {facts}
      <OwnerReviewActions review={{ ...review, labels: { accept: 'Grant', decline: 'Decline' } }} />
      {full}
    </>
  );
}
