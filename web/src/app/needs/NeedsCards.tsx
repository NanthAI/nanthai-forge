// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Needs you cards rendered inside Needs me: Held approvals, shared-state notices, parked Lanes, questions,
// and asked-ahead approval requests. Split from NeedsMe.tsx so each card renders cleanly and independently.
import { useState, type ReactNode } from 'react';
import { Key, State, Who } from '../../ds';
import { A } from '../frames';
import { hrefFor } from '../paths';
import { RecordedWho } from '../RecordedWho';
import { declaredModel, recordedIdentity, type WhoProject } from '../who-links';
import { AnswerKeys, HandBackDetails } from '../discussion/ConversationEntry';
import { answerFailureReason, type Answer, type DismissAsk } from '../discussion/conversation';
import { AheadKeys, DecisionKeys } from './DecisionKeys';
import { NeedsCard } from './NeedsCard';
import { TakenKeys } from './TakenKeys';
import { decideTarget, type Decide } from './decide';
import {
  agoText,
  inPageApprovalNext,
  laneTitle,
  protectedApprovalCopy,
  waited,
  waitingText,
  whoOf,
  type AheadRow,
  type AskRow,
  type NoticeRow,
  type NowRow,
  type ParkedRow,
} from './model';
import type { NoticeLink } from './notice-attention';
import type { TakenActions } from './taken-actions';

/** "Later": the row folds to one line for this visit. It stays open, still counted, and nobody is told. */
function Later({ head, onShow }: { head: string; onShow: () => void }) {
  return (
    <div className="pf needs-fold needs-later">
      <span className="ttl" dir="auto">
        Put off: {head}
      </span>
      <Key size="sm" onClick={onShow}>
        Show
      </Key>
    </div>
  );
}

export function Held({
  row,
  project,
  drawnAt,
  laneHref,
  waitsHref,
  anchor,
  decide,
  canDecide,
  announce,
}: {
  row: NowRow;
  project: WhoProject;
  drawnAt: number;
  laneHref: string | null;
  /** Who is touching what for this Lane (Lanes > Touching, its wait chain): where the cause line leads. */
  waitsHref: string | null;
  anchor: string | null;
  decide: Decide;
  canDecide: boolean;
  announce: (text: string, show?: boolean) => void;
}) {
  const target = decideTarget(row);
  const protectedReason = protectedApprovalCopy(row);
  const laneName = laneTitle(row);
  const title = protectedReason
    ? `${laneName} waits for ${canDecide ? 'your' : 'the owner’s'} approval to land.`
    : laneName;
  const detail = protectedReason ?? row.detail;
  const who = recordedIdentity(row.actor, row.agent);
  const [later, setLater] = useState(false);
  if (later) return <Later head={row.head} onShow={() => setLater(false)} />;
  const link =
    row.why === 'conflict'
      ? 'See where they cross'
      : row.why === 'check-failed' || row.why === 'infra'
        ? 'What failed'
        : 'Open the Lane';
  const canAct = Boolean(target && canDecide);
  return (
    <NeedsCard
      className="dec"
      tabIndex={-1}
      id={anchor ? `d-${anchor}` : undefined}
      data-st={row.word === 'Conflict' ? 'conflict' : undefined}
      title={title}
      next={row.next}
      status={
        <>
          <span>{waitingText(row.since, drawnAt)}</span>
          <State word={row.word}>{row.tag}</State>
        </>
      }
      actions={
        <>
          {row.url ? (
            <A className="lk" href={row.url}>
              Open approval
            </A>
          ) : null}
          {waitsHref ? (
            <A className="lk" href={waitsHref}>
              What it waits on
            </A>
          ) : null}
          {laneHref ? (
            <A className="lk" href={laneHref}>
              {link}
            </A>
          ) : null}
          {!canAct ? (
            <Key kind="ghost" size="sm" onClick={() => setLater(true)}>
              Later
            </Key>
          ) : null}
        </>
      }
    >
      <p className="meta why" dir="auto">
        {who || row.agentAuthored ? (
          <>
            <RecordedWho
              handle={who}
              agentAuthored={row.agentAuthored}
              model={declaredModel(row.agentClient)}
              project={project}
            />
            {' · '}
          </>
        ) : null}
        <span className="mono" translate="no">
          {row.laneId ? 'Lane' : 'Submission'} {row.mark}
        </span>
        {row.siblings > 1 ? `, 1 of ${row.siblings} held for this Item` : ''}
        {detail ? ` · ${detail}` : ''}
      </p>
      {canAct && target ? (
        <div className="btns needs-dec-actions">
          <DecisionKeys
            laneId={row.laneId}
            target={target}
            reviewCheck={row.reviewCheck}
            decide={decide}
            announce={announce}
          />
          <Key kind="ghost" size="sm" onClick={() => setLater(true)}>
            Later
          </Key>
        </div>
      ) : null}
    </NeedsCard>
  );
}

/** Work reverted from main, work that needs a fix, or a stopped GitHub mirror (Item 12fde646): a shared-state decision
 * only a person settles. It stays until the state changes, so it has no Later. A revert somebody ran is an offer to
 * the Lane's owner (J08): who took which Lane out and when, with Bring it back and Leave it out; never a raw id or an
 * agent's command, which stay on the board note and in the CLI. */
export function NoticeCard({
  row,
  href,
  taken,
  announce,
  drawnAt,
}: {
  row: NoticeRow;
  href: (to: NoticeLink['to']) => string;
  taken: TakenActions | undefined;
  announce: (text: string) => void;
  drawnAt: number;
}) {
  const offer = row.taken;
  const since = offer?.at ?? row.since;
  const action = row.action;
  const actionHref = action ? href(action.to) : undefined;
  return (
    <NeedsCard
      className="dec"
      title={offer ? laneTitle(offer) : row.head}
      next={offer || row.kind === 'deploy' ? null : row.next}
      status={
        <>
          {since !== undefined ? <span>{agoText(since, drawnAt)}</span> : null}
          <State word={offer ? 'Done' : row.word}>{offer ? 'Taken out of main' : row.tag}</State>
        </>
      }
      actions={
        <>
          {offer ? (
            <TakenKeys
              target={{ laneId: offer.laneId, intentId: row.id }}
              title={offer.title}
              actions={taken}
              announce={announce}
            />
          ) : null}
          {action ? (
            action.to.anchor ? (
              <a className="btn ghost sm" href={actionHref}>
                {action.label}
              </a>
            ) : (
              <A className="btn ghost sm" href={actionHref!}>
                {action.label}
              </A>
            )
          ) : null}
          {row.links
            .filter(link => href(link.to) !== actionHref)
            .map(link =>
              link.to.anchor ? (
                <a key={link.label} className="lk" href={href(link.to)}>
                  {link.label}
                </a>
              ) : (
                <A key={link.label} className="lk" href={href(link.to)}>
                  {link.label}
                </A>
              ),
            )}
        </>
      }
    >
      {offer ? (
        <p className="meta" dir="auto">
          {whoOf(offer.by, offer.agent) ?? 'Someone'} took this change out. Its Lane keeps its saved work.
          Bring it back to fix it and land it again, or leave it out.
        </p>
      ) : row.who || (row.kind === 'deploy' && row.next) ? (
        <p className="meta" dir="auto">
          {row.who ? <Who handle={row.who} /> : null}
          {row.who && row.kind === 'deploy' && row.next ? ' · ' : null}
          {row.kind === 'deploy' ? row.next : null}
        </p>
      ) : null}
    </NeedsCard>
  );
}

/** A Lane parked for the reader (Item e1633718): who parked it, why in their words, and how long it has waited. */
export function Parked({
  row,
  drawnAt,
  laneHref,
  project,
}: {
  row: ParkedRow;
  drawnAt: number;
  laneHref: string;
  project: WhoProject;
}) {
  const who = recordedIdentity(row.who);
  const [later, setLater] = useState(false);
  if (later) return <Later head={row.head} onShow={() => setLater(false)} />;
  const span = waited(row.since, drawnAt);
  return (
    <NeedsCard
      className="dec"
      title={laneTitle(row)}
      status={
        <>
          <span>
            {row.park.named ? 'Parked' : 'Idle'} {span === 'just now' ? 'under 1 min' : span}
          </span>
          <State word="Needs you">{row.tag}</State>
        </>
      }
      actions={
        <>
          <A className="btn ghost sm" href={laneHref}>
            Open the Lane
          </A>
          <Key kind="ghost" size="sm" onClick={() => setLater(true)}>
            Later
          </Key>
        </>
      }
    >
      <p className="meta" dir="auto">
        {who ? (
          <>
            <RecordedWho handle={who} model={null} project={project} />
            {' · '}
          </>
        ) : null}
        <span className="mono" translate="no">
          Lane {row.mark}
        </span>
        {row.park.reason ? ` · ${row.park.reason}` : ''}
      </p>
    </NeedsCard>
  );
}

/** A question with fixed choices for the reader, from a person or an agent with no terminal (12fde646). */
export function Question({
  row,
  project,
  drawnAt,
  answer,
  dismissAsk,
  contextHref,
  announce,
}: {
  row: AskRow;
  project: WhoProject;
  drawnAt: number;
  answer: Answer;
  dismissAsk?: DismissAsk | undefined;
  contextHref: string | undefined;
  announce: (text: string) => void;
}) {
  const [later, setLater] = useState(false);
  const [dismissing, setDismissing] = useState(false);
  const [dismissError, setDismissError] = useState<string | null>(null);
  if (later) return <Later head={row.text} onShow={() => setLater(false)} />;
  const ended = Boolean(row.recipientEnded);
  const directed = Boolean(row.recipientSession);
  const onDismiss = async () => {
    if (!dismissAsk || dismissing) return;
    setDismissing(true);
    setDismissError(null);
    try {
      await dismissAsk(row);
      announce('Dismissed.');
    } catch (error) {
      setDismissError(answerFailureReason(error));
    } finally {
      setDismissing(false);
    }
  };
  return (
    <NeedsCard
      className="dec"
      titleClass="thread-choice"
      title={row.handBack ? (row.handBack.savedWork?.title ?? 'Lane handed back') : row.text}
      status={
        <>
          <span>
            {row.ahead || directed ? `Asked ${agoText(row.at, drawnAt)}` : waitingText(row.at, drawnAt)}
          </span>
          <State word={ended ? 'Stopped' : directed ? 'Waiting its turn' : 'Needs you'}>
            {ended
              ? 'Session ended'
              : directed
                ? 'For another session'
                : row.handBack
                  ? 'Handed back'
                  : 'Question'}
          </State>
        </>
      }
      actions={
        <>
          {ended && dismissAsk ? (
            <Key size="sm" disabled={dismissing} onClick={() => void onDismiss()}>
              Dismiss
            </Key>
          ) : null}
          {contextHref ? (
            <A className="btn ghost sm" href={contextHref}>
              Open the thread
            </A>
          ) : null}
          {!ended ? (
            <Key kind="ghost" size="sm" onClick={() => setLater(true)}>
              Later
            </Key>
          ) : null}
        </>
      }
    >
      {row.who ? (
        <p className="meta" dir="auto">
          <RecordedWho
            handle={recordedIdentity(row.who)}
            agentAuthored={!!row.agent}
            model={null}
            project={project}
          />
        </p>
      ) : null}
      {row.handBack ? (
        <HandBackDetails
          savedWork={row.handBack.savedWork}
          left={row.handBack.left}
          to={row.handBack.to}
          tried={row.text}
        />
      ) : null}
      {ended ? (
        <>
          <p className="why" dir="auto">
            For {row.to ?? 'another session'} — that session ended.
          </p>
          {row.choices.length ? (
            <p className="t2" dir="auto">
              {row.choices.join(' · ')}
            </p>
          ) : null}
          {dismissError ? (
            <p role="alert" className="err">
              {dismissError}
            </p>
          ) : null}
        </>
      ) : directed ? (
        <>
          <p className="why" dir="auto">
            For {row.to ?? 'another session'} — waiting on that session.
          </p>
          {row.choices.length ? (
            <p className="t2" dir="auto">
              {row.choices.join(' · ')}
            </p>
          ) : null}
        </>
      ) : (
        <AnswerKeys
          entry={row}
          choices={row.choices}
          answer={answer}
          handBack={Boolean(row.handBack)}
          onAnswered={announce}
        />
      )}
    </NeedsCard>
  );
}

export function Ahead({
  row,
  project,
  detail,
  waitsHref = null,
  drawnAt,
  decide,
  canDecide,
  announce,
}: {
  row: AheadRow;
  project: WhoProject;
  detail?: (laneId: string) => ReactNode;
  /** Set only on a request that blocks its Lane's landing (Holding work now): where that Lane's wait chain is. */
  waitsHref?: string | null;
  drawnAt: number;
  decide: Decide;
  canDecide: boolean;
  announce: (text: string) => void;
}) {
  const asked = Date.parse(row.at);
  const [open, setOpen] = useState(false);
  return (
    <details className="sumdec" onToggle={event => setOpen(event.currentTarget.open)}>
      <summary>
        <State word={row.word}>{row.tag}</State>
        <span className="ttl" dir="auto">
          {row.question}
        </span>
        <span className="meta">
          Asked {Number.isNaN(asked) ? 'at a time not reported' : agoText(asked, drawnAt)}
        </span>
      </summary>
      <div className="dec">
        <div className="dtop">
          <span>{waitsHref ? 'holds its Lane' : 'holds nothing yet'}</span>
          {row.who ? (
            <RecordedWho
              handle={recordedIdentity(row.who)}
              agentAuthored={!!row.agent}
              model={null}
              project={project}
            />
          ) : null}
        </div>
        <p className="why" dir="auto">
          {row.label}. {inPageApprovalNext(row, canDecide)}
        </p>
        {open && detail ? detail(row.laneId) : null}
        {waitsHref ? (
          <div className="btns">
            <A className="btn ghost sm" href={waitsHref}>
              What it waits on
            </A>
          </div>
        ) : null}
        {row.needsOwner && canDecide ? (
          <div className="btns">
            {row.kind === 'lane' ? (
              // A Lane request is decided on the Lane's current save, which its page shows (Item 0a99ab23).
              <A
                className="btn sm"
                href={hrefFor({
                  frame: 'project',
                  handle: project.handle,
                  project: project.project,
                  place: 'lanes',
                  section: '',
                  rest: row.laneId,
                })}
              >
                Review the Lane
              </A>
            ) : (
              <AheadKeys row={row} decide={decide} announce={announce} />
            )}
          </div>
        ) : null}
      </div>
    </details>
  );
}
