// SPDX-License-Identifier: Apache-2.0
import { hostedHref } from '../cockpit/hosted-links';
import { Glyph } from '../ui/Glyph';
import { Button } from '../ui/primitives';
import { clockTime, elapsed, landingState, type LandingRead } from './landing-model';
export function LandingRail({
  landed = false,
  checked = true,
  checking = false,
}: {
  landed?: boolean;
  checked?: boolean;
  checking?: boolean;
}) {
  return (
    <div className="fx-land-rail">
      <div
        className="fx-rail fx-rail-lg"
        title={landed ? 'edited · saved · checked · accepted' : 'edited · saved · checked · accepting'}
        aria-hidden="true"
      >
        {[0, 1, 2, 3].map(index => (
          <i
            key={index}
            className={
              landed
                ? index === 2 && !checked
                  ? 'fx-rail-off'
                  : 'fx-rail-ok'
                : index < 2
                  ? 'fx-rail-on'
                  : index === 2
                    ? checking
                      ? 'fx-rail-run'
                      : checked
                        ? 'fx-rail-ok'
                        : 'fx-rail-off'
                    : checked || !checking
                      ? 'fx-rail-run'
                      : 'fx-rail-off'
            }
          />
        ))}
      </div>
      <span>
        edited · saved · {checked || checking ? 'checked' : 'unchecked'} ·{' '}
        <b>{landed ? 'accepted' : 'accepting'}</b>
      </span>
    </div>
  );
}
export function LandingProgress({
  read,
  cancel,
  busy,
  aheadLabel,
}: {
  read: LandingRead;
  cancel?: () => void;
  busy?: boolean;
  aheadLabel?: string;
}) {
  const state = landingState(read),
    { request, attempt, run } = read;
  return (
    <div className="fx-land" aria-live="polite">
      <LandingRail checked={run?.status === 'passed'} checking={Boolean(run && run.status !== 'passed')} />
      <ol className="fx-land-steps">
        <li className="fx-gate-ok">
          <span className="fx-gate-icon">
            <Glyph name="passed" size={11} />
          </span>
          <div>
            <b>Submitted</b>
            <p>by {attempt.actor.kind === 'person' ? 'you' : 'an agent'}</p>
          </div>
          <time dateTime={request.at}>{clockTime(request.at)}</time>
        </li>
        <li className={request.phase === 'queued' ? 'fx-gate-warn' : 'fx-gate-ok'}>
          <span className="fx-gate-icon">
            <Glyph name={request.phase === 'queued' ? 'waiting' : 'passed'} size={11} />
          </span>
          <div>
            <b>Queued</b>
            {read.ahead && <p>waits for {aheadLabel ?? 'another Candidate'} to finish landing</p>}
          </div>
          <time dateTime={attempt.at}>{clockTime(attempt.at)}</time>
        </li>
        <li className={run ? '' : 'pending'}>
          <span className="fx-gate-icon">
            <Glyph
              name={run?.status === 'passed' ? 'passed' : state.tone === 'stale' ? 'stale' : 'running'}
              size={11}
            />
          </span>
          <div>
            <b>{state.label === 'Check waiting for a runner' ? state.label : 'Checking'}</b>
            {read.pendingAttempt && (
              <p>
                main moved · recomposing <span className="fx-auto">auto</span>
              </p>
            )}
            <p>
              {run
                ? `${run.check.name} · ${run.counts.completed} of ${run.plan?.shardCount ?? '…'} shards${run.endedAt ? ` · ${elapsed(run.at, run.endedAt)}` : ''}`
                : 'No check selected'}
            </p>
            {state.tone === 'stale' && (
              <>
                <p>
                  {run?.configuration.provider === 'github-actions' ? 'GitHub-hosted · ' : ''}no runner has
                  started it
                </p>
                <a href={hostedHref({ projectTab: 'checks' })}>Checks settings</a>
              </>
            )}
            {request.observation.pendingReason === 'waiting-for-review' && (
              <p>{request.error?.message ?? 'Waiting for review'}</p>
            )}
            {request.observation.pendingReason === 'waiting-for-dependency' && (
              <p>Waiting for the selected dependency to land</p>
            )}
          </div>
          {run && <time dateTime={run.at}>{clockTime(run.at)}</time>}
        </li>
        <li className={request.phase === 'ready' ? '' : 'pending'}>
          <span className="fx-gate-icon">→</span>
          <div>
            <b>Land on main</b>
          </div>
        </li>
      </ol>
      <div className="fx-land-actions">
        {cancel && (
          <Button variant="ghost" disabled={busy} onClick={cancel}>
            Cancel landing
          </Button>
        )}
        <span>updates live · no action needed</span>
      </div>
    </div>
  );
}
