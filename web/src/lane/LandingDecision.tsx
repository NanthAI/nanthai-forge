// SPDX-License-Identifier: Apache-2.0
import { useState, type ReactNode } from 'react';
import { Button, Panel } from '../ui/primitives';
import { Glyph } from '../ui/Glyph';
import { ErrorToast } from '../ui/Toast';
import { LandingProgress, LandingRail } from './LandingProgress';
import { landingState, elapsed, type LandingRead } from './landing-model';
import { RequestChanges, type ReviewRecipient } from '../review/RequestChanges';
import { ReviewDisposition, type ReviewAcceptance } from '../review/ReviewDisposition';
import './landing.css';
export type LandingDecisionProps = {
  read?: LandingRead | null;
  reverseRead?: LandingRead | null;
  reverseLabel?: string;
  reverseHref?: string;
  reversing?: boolean;
  acceptance?: ReviewAcceptance;
  candidateLabel: string;
  canAccept: boolean;
  canComment: boolean;
  onRequestSent?: () => void;
  busy?: boolean;
  error?: string;
  gates?: { ok: boolean; title: string; body?: string; warn?: boolean }[];
  recipients?: ReviewRecipient[];
  draftKey: string;
  replacement?: { href: string; label: string };
  accept: () => void;
  cancel?: () => void;
  send: (text: string, laneId?: string) => Promise<unknown>;
  revert?: (why: string) => void;
  repairHref?: string;
  aheadLabel?: string;
  runHref?: string;
  failures?: string[];
  log?: string;
  initialRevert?: boolean;
  requestOpen?: boolean;
  requestSent?: { text: string; to: string };
  children?: ReactNode;
};
export function LandingDecision(props: LandingDecisionProps) {
  const [confirm, setConfirm] = useState(props.initialRevert ?? false),
    [why, setWhy] = useState(''),
    [composing, setComposing] = useState(props.requestOpen ?? false);
  const reverseFailed = props.reverseRead?.request.observation.state === 'terminal-failed';
  const current = reverseFailed ? props.reverseRead : props.read;
  const state = landingState(current, Boolean(props.replacement));
  const landed = !reverseFailed && (state.kind === 'landed' || Boolean(props.acceptance));
  const reversing = props.reversing || props.reverseRead?.request.observation.state === 'pending';
  const reversed = props.reverseRead?.request.observation.state === 'landed';
  const run = current?.run;
  const feedback = (
    <RequestChanges
      key={props.draftKey}
      draftKey={props.draftKey}
      disabled={!props.canComment}
      send={props.send}
      recipients={props.recipients}
      onSent={props.onRequestSent}
      onOpen={setComposing}
      initialOpen={props.requestOpen}
      initialSent={props.requestSent}
    />
  );
  return (
    <Panel
      title={reversing ? 'Reverting' : landed ? 'Landed' : state.title}
      className={`fx-decide${state.pending || reversing ? ' fx-decide-running' : state.kind === 'check' ? ' fx-decide-failed' : ''}`}
      actions={
        landed &&
        props.revert &&
        !reversing &&
        !reversed && (
          <Button size="sm" variant="ghost" onClick={() => setConfirm(!confirm)}>
            Revert…
          </Button>
        )
      }
    >
      {reversing ? (
        props.reverseRead ? (
          <LandingProgress read={props.reverseRead} cancel={props.cancel} busy={props.busy} />
        ) : (
          <div className="fx-land" role="status">
            <LandingRail />
            <b>Preparing reverse Candidate</b>
            <p className="fx-faint">Reverse source submitted</p>
          </div>
        )
      ) : state.pending ? (
        <LandingProgress
          read={props.read!}
          cancel={props.cancel}
          busy={props.busy}
          aheadLabel={props.aheadLabel}
        />
      ) : landed ? (
        <>
          <ReviewDisposition
            check={run?.status === 'passed' ? run.check.name : undefined}
            acceptance={
              props.acceptance ?? {
                at: props.read!.receipt?.at ?? props.read!.request.at,
                actor: props.read!.attempt.actor.id,
              }
            }
          />
          {reversed && (
            <ReviewDisposition
              reverted={{
                href: props.reverseHref ?? '#',
                label: props.reverseLabel ?? 'the reverse Candidate',
                at: props.reverseRead!.receipt?.at ?? props.reverseRead!.request.at,
                actor: props.reverseRead!.receipt?.actor.id,
                check:
                  props.reverseRead!.run?.status === 'passed'
                    ? props.reverseRead!.run!.check.name
                    : undefined,
                why: props.reverseRead?.message ?? why,
              }}
            />
          )}
          <ul className="fx-completion">
            {props.recipients?.map(lane => (
              <li key={lane.id}>
                <Glyph name="passed" size={12} />
                {lane.name} · {lane.state ?? 'Done'}{' '}
                {lane.automatic !== false && <span className="fx-auto">auto</span>}
              </li>
            ))}
            <li>Snapshots kept</li>
          </ul>
          <div className="fx-land">
            <LandingRail landed checked={run?.status === 'passed' || Boolean(props.read?.receipt?.check)} />
          </div>
          {confirm && !reversed && (
            <div className="fx-confirm">
              <h3>Revert {props.candidateLabel} from main</h3>
              <ul className="fx-confirm-facts">
                <li>Creates a new Candidate: the reverse of this change on current main</li>
                <li>Checked (verify) and landed through the queue, like any Candidate</li>
                <li>main is never rewound · later landings are kept</li>
              </ul>
              <label className="fx-field-label">
                Why <span className="fx-faint">(optional)</span>
                <input className="fx-input" value={why} onChange={event => setWhy(event.target.value)} />
              </label>
              <div className="fx-land-actions">
                <Button variant="primary" disabled={props.busy} onClick={() => props.revert?.(why)}>
                  Revert into main
                </Button>
                <Button variant="ghost" disabled={props.busy} onClick={() => setConfirm(false)}>
                  Not now
                </Button>
              </div>
            </div>
          )}
        </>
      ) : state.kind === 'superseded' ? (
        <div className="fx-land">
          <a href={props.replacement?.href}>
            Superseded by {props.replacement?.label ?? 'a newer Candidate'}
          </a>
        </div>
      ) : state.kind === 'ready' ? (
        <>
          <ul className="fx-gates">
            {props.gates?.map(gate => (
              <li
                key={gate.title}
                className={gate.warn ? 'fx-gate-warn' : gate.ok ? 'fx-gate-ok' : 'fx-gate-none'}
              >
                <span className="fx-gate-icon">
                  <Glyph name={gate.ok ? 'passed' : 'info'} size={11} />
                </span>
                <div>
                  <b>{gate.title}</b>
                  {gate.body && <p>{gate.body}</p>}
                </div>
              </li>
            ))}
            {!props.canAccept && (
              <li className="fx-gate-none">
                <span className="fx-gate-icon">
                  <Glyph name="info" size={11} />
                </span>
                <b>A project owner or maintainer accepts</b>
              </li>
            )}
          </ul>
          {props.canAccept && (
            <div className="fx-decide-go">
              <Button
                variant={composing ? 'secondary' : 'primary'}
                size="lg"
                disabled={props.busy}
                onClick={props.accept}
              >
                Accept into main
              </Button>
              <p className="fx-decide-after">
                Lands through the queue · checked again only if main moves first
              </p>
            </div>
          )}
          {feedback}
        </>
      ) : (
        <>
          <div className="fx-land">
            <b>
              {state.kind === 'check'
                ? `${run?.check.name ?? 'Check'} failed${run?.exitCode != null ? ` · exit ${run.exitCode}` : ''}${run?.endedAt ? ` · ${elapsed(run.at, run.endedAt)}` : ''} · main unchanged`
                : state.kind === 'conflict'
                  ? 'main moved and this Candidate no longer composes'
                  : state.kind === 'not-run'
                    ? 'Not run · runner never started'
                    : state.kind === 'cancelled'
                      ? 'Landing cancelled · main unchanged'
                      : (current?.request.error?.message ?? 'Landing did not complete · main unchanged')}
            </b>
          </div>
          {state.kind === 'check' && (
            <div className="fx-failures">
              {props.failures?.length ? (
                <ul className="fx-failing">
                  {props.failures.slice(0, 3).map(name => (
                    <li key={name}>
                      <span className="fx-fail-x">×</span>
                      {name}
                    </li>
                  ))}
                  {props.failures.length > 3 && <li>+{props.failures.length - 3}</li>}
                </ul>
              ) : null}
              {props.log && <pre className="fx-log">{props.log.split('\n').slice(0, 8).join('\n')}</pre>}
            </div>
          )}
          <div className="fx-land-actions fx-decision-recovery">
            {state.kind === 'check' && props.runHref && (
              <a className="fx-btn fx-btn-rec" href={props.runHref}>
                Open run
              </a>
            )}
            {(state.kind === 'check' || state.kind === 'conflict') && props.repairHref && (
              <a className="fx-btn" href={props.repairHref}>
                {state.kind === 'conflict' ? 'Resolve in Lane' : 'Repair in Lane'}
              </a>
            )}
            {(state.kind === 'not-run' || state.kind === 'cancelled') && props.canAccept && (
              <Button disabled={props.busy} onClick={props.accept}>
                Try again
              </Button>
            )}
          </div>
          {feedback}
        </>
      )}
      {props.children}
      <ErrorToast error={props.error ?? ''} />
    </Panel>
  );
}
